/**
 * Task #1840 — Lokaler Upload-Flow (Commit 4b): HMAC-Token,
 * createUploadUrl-Format und normalizeObjectEntityPath-Local-Zweig.
 *
 * Der local-Treiber kann keine GCS-Presigned-URL ausstellen; stattdessen gibt
 * er eine relative, HMAC-signierte App-URL aus, auf die der Browser direkt
 * PUTtet. Diese Tests sichern das Capability-Modell (Token nur für genau ein
 * Upload-Objekt, kurzlebig, unfälschbar) und die Rück-Auflösung der Upload-URL
 * auf den Objekt-Pfad ab.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  signLocalUploadToken,
  verifyLocalUploadToken,
} from "../../server/lib/storage/local-upload-token";
import { localStorageDriver } from "../../server/lib/storage/local-driver";
import { ObjectStorageService } from "../../server/replit_integrations/object_storage/objectStorage";

const KEY = "0".repeat(64);

describe("lokaler Upload-Token (Task #1840)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
  });

  it("signiert und verifiziert einen gültigen Token", () => {
    const t = signLocalUploadToken({ objectId: "abc-123" });
    const v = verifyLocalUploadToken(t);
    expect(v.ok).toBe(true);
    expect(v.objectId).toBe("abc-123");
  });

  it("weist einen abgelaufenen Token ab", () => {
    // vor 20 min ausgestellt, TTL 15 min → abgelaufen
    const past = Date.now() - 20 * 60 * 1000;
    const t = signLocalUploadToken({ objectId: "abc-123" }, 15 * 60 * 1000, past);
    expect(verifyLocalUploadToken(t).reason).toBe("expired");
  });

  it("weist einen manipulierten Token ab (bad_signature)", () => {
    const t = signLocalUploadToken({ objectId: "abc-123" });
    const [body] = t.split(".");
    const forged = `${body}.${"A".repeat(43)}`;
    expect(verifyLocalUploadToken(forged).ok).toBe(false);
  });

  it("weist fehlenden/leeren Token ab", () => {
    expect(verifyLocalUploadToken(undefined).reason).toBe("missing");
    expect(verifyLocalUploadToken("").reason).toBe("missing");
  });
});

describe("createUploadUrl + normalizeObjectEntityPath (local)", () => {
  let saved: Record<string, string | undefined>;
  const KEYS = ["ENCRYPTION_KEY", "STORAGE_DRIVER", "PRIVATE_OBJECT_DIR"] as const;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.ENCRYPTION_KEY = KEY;
    process.env.STORAGE_DRIVER = "local";
    process.env.PRIVATE_OBJECT_DIR = "/meinbucket/.private";
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("createUploadUrl liefert eine signierte /api/uploads/local/<id>-URL", async () => {
    const objectId = "11111111-2222-3333-4444-555555555555";
    const fullPath = `/meinbucket/.private/uploads/${objectId}`;
    const url = await localStorageDriver.createUploadUrl(fullPath, 900);
    expect(url.startsWith(`/api/uploads/local/${objectId}?token=`)).toBe(true);

    // Der Token in der URL verifiziert für genau diese objectId.
    const token = decodeURIComponent(new URL(url, "http://x").searchParams.get("token")!);
    const v = verifyLocalUploadToken(token);
    expect(v.ok).toBe(true);
    expect(v.objectId).toBe(objectId);
  });

  it("normalizeObjectEntityPath mappt die Upload-URL → /objects/uploads/<id>", () => {
    const objectId = "11111111-2222-3333-4444-555555555555";
    const svc = new ObjectStorageService();
    const uploadUrl = `/api/uploads/local/${objectId}?token=abc.def`;
    expect(svc.normalizeObjectEntityPath(uploadUrl)).toBe(`/objects/uploads/${objectId}`);
  });

  it("normalizeObjectEntityPath lässt GCS-URLs unverändert (Replit-Pfad intakt)", () => {
    const svc = new ObjectStorageService();
    const other = "https://example.com/whatever";
    expect(svc.normalizeObjectEntityPath(other)).toBe(other);
  });
});
