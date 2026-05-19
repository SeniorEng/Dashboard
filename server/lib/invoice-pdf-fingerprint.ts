import { createHash } from "crypto";
import type { InvoicePdfData } from "./pdf-generator";

function sortedJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(sortedJsonStringify).join(",")}]`;
  }
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).sort(([a], [b]) =>
      String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
    );
    return `{${entries
      .map(([k, v]) => `${JSON.stringify(String(k))}:${sortedJsonStringify(v)}`)
      .join(",")}}`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${sortedJsonStringify(obj[k])}`)
    .join(",")}}`;
}

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Task #522: Fingerprint der Eingabedaten des Rechnungs-PDF.
 * Deckt alle Felder ab, die im PDF sichtbar gerendert werden — KundenName,
 * Empfänger-Adresse, Versicherungsdaten, Positionen, Beträge und Notizen.
 * Signaturen/Mitarbeiterqualifikationen sind hier ausgespart, da sie nur im
 * Leistungsnachweis sichtbar sind.
 */
export function computeInvoicePdfFingerprint(data: InvoicePdfData): string {
  const canonical = {
    invoiceNumber: data.invoiceNumber,
    invoiceType: data.invoiceType,
    billingType: data.billingType,
    billingMonth: data.billingMonth,
    billingYear: data.billingYear,
    recipientName: data.recipientName,
    recipientAddress: data.recipientAddress,
    insuranceProviderName: data.insuranceProviderName,
    insuranceIkNummer: data.insuranceIkNummer,
    versichertennummer: data.versichertennummer,
    pflegegrad: data.pflegegrad,
    customerName: data.customerName,
    customerAddress: data.customerAddress,
    customerGeburtsdatum: data.customerGeburtsdatum,
    beihilfeBerechtigt: data.beihilfeBerechtigt ?? false,
    rechnungAnKunde: data.rechnungAnKunde ?? false,
    lineItems: data.lineItems.map((item) => ({
      appointmentId: item.appointmentId,
      appointmentDate: item.appointmentDate,
      startTime: item.startTime,
      endTime: item.endTime,
      serviceDescription: item.serviceDescription,
      serviceCode: item.serviceCode,
      durationMinutes: item.durationMinutes,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
      employeeName: item.employeeName,
      appointmentNotes: item.appointmentNotes,
      serviceDetails: item.serviceDetails,
    })),
    netAmountCents: data.netAmountCents,
    vatAmountCents: data.vatAmountCents,
    grossAmountCents: data.grossAmountCents,
    vatRate: data.vatRate,
    notes: data.notes,
  };
  return shortHash(sortedJsonStringify(canonical));
}

/**
 * Fingerprint des Leistungsnachweis-PDF: Eingangsdaten des Invoice-Fingerprints
 * plus Signaturen (Signaturbytes werden gehasht, sodass der Wert bei minimaler
 * Pixeländerung wechselt) und Mitarbeiter-Qualifikationen.
 */
export function computeLeistungsnachweisFingerprint(data: InvoicePdfData): string {
  const baseFp = computeInvoicePdfFingerprint(data);
  // Signaturen werden kanonisch sortiert, damit Reihenfolge-Unterschiede aus
  // dem Storage-Read (kein ORDER BY in enrichPdfDataWithSignatures) keinen
  // falschen Drift erzeugen. Stabiler Sort-Key: recordType, sortierte
  // appointmentIds, employeeSignedAt, employeeName.
  const signatures = (data.signatures ?? [])
    .map((s) => ({
      employeeSignatureHash: s.employeeSignatureData ? shortHash(s.employeeSignatureData) : null,
      employeeSignedAt: s.employeeSignedAt,
      employeeName: s.employeeName,
      customerSignatureHash: s.customerSignatureData ? shortHash(s.customerSignatureData) : null,
      customerSignedAt: s.customerSignedAt,
      customerName: s.customerName,
      appointmentIds: [...s.appointmentIds].sort((a, b) => a - b),
      recordType: s.recordType,
    }))
    .sort((a, b) => {
      const ka = `${a.recordType}|${a.appointmentIds.join(",")}|${a.employeeSignedAt ?? ""}|${a.employeeName ?? ""}`;
      const kb = `${b.recordType}|${b.appointmentIds.join(",")}|${b.employeeSignedAt ?? ""}|${b.employeeName ?? ""}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  const qualifications = data.employeeQualifications
    ? Array.from(data.employeeQualifications.entries()).sort(([a], [b]) =>
        a < b ? -1 : a > b ? 1 : 0
      )
    : [];
  return shortHash(
    sortedJsonStringify({ baseFp, signatures, qualifications })
  );
}
