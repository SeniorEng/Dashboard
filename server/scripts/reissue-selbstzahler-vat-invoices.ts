/**
 * Task #1659 — Datenbereinigung der Selbstzahler-Rechnungen mit der um Faktor
 * 100 zu niedrig berechneten Umsatzsteuer (0,19 % statt 19 %).
 *
 * Kontext
 * -------
 * Der Erzeugungspfad hat die Positions-USt aus dem Service-Feld `vatRate`
 * (PROZENT, z.B. 19) berechnet, aber durch 10000 geteilt, als wäre es ein
 * Basispunkt-Wert (19 % = 1900). Ergebnis: `round(netto × 19 / 10000)` ≈
 * 0,19 % statt 19 %. Der Code-Fix (zentrale VAT-SSoT `serviceVatRateBP` in
 * `shared/domain/invoice-vat.ts`) verhindert die NEU-Entstehung. Dieses Skript
 * bereinigt den BESTAND GoBD-konform.
 *
 * Betroffen ist AUSSCHLIESSLICH der Selbstzahler-/Privat-Topf (19 %).
 * Pflegekassen-Rechnungen sind steuerbefreit (§ 4 Nr. 16 UStG, 0 € USt) und
 * werden NIE angefasst — die Erkennung nutzt dieselbe VAT-SSoT
 * (`resolveVatTreatment`), die auch Erzeugung/Renderer verwenden.
 *
 * Erkennung (SSoT-basiert, kein Heuristik-Rätselraten)
 * ----------------------------------------------------
 * Eine Rechnung gilt als „buggy" iff ALLE zutreffen:
 *   - kein Storno-Beleg (`invoiceType !== 'stornorechnung'`),
 *   - nicht bereits storniert (`status !== 'storniert'`),
 *   - steuerpflichtig laut `resolveVatTreatment` (= Selbstzahler/Privat),
 *   - `vatAmountCents === round(netto × 19 / 10000)` (der buggy-Wert) UND
 *     `vatAmountCents !== round(netto × 1900 / 10000)` (der korrekte Wert),
 *   - korrekter USt-Wert > 0 (Netto groß genug, dass sich beide Werte
 *     unterscheiden — sonst gibt es nichts zu korrigieren).
 * Dadurch werden korrekt gerechnete Rechnungen, steuerbefreite Kassen-
 * Rechnungen und bereits stornierte Belege automatisch übersprungen. Die
 * eingefrorene Storno-Kette (Original `storniert` + `stornorechnung`-Spiegel)
 * fällt aus beiden Gründen heraus und bleibt bit-genau erhalten (GoBD).
 *
 * Korrektur-Pfade
 * ---------------
 *   - ENTWURF (`status = 'entwurf'` UND nie ausgegeben): Der Entwurf wird
 *     gelöscht und über den kanonischen `generateInvoiceCore` frisch (mit 19 %)
 *     neu erzeugt — exakt der Pfad von `POST /billing/generate`.
 *
 *     ACHTUNG (#66): „Entwurf" heißt NICHT mehr „nie versendet". Seit dem
 *     Fehlmarkierungs-Ventil (`POST /billing/:id/revoke-sent-mark`) kann eine
 *     bereits AUSGEGEBENE Rechnung wieder im Entwurfsstatus stehen — das Ventil
 *     macht sie bearbeitbar, nicht löschbar, und lässt `issued_at` stehen.
 *     Dieser Pfad prüft deshalb `neverIssuedCondition()` mit, sonst würde er
 *     genau den Beleg hart löschen, um dessen Schutz es in #66 geht. Eine
 *     ausgegebene Rechnung gehört auch hier in den Storno-Pfad darunter.
 *     (Die frühere Fassung dieses Absatzes behauptete das Gegenteil.)
 *   - AUSGESTELLT (`versendet`/`bezahlt`): GoBD-konforme
 *     Storno-und-Neuausstellung — `stornoInvoiceCascade` legt die
 *     Stornorechnung an (kopiert & negiert das buggy Original 1:1, KEINE
 *     Neuberechnung → Storno-Symmetrie bleibt gewahrt), danach erzeugt
 *     `generateInvoiceCore` die korrekte Neu-Rechnung (19 %).
 *
 * Sicherheit / GoBD
 * -----------------
 *   - Trockenlauf ist Default; `--apply` schreibt erst nach explizitem Opt-in.
 *   - `--apply` erfordert `NODE_ENV=production` — der Objektspeicher (PDF-Keys)
 *     ist env-scoped; ein `--apply` aus Dev würde in den falschen Bucket
 *     schreiben. Skript wird im Dev VORBEREITET, im Produktionsumfeld
 *     AUSGEFÜHRT.
 *   - `--apply` erfordert `--user=<superadmin-id>` (Audit-Attribution) UND
 *     `--reason="…"` (≥10 Zeichen, landet im Audit-Log).
 *
 * Aufruf
 * ------
 *   - Trockenlauf (alle):  tsx server/scripts/reissue-selbstzahler-vat-invoices.ts
 *   - Auf Nummern scopen:  tsx server/scripts/reissue-selbstzahler-vat-invoices.ts \
 *                            --invoices=RE-2026-0250,RE-2026-0302,RE-2026-0324
 *   - Scharf (nur Prod):   NODE_ENV=production tsx server/scripts/reissue-selbstzahler-vat-invoices.ts \
 *                            --apply --user=<superadmin-id> --reason="USt-Korrektur #1659"
 *
 * Exit-Code: 0 = keine buggy Selbstzahler-Rechnung gefunden, 1 = mindestens
 * eine gefunden (Skript-/CI-freundliches Signal). `--apply` ändert das nicht.
 */

