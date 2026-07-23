import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CompanySettings } from "@shared/schema";

// Task #1856 — verify the Microsoft Graph transport WITHOUT ever contacting
// Graph: the Azure/Graph SDKs are mocked, so `sendViaGraph` exercises only the
// payload mapping (cid→contentId/isInline, PDF attachments, recipients) against
// a fake client.

const apiPost = vi.fn();
const apiGet = vi.fn().mockResolvedValue({ id: "user-1" });
// The fake client resolves per-path: createUploadSession yields an uploadUrl,
// everything else yields a draft id. apiPost still receives only the body so the
// payload-mapping assertions keep working.
const apiFor = vi.fn((path: string) => ({
  post: (body: unknown) => {
    apiPost(body);
    if (path.includes("createUploadSession")) {
      return Promise.resolve({ uploadUrl: "https://upload.local/session" });
    }
    return Promise.resolve({ id: "draft-1" });
  },
  get: () => apiGet(),
}));
const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });

vi.mock("@azure/identity", () => ({
  ClientSecretCredential: class {
    constructor() {
      return { kind: "client-secret" };
    }
  },
}));

vi.mock("@microsoft/microsoft-graph-client", () => ({
  Client: {
    initWithMiddleware: vi.fn(() => ({ api: apiFor })),
  },
}));

vi.mock(
  "@microsoft/microsoft-graph-client/authProviders/azureTokenCredentials/index.js",
  () => ({
    TokenCredentialAuthenticationProvider: class {
      constructor() {
        return { kind: "auth" };
      }
    },
  }),
);

import {
  sendViaGraph,
  testGraphConnection,
  hasGraphCredentials,
  __resetGraphClientCache,
} from "../server/services/email-graph-transport";

function graphSettings(overrides: Partial<CompanySettings> = {}): CompanySettings {
  return {
    id: 1,
    companyName: "Test GmbH",
    emailProvider: "graph",
    graphTenantId: "tenant-123",
    graphClientId: "client-123",
    graphClientSecret: "secret-123",
    graphSenderUpn: "info@firma.de",
    ...overrides,
  } as unknown as CompanySettings;
}

