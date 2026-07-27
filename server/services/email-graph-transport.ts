import type { CompanySettings } from "@shared/schema";

// Task #1856 — Second email transport behind the SSoT `sendEmail`: Microsoft
// Graph, app-only OAuth2 (client-credentials). No mailbox password, no
// interactive login, no MFA/Basic-Auth problem — the app identity fetches and
// renews tokens itself (the Graph client library handles renewal). This is the
// future replacement for the SMTP transport; SMTP stays as fallback until the
// Graph path is stable (see task description / replit.md).

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";

// Graph inlines attachments in the sendMail payload up to ~4 MB total request
// size. We keep a conservative headroom and switch to the upload-session /
// draft path above this threshold rather than silently failing.
const INLINE_ATTACHMENT_LIMIT_BYTES = 3 * 1024 * 1024;

interface GraphAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
  cid?: string;
  contentDisposition?: "inline" | "attachment";
}

interface GraphEmailOptions {
  to: string;
  subject: string;
  html: string;
  from: string;
  attachments?: GraphAttachment[];
}

// The concrete Graph client type lives in the runtime-only dependency; we type
// it structurally so this module compiles without pulling the SDK types into
// the shared build graph.
interface GraphClientLike {
  api(path: string): {
    post(body: unknown): Promise<unknown>;
    get(): Promise<unknown>;
  };
}

// Graph rejects a single POST /attachments above ~3 MB and requires an upload
// session (chunked PUT) for larger files. Chunks MUST be a multiple of 320 KiB
// (except the final chunk). ~3.75 MiB per chunk keeps requests small but few.
const UPLOAD_SESSION_THRESHOLD_BYTES = 3 * 1024 * 1024;
const UPLOAD_CHUNK_BYTES = 12 * 320 * 1024; // 3,932,160 bytes (multiple of 320 KiB)

interface CachedClient {
  tenantId: string;
  clientId: string;
  secret: string;
  client: GraphClientLike;
}

let cached: CachedClient | null = null;

/**
 * Returns true when all Graph credentials are present. Kept separate from the
 * SMTP validation so a Graph-mode deployment does not need SMTP fields.
 */
export function hasGraphCredentials(settings: CompanySettings): boolean {
  return Boolean(
    settings.graphTenantId &&
      settings.graphClientId &&
      settings.graphClientSecret &&
      settings.graphSenderUpn,
  );
}

async function getGraphClient(settings: CompanySettings): Promise<GraphClientLike> {
  const tenantId = settings.graphTenantId!;
  const clientId = settings.graphClientId!;
  const secret = settings.graphClientSecret!;

  if (
    cached &&
    cached.tenantId === tenantId &&
    cached.clientId === clientId &&
    cached.secret === secret
  ) {
    return cached.client;
  }

  // Runtime-only imports (kept external from the esbuild server bundle).
  const { ClientSecretCredential } = await import("@azure/identity");
  const { Client } = await import("@microsoft/microsoft-graph-client");
  const { TokenCredentialAuthenticationProvider } = await import(
    "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js"
  );

  const credential = new ClientSecretCredential(tenantId, clientId, secret);
  const authProvider = new TokenCredentialAuthenticationProvider(credential, {
    scopes: [GRAPH_SCOPE],
  });
  const client = Client.initWithMiddleware({ authProvider }) as unknown as GraphClientLike;

  cached = { tenantId, clientId, secret, client };
  return client;
}

function buildGraphAttachments(attachments: GraphAttachment[] | undefined) {
  if (!attachments || attachments.length === 0) return [];
  return attachments.map((a) => {
    const isInline = a.contentDisposition === "inline" || Boolean(a.cid);
    return {
      "@odata.type": "#microsoft.graph.fileAttachment",
      name: a.filename,
      contentType: a.contentType || "application/pdf",
      contentBytes: a.content.toString("base64"),
      isInline,
      // `contentId` is what makes `cid:company-logo` in the HTML resolve to the
      // inline image (mirrors the nodemailer `cid` behaviour).
      ...(a.cid ? { contentId: a.cid } : {}),
    };
  });
}

function totalAttachmentBytes(attachments: GraphAttachment[] | undefined): number {
  if (!attachments) return 0;
  return attachments.reduce((sum, a) => sum + a.content.length, 0);
}