import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "../lib/db";
import { withAudit } from "../lib/with-audit";
import {
  customers,
  invoices as invoicesTable,
  invoiceLineItems,
  type Invoice,
} from "@shared/schema";
import { resolveVatTreatment, STANDARD_VAT_RATE_BP } from "@shared/domain/invoice-vat";
import { isInvoiceIssued, neverIssuedCondition } from "../lib/invoice-issued";
import { stornoInvoiceCascade } from "../services/invoice-storno";
import { generateInvoiceCore } from "../services/invoice-calc";
import { persistInvoicePdf } from "../services/invoice-pdf-orchestrator";
import { assertProdWriteAllowedOrThrow, parseProdWriteArgs } from "./lib/prod-write-gate";

interface Args {
  apply: boolean;
  invoiceNumbers: string[];
  userId: number | undefined;
  reason: string | undefined;
  /** `--confirm-target=<host>/<datenbank>` — vom Ziel-Gate geprueft. */
  confirmTarget?: string;
}

/** Der historische Bug: Prozent-Rate roh durch 10000 → 100× zu niedrig. */
function buggyVatCents(netCents: number): number {
  return Math.round((netCents * 19) / 10000);
}

/** Der korrekte Wert über die zentrale VAT-SSoT (19 % = 1900 BP). */
function correctVatCents(netCents: number): number {
  return Math.round((netCents * STANDARD_VAT_RATE_BP) / 10000);
}

export interface VatFinding {
  invoiceId: number;
  invoiceNumber: string;
  customerId: number;
  status: string;
  billingType: string;
  budgetType: string | null;
  billingMonth: number;
  billingYear: number;
  netAmountCents: number;
  storedVatCents: number;
  correctVatCents: number;
  kind: "draft" | "issued";
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const apply = argv.includes("--apply");
  const invArg = get("--invoices=");
  const invoiceNumbers = invArg
    ? invArg.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // Die gemeinsamen Flags aus der SSoT: der lokale `get` schnitt per
  // `.split("=")[1]` am ERSTEN `=` ab — eine Begruendung mit `=>` landete
  // verstuemmelt im GoBD-Audit-Log (PR #119).
  const gemeinsam = parseProdWriteArgs(process.argv);
  return {
    apply,
    invoiceNumbers,
    userId: gemeinsam.userId,
    reason: gemeinsam.reason,
    confirmTarget: gemeinsam.confirmTarget,
  };
}

