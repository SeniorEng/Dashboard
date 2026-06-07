import { and, eq } from "drizzle-orm";
import { db } from "../lib/db";
import { invoices as invoicesTable, customers as customersTable } from "@shared/schema";
import type { Invoice } from "@shared/schema";
import { formatCustomerMasterAddress } from "../lib/customer-address-format";
import {
  schedulePdfPersistInBackground,
  computeLiveInvoiceFingerprints,
} from "./invoice-pdf-orchestrator";

/**
 * Task #1030 — Empfänger-/Leistungsempfänger-Auflösung pro Rechnung.
 *
 * Der Rechnungsempfänger ist der Kunde bei Selbstzahlern, privaten Pflegekassen
 * und gesetzlichen Kassen im Kostenerstattungsverfahren (`rechnungAnKunde`).
 * Eine gesetzliche Kasse OHNE Kostenerstattung adressiert an die Pflegekasse —
 * dort bleibt `recipient_address` die Versicherungs-Anschrift.
 *
 * (Spiegelt die Empfänger-Auflösung in `invoice-calc.generateInvoiceCore`.)
 */
export function isCustomerAddressedInvoice(billingType: string, rechnungAnKunde: boolean): boolean {
  return !(billingType === "pflegekasse_gesetzlich" && !rechnungAnKunde);
}

export interface DraftInvoiceAddressRefreshItem {
  invoiceId: number;
  invoiceNumber: string;
  billingType: string;
  recipientUpdated: boolean;
  cacheCleared: boolean;
  oldRecipientAddress: string | null;
  newRecipientAddress: string | null;
}

export interface DraftInvoiceAddressRefreshReport {
  customerId: number;
  masterAddress: string | null;
  scanned: number;
  changed: DraftInvoiceAddressRefreshItem[];
  dryRun: boolean;
}

/**
 * Task #1030 — Aktualisiert die Adress-Daten aller ENTWURF-Rechnungen eines
 * Kunden auf den aktuellen Stamm-Stand und rendert betroffene PDFs neu.
 *
 *  - Versendete/bezahlte/stornierte Rechnungen werden NIE angefasst (GoBD —
 *    nur Status `entwurf`).
 *  - Stornorechnungen werden NIE angefasst (sie spiegeln immer ihr Original).
 *  - Kunden-adressierte Rechnungen (Selbstzahler / Privat / Kostenerstattung)
 *    bekommen `recipient_address` auf die Stammadresse gesetzt.
 *  - Kassen-adressierte Rechnungen behalten ihre Pflegekassen-Anschrift; nur
 *    der Leistungsnachweis-Cache wird neu gerendert (zeigt jetzt korrekt die
 *    Patient-Stammadresse statt der Kasse).
 *  - Idempotent: Staleness wird über Empfänger-Vergleich + Fingerprint-Drift
 *    erkannt; ein zweiter Lauf ohne Datenänderung ist ein No-Op.
 *
 * @param opts.dryRun true = nur ermitteln + berichten, nichts schreiben.
 */
