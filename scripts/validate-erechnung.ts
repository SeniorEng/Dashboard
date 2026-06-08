/**
 * Task #1073 — Offizielles E-Rechnungs-Validierungs-Gate.
 *
 * Aufruf:  npm run validate:erechnung
 *
 * Was es macht:
 *   1. Erzeugt eine BEISPIEL-EN-16931-(COMFORT)-ZUGFeRD/Factur-X-Rechnung als
 *      PDF/A-3 — OHNE Chromium: node-zugferd bettet die XML in ein leeres,
 *      mit pdf-lib erzeugtes Trägerdokument ein. So testet das Gate exakt die
 *      Library-Pipeline (`buildZugferdData` → node-zugferd `embedInPdf`), die
 *      auch der Produktivpfad (`server/lib/zugferd.ts`) nutzt.
 *   2. Validiert das Ergebnis mit den OFFIZIELLEN Prüfwerkzeugen, sofern
 *      vorhanden:
 *        - Mustang/KoSIT (EN-16931-Schematron + ZUGFeRD-Konformität)
 *        - veraPDF (PDF/A-3b-Konformität)
 *      Beide sind Java-Tools. Ist KEINE Java-Runtime auffindbar, ÜBERSPRINGT
 *      das Gate sich sauber (Exit 0) statt hart zu failen — damit der lokale
 *      Dev-Container (kein Java) `npm run validate:erechnung` aufrufen kann,
 *      ohne zu brechen. Die verbindliche Prüfung läuft im CI-Job
 *      `erechnung-validation` (installiert Java + lädt die Validator-JARs).
 *
 * Konfiguration (Env, optional):
 *   MUSTANG_CLI_JAR   Pfad zur Mustang-CLI-JAR (z.B. Mustang-CLI-x.y.z.jar).
 *                     Fehlt der Pfad → Mustang-Check übersprungen.
 *   VERAPDF_CLI       Pfad zur veraPDF-Executable (z.B. .../verapdf).
 *                     Fehlt der Pfad → veraPDF-Check übersprungen.
 *   ERECHNUNG_REQUIRE_VALIDATORS  "1" erzwingt, dass BEIDE Validatoren
 *                     vorhanden sein MÜSSEN (sonst Exit 1). Wird im CI gesetzt,
 *                     damit ein versehentlich fehlender Validator nicht still
 *                     durchläuft. Lokal ungesetzt = graceful skip.
 *
 * Exit-Codes:
 *   0 = OK (oder sauber übersprungen, weil Java/Validatoren fehlen und
 *           ERECHNUNG_REQUIRE_VALIDATORS != "1")
 *   1 = Ein konfigurierter Validator hat die Beispielrechnung als NICHT
 *       konform gemeldet (oder ein erzwungener Validator fehlt / Java fehlt
 *       trotz ERECHNUNG_REQUIRE_VALIDATORS=1).
 *   2 = Die Beispiel-PDF/A-3 konnte gar nicht erst erzeugt werden (Pipeline-
 *       Defekt — das ist immer ein echter Fehler, auch ohne Java).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { embedZugferdXml, DEFAULT_ZUGFERD_PROFILE } from "../server/lib/zugferd";
import type { InvoicePdfData } from "../server/lib/pdf-generator";

const LOG = "[validate-erechnung]";
const REQUIRE = process.env.ERECHNUNG_REQUIRE_VALIDATORS === "1";

function buildSampleInvoiceData(): InvoicePdfData {
  return {
    invoiceNumber: "MUSTER-2026-0001",
    invoiceDate: "15.01.2026",
    invoiceDueDate: "29.01.2026",
    invoiceType: "pflegekasse_gesetzlich",
    billingYear: 2026,
    billingMonth: 1,
    companyName: "Pflegedienst Muster GmbH",
    companyAddress: "Musterstraße 1\n10115 Berlin",
    iban: "DE89370400440532013000",
    bic: "COBADEFFXXX",
    ikNummer: "123456789",
    ustId: "",
    steuernummer: "",
    insuranceIkNummer: "987654321",
    versichertennummer: "A123456789",
    recipientName: "AOK Nordost",
    recipientAddress: "Wilhelmstraße 1\n10963 Berlin",
    customerName: "Max Mustermann",
    customerGeburtsdatum: "1940-03-15",
    pflegegrad: 3,
    buyerReference: null,
    assignmentDeclarationDate: null,
    assignmentDeclarationRef: null,
    netAmountCents: 12045,
    vatAmountCents: 0,
    grossAmountCents: 12045,
    vatRate: 0,
    lineItems: [
      {
        appointmentId: 101,
        appointmentDate: "2026-01-05",
        startTime: "09:00",
        endTime: "10:00",
        serviceCode: "hauswirtschaft",
        serviceDescription: "Hauswirtschaft",
        durationMinutes: 60,
        quantityRaw: 1,
        quantityUnit: "hours",
        unitPriceCents: 4500,
        totalCents: 4500,
        employeeName: "Anna Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
      {
        appointmentId: 102,
        appointmentDate: "2026-01-12",
        startTime: "11:00",
        endTime: "12:30",
        serviceCode: "alltagsbegleitung",
        serviceDescription: "Alltagsbegleitung",
        durationMinutes: 90,
        quantityRaw: 1.5,
        quantityUnit: "hours",
        unitPriceCents: 5030,
        totalCents: 7545,
        employeeName: "Bernd Beispiel",
        appointmentNotes: null,
        serviceDetails: null,
      },
    ],
    appointments: [],
    signatures: [],
  } as unknown as InvoicePdfData;
}

/** Leeres A4-Trägerdokument (kein Chromium nötig). */
async function buildCarrierPdf(invoiceNumber: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595.28, 841.89]); // A4 in pt
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText(`Beispiel-Rechnung ${invoiceNumber}`, { x: 56, y: 780, size: 16, font });
  page.drawText("Trägerdokument für die ZUGFeRD/Factur-X EN-16931 Validierung.", { x: 56, y: 752, size: 10, font });
  // Eingefrorenes Erzeugungsdatum → deterministisch (für reproduzierbare Läufe).
  const frozen = new Date("2026-01-15T00:00:00.000Z");
  doc.setCreationDate(frozen);
  doc.setModificationDate(frozen);
  return Buffer.from(await doc.save());
}

