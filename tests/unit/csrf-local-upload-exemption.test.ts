/**
 * Task #1840 — Sicherheits-Test für die CSRF-Ausnahme des lokalen Upload-
 * Endpoints. Die Ausnahme MUSS eng gescoped sein: nur Methode PUT, nur der
 * `/uploads/local/`-Pfad, nur bei GÜLTIGEM HMAC-Token. Jeder andere Fall MUSS
 * der normalen CSRF-Prüfung unterliegen (403 ohne Cookie/Header).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request, Response } from "express";
import { csrfProtection } from "../../server/middleware/csrf";
import { signLocalUploadToken } from "../../server/lib/storage/local-upload-token";

const KEY = "0".repeat(64);

function mockReq(over: Partial<Request> & { method: string; path: string }): Request {
  return {
    query: {},
    cookies: {},
    headers: {},
    ...over,
  } as unknown as Request;
}

function mockRes(): { res: Response; status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const res = { status } as unknown as Response;
  return { res, status, json };
}

describe("CSRF-Ausnahme für lokalen Upload (Task #1840)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.ENCRYPTION_KEY;
    else process.env.ENCRYPTION_KEY = savedKey;
  });

  it("PUT /uploads/local/<id> mit GÜLTIGEM Token → next() (CSRF übersprungen)", () => {
    const oid = "11111111-2222-3333-4444-555555555555";
    const token = signLocalUploadToken({ objectId: oid });
    const req = mockReq({ method: "PUT", path: `/uploads/local/${oid}`, query: { token } });
    const { res, status } = mockRes();
    const next = vi.fn();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(status).not.toHaveBeenCalled();
  });

  it("PUT mit UNGÜLTIGEM Token → 403 (Ausnahme greift NICHT)", () => {
    const req = mockReq({
      method: "PUT",
      path: "/uploads/local/11111111-2222-3333-4444-555555555555",
      query: { token: "garbage.sig" },
    });
    const { res, status, json } = mockRes();
    const next = vi.fn();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ error: "CSRF_TOKEN_MISSING" }));
  });

  it("PUT ohne Token → 403", () => {
    const req = mockReq({
      method: "PUT",
      path: "/uploads/local/11111111-2222-3333-4444-555555555555",
    });
    const { res, status } = mockRes();
    const next = vi.fn();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("POST (statt PUT) auf denselben Pfad mit gültigem Token → 403 (method-gescoped)", () => {
    const oid = "11111111-2222-3333-4444-555555555555";
    const token = signLocalUploadToken({ objectId: oid });
    const req = mockReq({ method: "POST", path: `/uploads/local/${oid}`, query: { token } });
    const { res, status } = mockRes();
    const next = vi.fn();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("kein pauschaler Bypass: PUT auf anderer Pfad mit gültigem Upload-Token → 403", () => {
    const token = signLocalUploadToken({ objectId: "11111111-2222-3333-4444-555555555555" });
    const req = mockReq({ method: "PUT", path: "/admin/users/7", query: { token } });
    const { res, status } = mockRes();
    const next = vi.fn();
    csrfProtection(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });

  it("GET bleibt safe-method (next, unabhängig vom Pfad)", () => {
    const req = mockReq({ method: "GET", path: "/uploads/local/whatever" });
    const { res } = mockRes();
    const next = vi.fn();
    csrfProtection(req, res, next);
    expect(next).toHaveBeenCalledOnce();
  });
});