export async function refreshDraftInvoicesForCustomerAddress(
  customerId: number,
  opts: { dryRun?: boolean } = {},
): Promise<DraftInvoiceAddressRefreshReport> {
  const dryRun = opts.dryRun ?? false;

  const customerRows = await db
    .select({
      rechnungAnKunde: customersTable.rechnungAnKunde,
      strasse: customersTable.strasse,
      nr: customersTable.nr,
      plz: customersTable.plz,
      stadt: customersTable.stadt,
    })
    .from(customersTable)
    .where(eq(customersTable.id, customerId))
    .limit(1);
  const customer = customerRows[0];

  const masterAddress = customer ? formatCustomerMasterAddress(customer) : null;
  const rechnungAnKunde = customer?.rechnungAnKunde === true;

  const report: DraftInvoiceAddressRefreshReport = {
    customerId,
    masterAddress,
    scanned: 0,
    changed: [],
    dryRun,
  };
  if (!customer) return report;

  const drafts = (await db
    .select()
    .from(invoicesTable)
    .where(and(eq(invoicesTable.customerId, customerId), eq(invoicesTable.status, "entwurf")))) as Invoice[];

  for (const inv of drafts) {
    // GoBD: Stornorechnungen spiegeln immer ihr Original — niemals anfassen.
    if (inv.invoiceType === "stornorechnung") continue;
    report.scanned++;

    const customerAddressed = isCustomerAddressedInvoice(inv.billingType, rechnungAnKunde);
    const recipientStale =
      customerAddressed && masterAddress !== null && (inv.recipientAddress ?? null) !== masterAddress;

    const hasCache = Boolean(
      inv.pdfPath ||
        inv.leistungsnachweisPath ||
        inv.pdfDataFingerprint ||
        inv.leistungsnachweisDataFingerprint ||
        inv.renderSnapshot,
    );

    // Cache-Staleness via Fingerprint-Drift: weicht das, was die aktuellen
    // (Live-)Stammdaten rendern würden, vom eingefrorenen Cache ab?
    let cacheStale = false;
    if (hasCache) {
      try {
        // Empfänger-Korrektur vorab in die Fingerprint-Probe spiegeln, damit
        // ein reiner Empfänger-Drift nicht doppelt als „Cache stale" zählt.
        const probe: Invoice = recipientStale
          ? ({ ...inv, recipientAddress: masterAddress } as Invoice)
          : inv;
        const live = await computeLiveInvoiceFingerprints(probe);
        if (
          inv.pdfDataFingerprint &&
          live.pdfFingerprint &&
          live.pdfFingerprint !== inv.pdfDataFingerprint
        ) {
          cacheStale = true;
        }
        if (
          inv.leistungsnachweisDataFingerprint &&
          live.leistungsnachweisFingerprint &&
          live.leistungsnachweisFingerprint !== inv.leistungsnachweisDataFingerprint
        ) {
          cacheStale = true;
        }
        // Legacy-Cache ohne Fingerprint → konservativ neu rendern.
        if (!inv.pdfDataFingerprint && !inv.leistungsnachweisDataFingerprint) {
          cacheStale = true;
        }
      } catch {
        // Live-Render-Daten nicht reproduzierbar → konservativ neu rendern.
        cacheStale = true;
      }
    }

    if (!recipientStale && !cacheStale) continue;

    report.changed.push({
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      billingType: inv.billingType,
      recipientUpdated: recipientStale,
      cacheCleared: cacheStale,
      oldRecipientAddress: inv.recipientAddress ?? null,
      newRecipientAddress: recipientStale ? masterAddress : inv.recipientAddress ?? null,
    });

    if (dryRun) continue;

    const updateData: Record<string, unknown> = {};
    if (recipientStale) {
      updateData.recipientAddress = masterAddress;
    }
    if (cacheStale) {
      // Cache-Spalten leeren → der nächste Abruf (bzw. der Hintergrund-Persist
      // unten) rendert PDF + Leistungsnachweis frisch aus den Live-Stammdaten.
      updateData.pdfPath = null;
      updateData.pdfHash = null;
      updateData.pdfDataFingerprint = null;
      updateData.zugferdXml = null;
      updateData.leistungsnachweisPath = null;
      updateData.leistungsnachweisHash = null;
      updateData.leistungsnachweisDataFingerprint = null;
      updateData.renderSnapshot = null;
    }

    // Entwurfs-UPDATE ist GoBD-erlaubt (Trigger blockt nur DELETE finalisierter
    // Rechnungen + TRUNCATE) — kein Bypass nötig.
    await db.update(invoicesTable).set(updateData).where(eq(invoicesTable.id, inv.id));
    schedulePdfPersistInBackground(inv.id);
  }

  return report;
}
