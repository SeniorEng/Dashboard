import { describe, expect, it } from "vitest";
import { computeLeistungsnachweisFingerprint } from "../../server/lib/invoice-pdf-fingerprint";
import type { InvoicePdfData } from "../../server/lib/pdf-generator";

/**
 * Stopgap gegen den falschen „Storno + Neuerstellung"-Alarm.
 *
 * ── Der Defekt ──────────────────────────────────────────────────────────
 * `enrichPdfDataWithSignatures` lädt ALLE signierten Sammel-Leistungsnachweise
 * des Kunden-Monats. Liegen die Termine eines davon nicht auf DIESER Rechnung,
 * bleibt der Eintrag trotzdem in `pdfData.signatures` — nur seine
 * `appointmentIds` sind leer. Der Renderer überspringt solche Einträge, der
 * Fingerprint hasht sie mit.
 *
 * Folge: wird nach dem Rechnungsdruck ein weiterer LN signiert, weicht der
 * Live-Fingerprint vom eingefrorenen ab. Die Oberfläche sagt dann wörtlich
 * „PDF entspricht nicht mehr den aktuellen Daten … bitte Storno +
 * Neuerstellung durchführen" — bei BYTE-IDENTISCHEM PDF. Ein Storno-Aufruf auf
 * eine korrekte, gestellte Rechnung; GoBD-relevant.
 *
 * Älter als das Teil-Bündeln (möglich seit #1542), aber das Teil-Bündeln macht
 * den auslösenden Zustand vom Sonderfall zum Regelfall.
 *
 * ── Warum ein Stopgap und kein Fix ──────────────────────────────────────
 * Die gespeicherten Fingerprints sind eingefroren. Rechnungen, die entstanden
 * sind, ALS der fremde Nachweis bereits existierte, tragen ihn im
 * gespeicherten Wert — eine korrigierte Formel erzeugte dort einen NEUEN
 * Fehlalarm. An der Referenz-Kopie gemessen kein Randfall: 42 Kunden-Monate
 * mit 2+ signierten Sammel-LN, 33 davon mit Rechnung.
 *
 * Deshalb prüft die Route ZWEI Live-Werte und meldet Drift nur, wenn der
 * gespeicherte zu keinem passt. Diese Datei hält die Rechnung dahinter fest.
 */

function ln(appointmentIds: number[], name: string): NonNullable<InvoicePdfData["signatures"]>[number] {
  return {
    employeeSignatureData: `sig-${name}`,
    employeeSignedAt: "01.08.2026",
    employeeName: name,
    customerSignatureData: `cust-${name}`,
    customerSignedAt: "02.08.2026",
    customerName: "Kundin",
    appointmentIds,
    recordType: "monthly",
  };
}

function pdfData(signaturen: NonNullable<InvoicePdfData["signatures"]>): InvoicePdfData {
  return {
    invoiceNumber: "RE-2026-0001",
    invoiceDate: "01.08.2026",
    recipientName: "Pflegekasse",
    lineItems: [],
    signatures: signaturen,
  } as unknown as InvoicePdfData;
}

/** Spiegelt `istLeistungsnachweisDrift` aus `server/routes/billing.ts`. */
function driftet(gespeichert: string, voll: string, nurRelevant: string): boolean {
  return ![voll, nurRelevant].includes(gespeichert);
}

describe("LN-Drift — der Zweit-Fingerprint entschärft den falschen Storno-Aufruf", () => {
  const eigener = ln([101, 102], "Mandy");
  const fremderLeer = ln([], "Ursula");

  it("1 — der Defekt ist real: ein fremder Nachweis ändert den vollen Fingerprint", () => {
    // Ohne diesen Nachweis misst der Rest nichts. Beide Seiten rendern
    // identisch (der leere Eintrag wird übersprungen), der Hash unterscheidet
    // sich trotzdem.
    const vorher = computeLeistungsnachweisFingerprint(pdfData([eigener]));
    const nachher = computeLeistungsnachweisFingerprint(pdfData([eigener, fremderLeer]));
    expect(nachher).not.toBe(vorher);
  });

  it("2 — Altfall A: Rechnung vor dem zweiten LN gedruckt → kein Drift mehr", () => {
    // Eingefroren wurde ohne den fremden Eintrag; live ist er jetzt dabei.
    const gespeichert = computeLeistungsnachweisFingerprint(pdfData([eigener]));
    const voll = computeLeistungsnachweisFingerprint(pdfData([eigener, fremderLeer]));
    const nurRelevant = computeLeistungsnachweisFingerprint(pdfData([eigener]));

    expect(gespeichert, "genau hier schlug der Fehlalarm zu").not.toBe(voll);
    expect(driftet(gespeichert, voll, nurRelevant)).toBe(false);
  });

  it("3 — Altfall B: Rechnung NACH dem zweiten LN gedruckt → weiterhin kein Drift", () => {
    // Der Fall, an dem eine bloss korrigierte Formel gescheitert wäre: hier
    // steckt der fremde Eintrag IM eingefrorenen Wert.
    const gespeichert = computeLeistungsnachweisFingerprint(pdfData([eigener, fremderLeer]));
    const voll = computeLeistungsnachweisFingerprint(pdfData([eigener, fremderLeer]));
    const nurRelevant = computeLeistungsnachweisFingerprint(pdfData([eigener]));

    expect(driftet(gespeichert, voll, nurRelevant)).toBe(false);
    // Und die Gegenprobe: die reine Formel-Korrektur hätte hier gemeldet.
    expect(gespeichert, "eine blosse Formel-Korrektur hätte hier falsch gemeldet").not.toBe(nurRelevant);
  });

  it("4 — ECHTER Drift wird weiterhin gemeldet", () => {
    // Der Stopgap darf die Erkennung nicht ausschalten. Ändert sich etwas an
    // einem Nachweis, dessen Termine auf DIESER Rechnung liegen, muss es
    // auffallen — sonst wäre der Hinweis wertlos.
    const gespeichert = computeLeistungsnachweisFingerprint(pdfData([eigener, fremderLeer]));
    const geaendert = ln([101, 102], "Mandy (neu unterschrieben)");
    const voll = computeLeistungsnachweisFingerprint(pdfData([geaendert, fremderLeer]));
    const nurRelevant = computeLeistungsnachweisFingerprint(pdfData([geaendert]));

    expect(driftet(gespeichert, voll, nurRelevant)).toBe(true);
  });

  it("5 — ohne fremde Nachweise sind beide Werte identisch (kein toter Pfad)", () => {
    const voll = computeLeistungsnachweisFingerprint(pdfData([eigener]));
    const nurRelevant = computeLeistungsnachweisFingerprint(pdfData([eigener]));
    expect(nurRelevant).toBe(voll);
  });
});