/**
 * Sends an email via Microsoft Graph (app-only). Returns a synthetic
 * `{ messageId }` because Graph's sendMail does not return a message id, so the
 * shape stays identical to the SMTP transport.
 */
export async function sendViaGraph(
  settings: CompanySettings,
  options: GraphEmailOptions,
): Promise<{ messageId: string }> {
  const client = await getGraphClient(settings);
  const senderUpn = settings.graphSenderUpn!;

  const toRecipients = options.to
    .split(",")
    .map((addr) => addr.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));

  const messageId = `<graph-${Date.now()}-${Math.random().toString(36).slice(2, 10)}@${
    senderUpn.split("@")[1] || "graph.local"
  }>`;

  const message = {
    subject: options.subject,
    body: { contentType: "HTML", content: options.html },
    toRecipients,
    attachments: buildGraphAttachments(options.attachments),
  };

  if (totalAttachmentBytes(options.attachments) <= INLINE_ATTACHMENT_LIMIT_BYTES) {
    // Small payload: single sendMail call with inline attachments.
    await client
      .api(`/users/${encodeURIComponent(senderUpn)}/sendMail`)
      .post({ message, saveToSentItems: true });
    return { messageId };
  }

  // Large payload: create a draft, attach files, then send. Small attachments go
  // via POST /attachments; anything above the single-request limit uses a Graph
  // upload session (chunked PUT) instead of silently failing.
  const draft = (await client
    .api(`/users/${encodeURIComponent(senderUpn)}/messages`)
    .post({
      subject: options.subject,
      body: { contentType: "HTML", content: options.html },
      toRecipients,
    })) as { id: string };

  const basePath = `/users/${encodeURIComponent(senderUpn)}/messages/${draft.id}`;

  for (const attachment of options.attachments || []) {
    if (attachment.content.length <= UPLOAD_SESSION_THRESHOLD_BYTES) {
      const [built] = buildGraphAttachments([attachment]);
      await client.api(`${basePath}/attachments`).post(built);
    } else {
      await uploadLargeAttachment(client, basePath, attachment);
    }
  }

  await client.api(`${basePath}/send`).post({});

  return { messageId };
}

/**
 * Uploads an oversized attachment to a draft via a Graph upload session: create
 * the session, then PUT the bytes in 320-KiB-aligned chunks with Content-Range.
 */
async function uploadLargeAttachment(
  client: GraphClientLike,
  basePath: string,
  attachment: GraphAttachment,
): Promise<void> {
  const size = attachment.content.length;
  const isInline = attachment.contentDisposition === "inline" || Boolean(attachment.cid);

  const session = (await client.api(`${basePath}/attachments/createUploadSession`).post({
    AttachmentItem: {
      attachmentType: "file",
      name: attachment.filename,
      size,
      contentType: attachment.contentType || "application/pdf",
      isInline,
      ...(attachment.cid ? { contentId: attachment.cid } : {}),
    },
  })) as { uploadUrl: string };

  for (let start = 0; start < size; start += UPLOAD_CHUNK_BYTES) {
    const end = Math.min(start + UPLOAD_CHUNK_BYTES, size);
    const chunk = attachment.content.subarray(start, end);
    const response = await fetch(session.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": String(chunk.length),
        "Content-Range": `bytes ${start}-${end - 1}/${size}`,
      },
      body: chunk,
    });
    if (!response.ok) {
      throw new Error(
        `Graph-Upload-Session fehlgeschlagen (${response.status}) für ${attachment.filename}`,
      );
    }
  }
}

/**
 * Cheap connectivity check for the admin "Verbindung testen" button: fetches a
 * token (implicit in the first Graph call) and does a minimal `GET /users/{upn}`.
 */
export async function testGraphConnection(
  settings: CompanySettings,
): Promise<{ success: boolean; error?: string }> {
  try {
    const client = await getGraphClient(settings);
    await client.api(`/users/${encodeURIComponent(settings.graphSenderUpn!)}?$select=id`).get();
    return { success: true };
  } catch (error: unknown) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Graph-Verbindung fehlgeschlagen",
    };
  }
}

/** Test hook: clears the cached Graph client between test cases. */
export function __resetGraphClientCache(): void {
  cached = null;
}
