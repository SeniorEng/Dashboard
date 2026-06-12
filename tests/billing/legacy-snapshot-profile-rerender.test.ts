/**
 * Task #1087 — Bestandsrechnungen ohne `renderSnapshot.profile` re-rendern
 * byte-genau im historischen BASIC-ZUGFeRD-Profil (nicht EN 16931).
 *
 * Kontext
 * -------
 * Mit Task #1073 werden NEUE Rechnungen mit dem vollständigen EN-16931-Profil
 * versiegelt und der Modus pro Rechnung über `renderSnapshot.profile`
 * eingefroren (`"en16931"`). Bereits versendete/versiegelte Bestandsrechnungen
 * wurden VOR der EN-16931-Umstellung versiegelt — ihr Snapshot besitzt das Feld
 * `profile` NICHT. Aus GoBD-Gründen müssen diese Rechnungen byte-genau
 * unverändert bleiben: der Integritäts-Verifier re-rendert sie und vergleicht
 * ZUGFeRD-XML + pdf_hash. Fehlt das Feld, MUSS der Default `"basic"` gelten
 * (das historische Factur-X-BASIC-Profil), NICHT der neue EN-16931-Default.
 *
 * Genau wie beim Line-Aggregation-Default (Task #1084) gab es bisher keinen
 * Integrationstest, der dieses Verhalten festnagelt — ein künftiges Refactoring
 * könnte alte Rechnungen still als EN 16931 re-versiegeln und ihren
 * gespeicherten Integritäts-Hash brechen.
 *
 * Dieser Test simuliert exakt diesen Altbestand: eine Rechnung wird versiegelt
 * (Erst-Persist ⇒ `profile: "en16931"`, #1073-Default); aus dem versiegelten
 * Snapshot wird `profile` ENTFERNT (= Bestand vor #1073). Das Re-Render aus
 * diesem „legacy"-Snapshot wird verglichen mit:
 *
 *   1. einem expliziten `profile: "basic"`-Re-Render
 *      → MUSS byte-genau identisch sein (XML + PDF-Hash). Damit ist bewiesen,
 *        dass der Default des fehlenden Feldes BASIC ist.
 *   2. dem versiegelten EN-16931-Artefakt (pdf_hash / zugferd_xml)
 *      → MUSS sich unterscheiden. Damit ist der Test nicht trivial erfüllt:
 *        die beiden Profile erzeugen tatsächlich unterschiedliche Bytes.
 *
 * Zusätzlich wird die eingebettete ZUGFeRD-XML auf den Profil-Marker
 * (`GuidelineSpecifiedDocumentContextParameter`) geprüft: die BASIC-Form trägt
 * die `…factur-x.eu:1p0:basic`-Guideline, die EN-16931-Form die reine
 * `urn:cen.eu:en16931:2017`-Guideline ohne BASIC-Suffix.
 *
 * Würde der Default in `invoice-pdf-orchestrator.ts` still auf `"en16931"`
 * kippen, schlüge dieser Test fehl (legacy-Re-Render driftet gegen den
 * versiegelten BASIC-Referenz-Hash und gegen den Profil-Marker).
 *
 * Hinweis zur Isolation: Wie #1052 / #1084 liest dieser Test NIE das
 * gespeicherte Objekt zurück — er vergleicht IN-MEMORY-Re-Render-Hashes mit dem
 * in der (isolierten) DB versiegelten Hash und nutzt eindeutige
 * Rechnungsnummern.
 *
 * Hinweis Chromium: PDF-Tests in diesem Dev-Container brauchen
 * `PUPPETEER_SINGLE_PROCESS=0`, damit Chromium startet; in CI laufen sie ohne
 * Override.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { describe } from "../helpers/object-storage";
import { eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { invoices as invoicesTable, users, type InvoiceRenderSnapshot } from "@shared/schema";
import { storage } from "../../server/storage";
import {
  buildInvoicePdfBytes,
  persistInvoicePdf,
} from "../../server/services/invoice-pdf-orchestrator";
import { getCachedCompanySettings } from "../../server/services/cache";
import { computeDataHash } from "../../server/services/signature-integrity";
import { createInvoiceTx } from "../../server/storage/billing-storage";
import { apiPost, cleanupCustomer, getAuthCookie, runCleanup, uniqueId } from "../test-utils";

const YEAR = 2026;
const MONTH = 4;
const APPT_DATE = `${YEAR}-0${MONTH}-15`;

function uniqueInvoiceNumber(): string {
  return `RE-${YEAR}-T1087-${uniqueId()}`.replace(/[^a-z0-9_-]/gi, "_");
}

describe("Task #1087 — Snapshot ohne profile re-rendert byte-genau als BASIC", () => {
  let superadminId: number;
  let customerId: number;
  let invoiceId: number;
  const createdInvoiceIds: number[] = [];

  beforeAll(async () => {
    const auth = await getAuthCookie();
    const [admin] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.isSuperAdmin, true))
      .limit(1);
    superadminId = admin?.id ?? auth.user.id;

    const cust = await apiPost<{ id: number }>("/api/admin/customers", {
      vorname: "Legacy",
      nachname: `Profile-${uniqueId()}`,
      geburtsdatum: "1940-05-05",
      email: `legacy-profile-${uniqueId()}@test.local`,
      strasse: "Kassenweg",
      nr: "1",
      plz: "01067",
      stadt: "Dresden",
      telefon: "+4917600000030",
      pflegegrad: 3,
      pflegegradSeit: "2024-01-01",
      billingType: "pflegekasse_gesetzlich",
      acceptsPrivatePayment: false,
      beihilfeBerechtigt: false,
    });
    expect(cust.status, `create customer: ${JSON.stringify(cust.data)}`).toBe(201);
    customerId = cust.data.id;

    const inv = await db.transaction(async (tx) =>
      createInvoiceTx(
        tx,
        {
          invoiceNumber: uniqueInvoiceNumber(),
          customerId,
          billingType: "pflegekasse_gesetzlich",
          invoiceType: "rechnung",
          billingMonth: MONTH,
          billingYear: YEAR,
          recipientName: "Pflegekasse Test",
          recipientAddress: "Empfängerweg 1, 01067 Dresden",
          customerName: "Legacy Profile",
          pflegegrad: 3,
          netAmountCents: 5000,
          vatAmountCents: 0,
          grossAmountCents: 5000,
          vatRate: 0,
          status: "entwurf",
          budgetType: "entlastungsbetrag_45b",
        },
        [
          {
            appointmentId: null,
            appointmentDate: APPT_DATE,
            serviceDescription: "Alltagsbegleitung",
            serviceCode: "alltagsbegleitung",
            durationMinutes: 30,
            unitPriceCents: 5000,
            totalCents: 5000,
            employeeName: "Erik",
          },
        ],
        superadminId,
      ),
    );
    createdInvoiceIds.push(inv.id);
    invoiceId = inv.id;

    // Versiegeln: schreibt pdf_hash / zugferd_xml (EN 16931, #1073-Default) und
    // friert den Snapshot inkl. `profile: "en16931"` + pdfCreationDate ein.
    await persistInvoicePdf(invoiceId);
  }, 180_000);

  afterAll(async () => {
    for (const id of createdInvoiceIds) {
      try {
        await db.delete(invoicesTable).where(eq(invoicesTable.id, id));
      } catch {
        /* best-effort */
      }
    }
    await cleanupCustomer(customerId);
    await runCleanup();
  });

  it("Snapshot ohne profile == explizit basic (byte-genau) und ≠ versiegeltes EN 16931", async () => {
    const invoice = await storage.getInvoice(invoiceId);
    expect(invoice, "Rechnung muss existieren").toBeTruthy();
    expect(invoice!.pdfHash, "pdf_hash muss versiegelt sein").toBeTruthy();
    expect(invoice!.zugferdXml, "zugferd_xml muss versiegelt sein").toBeTruthy();
    expect(invoice!.renderSnapshot, "render_snapshot muss versiegelt sein").toBeTruthy();

    const companySettings = await getCachedCompanySettings();
    expect(companySettings, "company_settings muss geseedet sein").toBeTruthy();

    const sealed = invoice!.renderSnapshot as InvoiceRenderSnapshot;
    expect(sealed.pdfCreationDate, "pdfCreationDate muss eingefroren sein").toBeTruthy();
    expect(sealed.profile, "Erst-Persist versiegelt EN 16931 (#1073)").toBe("en16931");

    // (A) Altbestand simulieren: identischer Snapshot OHNE `profile`.
    const legacySnapshot = { ...sealed } as InvoiceRenderSnapshot;
    delete (legacySnapshot as { profile?: unknown }).profile;
    expect(
      (legacySnapshot as { profile?: unknown }).profile,
      "legacy-Snapshot darf das Feld nicht mehr tragen",
    ).toBeUndefined();

    // (B) Referenz: derselbe Snapshot, aber explizit basic.
    const explicitBasic = { ...sealed, profile: "basic" } as InvoiceRenderSnapshot;

    const legacy = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot: legacySnapshot });
    const explicit = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot: explicitBasic });

    const legacyPdfHash = computeDataHash(legacy.pdf as unknown as string);
    const explicitPdfHash = computeDataHash(explicit.pdf as unknown as string);

    // 1) Fehlendes Feld == explizit basic, byte-genau (XML + PDF).
    expect(legacyPdfHash, "fehlendes profile muss das basic-PDF reproduzieren").toBe(explicitPdfHash);
    expect(legacy.xml, "fehlendes profile muss die basic-XML reproduzieren").toBe(explicit.xml);
    expect(legacy.zugferdProfile, "fehlendes profile muss als basic aufgelöst werden").toBe("basic");

    // 2) Nicht-trivial: BASIC ≠ versiegelt-EN-16931 (sonst wäre der Test
    //    bedeutungslos, weil beide Profile dasselbe lieferten).
    expect(legacyPdfHash, "BASIC darf NICHT dem versiegelten EN-16931-Hash entsprechen").not.toBe(
      invoice!.pdfHash,
    );
    expect(legacy.xml, "BASIC-XML darf NICHT der versiegelten EN-16931-XML entsprechen").not.toBe(
      invoice!.zugferdXml,
    );

    // 3) Profil-Marker sichtbar: BASIC trägt die factur-x-BASIC-Guideline.
    expect(legacy.xml, "BASIC-XML muss vorhanden sein").toBeTruthy();
    expect(legacy.xml!, "BASIC-XML trägt die factur-x-BASIC-Guideline").toContain(
      "factur-x.eu:1p0:basic",
    );

    // 4) Gegenprobe: das versiegelte EN-16931-Re-Render reproduziert den
    //    versiegelten Hash byte-genau und trägt NICHT die BASIC-Guideline.
    const en16931 = await buildInvoicePdfBytes(invoice!, companySettings, { snapshot: sealed });
    expect(en16931.zugferdProfile, "versiegelter Snapshot bleibt EN 16931").toBe("en16931");
    expect(
      computeDataHash(en16931.pdf as unknown as string),
      "EN-16931-Re-Render reproduziert den versiegelten Hash",
    ).toBe(invoice!.pdfHash);
    expect(en16931.xml, "EN-16931-Re-Render reproduziert die versiegelte XML").toBe(
      invoice!.zugferdXml,
    );
    expect(en16931.xml!, "EN-16931-XML trägt NICHT die BASIC-Guideline").not.toContain(
      "factur-x.eu:1p0:basic",
    );
  }, 180_000);
});
