import { describe, it, expect } from "vitest";
import {
  buildSignatureImg,
  getDocumentPdfBuffer,
  stripReservedRawHtmlPlaceholders,
} from "../server/services/document-pdf";
import { AppError } from "../server/lib/errors";
import { renderTemplate } from "../server/services/template-engine";

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const VALID_PNG = `data:image/png;base64,${PNG_HEADER.toString("base64")}`;

describe("buildSignatureImg", () => {
  it("renders a valid PNG data URL as an <img> tag", () => {
    const html = buildSignatureImg(VALID_PNG, "Kundenunterschrift", 240);
    expect(html).toBe(`<img src="${VALID_PNG}" alt="Kundenunterschrift" style="max-height:240px;" />`);
  });

  it("escapes a script-injection attempt instead of emitting raw HTML", () => {
    const attack = `"><script>alert(1)</script>`;
    const html = buildSignatureImg(attack, "Kundenunterschrift", 240);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("rejects a non-data URL", () => {
    const html = buildSignatureImg("https://evil.example/x.png", "x", 60);
    expect(html).not.toContain("<img");
    expect(html).toBe("https://evil.example/x.png".replace(/&/g, "&amp;"));
  });

  it("rejects a PNG mime type with non-PNG magic bytes", () => {
    const fakeBytes = Buffer.from("not a png at all").toString("base64");
    const fake = `data:image/png;base64,${fakeBytes}`;
    const html = buildSignatureImg(fake, "x", 60);
    expect(html).not.toContain("<img");
  });

  it("rejects SVG signatures entirely (no SSRF surface)", () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`).toString("base64");
    const html = buildSignatureImg(`data:image/svg+xml;base64,${svg}`, "x", 60);
    expect(html).not.toContain("<img");
  });

  it("rejects SVG with embedded <script> and external href", () => {
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><image xlink:href="http://evil/x.png"/><script>alert(1)</script></svg>`).toString("base64");
    const html = buildSignatureImg(`data:image/svg+xml;base64,${svg}`, "x", 60);
    expect(html).not.toContain("<img");
  });
});

describe("stripReservedRawHtmlPlaceholders", () => {
  it("removes reserved raw-HTML keys from caller-supplied overrides", () => {
    const result = stripReservedRawHtmlPlaceholders({
      customer_signature: "<script>alert(1)</script>",
      employee_signature: "<img src=x onerror=alert(1)>",
      company_logo: "<svg onload=alert(1)></svg>",
      kunden_name: "Mustermann",
    });
    expect(result).not.toHaveProperty("customer_signature");
    expect(result).not.toHaveProperty("employee_signature");
    expect(result).not.toHaveProperty("company_logo");
    expect(result.kunden_name).toBe("Mustermann");
  });

  it("guarantees that attacker-supplied placeholders cannot emit raw HTML through renderTemplate", () => {
    const overrides = stripReservedRawHtmlPlaceholders({
      customer_signature: "<script>alert('xss')</script>",
    });
    const html = renderTemplate(
      "<div>Sig: {{customer_signature}}</div>",
      overrides as Record<string, string>,
    );
    expect(html).not.toContain("<script>");
    expect(html).toBe("<div>Sig: </div>");
  });
});

describe("getDocumentPdfBuffer path traversal protection", () => {
  async function expectBadRequest(objectPath: string) {
    let caught: unknown;
    try {
      await getDocumentPdfBuffer(objectPath);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).statusCode).toBe(400);
    expect((caught as AppError).message).toContain("Ungültiger Objekt-Pfad");
  }

  it("rejects ../ traversal in /objects/ paths with HTTP 400", async () => {
    await expectBadRequest("/objects/../../../etc/passwd");
  });

  it("rejects embedded traversal that normalizes to escape /objects/", async () => {
    await expectBadRequest("/objects/foo/../../etc/passwd");
  });

  it("rejects empty object id with HTTP 400", async () => {
    await expectBadRequest("/objects/");
  });
});