describe("email-graph-transport (Task #1856)", () => {
  beforeEach(() => {
    apiPost.mockClear();
    apiGet.mockClear();
    apiFor.mockClear();
    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    __resetGraphClientCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetGraphClientCache();
  });

  describe("hasGraphCredentials", () => {
    it("is true only when all four Graph fields are present", () => {
      expect(hasGraphCredentials(graphSettings())).toBe(true);
      expect(hasGraphCredentials(graphSettings({ graphClientSecret: null }))).toBe(false);
      expect(hasGraphCredentials(graphSettings({ graphSenderUpn: null }))).toBe(false);
      expect(hasGraphCredentials(graphSettings({ graphTenantId: null }))).toBe(false);
      expect(hasGraphCredentials(graphSettings({ graphClientId: null }))).toBe(false);
    });
  });

  describe("sendViaGraph (small/inline payload)", () => {
    it("posts to /users/{upn}/sendMail with HTML body and recipients", async () => {
      const result = await sendViaGraph(graphSettings(), {
        to: "to@test.local",
        subject: "Hallo",
        html: "<p>hi</p>",
        from: '"Test GmbH" <info@firma.de>',
      });

      expect(result.messageId).toMatch(/^<graph-/);
      expect(apiFor).toHaveBeenCalledWith("/users/info%40firma.de/sendMail");
      const body = apiPost.mock.calls[0][0] as {
        message: { subject: string; body: { contentType: string; content: string }; toRecipients: unknown[] };
      };
      expect(body.message.subject).toBe("Hallo");
      expect(body.message.body).toEqual({ contentType: "HTML", content: "<p>hi</p>" });
      expect(body.message.toRecipients).toEqual([{ emailAddress: { address: "to@test.local" } }]);
    });

    it("maps a cid logo attachment to contentId + isInline", async () => {
      await sendViaGraph(graphSettings(), {
        to: "to@test.local",
        subject: "Mit Logo",
        html: '<img src="cid:company-logo">',
        from: "x",
        attachments: [
          {
            filename: "logo.png",
            content: Buffer.from("PNGDATA"),
            contentType: "image/png",
            cid: "company-logo",
            contentDisposition: "inline",
          },
        ],
      });

      const body = apiPost.mock.calls[0][0] as { message: { attachments: Array<Record<string, unknown>> } };
      const att = body.message.attachments[0];
      expect(att["@odata.type"]).toBe("#microsoft.graph.fileAttachment");
      expect(att.name).toBe("logo.png");
      expect(att.contentType).toBe("image/png");
      expect(att.contentBytes).toBe(Buffer.from("PNGDATA").toString("base64"));
      expect(att.isInline).toBe(true);
      expect(att.contentId).toBe("company-logo");
    });

    it("maps a PDF attachment as a non-inline file attachment", async () => {
      await sendViaGraph(graphSettings(), {
        to: "to@test.local",
        subject: "Rechnung",
        html: "<p>x</p>",
        from: "x",
        attachments: [
          { filename: "Rechnung.pdf", content: Buffer.from("PDF"), contentType: "application/pdf" },
        ],
      });

      const body = apiPost.mock.calls[0][0] as { message: { attachments: Array<Record<string, unknown>> } };
      const att = body.message.attachments[0];
      expect(att.name).toBe("Rechnung.pdf");
      expect(att.contentType).toBe("application/pdf");
      expect(att.isInline).toBe(false);
      expect(att.contentId).toBeUndefined();
      expect(att.contentBytes).toBe(Buffer.from("PDF").toString("base64"));
    });

    it("splits a comma-separated recipient list", async () => {
      await sendViaGraph(graphSettings(), {
        to: "a@test.local, b@test.local",
        subject: "x",
        html: "y",
        from: "x",
      });
      const body = apiPost.mock.calls[0][0] as { message: { toRecipients: unknown[] } };
      expect(body.message.toRecipients).toEqual([
        { emailAddress: { address: "a@test.local" } },
        { emailAddress: { address: "b@test.local" } },
      ]);
    });
  });

  describe("sendViaGraph (large payload → upload session)", () => {
    it("creates a draft and uploads an oversized attachment via a chunked upload session", async () => {
      const big = Buffer.alloc(4 * 1024 * 1024, 1); // 4 MiB > 3 MiB threshold
      await sendViaGraph(graphSettings(), {
        to: "to@test.local",
        subject: "Groß",
        html: "<p>x</p>",
        from: "x",
        attachments: [{ filename: "big.pdf", content: big, contentType: "application/pdf" }],
      });

      const paths = apiFor.mock.calls.map((c) => c[0] as string);
      expect(paths).toContain("/users/info%40firma.de/messages");
      expect(paths).toContain(
        "/users/info%40firma.de/messages/draft-1/attachments/createUploadSession",
      );
      // Oversized attachment must NOT be POSTed inline.
      expect(paths).not.toContain("/users/info%40firma.de/messages/draft-1/attachments");
      expect(paths).toContain("/users/info%40firma.de/messages/draft-1/send");

      // Chunks are PUT to the session uploadUrl with 320-KiB-aligned Content-Range.
      expect(fetchMock).toHaveBeenCalled();
      const firstCall = fetchMock.mock.calls[0];
      expect(firstCall[0]).toBe("https://upload.local/session");
      expect((firstCall[1] as { method: string }).method).toBe("PUT");
      const headers = (firstCall[1] as { headers: Record<string, string> }).headers;
      expect(headers["Content-Range"]).toMatch(/^bytes 0-\d+\/4194304$/);
      // 4 MiB / 3,932,160-byte chunks ⇒ 2 chunks.
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("small attachments in a large total payload still POST inline", async () => {
      // Two 2 MiB attachments: total 4 MiB (draft path) but each below the
      // per-attachment upload-session threshold ⇒ plain POST /attachments.
      const two = Buffer.alloc(2 * 1024 * 1024, 1);
      await sendViaGraph(graphSettings(), {
        to: "to@test.local",
        subject: "Groß",
        html: "<p>x</p>",
        from: "x",
        attachments: [
          { filename: "a.pdf", content: two, contentType: "application/pdf" },
          { filename: "b.pdf", content: two, contentType: "application/pdf" },
        ],
      });

      const paths = apiFor.mock.calls.map((c) => c[0] as string);
      expect(paths.filter((p) => p === "/users/info%40firma.de/messages/draft-1/attachments")).toHaveLength(2);
      expect(paths).not.toContain(
        "/users/info%40firma.de/messages/draft-1/attachments/createUploadSession",
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("testGraphConnection", () => {
    it("does a cheap GET /users/{upn} and reports success", async () => {
      const result = await testGraphConnection(graphSettings());
      expect(result).toEqual({ success: true });
      expect(apiFor).toHaveBeenCalledWith("/users/info%40firma.de?$select=id");
      expect(apiGet).toHaveBeenCalledTimes(1);
    });

    it("reports the error message when the Graph call rejects", async () => {
      apiGet.mockRejectedValueOnce(new Error("AADSTS7000215"));
      const result = await testGraphConnection(graphSettings());
      expect(result.success).toBe(false);
      expect(result.error).toBe("AADSTS7000215");
    });
  });
});
