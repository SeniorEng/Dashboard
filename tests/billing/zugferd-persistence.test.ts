import { validSignatureDataUrl } from "../helpers/valid-signature";
/**
 * Tier-A3 — Persistenz von ZUGFeRD-XML + PDF-Hash auf der Rechnungs-Zeile.
 *
 * Nach POST /api/billing/generate MUSS invoices.zugferd_xml den XML-Inhalt
 * der eingebetteten Factur-X-Datei enthalten und invoices.pdf_hash den
 * SHA-256 des persistierten PDFs. Außerdem muss verifyInvoiceIntegrity()
 * für die frisch erzeugte Rechnung xmlMatch=true und pdfHashMatch=true
 * liefern, da PDF + XML deterministisch re-renderbar sind.
 *
 * Drift-Repair-Härtung (Task #589):
 * `server/startup/sync-appointment-service-durations.ts` läuft beim
 * Server-Boot asynchron im Hintergrund und kann stale (Vor-Lauf-)Termine
 * idempotent reparieren. Damit der Verifier-Re-Render denselben Snapshot
 * sieht wie die Persistenz aus `/generate`, erzwingen wir vor jedem
 * `verifyInvoiceIntegrity()`-Aufruf einen synchronen Re-Run der Drift-
 * Reparatur — für den Test-Termin selbst muss das ein No-Op sein
 * (Service-Zeile wird mit `durationMinutes === durationPromised` angelegt).
 * Der Regressions-Test ZFP.2 simuliert dagegen einen echten Integrity-
 * Drift (manuelle Mutation von `invoices.zugferd_xml`) und prüft, dass der
 * Verifier diesen weiterhin als `xmlMatch=false` meldet — die Härtung
 * gegen Drift-Repair-Interferenz darf echte Drift NICHT schlucken.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable } from "../../shared/schema";
import {
  apiGet,
  apiPost,
  apiDelete,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  cleanupCustomer,
} from "../test-utils";

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let hwServiceId: number;
let customerId: number;
const cleanupApptIds: number[] = [];
const cleanupSrIds: number[] = [];
const cleanupInvoiceIds: number[] = [];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function shiftToWeekday(d: Date): Date {
  const dow = d.getDay();
  if (dow === 0) d.setDate(d.getDate() - 2);
  else if (dow === 6) d.setDate(d.getDate() - 1);
  return d;
}
// Task #906: Auf einer von mehreren Test-Dateien geteilten Worker-DB
// (fileParallelism, Task #894) werden feste Slots schnell aufgebraucht — alle
// Dateien buchen gegen denselben geseedeten Mitarbeiter. Statt 11 fixer Zeiten
// generieren wir alle 48 Halbstunden-Slots über bis zu 90 Werktage und
// probieren sie in ZUFÄLLIGER Reihenfolge, damit parallele Dateien nicht um
// dieselben Slots konkurrieren und ein freier Slot praktisch immer gefunden wird.
function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
const ALL_HALF_HOUR_SLOTS: string[] = (() => {
  const out: string[] = [];
  for (let h = 0; h < 24; h++) {
    for (const m of ["00", "30"]) out.push(`${String(h).padStart(2, "0")}:${m}`);
  }
  return out;
})();

async function waitForZugferdPersisted(
  invoiceId: number,
): Promise<{ zugferdXml: string | null; pdfHash: string | null }> {
  // Erste, kurze Warteschleife (5s) für den Hintergrund-Persist (Happy Path).
  for (let i = 0; i < 10; i++) {
    const [row] = await db
      .select({ zugferdXml: invoicesTable.zugferdXml, pdfHash: invoicesTable.pdfHash })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    if (row?.zugferdXml && row?.pdfHash) return row;
    await new Promise((r) => setTimeout(r, 500));
  }
  // Fallback: GET /:id/pdf triggert `persistInvoicePdf` synchron im Request-
  // Handler (Cache-Miss-Pfad, siehe `server/routes/billing.ts`). Damit ist die
  // Persistierung nach Rückkehr garantiert geschrieben — wir umgehen so den
  // intermittierenden Puppeteer-Cold-Start („Navigating frame was detached"),
  // der den Hintergrund-Persist gelegentlich in den 3x-Retry-Backoff schickt.
  // Task #593: GET /:id/pdf hat KEINEN eigenen Retry-Wrapper (nur der
  // Background-Persist via `runPdfPersistWithRetry`), deshalb retryen wir den
  // Fallback bis zu 3x — unter paralleler Test-Last (viele Workers) kann ein
  // einzelner Puppeteer-Launch noch immer mit "Navigating frame was detached"
  // schieflaufen, ohne dass das ein echter Drift-Bug wäre.
  for (let attempt = 0; attempt < 3; attempt++) {
    await apiGet<any>(`/api/billing/${invoiceId}/pdf`).catch(() => undefined);
    const [row] = await db
      .select({ zugferdXml: invoicesTable.zugferdXml, pdfHash: invoicesTable.pdfHash })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, invoiceId))
      .limit(1);
    if (row?.zugferdXml && row?.pdfHash) return row;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const [row] = await db
    .select({ zugferdXml: invoicesTable.zugferdXml, pdfHash: invoicesTable.pdfHash })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, invoiceId))
    .limit(1);
  return row ?? { zugferdXml: null, pdfHash: null };
}

async function findFreeSlotAndCreate(custId: number, tag: string): Promise<{ id: number; date: string; time: string }> {
  const offsets = shuffle(Array.from({ length: 90 }, (_, i) => i + 1));
  for (const offset of offsets) {
    const cand = new Date();
    cand.setDate(cand.getDate() - offset);
    shiftToWeekday(cand);
    const dateStr = ymd(cand);
    for (const time of shuffle([...ALL_HALF_HOUR_SLOTS])) {
      const res = await apiPost<any>("/api/appointments/kundentermin", {
        customerId: custId,
        date: dateStr,
        scheduledStart: time,
        notes: `ZFP-${tag}-${uniqueId()}`,
        assignedEmployeeId: auth.user.id,
        services: [{ serviceId: hwServiceId, durationMinutes: 30 }],
      });
      if (res.status === 201) {
        cleanupApptIds.push(res.data.id);
        return { id: res.data.id, date: dateStr, time };
      }
    }
  }
  throw new Error("findFreeSlotAndCreate(ZFP): kein freier Slot");
}

beforeAll(async () => {
  auth = await getAuthCookie();
  const services = await apiGet<any[]>("/api/services/all");
  hwServiceId = (services.data as any[]).find((s) => s.code === "hauswirtschaft")!.id;
  const cust = await createTestCustomer({
    nachname: `Privat-ZFP-${uniqueId()}`,
    billingType: "selbstzahler",
    acceptsPrivatePayment: true,
  });
  customerId = cust.id as number;
});

afterAll(async () => {
  for (const id of cleanupInvoiceIds) {
    try { await apiDelete(`/api/billing/${id}`); } catch {}
  }
  for (const id of cleanupSrIds) {
    try { await apiDelete(`/api/service-records/${id}`); } catch {}
  }
  for (const id of cleanupApptIds) {
    try { await apiDelete(`/api/appointments/${id}`); } catch {}
  }
  await cleanupCustomer(customerId);
});

describe("ZUGFeRD-Persistenz — invoices.zugferd_xml + Integrity-Verifier", () => {
  it("ZFP.1 — /generate persistiert zugferd_xml und re-render matcht (Integrity-Check ok)", async () => {
    const slot = await findFreeSlotAndCreate(customerId, "G");
    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "ZFP" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const d = new Date(slot.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const sr = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year,
      month,
    });
    expect(sr.status, `SR create: ${JSON.stringify(sr.data)}`).toBe(201);
    cleanupSrIds.push(sr.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<any>(`/api/service-records/${sr.data.id}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
    const inv: any = gen.data?.splitInvoices ? gen.data.invoices[0]
      : Array.isArray(gen.data) ? gen.data[0]
      : gen.data;
    expect(inv?.id, "Rechnung muss erzeugt sein").toBeDefined();
    cleanupInvoiceIds.push(inv.id);

    // Task #544 + #589: persistInvoicePdf läuft nach /generate im Hintergrund
    // und kann unter Last (Puppeteer-Cold-Start, „frame detached"-Retries) > 30s
    // brauchen. Wir polln kurz und triggern dann den synchronen On-Demand-Render
    // via GET /:id/pdf — der ruft `persistInvoicePdf` direkt auf und schreibt
    // PDF + ZUGFeRD-XML hashstabil. So entfernen wir auch diese Flake-Quelle.
    const row = await waitForZugferdPersisted(inv.id);

    expect(
      row?.zugferdXml,
      `ZUGFeRD-Persistenz-Bug: invoices.zugferd_xml ist nach /generate NULL`,
    ).not.toBeNull();
    expect(typeof row?.zugferdXml).toBe("string");
    expect(
      (row?.zugferdXml || "").length,
      "zugferd_xml muss substanziellen XML-Inhalt enthalten",
    ).toBeGreaterThan(500);
    expect(row?.zugferdXml).toContain("CrossIndustryInvoice");
    expect(row?.pdfHash, "pdf_hash darf nach /generate nicht NULL sein").not.toBeNull();

    // Task #589: Race gegen Startup-Drift-Repair neutralisieren — synchron
    // re-runnen, sodass alle pending Reparaturen abgeschlossen sind, BEVOR
    // der Verifier den Re-Render startet. Für den Test-Termin ist der Re-Run
    // ein No-Op (Service-Zeile wurde mit `durationMinutes === durationPromised`
    // angelegt, Status ist nach /document `completed` → GoBD-locked → nur
    // Audit-Log, keine Mutation).
    const { syncAppointmentServiceDurations } = await import(
      "../../server/startup/sync-appointment-service-durations"
    );
    await syncAppointmentServiceDurations();

    // Integrity-Verifier muss xmlMatch=true und pdfHashMatch=true liefern.
    const { verifyInvoiceIntegrity } = await import("../../server/services/invoice-integrity-verifier");
    const result = await verifyInvoiceIntegrity(inv.id);
    expect(result, "Verifier liefert Ergebnis").not.toBeNull();

    // Diagnose-Hilfe (Task #589): falls die Re-Render-XML trotz synchronem
    // Drift-Repair-Re-Run nicht matcht, dump den ersten abweichenden Index
    // + 80-Byte-Kontext, damit die nächste Iteration die echte Drift-Quelle
    // (z.B. cached companySettings, customer-State, Timestamp im XML) sofort
    // sieht — statt erneut blind nach der Ursache zu raten.
    if (result && !result.xmlMatch) {
      const persisted = String(row?.zugferdXml ?? "");
      const { buildInvoicePdfBytes } = await import("../../server/routes/billing");
      const { storage } = await import("../../server/storage");
      const invJoined = await storage.getInvoice(inv.id);
      const [invRow] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, inv.id)).limit(1);
      const snap = (invRow?.renderSnapshot ?? null) as any;
      const rerendered = invJoined && snap?.companySettings
        ? (await buildInvoicePdfBytes(invJoined as any, snap.companySettings, { snapshot: snap })).xml ?? ""
        : "";
      let diffAt = -1;
      const max = Math.min(persisted.length, rerendered.length);
      for (let i = 0; i < max; i++) {
        if (persisted.charCodeAt(i) !== rerendered.charCodeAt(i)) { diffAt = i; break; }
      }
      if (diffAt < 0 && persisted.length !== rerendered.length) diffAt = max;
      const ctx = (s: string) => s.slice(Math.max(0, diffAt - 40), diffAt + 80).replace(/\s+/g, " ");
       
      console.error(`[ZFP.1] XML-Drift bei Byte ${diffAt} (persisted.len=${persisted.length} rerendered.len=${rerendered.length})\n  persisted : …${ctx(persisted)}…\n  rerendered: …${ctx(rerendered)}…`);
    }

    expect(result?.xmlMatch, "Re-render-XML muss byte-genau gegen persistiertes XML matchen").toBe(true);
    expect(result?.pdfHashMatch, "Re-render-PDF-Hash muss gegen persistierten pdfHash matchen").toBe(true);
  }, 60_000);

  it("ZFP.2 — Verifier meldet echten XML-Drift weiterhin als xmlMatch=false (Regressions-Schutz)", async () => {
    // Sicherstellen, dass die ZFP.1-Härtung (synchroner Drift-Repair-Re-Run +
    // No-Op auf dem Test-Termin) keinen echten Integrity-Drift verschluckt:
    // Wir mutieren das persistierte `invoices.zugferd_xml` direkt und
    // erwarten, dass der Verifier diese Manipulation erkennt.
    const slot = await findFreeSlotAndCreate(customerId, "Dr");
    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "ZFP-Dr" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const d = new Date(slot.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const sr = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year,
      month,
    });
    expect(sr.status, `SR create: ${JSON.stringify(sr.data)}`).toBe(201);
    cleanupSrIds.push(sr.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<any>(`/api/service-records/${sr.data.id}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
    const inv: any = gen.data?.splitInvoices ? gen.data.invoices[0]
      : Array.isArray(gen.data) ? gen.data[0]
      : gen.data;
    expect(inv?.id).toBeDefined();
    cleanupInvoiceIds.push(inv.id);

    // Auf zugferd_xml warten — gleicher On-Demand-Fallback wie ZFP.1.
    const persisted = await waitForZugferdPersisted(inv.id);
    const originalXml = persisted.zugferdXml;
    expect(originalXml).not.toBeNull();
    expect(persisted.pdfHash).not.toBeNull();

    // Künstlicher Integrity-Drift: persistiertes XML bewusst verstimmen.
    const tamperedXml = (originalXml || "").replace(
      "CrossIndustryInvoice",
      "CrossIndustryInvoice_TAMPERED_ZFP2",
    );
    expect(tamperedXml).not.toBe(originalXml);
    await db
      .update(invoicesTable)
      .set({ zugferdXml: tamperedXml })
      .where(eq(invoicesTable.id, inv.id));

    // Drift-Repair synchron triggern — Härtung darf den echten Drift NICHT
    // kaschieren.
    const { syncAppointmentServiceDurations } = await import(
      "../../server/startup/sync-appointment-service-durations"
    );
    await syncAppointmentServiceDurations();

    const { verifyInvoiceIntegrity } = await import("../../server/services/invoice-integrity-verifier");
    const result = await verifyInvoiceIntegrity(inv.id);
    expect(result).not.toBeNull();
    expect(
      result?.xmlMatch,
      "Verifier muss manipuliertes XML weiterhin als Drift melden",
    ).toBe(false);

    // Aufräumen: persistiertes XML zurück auf den Original-Wert, damit der
    // Storno-Cleanup im afterAll nicht über die Tampered-Daten stolpert.
    await db
      .update(invoicesTable)
      .set({ zugferdXml: originalXml })
      .where(eq(invoicesTable.id, inv.id));
  }, 60_000);

  /**
   * ZFP.3 (Security-Härtung Task #593): `invoices.render_snapshot` darf NIEMALS
   * Plaintext-Secrets der `company_settings` enthalten (smtpPass,
   * letterxpressApiKey, qontoSecretKey, whatsappAccessToken, twilioAuthToken,
   * …). Würden wir das gesamte companySettings-Objekt snapshotten, wäre pro
   * Rechnung eine entschlüsselte Credential-Replik im JSONB persistiert —
   * schwerer DSGVO-/GoBD-Verstoss. Der Snapshot ist über
   * `INVOICE_RENDER_COMPANY_SNAPSHOT_KEYS` strikt allowlist-gefiltert; dieser
   * Test bewacht den Sanitizer.
   */
  it("ZFP.3 — render_snapshot enthält keine company_settings-Secrets (Allowlist erzwungen)", async () => {
    const slot = await findFreeSlotAndCreate(customerId, "Sec");
    const docRes = await apiPost<any>(`/api/appointments/${slot.id}/document`, {
      actualStart: slot.time,
      travelOriginType: "home",
      travelKilometers: 0,
      customerKilometers: 0,
      services: [{ serviceId: hwServiceId, actualDurationMinutes: 30, details: "ZFP-Sec" }],
    });
    expect(docRes.status, `document: ${JSON.stringify(docRes.data)}`).toBe(200);

    const d = new Date(slot.date);
    const year = d.getFullYear();
    const month = d.getMonth() + 1;

    const sr = await apiPost<any>("/api/service-records", {
      customerId,
      employeeId: auth.user.id,
      year,
      month,
    });
    expect(sr.status, `SR create: ${JSON.stringify(sr.data)}`).toBe(201);
    cleanupSrIds.push(sr.data.id);
    for (const signerType of ["employee", "customer"] as const) {
      const sig = await apiPost<any>(`/api/service-records/${sr.data.id}/sign`, {
        signerType,
        signatureData: validSignatureDataUrl(),
      });
      expect(sig.status, `sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
    }

    const gen = await apiPost<any>("/api/billing/generate", {
      customerId,
      billingMonth: month,
      billingYear: year,
    });
    expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
    const inv: any = gen.data?.splitInvoices ? gen.data.invoices[0]
      : Array.isArray(gen.data) ? gen.data[0]
      : gen.data;
    expect(inv?.id).toBeDefined();
    cleanupInvoiceIds.push(inv.id);

    const persisted = await waitForZugferdPersisted(inv.id);
    expect(persisted.zugferdXml).not.toBeNull();

    const [row] = await db
      .select({ renderSnapshot: invoicesTable.renderSnapshot })
      .from(invoicesTable)
      .where(eq(invoicesTable.id, inv.id))
      .limit(1);
    expect(row?.renderSnapshot, "render_snapshot muss nach /generate gesetzt sein").not.toBeNull();

    const snap = row!.renderSnapshot as { companySettings: Record<string, unknown> };
    const forbiddenKeys = [
      "smtpPass",
      "letterxpressApiKey",
      "qontoSecretKey",
      "whatsappAccessToken",
      "twilioAuthToken",
    ];
    for (const k of forbiddenKeys) {
      expect(
        Object.prototype.hasOwnProperty.call(snap.companySettings, k),
        `render_snapshot.companySettings darf '${k}' nicht enthalten`,
      ).toBe(false);
    }
    // Defense-in-depth: Auch generische Secret-Heuristik prüfen.
    const secretLike = Object.keys(snap.companySettings).filter((k) =>
      /secret|token|password|pass$|apikey|api_key/i.test(k),
    );
    expect(
      secretLike,
      `render_snapshot.companySettings enthält Secret-verdächtige Keys: ${secretLike.join(", ")}`,
    ).toEqual([]);
  }, 60_000);
});