// `assertSuperadminOrThrow` ist entfallen — ERSETZT durch die SSoT
// `assertProdWriteAllowedOrThrow`, die Superadmin, Begruendung UND das
// Ziel in einem Aufruf prueft. Eine Superadmin-Pruefung OHNE
// Ziel-Freigabe ist genau der Zweitbegriff aus W1.


/** Lädt Kandidaten (kein Storno-Beleg, nicht storniert), optional auf Nummern gescopt. */
async function loadCandidates(invoiceNumbers: string[]) {
  const whereParts = [
    ne(invoicesTable.invoiceType, "stornorechnung"),
    ne(invoicesTable.status, "storniert"),
  ];
  if (invoiceNumbers.length > 0) {
    whereParts.push(inArray(invoicesTable.invoiceNumber, invoiceNumbers));
  }
  return db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      customerId: invoicesTable.customerId,
      status: invoicesTable.status,
      billingType: invoicesTable.billingType,
      budgetType: invoicesTable.budgetType,
      billingMonth: invoicesTable.billingMonth,
      billingYear: invoicesTable.billingYear,
      netAmountCents: invoicesTable.netAmountCents,
      vatAmountCents: invoicesTable.vatAmountCents,
      // #66: Die Ausgabe-Marke MUSS mitgeladen werden — `status` allein
      // entscheidet seit dem Ventil nicht mehr, welcher Korrektur-Pfad gilt.
      issuedAt: invoicesTable.issuedAt,
    })
    .from(invoicesTable)
    .where(and(...whereParts));
}

function classifyFinding(row: Awaited<ReturnType<typeof loadCandidates>>[number]): VatFinding | null {
  const treatment = resolveVatTreatment({
    billingType: row.billingType,
    budgetType: row.budgetType,
  });
  if (treatment !== "standard") return null; // steuerbefreit (Kasse) → nie anfassen

  const net = row.netAmountCents;
  const correct = correctVatCents(net);
  const buggy = buggyVatCents(net);
  // Nur eingreifen, wenn der Bestand exakt den buggy-Wert trägt UND sich der
  // korrekte Wert davon unterscheidet (sonst gibt es nichts zu korrigieren).
  if (correct <= 0) return null;
  if (row.vatAmountCents !== buggy || row.vatAmountCents === correct) return null;

  // #66 — Die Weiche laeuft ueber die AUSGABE-MARKE, nicht ueber den Status.
  //
  // `status === "entwurf"` hiess frueher „nie ausgegeben". Seit dem
  // Fehlmarkierungs-Ventil kann eine ausgegebene Rechnung wieder im
  // Entwurfsstatus stehen. Die alte Zuordnung haette sie als `draft`
  // eingestuft — mit drei Folgen: der TROCKENLAUF (die Entscheidungsgrundlage
  // vor `--apply` auf PROD) haette „loeschen + neu erzeugen" gedruckt, der
  // scharfe Lauf waere am Loeschschutz mitten im Durchlauf abgebrochen, und
  // der Docstring oben („gehoert auch hier in den Storno-Pfad") waere nicht
  // eingeloest worden. Ueber die Marke landet sie da, wo sie hingehoert.
  const kind: VatFinding["kind"] = isInvoiceIssued(row) ? "issued" : "draft";
  return {
    invoiceId: row.id,
    invoiceNumber: row.invoiceNumber,
    customerId: row.customerId,
    status: row.status,
    billingType: row.billingType,
    budgetType: row.budgetType,
    billingMonth: row.billingMonth,
    billingYear: row.billingYear,
    netAmountCents: net,
    storedVatCents: row.vatAmountCents,
    correctVatCents: correct,
    kind,
  };
}

/**
 * ENTWURF: löschen + kanonisch neu erzeugen.
 *
 * EXPORTIERT ausschliesslich für den Löschschutz-Test
 * (`tests/billing/invoice-number-never-reused.test.ts`, Fall d3). Der Guard
 * `neverIssuedCondition()` unten ist sonst nicht prüfbar, ohne das ganze
 * Skript mit `--apply` unter `NODE_ENV=production` zu fahren — und ein
 * ungeprüfter Löschpfad ist genau das, was #66 dreimal gefunden hat.
 */
