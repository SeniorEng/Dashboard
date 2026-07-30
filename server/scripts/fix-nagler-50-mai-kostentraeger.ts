/**
 * Task #1894 — Prod-Korrektur: Nagler (Kunde 50), Mai 2026 an IKK classic.
 *
 * Problem (prod-verifiziert)
 * -------------------------
 * Vor #1893 adressierten alle Abrechnungs-Lesepfade den HEUTE gültigen
 * Kostenträger statt den im abgerechneten Zeitraum gültigen. Folge bei Nagler:
 * RE-2026-0186 (Rechnung 188, Mai 2026, versendet, §45b, 123,49 € brutto) ging
 * an „AOK PLUS", obwohl im Mai IKK classic Kostenträger war.
 *
 * Zusätzlich ist die Kassenhistorie selbst fehlerhaft: der Wechsel steht auf dem
 * 08.06. statt auf dem Monatsersten, und beide Zeilen überlappen sich an genau
 * diesem Randtag (IKK bis 08.06., AOK ab 08.06. — am 08.06. galten zwei Kassen
 * gleichzeitig, `.limit(1)` entschied zufällig).
 *
 * Was dieses Skript tut (drei einzeln freigebbare Phasen)
 * ------------------------------------------------------
 * A) `fenster`   — Kassenfenster auf die Zielzeiträume korrigieren:
 *                  IKK classic 01.02.–31.05.2026, AOK Plus ab 01.06.2026 offen.
 * B) `storno`    — RE-2026-0186 über den kanonischen Storno-Weg stornieren
 *                  (`stornoInvoiceCascade`: Stornorechnung mit eigener Nummer,
 *                  negierte Positionen, Budget-Rückbuchung) + Storno-PDF.
 * C) `neu`       — Mai 2026 über den regulären Generator (`generateInvoiceCore`)
 *                  neu ausstellen. Da #1893 zeitraumgenau auflöst, adressiert
 *                  die neue Rechnung automatisch IKK classic.
 * D) `scan`      — read-only Bestandsbericht (läuft IMMER, auch im Trockenlauf).
 *
 * GoBD
 * ----
 * Die versendete Rechnung wird NICHT umgeschrieben — Storno + Neuausstellung mit
 * neuer Nummer, das Original bleibt als `storniert` erhalten und die
 * Stornorechnung referenziert es über `stornierte_rechnung_id`. Kein direkter
 * DB-Eingriff an Rechnungen: Phase B nutzt ausschließlich die Storno-SSoT.
 *
 * Reihenfolge-Zwang
 * -----------------
 * Phase A MUSS vor Phase C laufen: der Generator liest den im Abrechnungszeitraum
 * gültigen Kostenträger. Solange das Fenster noch auf dem 08.06. steht, liefert
 * der Stichtag 31.05. zwar bereits IKK (die Überlappung liegt im Juni) — die
 * Korrektur ist aber Voraussetzung dafür, dass Juni sauber der AOK zufällt und
 * die Historie überhaupt wieder editierbar wird (siehe unten).
 *
 * Warum Phase A NICHT über `updateCustomerInsurance` läuft
 * -------------------------------------------------------
 * Der #1893-Schreibpfad validiert nach JEDER Einzeländerung die komplette
 * Fenster-Menge. Für diese Korrektur gibt es keine zulässige Einzelschritt-
 * Reihenfolge:
 *   - Zuerst IKK auf 31.05. schließen → AOK beginnt weiterhin am 08.06.
 *     → dessen `validFrom` ist kein Monatserster → Abbruch (01.-Regel).
 *   - Zuerst AOK auf 01.06. ziehen → IKK endet weiterhin am 08.06.
 *     → 08.06. >= 01.06. → Abbruch (Überlappung).
 * Beide Zeilen müssen deshalb in EINER Transaktion umgesetzt und die
 * RESULTIERENDE Menge einmal validiert werden — mit derselben SSoT
 * (`validateInsuranceWindows`), nicht mit einer zweiten Regel-Kopie.
 *
 * Sicherheit
 * ----------
 *   - Trockenlauf ist DEFAULT; jede schreibende Phase wird simuliert und
 *     zurückgerollt. `stornoInvoiceCascade` und `generateInvoiceCore` schreiben
 *     im Trockenlauf nichts (Rollback bzw. gar kein Aufruf).
 *   - `--apply` erfordert `NODE_ENV=production`, `--user=<superadmin-id>`,
 *     `--reason="…"` (≥10 Zeichen), eine Nicht-Test-DB UND die Replit-
 *     Objektspeicher-Umgebung. Ein `--apply` aus der Hetzner-Dev-Umgebung
 *     (`STORAGE_DRIVER=local`) legte das Storno-PDF im falschen Bucket ab und
 *     wird hart abgelehnt.
 *   - Jede Phase prüft ihre erwarteten Ist-Werte VORHER. Bei Abweichung: harter
 *     Abbruch mit Ausgabe des tatsächlich Vorgefundenen — nie raten.
 *   - Ist eine Phase bereits im Zielzustand, wird sie als „bereits korrekt"
 *     übersprungen (idempotent, kein Fehler).
 *
 * Aufruf
 * ------
 *   Trockenlauf (read-only, alle Phasen + Scan):
 *     tsx server/scripts/fix-nagler-50-mai-kostentraeger.ts
 *
 *   Scharf, Phase für Phase (nur Replit-Prod, je einzeln freigegeben):
 *     NODE_ENV=production tsx server/scripts/fix-nagler-50-mai-kostentraeger.ts \
 *       --apply --phase=fenster --user=<id> --reason="Nagler #1894 Kassenfenster"
 *     … --apply --phase=storno --user=<id> --reason="Nagler #1894 Storno RE-2026-0186"
 *     … --apply --phase=neu    --user=<id> --reason="Nagler #1894 Mai-Neuausstellung"
 *
 *   Nur der Bestandsbericht:
 *     tsx server/scripts/fix-nagler-50-mai-kostentraeger.ts --phase=scan
 */