function hasJava(): boolean {
  const r = spawnSync("java", ["-version"], { stdio: "pipe" });
  return r.status === 0 || (r.error == null && r.status != null);
}

function runMustang(jar: string, pdfPath: string): boolean {
  console.log(`${LOG} Mustang: validiere ${pdfPath} mit ${jar} ...`);
  const r = spawnSync("java", ["-jar", jar, "--action", "validate", "--no-notices", "--source", pdfPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  console.log(out.trim());
  // Mustang gibt im Report `<summary status="valid"/>` aus und exit-code 0 bei
  // gültigen Dokumenten. Wir prüfen BEIDES defensiv.
  const reportedValid = /status\s*=\s*"valid"/i.test(out) || /\bvalid\b/i.test(out);
  if (r.status === 0 && reportedValid) {
    console.log(`${LOG} Mustang: OK (EN-16931-konform).`);
    return true;
  }
  console.error(`${LOG} Mustang: FAIL (exit=${r.status}).`);
  return false;
}

function runVeraPdf(bin: string, pdfPath: string): boolean {
  console.log(`${LOG} veraPDF: validiere ${pdfPath} (flavour 3b) ...`);
  const r = spawnSync(bin, ["--flavour", "3b", pdfPath], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  console.log(out.trim());
  // veraPDF: exit 0 = compliant, 1 = non-compliant, >1 = Tool-Fehler. Der
  // XML-Report enthält `isCompliant="true"`.
  const compliant = /isCompliant\s*=\s*"true"/i.test(out) || /\bPASS\b/.test(out);
  if (r.status === 0 && compliant) {
    console.log(`${LOG} veraPDF: OK (PDF/A-3b-konform).`);
    return true;
  }
  console.error(`${LOG} veraPDF: FAIL (exit=${r.status}).`);
  return false;
}

async function main(): Promise<void> {
  const data = buildSampleInvoiceData();

  // Schritt 1: Beispiel-PDF/A-3 erzeugen (immer, auch ohne Java).
  let pdf: Buffer;
  let xml: string | null;
  let usedStrictMode: boolean;
  try {
    const carrier = await buildCarrierPdf(data.invoiceNumber);
    const res = await embedZugferdXml(carrier, data, {
      profile: DEFAULT_ZUGFERD_PROFILE,
      creationDate: "2026-01-15T00:00:00.000Z",
    });
    pdf = res.pdf;
    xml = res.xml;
    usedStrictMode = res.usedStrictMode;
  } catch (err) {
    console.error(`${LOG} FEHLER: Beispiel-PDF konnte nicht erzeugt werden:`, err);
    process.exit(2);
  }

  if (!xml) {
    console.error(`${LOG} FEHLER: Es wurde keine ZUGFeRD-XML eingebettet (Standard-PDF-Fallback).`);
    process.exit(2);
  }
  console.log(
    `${LOG} Beispiel-PDF/A-3 erzeugt (Profil=${DEFAULT_ZUGFERD_PROFILE}, library-strict=${usedStrictMode}, ${pdf.length} Bytes, XML ${xml.length} Zeichen).`,
  );

  const tmp = mkdtempSync(join(tmpdir(), "erechnung-validate-"));
  const pdfPath = join(tmp, "muster-en16931.pdf");
  const xmlPath = join(tmp, "factur-x.xml");
  writeFileSync(pdfPath, pdf);
  writeFileSync(xmlPath, xml, "utf8");

  // Schritt 2: Offizielle Validatoren — nur wenn Java + JAR/Bin vorhanden.
  const java = hasJava();
  if (!java) {
    const msg = `${LOG} Keine Java-Runtime gefunden — offizielle Validierung übersprungen. Beispiel-PDF/A-3 + XML wurden erfolgreich erzeugt.`;
    if (REQUIRE) {
      console.error(`${msg}\n${LOG} ERECHNUNG_REQUIRE_VALIDATORS=1 → das ist ein Fehler.`);
      process.exit(1);
    }
    console.log(msg);
    process.exit(0);
  }

  const mustangJar = process.env.MUSTANG_CLI_JAR;
  const verapdfBin = process.env.VERAPDF_CLI;
  const checks: boolean[] = [];

  if (mustangJar && existsSync(mustangJar)) {
    checks.push(runMustang(mustangJar, pdfPath));
  } else if (REQUIRE) {
    console.error(`${LOG} MUSTANG_CLI_JAR fehlt/ungültig, aber ERECHNUNG_REQUIRE_VALIDATORS=1.`);
    process.exit(1);
  } else {
    console.log(`${LOG} MUSTANG_CLI_JAR nicht gesetzt — Mustang-Check übersprungen.`);
  }

  if (verapdfBin && existsSync(verapdfBin)) {
    checks.push(runVeraPdf(verapdfBin, pdfPath));
  } else if (REQUIRE) {
    console.error(`${LOG} VERAPDF_CLI fehlt/ungültig, aber ERECHNUNG_REQUIRE_VALIDATORS=1.`);
    process.exit(1);
  } else {
    console.log(`${LOG} VERAPDF_CLI nicht gesetzt — veraPDF-Check übersprungen.`);
  }

  if (checks.length === 0) {
    console.log(`${LOG} Kein Validator konfiguriert — nichts zu prüfen (Beispiel-PDF OK).`);
    process.exit(0);
  }

  if (checks.every((ok) => ok)) {
    console.log(`${LOG} Alle konfigurierten Validatoren OK.`);
    process.exit(0);
  }
  console.error(`${LOG} Mindestens ein Validator meldete NICHT-Konformität.`);
  process.exit(1);
}

main().catch((err) => {
  console.error(`${LOG} Unerwarteter Fehler:`, err);
  process.exit(2);
});