export async function reissueDraft(finding: VatFinding, userId: number): Promise<void> {
  await withAudit(async (tx, audit) => {
    const deleted = await tx
      .delete(invoicesTable)
      .where(
        and(
          eq(invoicesTable.id, finding.invoiceId),
          eq(invoicesTable.status, "entwurf"),
          ne(invoicesTable.invoiceType, "stornorechnung"),
          // #66: „Entwurf" heisst seit dem Fehlmarkierungs-Ventil NICHT mehr
          // „nie ausgegeben". Eine ausgegebene Rechnung kann per Ventil wieder
          // im Entwurfsstatus stehen — sie hart zu loeschen und neu
          // auszustellen wuerde genau den Beleg verschwinden lassen, um den es
          // in #66 geht. Dieselbe SSoT wie die drei Loeschpfade in
          // `routes/billing.ts` und `services/draft-invoice-regen.ts`.
          neverIssuedCondition(),
        ),
      )
      .returning({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber });
    if (deleted.length === 0) {
      // Zwei Ursachen, und sie brauchen unterschiedliche Reaktionen: eine
      // ausgegebene Rechnung ist KEIN Wettlauf, sondern gehoert in den
      // Storno-Pfad. Die frueher pauschale Meldung „Status geaendert?" haette
      // den Bediener genau in die falsche Richtung geschickt.
      const [current] = await tx
        .select({ issuedAt: invoicesTable.issuedAt, status: invoicesTable.status })
        .from(invoicesTable)
        .where(eq(invoicesTable.id, finding.invoiceId));
      if (current && current.issuedAt !== null) {
        throw new Error(
          `Entwurf ${finding.invoiceNumber} wurde bereits ausgegeben (issued_at gesetzt) — `
            + "harte Loeschung ist gesperrt (#66). Diese Rechnung gehoert in den "
            + "Storno-Pfad: stornieren und neu ausstellen, statt den Beleg zu entfernen.",
        );
      }
      throw new Error(
        `Entwurf ${finding.invoiceNumber} konnte nicht gelöscht werden `
          + `(Status jetzt "${current?.status ?? "unbekannt"}" — zwischenzeitlich geändert?).`,
      );
    }
    audit.record({
      userId,
      action: "invoice_draft_discarded",
      entityType: "invoice",
      entityId: finding.invoiceId,
      metadata: {
        invoiceNumber: finding.invoiceNumber,
        customerId: finding.customerId,
        billingMonth: finding.billingMonth,
        billingYear: finding.billingYear,
        reason: "vat_100x_correction_1659",
        storedVatCents: finding.storedVatCents,
        correctVatCents: finding.correctVatCents,
      },
    });
  }, {});

  const result = await generateInvoiceCore(
    {
      customerId: finding.customerId,
      billingMonth: finding.billingMonth,
      billingYear: finding.billingYear,
    },
    { userId, testFaults: new Set() },
  );
  const created = "splitInvoices" in result ? result.invoices : [result];
  for (const inv of created) await persistInvoicePdf(inv.id);
  console.log(
    `  ✓ Entwurf ${finding.invoiceNumber} verworfen → ${created
      .map((i) => i.invoiceNumber)
      .join(", ")} neu erzeugt (19 %).`,
  );
}

/** AUSGESTELLT: GoBD-Storno (copy-negate) + korrekte Neu-Rechnung. */
async function reissueIssued(finding: VatFinding, userId: number, reason: string): Promise<void> {
  await withAudit(async (tx, audit) => {
    await stornoInvoiceCascade(tx, audit, {
      rootInvoiceId: finding.invoiceId,
      cascadeRun: false,
      userId,
      auditMetadataExtra: {
        reason: "vat_100x_correction_1659",
        note: reason,
        storedVatCents: finding.storedVatCents,
        correctVatCents: finding.correctVatCents,
      },
    });
  }, {});

  const result = await generateInvoiceCore(
    {
      customerId: finding.customerId,
      billingMonth: finding.billingMonth,
      billingYear: finding.billingYear,
    },
    { userId, testFaults: new Set() },
  );
  const created = "splitInvoices" in result ? result.invoices : [result];
  for (const inv of created) await persistInvoicePdf(inv.id);
  console.log(
    `  ✓ ${finding.invoiceNumber} storniert → ${created
      .map((i) => i.invoiceNumber)
      .join(", ")} korrekt neu ausgestellt (19 %).`,
  );
}