import { and, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { db, type DbOrTx, type Tx } from "../lib/db";
import { withAudit, type TxAuditRecorder } from "../lib/with-audit";
import {
  customers,
  customerInsuranceHistory,
  insuranceProviders,
  invoices as invoicesTable,
  paymentAdviceItems,
  qontoTransactions,
  users,
} from "@shared/schema";
import {
  billingPeriodAsOfISO,
  dayBeforeISO,
  isMonthStartISO,
  pickInsuranceWindowAt,
  validateInsuranceWindows,
  type InsuranceWindow,
} from "@shared/domain/insurance-period";
import { stornoInvoiceCascade } from "../services/invoice-storno";
import { generateInvoiceCore } from "../services/invoice-calc";
import { persistInvoicePdf } from "../services/invoice-pdf-orchestrator";
import { formatEuroDE } from "@shared/utils/money";

// --- Fallkonstanten (Arbeitsanweisung #1894) --------------------------------

const CUSTOMER_ID = 50;
const CUSTOMER_NAME_FRAGMENT = "Nagler";
const BILLING_YEAR = 2026;
const BILLING_MONTH = 5;

/** Kassenzeile IKK classic — Zielfenster 01.02.–31.05.2026. */
const ROW_IKK = {
  id: 14,
  ikNummer: "187202793",
  expectedFrom: "2026-02-01",
  expectedTo: "2026-06-08",
  targetFrom: "2026-02-01",
  targetTo: "2026-05-31",
} as const;

/** Kassenzeile AOK Plus — Zielfenster ab 01.06.2026, offenes Ende. */
const ROW_AOK = {
  id: 148,
  ikNummer: "107299005",
  expectedFrom: "2026-06-08",
  expectedTo: null as string | null,
  targetFrom: "2026-06-01",
  targetTo: null as string | null,
} as const;

const VERSICHERTENNUMMER = "A268233642";

/** Die fehladressierte Mai-Rechnung. */
const INVOICE_ID = 188;
const INVOICE_NUMBER = "RE-2026-0186";
const INVOICE_GROSS_CENTS = 12349;

type Phase = "fenster" | "storno" | "neu" | "scan" | "alle";
const PHASES: Phase[] = ["fenster", "storno", "neu", "scan", "alle"];

interface Args {
  apply: boolean;
  phase: Phase;
  userId: number | undefined;
  reason: string | undefined;
}

/** Sentinel, um eine Phase im Trockenlauf sauber zurückzurollen. */
class DryRunRollback extends Error {}

function eur(cents: number): string {
  return formatEuroDE(cents);
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (p: string) => argv.find((a) => a.startsWith(p))?.split("=")[1];
  const userArg = get("--user=");
  const userId = userArg ? parseInt(userArg, 10) : undefined;
  const phaseArg = (get("--phase=") ?? "alle") as Phase;
  if (!PHASES.includes(phaseArg)) {
    console.error(`Fehler: --phase=${phaseArg} unbekannt. Erlaubt: ${PHASES.join(", ")}`);
    process.exit(1);
  }
  return {
    apply: argv.includes("--apply"),
    phase: phaseArg,
    userId: userId !== undefined && Number.isFinite(userId) ? userId : undefined,
    reason: get("--reason="),
  };
}

async function assertSuperadminOrThrow(userId: number): Promise<void> {
  const [row] = await db
    .select({
      id: users.id,
      isSuperAdmin: users.isSuperAdmin,
      isActive: users.isActive,
      displayName: users.displayName,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) throw new Error(`--user=${userId}: User existiert nicht`);
  if (!row.isActive) throw new Error(`--user=${userId} (${row.displayName}) ist inaktiv`);
  if (!row.isSuperAdmin) {
    throw new Error(
      `--user=${userId} (${row.displayName}) ist kein Superadmin. ` +
        "Diese Prod-Korrektur ist auf Superadmins beschränkt.",
    );
  }
}

/** Grober Schutz gegen versehentliches --apply gegen eine Wegwerf-/Test-DB. */
function assertNotTestDatabase(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (/cc_test_|_ephemeral|localhost:5(0|4)\d\d/.test(url)) {
    throw new Error(
      "--apply gegen eine augenscheinliche Test-/Ephemeral-DB verweigert. " +
        "Bitte im echten Produktionsumfeld ausführen.",
    );
  }
}

/**
 * Der scharfe Lauf gehört ausschließlich in die Replit-Prod-Umgebung. Aus der
 * Hetzner-Umgebung (`STORAGE_DRIVER=local`, FS-Treiber) landeten Storno- und
 * Neuausstellungs-PDF im falschen Objektspeicher — die Rechnung existierte dann
 * in der DB, ihr PDF aber nirgends, wo Prod es findet.
 */
function assertReplitObjectStorage(): void {
  const driver = (process.env.STORAGE_DRIVER ?? "replit").toLowerCase();
  if (driver !== "replit") {
    throw new Error(
      `--apply verweigert: STORAGE_DRIVER="${driver}" — das ist nicht die Replit-Prod-Umgebung.\n` +
        "  Storno- und Neuausstellungs-PDF sind objektspeicher-gebunden; ein Lauf aus der\n" +
        "  Hetzner-Umgebung (STORAGE_DRIVER=local) legte sie im falschen Bucket ab.\n" +
        "  Diese Korrektur ausschließlich in Replit-Prod scharf schalten (#1894).",
    );
  }
}

// ---------------------------------------------------------------------------
// Phase A — Kassenfenster korrigieren
// ---------------------------------------------------------------------------

interface WindowRow {
  id: number;
  insuranceProviderId: number;
  versichertennummer: string;
  validFrom: string;
  validTo: string | null;
  providerName: string;
  providerIk: string | null;
}

async function loadNaglerWindows(executor: DbOrTx): Promise<WindowRow[]> {
  const rows = await executor
    .select({
      id: customerInsuranceHistory.id,
      insuranceProviderId: customerInsuranceHistory.insuranceProviderId,
      versichertennummer: customerInsuranceHistory.versichertennummer,
      validFrom: customerInsuranceHistory.validFrom,
      validTo: customerInsuranceHistory.validTo,
      providerName: insuranceProviders.name,
      providerIk: insuranceProviders.ikNummer,
    })
    .from(customerInsuranceHistory)
    .innerJoin(
      insuranceProviders,
      eq(insuranceProviders.id, customerInsuranceHistory.insuranceProviderId),
    )
    .where(eq(customerInsuranceHistory.customerId, CUSTOMER_ID));
  return rows.map((r) => ({
    ...r,
    validFrom: String(r.validFrom),
    validTo: r.validTo === null ? null : String(r.validTo),
  }));
}

function describeWindow(w: WindowRow): string {
  return `#${w.id} ${w.providerName} (IK ${w.providerIk ?? "—"}, VNr ${w.versichertennummer}) ` +
    `${w.validFrom} → ${w.validTo ?? "offen"}`;
}

/** True, wenn beide Zeilen bereits exakt im Zielzustand sind. */
function windowsAtTarget(rows: WindowRow[]): boolean {
  const ikk = rows.find((r) => r.id === ROW_IKK.id);
  const aok = rows.find((r) => r.id === ROW_AOK.id);
  return (
    !!ikk && !!aok &&
    ikk.validFrom === ROW_IKK.targetFrom && ikk.validTo === ROW_IKK.targetTo &&
    aok.validFrom === ROW_AOK.targetFrom && aok.validTo === ROW_AOK.targetTo
  );
}

/**
 * Prüft die erwarteten Ist-Werte. Bei JEDER Abweichung harter Abbruch mit
 * Ausgabe des tatsächlich Vorgefundenen — die Korrektur rät nicht.
 */
function assertExpectedWindowState(rows: WindowRow[]): void {
  const problems: string[] = [];

  if (rows.length !== 2) {
    problems.push(`Erwartet: genau 2 Kassenzeilen. Vorgefunden: ${rows.length}.`);
  }

  for (const spec of [ROW_IKK, ROW_AOK] as const) {
    const row = rows.find((r) => r.id === spec.id);
    if (!row) {
      problems.push(`Zeile #${spec.id} (IK ${spec.ikNummer}) fehlt.`);
      continue;
    }
    if (row.providerIk !== spec.ikNummer) {
      problems.push(
        `Zeile #${spec.id}: erwartete IK ${spec.ikNummer}, vorgefunden ${row.providerIk ?? "—"} (${row.providerName}).`,
      );
    }
    if (row.validFrom !== spec.expectedFrom) {
      problems.push(`Zeile #${spec.id}: erwartetes „gültig ab" ${spec.expectedFrom}, vorgefunden ${row.validFrom}.`);
    }
    if (row.validTo !== spec.expectedTo) {
      problems.push(
        `Zeile #${spec.id}: erwartetes „gültig bis" ${spec.expectedTo ?? "offen"}, vorgefunden ${row.validTo ?? "offen"}.`,
      );
    }
    if (row.versichertennummer !== VERSICHERTENNUMMER) {
      problems.push(
        `Zeile #${spec.id}: erwartete VNr ${VERSICHERTENNUMMER}, vorgefunden ${row.versichertennummer}.`,
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      "Abbruch Phase A — der Ist-Zustand weicht von der Arbeitsanweisung ab:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n  Bitte den Befund fachlich klären, statt zu raten.",
    );
  }
}

async function correctWindowsTx(
  tx: Tx,
  audit: TxAuditRecorder,
  userId: number,
  reason: string,
  before: WindowRow[],
): Promise<WindowRow[]> {
  // Beide Zeilen in EINER Transaktion — für die Einzelschritt-Validierung des
  // #1893-Schreibpfads gibt es keine zulässige Reihenfolge (siehe Datei-Kopf).
  for (const spec of [ROW_IKK, ROW_AOK] as const) {
    await tx
      .update(customerInsuranceHistory)
      .set({ validFrom: spec.targetFrom, validTo: spec.targetTo })
      .where(eq(customerInsuranceHistory.id, spec.id));
  }

  const after = await loadNaglerWindows(tx);

  // Die RESULTIERENDE Menge einmal gegen die SSoT prüfen — 01.-Regel,
  // Überlappungs- und Lückenfreiheit. Keine zweite Regel-Kopie.
  const setError = validateInsuranceWindows(
    after.map<InsuranceWindow>((r) => ({ id: r.id, validFrom: r.validFrom, validTo: r.validTo })),
  );
  if (setError) {
    throw new Error(
      `Abbruch Phase A: die korrigierte Fenster-Menge ist unzulässig — ${setError}`,
    );
  }

  // Gegenprobe am fachlichen Kern: Mai muss IKK sein, Juni AOK.
  const maiAsOf = billingPeriodAsOfISO(BILLING_YEAR, BILLING_MONTH);
  const maiWin = pickInsuranceWindowAt(after, maiAsOf);
  const juniWin = pickInsuranceWindowAt(after, billingPeriodAsOfISO(2026, 6));
  if (maiWin?.providerIk !== ROW_IKK.ikNummer) {
    throw new Error(
      `Abbruch Phase A: Stichtag ${maiAsOf} (Mai) löst auf ${maiWin?.providerName ?? "—"} auf, erwartet IKK classic.`,
    );
  }
  if (juniWin?.providerIk !== ROW_AOK.ikNummer) {
    throw new Error(
      `Abbruch Phase A: Stichtag Juni löst auf ${juniWin?.providerName ?? "—"} auf, erwartet AOK Plus.`,
    );
  }

  for (const spec of [ROW_IKK, ROW_AOK] as const) {
    const b = before.find((r) => r.id === spec.id)!;
    audit.record({
      userId,
      // Dieselbe Action wie der #1893-Korrektur-Endpunkt (PATCH auf eine
      // bestehende Kassen-Zuordnung) — kein neuer Enum-Wert für dieselbe
      // fachliche Operation. Die Unterscheidung trägt `metadata.task`.
      action: "customer_updated",
      entityType: "customer",
      entityId: CUSTOMER_ID,
      metadata: {
        task: "#1894",
        reason,
        insuranceHistoryId: spec.id,
        providerIk: spec.ikNummer,
        from: { validFrom: b.validFrom, validTo: b.validTo },
        to: { validFrom: spec.targetFrom, validTo: spec.targetTo },
        korrekturGrund:
          "Kassenwechsel stand auf dem 08.06. statt dem Monatsersten; beide Zeilen überlappten an diesem Randtag.",
      },
    });
  }

  return after;
}

async function phaseFenster(args: Args, userId: number, reason: string): Promise<void> {
  console.log("\n=== Phase A · Kassenfenster ===");

  const before = await loadNaglerWindows(db);
  console.log("[VORHER]");
  for (const w of before) console.log(`  ${describeWindow(w)}`);

  if (windowsAtTarget(before)) {
    console.log("\n  ✓ Bereits im Zielzustand — nichts zu tun (idempotent übersprungen).");
    return;
  }

  assertExpectedWindowState(before);

  console.log("\n[ZIEL]");
  console.log(`  #${ROW_IKK.id} IKK classic  ${ROW_IKK.targetFrom} → ${ROW_IKK.targetTo}`);
  console.log(`  #${ROW_AOK.id} AOK Plus     ${ROW_AOK.targetFrom} → offen`);

  let after: WindowRow[] | undefined;
  try {
    await withAudit(async (tx, audit) => {
      after = await correctWindowsTx(tx, audit, userId, reason, before);
      if (!args.apply) throw new DryRunRollback();
    }, {});
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  console.log(`\n[${args.apply ? "AUSGEFÜHRT" : "SIMULIERT"}]`);
  for (const w of after ?? []) console.log(`  ${describeWindow(w)}`);
  console.log("  ✓ Fenster-Menge zulässig (01.-Regel, überlappungs- und lückenfrei).");
  console.log("  ✓ Mai löst auf IKK classic auf, Juni auf AOK Plus.");
}

// ---------------------------------------------------------------------------
// Phase B — Storno der Mai-Rechnung
// ---------------------------------------------------------------------------

interface InvoiceState {
  id: number;
  invoiceNumber: string;
  status: string;
  invoiceType: string;
  billingYear: number;
  billingMonth: number;
  grossAmountCents: number;
  insuranceProviderName: string | null;
  insuranceIkNummer: string | null;
  billingRunId: string | null;
  budgetType: string | null;
}

async function loadInvoice(id: number): Promise<InvoiceState | undefined> {
  const [row] = await db
    .select({
      id: invoicesTable.id,
      invoiceNumber: invoicesTable.invoiceNumber,
      status: invoicesTable.status,
      invoiceType: invoicesTable.invoiceType,
      billingYear: invoicesTable.billingYear,
      billingMonth: invoicesTable.billingMonth,
      grossAmountCents: invoicesTable.grossAmountCents,
      insuranceProviderName: invoicesTable.insuranceProviderName,
      insuranceIkNummer: invoicesTable.insuranceIkNummer,
      billingRunId: invoicesTable.billingRunId,
      budgetType: invoicesTable.budgetType,
      customerId: invoicesTable.customerId,
    })
    .from(invoicesTable)
    .where(eq(invoicesTable.id, id))
    .limit(1);
  if (!row) return undefined;
  if (row.customerId !== CUSTOMER_ID) {
    throw new Error(
      `Abbruch: Rechnung #${id} gehört zu Kunde ${row.customerId}, erwartet ${CUSTOMER_ID} (Nagler).`,
    );
  }
  return {
    ...row,
    billingRunId: row.billingRunId === null ? null : String(row.billingRunId),
  };
}

/** Keine Zahlung darf an der zu stornierenden Rechnung hängen (#1894). */
async function assertNoPaymentLinked(invoiceId: number): Promise<void> {
  const [qonto] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(qontoTransactions)
    .where(eq(qontoTransactions.matchedInvoiceId, invoiceId));
  const [advice] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentAdviceItems)
    .where(eq(paymentAdviceItems.matchedInvoiceId, invoiceId));
  const qontoCount = Number(qonto?.n ?? 0);
  const adviceCount = Number(advice?.n ?? 0);
  if (qontoCount > 0 || adviceCount > 0) {
    throw new Error(
      `Abbruch Phase B: an Rechnung #${invoiceId} hängt eine Zahlung ` +
        `(Qonto-Transaktionen: ${qontoCount}, Zahlungsavis-Positionen: ${adviceCount}).\n` +
        "  Die Arbeitsanweisung geht von KEINER Zahlung aus — ein Storno würde die\n" +
        "  Zahlungszuordnung ins Leere laufen lassen. Bitte fachlich klären.",
    );
  }
  console.log("  ✓ Keine Zahlung verknüpft (Qonto 0, Zahlungsavis 0).");
}

/**
 * Der Storno darf keine lebenden Geschwister-Rechnungen desselben Laufs
 * übersehen — sonst erzeugte die Neuausstellung ein Duplikat. Die Anweisung
 * nennt genau EINE Mai-Rechnung; alles andere ist ein Abweichungsfall.
 */
async function assertNoLiveSiblings(inv: InvoiceState): Promise<void> {
  if (inv.billingRunId === null) {
    console.log("  ✓ Einzelrechnung (kein billing_run_id-Split).");
    return;
  }
  const siblings = await db
    .select({ id: invoicesTable.id, invoiceNumber: invoicesTable.invoiceNumber, budgetType: invoicesTable.budgetType })
    .from(invoicesTable)
    .where(
      and(
        eq(invoicesTable.billingRunId, inv.billingRunId),
        ne(invoicesTable.id, inv.id),
        ne(invoicesTable.status, "storniert"),
        ne(invoicesTable.invoiceType, "stornorechnung"),
      ),
    );
  if (siblings.length > 0) {
    throw new Error(
      `Abbruch Phase B: Rechnung #${inv.id} gehört zu einem Topf-Split mit ${siblings.length} ` +
        `weiteren lebenden Rechnung(en):\n` +
        siblings.map((s) => `  - ${s.invoiceNumber} (#${s.id}, Topf ${s.budgetType ?? "privat"})`).join("\n") +
        "\n  Die Arbeitsanweisung nennt genau eine Mai-Rechnung. Bitte fachlich klären.",
    );
  }
  console.log("  ✓ Keine lebenden Geschwister-Rechnungen im selben Lauf.");
}

function assertExpectedInvoiceState(inv: InvoiceState): void {
  const problems: string[] = [];
  if (inv.invoiceNumber !== INVOICE_NUMBER) {
    problems.push(`Rechnungsnummer: erwartet ${INVOICE_NUMBER}, vorgefunden ${inv.invoiceNumber}.`);
  }
  if (inv.billingYear !== BILLING_YEAR || inv.billingMonth !== BILLING_MONTH) {
    problems.push(
      `Abrechnungszeitraum: erwartet ${BILLING_MONTH}/${BILLING_YEAR}, ` +
        `vorgefunden ${inv.billingMonth}/${inv.billingYear}.`,
    );
  }
  if (inv.status !== "versendet") {
    problems.push(`Status: erwartet „versendet", vorgefunden „${inv.status}".`);
  }
  if (inv.invoiceType === "stornorechnung") {
    problems.push("Rechnungstyp ist bereits eine Stornorechnung.");
  }
  if (inv.grossAmountCents !== INVOICE_GROSS_CENTS) {
    problems.push(
      `Bruttobetrag: erwartet ${eur(INVOICE_GROSS_CENTS)}, vorgefunden ${eur(inv.grossAmountCents)}.`,
    );
  }
  if (!(inv.insuranceProviderName ?? "").toUpperCase().includes("AOK")) {
    problems.push(
      `Empfänger: erwartet die fehladressierte AOK, vorgefunden „${inv.insuranceProviderName ?? "—"}".`,
    );
  }
  if (problems.length > 0) {
    throw new Error(
      "Abbruch Phase B — der Ist-Zustand der Rechnung weicht ab:\n" +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

async function phaseStorno(args: Args, userId: number, reason: string): Promise<void> {
  console.log("\n=== Phase B · Storno der Mai-Rechnung ===");

  const inv = await loadInvoice(INVOICE_ID);
  if (!inv) throw new Error(`Abbruch: Rechnung #${INVOICE_ID} (${INVOICE_NUMBER}) nicht gefunden.`);

  console.log("[VORHER]");
  console.log(
    `  ${inv.invoiceNumber} (#${inv.id}) [${inv.status}] ${inv.billingMonth}/${inv.billingYear} ` +
      `brutto=${eur(inv.grossAmountCents)} Topf=${inv.budgetType ?? "—"}`,
  );
  console.log(`  Empfänger: ${inv.insuranceProviderName ?? "—"} (IK ${inv.insuranceIkNummer ?? "—"})`);

  if (inv.status === "storniert") {
    console.log("\n  ✓ Bereits storniert — nichts zu tun (idempotent übersprungen).");
    return;
  }

  assertExpectedInvoiceState(inv);
  await assertNoPaymentLinked(inv.id);
  await assertNoLiveSiblings(inv);

  let stornoId: number | undefined;
  let stornoNumber: string | undefined;
  try {
    await withAudit(async (tx, audit) => {
      const res = await stornoInvoiceCascade(tx, audit, {
        rootInvoiceId: INVOICE_ID,
        // Geschwister sind oben ausgeschlossen — kein Cascade nötig.
        cascadeRun: false,
        userId,
        auditMetadataExtra: {
          task: "#1894",
          reason,
          korrekturGrund:
            "Mai 2026 ging an AOK PLUS statt an die im Mai gültige IKK classic (Kostenträger-Stichtag vor #1893).",
        },
      });
      stornoId = res.mainStornoInvoice.id;
      stornoNumber = res.mainStornoInvoiceNumber;
      if (!args.apply) throw new DryRunRollback();
    }, {});
  } catch (err) {
    if (!(err instanceof DryRunRollback)) throw err;
  }

  console.log(`\n[${args.apply ? "AUSGEFÜHRT" : "SIMULIERT"}]`);
  console.log(`  Stornorechnung ${stornoNumber} (#${stornoId}) angelegt, Original → storniert.`);
  console.log("  Budget-Rückbuchung der Termin-Konsumptionen erfolgt (Storno-SSoT).");

  if (!args.apply) {
    console.log("  (Trockenlauf: zurückgerollt, kein PDF erzeugt.)");
    return;
  }

  // PDF außerhalb der Transaktion — analog zum kanonischen Route-Pfad.
  if (stornoId !== undefined) {
    await persistInvoicePdf(stornoId);
    console.log(`  ✓ Storno-PDF persistiert (#${stornoId}).`);
  }
  console.log(
    "  Hinweis: Die Stornorechnung steht — wie im kanonischen Storno-Weg — auf Status\n" +
      "  'entwurf'. Der Versand an den Kostenträger ist ein eigener, fachlich zu\n" +
      "  entscheidender Schritt (#1894 sieht ihn nicht vor).",
  );
}

// ---------------------------------------------------------------------------
// Phase C — Neuausstellung Mai 2026
// ---------------------------------------------------------------------------

async function phaseNeuausstellung(args: Args, userId: number): Promise<void> {
  console.log("\n=== Phase C · Neuausstellung Mai 2026 ===");

  // Vorbedingung: das Original MUSS storniert sein, sonst entstünde eine
  // Doppelabrechnung desselben Monats.
  const orig = await loadInvoice(INVOICE_ID);
  if (!orig) throw new Error(`Abbruch: Rechnung #${INVOICE_ID} nicht gefunden.`);
  if (orig.status !== "storniert") {
    throw new Error(
      `Abbruch Phase C: ${orig.invoiceNumber} steht auf „${orig.status}", erwartet „storniert". ` +
        "Phase B muss zuerst scharf gelaufen sein — sonst wäre der Mai doppelt abgerechnet.",
    );
  }

  // Vorbedingung: das Kassenfenster muss korrigiert sein, sonst adressiert der
  // Generator erneut falsch.
  const windows = await loadNaglerWindows(db);
  if (!windowsAtTarget(windows)) {
    throw new Error(
      "Abbruch Phase C: das Kassenfenster ist noch nicht im Zielzustand. " +
        "Phase A muss zuerst scharf gelaufen sein, sonst adressiert die neue Mai-Rechnung wieder falsch.",
    );
  }
  const asOf = billingPeriodAsOfISO(BILLING_YEAR, BILLING_MONTH);
  const expected = pickInsuranceWindowAt(windows, asOf);
  console.log(`  Stichtag ${asOf} → ${expected?.providerName} (IK ${expected?.providerIk})`);

  if (!args.apply) {
    console.log(
      "\n  (Trockenlauf: generateInvoiceCore wird NICHT ausgeführt — der Generator\n" +
        "   schreibt Rechnungen, Positionen, Budget-Buchungen und PDFs.)",
    );
    return;
  }

  const result = await generateInvoiceCore(
    { customerId: CUSTOMER_ID, billingMonth: BILLING_MONTH, billingYear: BILLING_YEAR },
    { userId, testFaults: new Set<string>() },
  );
  const created = "splitInvoices" in result ? result.invoices : [result];
  for (const inv of created) await persistInvoicePdf(inv.id);

  console.log(`\n[AUSGEFÜHRT] Erzeugte Rechnungen (${created.length}):`);
  let total = 0;
  for (const inv of created) {
    total += inv.grossAmountCents;
    console.log(
      `  - ${inv.invoiceNumber} [${inv.status}] Topf=${inv.budgetType ?? "—"} ` +
        `brutto=${eur(inv.grossAmountCents)} → ${inv.insuranceProviderName ?? "—"} ` +
        `(IK ${inv.insuranceIkNummer ?? "—"})`,
    );
  }

  // Abnahme: Empfänger IKK classic UND betragsgleich zum Original.
  const problems: string[] = [];
  for (const inv of created) {
    if (inv.insuranceIkNummer !== ROW_IKK.ikNummer) {
      problems.push(
        `${inv.invoiceNumber}: Empfänger-IK ${inv.insuranceIkNummer ?? "—"}, erwartet ${ROW_IKK.ikNummer} (IKK classic).`,
      );
    }
  }
  if (total !== INVOICE_GROSS_CENTS) {
    problems.push(
      `Σ Brutto ${eur(total)} weicht vom Original ${eur(INVOICE_GROSS_CENTS)} ab ` +
        `(Differenz ${eur(total - INVOICE_GROSS_CENTS)}).`,
    );
  }
  if (problems.length > 0) {
    console.error("\n  ✗ ABNAHME FEHLGESCHLAGEN:");
    for (const p of problems) console.error(`    - ${p}`);
    throw new Error("Phase C: Abnahmeprüfung fehlgeschlagen — bitte prüfen, bevor versendet wird.");
  }
  console.log(`\n  ✓ Empfänger IKK classic, Σ Brutto ${eur(total)} = Original.`);
}

// ---------------------------------------------------------------------------
// Phase D — Bestandsscan (read-only)
// ---------------------------------------------------------------------------

interface ScanFinding {
  customerId: number;
  customerName: string;
  invoiceNumber: string;
  billingPeriod: string;
  stamped: string;
  stampedIk: string | null;
  valid: string;
  validIk: string | null;
  kind: "echter-wechsel" | "stammsatz-duplikat";
}

interface HistoryDefect {
  customerId: number;
  customerName: string;
  ssotError: string;
  gaps: string[];
  overlaps: string[];
  nonFirstStarts: string[];
}

function normalizeName(s: string | null): string {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function phaseScan(): Promise<void> {
  console.log("\n=== Phase D · Bestandsscan (read-only, keine Korrektur) ===");

  // Alle Kunden mit mehr als einer Kassenzuordnung.
  const multi = await db
    .select({
      customerId: customerInsuranceHistory.customerId,
      n: sql<number>`count(*)::int`,
    })
    .from(customerInsuranceHistory)
    .groupBy(customerInsuranceHistory.customerId)
    .having(sql`count(*) > 1`);

  const customerIds = multi.map((m) => m.customerId);
  console.log(`  Kunden mit >1 Kassenzuordnung: ${customerIds.length}`);
  if (customerIds.length === 0) return;

  const custRows = await db
    .select({ id: customers.id, name: customers.name })
    .from(customers)
    .where(inArray(customers.id, customerIds));
  const nameById = new Map(custRows.map((c) => [c.id, c.name ?? `Kunde ${c.id}`]));

  const histRows = await db
    .select({
      customerId: customerInsuranceHistory.customerId,
      id: customerInsuranceHistory.id,
      validFrom: customerInsuranceHistory.validFrom,
      validTo: customerInsuranceHistory.validTo,
      providerName: insuranceProviders.name,
      providerIk: insuranceProviders.ikNummer,
    })
    .from(customerInsuranceHistory)
    .innerJoin(
      insuranceProviders,
      eq(insuranceProviders.id, customerInsuranceHistory.insuranceProviderId),
    )
    .where(inArray(customerInsuranceHistory.customerId, customerIds));

  const byCustomer = new Map<number, typeof histRows>();
  for (const r of histRows) {
    const list = byCustomer.get(r.customerId) ?? [];
    list.push(r);
    byCustomer.set(r.customerId, list);
  }

  // --- D1: gestempelter vs. zeitraumgültiger Kostenträger -------------------
  const invRows = await db
    .select({
      id: invoicesTable.id,
      customerId: invoicesTable.customerId,
      invoiceNumber: invoicesTable.invoiceNumber,
      billingYear: invoicesTable.billingYear,
      billingMonth: invoicesTable.billingMonth,
      insuranceProviderName: invoicesTable.insuranceProviderName,
      insuranceIkNummer: invoicesTable.insuranceIkNummer,
    })
    .from(invoicesTable)
    .where(
      and(
        inArray(invoicesTable.customerId, customerIds),
        isNotNull(invoicesTable.insuranceProviderName),
        ne(invoicesTable.invoiceType, "stornorechnung"),
        ne(invoicesTable.status, "storniert"),
      ),
    );

  const findings: ScanFinding[] = [];
  for (const inv of invRows) {
    const windows = byCustomer.get(inv.customerId);
    if (!windows) continue;
    const asOf = billingPeriodAsOfISO(inv.billingYear, inv.billingMonth);
    const valid = pickInsuranceWindowAt(
      windows.map((w) => ({ ...w, validFrom: String(w.validFrom), validTo: w.validTo === null ? null : String(w.validTo) })),
      asOf,
    );
    if (!valid) continue;

    const sameIk =
      inv.insuranceIkNummer !== null &&
      valid.providerIk !== null &&
      inv.insuranceIkNummer === valid.providerIk;
    if (sameIk) continue;

    const sameName = normalizeName(inv.insuranceProviderName) === normalizeName(valid.providerName);
    if (sameName && inv.insuranceIkNummer === valid.providerIk) continue;

    findings.push({
      customerId: inv.customerId,
      customerName: nameById.get(inv.customerId) ?? `Kunde ${inv.customerId}`,
      invoiceNumber: inv.invoiceNumber,
      billingPeriod: `${String(inv.billingMonth).padStart(2, "0")}/${inv.billingYear}`,
      stamped: inv.insuranceProviderName ?? "—",
      stampedIk: inv.insuranceIkNummer,
      valid: valid.providerName,
      validIk: valid.providerIk,
      // Gleicher Name (nur Schreibweise) ODER gleiche IK ⇒ Stammsatz-Duplikat,
      // kein echter Kassenwechsel.
      kind: sameName || sameIk ? "stammsatz-duplikat" : "echter-wechsel",
    });
  }

  const echte = findings.filter((f) => f.kind === "echter-wechsel");
  const dupes = findings.filter((f) => f.kind === "stammsatz-duplikat");

  console.log(`\n  [D1] Abweichung gestempelter vs. zeitraumgültiger Kostenträger: ${findings.length}`);
  console.log(`\n  ECHTER WECHSEL (fachlich relevant): ${echte.length}`);
  for (const f of echte) {
    console.log(
      `    - Kunde ${f.customerId} ${f.customerName} · ${f.invoiceNumber} (${f.billingPeriod})\n` +
        `        gestempelt: ${f.stamped} (IK ${f.stampedIk ?? "—"})\n` +
        `        gültig:     ${f.valid} (IK ${f.validIk ?? "—"})`,
    );
  }
  console.log(`\n  STAMMSATZ-DUPLIKAT (nur Schreibweise/Doppel-Stammsatz, NICHT stornieren): ${dupes.length}`);
  for (const f of dupes) {
    console.log(
      `    - Kunde ${f.customerId} ${f.customerName} · ${f.invoiceNumber} (${f.billingPeriod}): ` +
        `„${f.stamped}" vs. „${f.valid}"`,
    );
  }

  // --- D2: Lücken/Defekte in der Kassenhistorie -----------------------------
  // Die Zulässigkeits-ENTSCHEIDUNG trifft die SSoT `validateInsuranceWindows`.
  // Die Aufschlüsselung darunter ist reine Berichts-Detaillierung für die
  // Long-List — kein zweiter Entscheidungspfad.
  const defects: HistoryDefect[] = [];
  for (const [customerId, rows] of byCustomer) {
    const windows: InsuranceWindow[] = rows.map((r) => ({
      id: r.id,
      validFrom: String(r.validFrom),
      validTo: r.validTo === null ? null : String(r.validTo),
    }));
    const ssotError = validateInsuranceWindows(windows);
    if (!ssotError) continue;

    const sorted = [...windows].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const gaps: string[] = [];
    const overlaps: string[] = [];
    const nonFirstStarts: string[] = [];
    for (const w of sorted) {
      if (!isMonthStartISO(w.validFrom)) nonFirstStarts.push(`#${w.id} beginnt am ${w.validFrom}`);
    }
    for (let i = 0; i < sorted.length - 1; i++) {
      const prev = sorted[i];
      const next = sorted[i + 1];
      if (prev.validTo === null) continue;
      if (prev.validTo >= next.validFrom) {
        overlaps.push(`#${prev.id} (bis ${prev.validTo}) ⇄ #${next.id} (ab ${next.validFrom})`);
      } else if (prev.validTo !== dayBeforeISO(next.validFrom)) {
        gaps.push(`${prev.validTo} → ${next.validFrom} (erwartetes Ende: ${dayBeforeISO(next.validFrom)})`);
      }
    }
    defects.push({
      customerId,
      customerName: nameById.get(customerId) ?? `Kunde ${customerId}`,
      ssotError,
      gaps,
      overlaps,
      nonFirstStarts,
    });
  }

  const withGaps = defects.filter((d) => d.gaps.length > 0);
  console.log(`\n  [D2] Kassenhistorien, die die #1893-Regeln verletzen: ${defects.length}`);
  console.log(`       davon mit ECHTER LÜCKE (kostenträgerfreie Tage): ${withGaps.length}`);
  for (const d of defects) {
    console.log(`    - Kunde ${d.customerId} ${d.customerName}: ${d.ssotError}`);
    for (const g of d.gaps) console.log(`        LÜCKE:       ${g}`);
    for (const o of d.overlaps) console.log(`        Überlappung: ${o}`);
    for (const n of d.nonFirstStarts) console.log(`        Nicht-01.:   ${n}`);
  }

  if (withGaps.length > 0) {
    console.log(
      `\n  ⚠ ${withGaps.length} Kunde(n) mit echten Lücken → Warn-Follow-up zu #1893 nötig\n` +
        "    (der Stichtags-Resolver liefert für Tage in einer Lücke KEINEN Kostenträger).",
    );
  } else {
    console.log("\n  ✓ Keine echten Lücken in Prod — der Long-List-Punkt ist damit beantwortet.");
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();

  if (args.apply) {
    if (args.phase === "alle" || args.phase === "scan") {
      console.error(
        "Fehler: --apply erfordert eine EINZELNE schreibende Phase " +
          "(--phase=fenster | storno | neu).\n" +
          "  Jeder Schritt wird einzeln fachlich freigegeben (#1894).",
      );
      process.exit(1);
    }
    if (process.env.NODE_ENV !== "production") {
      console.error("Fehler: --apply ist nur mit NODE_ENV=production erlaubt.");
      process.exit(1);
    }
    if (args.userId === undefined) {
      console.error("Fehler: --apply erfordert --user=<superadmin-id> für die GoBD-Audit-Attribution.");
      process.exit(1);
    }
    if (!args.reason || args.reason.length < 10) {
      console.error('Fehler: --apply erfordert --reason="…" (≥10 Zeichen Begründung für den Audit-Log).');
      process.exit(1);
    }
    assertNotTestDatabase();
    assertReplitObjectStorage();
    await assertSuperadminOrThrow(args.userId);
  }

  console.log(`\n=== Nagler (Kunde ${CUSTOMER_ID}) · Mai ${BILLING_YEAR} → IKK classic · Task #1894 ===`);
  console.log(`Modus:      ${args.apply ? "SCHARF (--apply)" : "Trockenlauf (read-only, Rollback)"}`);
  console.log(`Phase:      ${args.phase}`);
  if (args.userId !== undefined) console.log(`Superadmin: ${args.userId}`);
  if (args.reason) console.log(`Begründung: ${args.reason}`);

  const [cust] = await db
    .select({ id: customers.id, name: customers.name, billingType: customers.billingType })
    .from(customers)
    .where(eq(customers.id, CUSTOMER_ID))
    .limit(1);
  if (!cust) throw new Error(`Kunde ${CUSTOMER_ID} nicht gefunden.`);
  if (!(cust.name ?? "").includes(CUSTOMER_NAME_FRAGMENT)) {
    throw new Error(
      `Abbruch: Kunde ${CUSTOMER_ID} heißt „${cust.name ?? "—"}", erwartet „${CUSTOMER_NAME_FRAGMENT}". ` +
        "Die Fallkonstanten passen nicht zu dieser Datenbank.",
    );
  }
  console.log(`Kunde:      #${cust.id} ${cust.name} (${cust.billingType})`);

  const userId = args.userId ?? 0;
  const reason = args.reason ?? "Trockenlauf (nicht persistiert)";
  const run = (p: Phase) => args.phase === "alle" || args.phase === p;

  if (run("fenster")) await phaseFenster(args, userId, reason);
  if (run("storno")) await phaseStorno(args, userId, reason);
  if (run("neu")) await phaseNeuausstellung(args, userId);
  if (run("scan") || args.phase === "alle") await phaseScan();

  if (!args.apply) {
    console.log(
      "\nTrockenlauf abgeschlossen — nichts geschrieben.\n" +
        "Scharf (nur Replit-Prod, Phase für Phase):\n" +
        '  NODE_ENV=production tsx server/scripts/fix-nagler-50-mai-kostentraeger.ts \\\n' +
        '    --apply --phase=fenster --user=<superadmin-id> --reason="…"',
    );
  } else {
    console.log(`\nPhase „${args.phase}" abgeschlossen.`);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Fehler:", err);
    process.exit(1);
  });
}