function eur(cents: number): string {
  return `${(cents / 100).toFixed(2)} €`;
}

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (process.env.NODE_ENV !== "production") {
      console.error(
        "Fehler: --apply ist nur mit NODE_ENV=production erlaubt.\n" +
          "  Der Objektspeicher (PDF-Keys) ist env-scoped — ein --apply aus Dev\n" +
          "  würde in den falschen Bucket schreiben. Bitte im Produktionsumfeld ausführen.",
      );
      process.exit(1);
    }
    // Ziel, Superadmin und Begruendung in EINEM Aufruf — und die Freigabe
    // fuer die Laufzeit-Schreibsperre.
    const freigabe = await assertProdWriteAllowedOrThrow(
      {
        apply: args.apply,
        userId: args.userId,
        reason: args.reason,
        confirmTarget: args.confirmTarget,
      },
      "Der Lauf storniert Selbstzahler-Rechnungen und stellt sie neu aus (GoBD).",
    );
    console.log(`Freigegeben durch: ${freigabe.displayName}`);
  }

  console.log(`\n=== Selbstzahler-USt-Korrektur · Task #1659 ===`);
  console.log(`Modus:      ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only)"}`);
  console.log(
    `Rechnungen: ${args.invoiceNumbers.length > 0 ? args.invoiceNumbers.join(", ") : "ALLE (auto-erkannt)"}`,
  );
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const candidates = await loadCandidates(args.invoiceNumbers);
  const findings = candidates
    .map(classifyFinding)
    .filter((f): f is VatFinding => f !== null);

  // Kundennamen für die Ausgabe.
  const cids = Array.from(new Set(findings.map((f) => f.customerId)));
  const names = new Map<number, string>();
  if (cids.length > 0) {
    const rows = await db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(inArray(customers.id, cids));
    for (const r of rows) names.set(r.id, r.name ?? "");
  }

  console.log(`\nGeprüfte Kandidaten:                 ${candidates.length}`);
  console.log(`Buggy Selbstzahler-Rechnungen:       ${findings.length}\n`);

  for (const f of findings) {
    console.log(
      `  ${f.invoiceNumber} [${f.status}] · Kunde #${f.customerId} ${names.get(f.customerId) ?? ""}` +
        `\n    ${f.kind === "draft" ? "ENTWURF → löschen + neu erzeugen" : "AUSGESTELLT → Storno + Neu-Rechnung"}` +
        `\n    Netto ${eur(f.netAmountCents)} · USt gebucht ${eur(f.storedVatCents)} → korrekt ${eur(f.correctVatCents)}`,
    );
  }

  if (args.apply) {
    console.log(`\n--- Ausführung ---`);
    for (const f of findings) {
      try {
        if (f.kind === "draft") await reissueDraft(f, args.userId!);
        else await reissueIssued(f, args.userId!, args.reason!);
      } catch (err) {
        console.error(`  ✗ ${f.invoiceNumber}: ${(err as Error).message}`);
        throw err;
      }
    }
    console.log(`\nBereinigt: ${findings.length}`);
  } else if (findings.length > 0) {
    console.log(
      '\nHinweis: Trockenlauf — keine Änderungen geschrieben.' +
        '\n  Scharf (nur Prod): NODE_ENV=production ... --apply --user=<superadmin-id> --reason="…"',
    );
  } else {
    console.log("\n✓ Keine buggy Selbstzahler-Rechnungen im Bestand.");
  }

  process.exit(findings.length === 0 ? 0 : 1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
