/**
 * Task #1785 P4 — §45b-Kürzung (Superadmin): EINE ausgestellte §45b-Rechnung
 * wird auf den tatsächlich von der Pflegekasse gezahlten Betrag (Y < X) gekürzt.
 * Der Überhang (X−Y) wird GoBD-konform (Storno + §45b-Reset #1812 + Neu-Buchung
 * + Re-Rechnung) in EINEN Ziel-Topf umgebucht.
 *
 * Deckt die vier fachlichen Kernpfade der SSoT `reduceInvoice45bToPaidAmount` ab:
 *   1. Ziel §45a (Kasse-Topf): Storno + Split-Re-Rechnung (§45b=Y + §45a=X−Y),
 *      §45b-Ledger nach der Re-Buchung netto null; gebundene Qonto-Zahlung ⇒
 *      Warnung zur manuellen Re-Zuordnung. Läuft über die HTTP-Route (Superadmin
 *      + Zod + Wiring).
 *   2. Ziel privat (Selbstzahler, 19% USt): Überhang wird zum Selbstzahler-Topf,
 *      die Re-Rechnung erzeugt eine Selbstzahler-Rechnung neben der gekürzten
 *      §45b-Kasse-Rechnung.
 *   3. Statutorischer Ziel-Topf zu klein ⇒ der Überhang passt nicht (kein
 *      Selbstzahler erlaubt) ⇒ `BudgetHardBlockError` in Tx#1 ⇒ ALLES rollback:
 *      die Original-Rechnung bleibt gültig, der §45b-Verbrauch unverändert.
 *
 * Kern-Invariante (fängt jede Anzeige-vs-Buchung-Drift): nach einer erfolgreichen
 * Kürzung gilt PRO TOPF `Σ(Live-Consumption im Ledger) === Σ(Netto der aktiven
 * Rechnungen)`, und der §45b-Verbrauch des Monats === Y.
 */
import { validSignatureDataUrl } from "../helpers/valid-signature";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { budgetTransactions, qontoTransactions } from "@shared/schema";
import {
  reduceInvoice45bToPaidAmount,
  type Reduce45bTargetPot,
} from "../../server/services/invoice-45b-reduction";
import {
  apiGet,
  apiPost,
  apiPatch,
  getAuthCookie,
  uniqueId,
  runCleanup,
} from "../test-utils";
import {
  setupBudgetScenario,
  type BudgetScenarioHandle,
} from "../helpers/budget-scenarios";
import { billingReferenceMonth, pastWeekdayInBillingMonth } from "../helpers/billing-month";

const POT_45B = "entlastungsbetrag_45b";
const POT_45A = "umwandlung_45a";

// Alltagsbegleitung = 4200 ct/h (siehe scripts/seed-test-reference-data.ts).
const APPT_MINUTES = 180;
const APPT_COST_CENTS = 12600; // 3h × 4200 — X, die ausgestellte §45b-Rechnung.
const PAID_CENTS = 9000; // Y — was die Kasse tatsächlich gezahlt hat.
const OVERFLOW_CENTS = APPT_COST_CENTS - PAID_CENTS; // 3600 → Ziel-Topf.

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
const handles: BudgetScenarioHandle[] = [];

interface ScenarioTypeSpec {
  type: typeof POT_45A | "ersatzpflege_39_42a";
  monthlyLimitCents?: number | null;
  yearlyLimitCents?: number | null;
}

/** Kassen-Kunde (PG3) mit §45b (Prio 1, seeded auf 131€) + optional einem
 *  Ziel-Topf; EIN 180-min-Termin ist dokumentiert und liegt (§45b-Cap ≥ Kosten)
 *  komplett in §45b. */
async function setupScenario(opts: {
  prefix: string;
  acceptsPrivatePayment: boolean;
  targetType?: ScenarioTypeSpec;
}): Promise<{ handle: BudgetScenarioHandle; date: string; year: number; month: number }> {
  const { year, month } = billingReferenceMonth();
  const monthStart = `${year}-${String(month).padStart(2, "0")}-01`;
  const date = pastWeekdayInBillingMonth();

  const types = [
    { type: POT_45B, enabled: true, priority: 1, monthlyLimitCents: 13100 },
    ...(opts.targetType
      ? [
          {
            type: opts.targetType.type,
            enabled: true,
            priority: 2,
            monthlyLimitCents:
              opts.targetType.monthlyLimitCents !== undefined
                ? opts.targetType.monthlyLimitCents
                : null,
            yearlyLimitCents:
              opts.targetType.yearlyLimitCents !== undefined
                ? opts.targetType.yearlyLimitCents
                : null,
          },
        ]
      : []),
  ];

  const handle = await setupBudgetScenario({
    customerNamePrefix: opts.prefix,
    pflegegrad: 3,
    billingType: "pflegekasse_gesetzlich",
    acceptsPrivatePayment: opts.acceptsPrivatePayment,
    types,
    initialBalance: { type: POT_45B, amountCents: 13100, validFrom: monthStart },
    appointments: [
      {
        date,
        scheduledStart: "09:00",
        services: [{ code: "alltagsbegleitung", durationMinutes: APPT_MINUTES }],
        document: true,
      },
    ],
  });
  handles.push(handle);
  return { handle, date, year, month };
}

/** Erstellt + signiert (Mitarbeiter + Kunde) den monatlichen Leistungsnachweis. */
async function createAndSignSr(
  customerId: number,
  employeeId: number,
  year: number,
  month: number,
): Promise<void> {
  const cre = await apiPost<{ id: number }>("/api/service-records", {
    customerId,
    employeeId,
    year,
    month,
  });
  expect(cre.status, `SR create: ${JSON.stringify(cre.data)}`).toBe(201);
  for (const signerType of ["employee", "customer"] as const) {
    const sig = await apiPost<unknown>(`/api/service-records/${cre.data.id}/sign`, {
      signerType,
      signatureData: validSignatureDataUrl(),
    });
    expect(sig.status, `SR sign(${signerType}): ${JSON.stringify(sig.data)}`).toBe(200);
  }
}

interface InvoiceRow {
  id: number;
  status: string;
  invoiceType: string | null;
  budgetType: string | null;
  billingType: string | null;
  netAmountCents: number | null;
}

async function listInvoices(customerId: number): Promise<InvoiceRow[]> {
  const list = await apiGet<InvoiceRow[]>(`/api/billing?customerId=${customerId}`);
  return Array.isArray(list.data) ? list.data : [];
}

async function activeInvoices(customerId: number): Promise<InvoiceRow[]> {
  return (await listInvoices(customerId)).filter(
    (i) => i.status !== "storniert" && i.invoiceType !== "stornorechnung",
  );
}

/** Generiert die Rechnung(en) des Monats und liefert die (einzige) §45b-Rechnung. */
async function generateAndGet45bInvoice(
  customerId: number,
  year: number,
  month: number,
): Promise<InvoiceRow> {
  const gen = await apiPost<Record<string, unknown>>("/api/billing/generate", {
    customerId,
    billingMonth: month,
    billingYear: year,
  });
  expect(gen.status, `generate: ${JSON.stringify(gen.data)}`).toBe(200);
  const active = await activeInvoices(customerId);
  const inv45b = active.find((i) => i.budgetType === POT_45B);
  expect(inv45b, `§45b-Rechnung nach Generierung vorhanden: ${JSON.stringify(active)}`).toBeTruthy();
  return inv45b!;
}

/** Setzt eine Entwurfs-Rechnung auf „versendet" (ausgestellt) — Voraussetzung
 *  für die Kürzung (Entwürfe/Stornierte werden abgelehnt). */
async function markIssued(invoiceId: number): Promise<void> {
  const res = await apiPatch<unknown>(`/api/billing/${invoiceId}/status`, {
    status: "versendet",
  });
  expect(res.status, `mark versendet: ${JSON.stringify(res.data)}`).toBe(200);
}

/** Live-Consumption (Consumption minus reversierte) für EINEN Topf. */
async function liveConsumptionCents(customerId: number, budgetType: string): Promise<number> {
  const consumptions = await db
    .select({ id: budgetTransactions.id, amountCents: budgetTransactions.amountCents })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, budgetType),
        eq(budgetTransactions.transactionType, "consumption"),
      ),
    );
  const reversals = await db
    .select({ ref: budgetTransactions.reversedTransactionId })
    .from(budgetTransactions)
    .where(
      and(
        eq(budgetTransactions.customerId, customerId),
        eq(budgetTransactions.budgetType, budgetType),
        eq(budgetTransactions.transactionType, "reversal"),
      ),
    );
  const reversedIds = new Set(reversals.map((r) => r.ref).filter((x): x is number => x !== null));
  return consumptions
    .filter((c) => !reversedIds.has(c.id))
    .reduce((sum, c) => sum + Math.abs(c.amountCents), 0);
}

beforeAll(async () => {
  auth = await getAuthCookie();
});

afterAll(async () => {
  for (const h of handles.reverse()) {
    try {
      await h.cleanup();
    } catch {
      // best-effort — Wegwerf-DB räumt ohnehin ab.
    }
  }
  await runCleanup();
});

describe("§45b-Kürzung: Storno + Reset + Umbuchung + Re-Rechnung (Task #1785 P4)", () => {
  it("Ziel §45a: kürzt auf Y, bucht Überhang nach §45a, Ledger pro Topf === aktive Rechnungen, Qonto-Warnung", async () => {
    const { handle, year, month } = await setupScenario({
      prefix: "Reduce45b-45a",
      acceptsPrivatePayment: false,
      targetType: { type: POT_45A, monthlyLimitCents: 59880 },
    });
    const customerId = handle.customerId;

    await createAndSignSr(customerId, handle.employeeId, year, month);
    const inv45b = await generateAndGet45bInvoice(customerId, year, month);
    expect(inv45b.netAmountCents, "§45b-Rechnung Netto = voller Termin (X)").toBe(APPT_COST_CENTS);
    await markIssued(inv45b.id);

    // Gebundene Qonto-Zahlung auf die §45b-Rechnung → muss als Warnung erscheinen.
    await db.insert(qontoTransactions).values({
      qontoTransactionId: `test-45b-reduction-${uniqueId()}`,
      amountCents: PAID_CENTS,
      side: "credit",
      emittedAt: new Date(),
      status: "completed",
      matchedInvoiceId: inv45b.id,
    });

    const red = await apiPost<Record<string, any>>(`/api/billing/${inv45b.id}/reduce-45b`, {
      paidCents: PAID_CENTS,
      targetPot: "umwandlung_45a" satisfies Reduce45bTargetPot,
    });
    expect(red.status, `reduce-45b: ${JSON.stringify(red.data)}`).toBe(200);
    const result = red.data;

    // Ergebnis-Objekt: Überhang + Re-Buchung + erfolgreiche Re-Rechnung.
    expect(result.overflowCents, "Überhang X−Y").toBe(OVERFLOW_CENTS);
    expect(result.rebooked45bCents, "§45b neu gebucht = Y").toBe(PAID_CENTS);
    expect(result.reissue.ok, `Re-Rechnung ok: ${JSON.stringify(result.reissue)}`).toBe(true);
    expect(result.reissue.invoiceIds.length, "Re-Rechnung = Split (§45b + §45a)").toBe(2);
    expect(result.storno.stornoInvoiceNumber, "Stornorechnung erzeugt").toBeTruthy();
    expect(
      (result.warnings as string[]).some((w) => w.includes("Qonto")),
      `Qonto-Warnung vorhanden: ${JSON.stringify(result.warnings)}`,
    ).toBe(true);

    // Original-Rechnung ist storniert.
    const all = await listInvoices(customerId);
    expect(all.find((i) => i.id === inv45b.id)?.status, "Original storniert").toBe("storniert");

    // Ledger pro Topf === aktive Rechnungen (kein Doppel-Spend / keine Drift).
    const active = await activeInvoices(customerId);
    const net45b = active
      .filter((i) => i.budgetType === POT_45B)
      .reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const net45a = active
      .filter((i) => i.budgetType === POT_45A)
      .reduce((s, i) => s + (i.netAmountCents ?? 0), 0);
    const ledger45b = await liveConsumptionCents(customerId, POT_45B);
    const ledger45a = await liveConsumptionCents(customerId, POT_45A);

    expect(ledger45b, "§45b-Verbrauch = Y").toBe(PAID_CENTS);
    expect(ledger45a, "§45a-Verbrauch = Überhang").toBe(OVERFLOW_CENTS);
    expect(net45b, "§45b: Σ Rechnungen === Ledger").toBe(ledger45b);
    expect(net45a, "§45a: Σ Rechnungen === Ledger").toBe(ledger45a);
  }, 180_000);

  it("Ziel privat: Überhang wird Selbstzahler-Rechnung (19% USt), §45b-Kasse-Rechnung auf Y gekürzt", async () => {
    const { handle, year, month } = await setupScenario({
      prefix: "Reduce45b-privat",
      acceptsPrivatePayment: true,
      // Kein statutorischer Ziel-Topf: Überhang muss in den Selbstzahler-Topf.
      targetType: undefined,
    });
    const customerId = handle.customerId;

    await createAndSignSr(customerId, handle.employeeId, year, month);
    const inv45b = await generateAndGet45bInvoice(customerId, year, month);
    expect(inv45b.netAmountCents, "§45b-Rechnung Netto = X").toBe(APPT_COST_CENTS);
    await markIssued(inv45b.id);

    const result = await reduceInvoice45bToPaidAmount({
      rootInvoiceId: inv45b.id,
      paidCents: PAID_CENTS,
      targetPot: "private",
      actor: { userId: auth.user.id, isSuperAdmin: auth.user.isSuperAdmin, ipAddress: "127.0.0.1" },
    });

    expect(result.overflowCents, "Überhang X−Y").toBe(OVERFLOW_CENTS);
    expect(result.rebooked45bCents, "§45b neu gebucht = Y").toBe(PAID_CENTS);
    expect(result.reissue.ok, `Re-Rechnung ok: ${JSON.stringify(result.reissue)}`).toBe(true);

    // Ledger: §45b = Y, privater Selbstzahler-Topf = Überhang.
    expect(await liveConsumptionCents(customerId, POT_45B), "§45b-Verbrauch = Y").toBe(PAID_CENTS);
    expect(await liveConsumptionCents(customerId, "private"), "privat-Verbrauch = Überhang").toBe(
      OVERFLOW_CENTS,
    );

    // Aktive Rechnungen: gekürzte §45b-Kasse-Rechnung + Selbstzahler-Rechnung.
    const active = await activeInvoices(customerId);
    const kasse45b = active.find((i) => i.budgetType === POT_45B);
    const selbstzahler = active.find((i) => i.billingType === "selbstzahler");
    expect(kasse45b?.netAmountCents, "gekürzte §45b-Rechnung Netto = Y").toBe(PAID_CENTS);
    expect(selbstzahler, `Selbstzahler-Rechnung vorhanden: ${JSON.stringify(active)}`).toBeTruthy();
    expect(selbstzahler?.netAmountCents, "Selbstzahler-Rechnung Netto = Überhang").toBe(OVERFLOW_CENTS);
  }, 180_000);

  it("statutorischer Ziel-Topf zu klein ⇒ Hard-Block ⇒ vollständiges Rollback (Original bleibt gültig)", async () => {
    // §45a-Limit (2.000 ct) < Überhang (3.600 ct); privat NICHT erlaubt ⇒ der
    // Rest kann nirgends hin → BudgetHardBlockError → Tx#1 rollback.
    const { handle, year, month } = await setupScenario({
      prefix: "Reduce45b-hardblock",
      acceptsPrivatePayment: false,
      targetType: { type: POT_45A, monthlyLimitCents: 2000 },
    });
    const customerId = handle.customerId;

    await createAndSignSr(customerId, handle.employeeId, year, month);
    const inv45b = await generateAndGet45bInvoice(customerId, year, month);
    await markIssued(inv45b.id);

    const before45b = await liveConsumptionCents(customerId, POT_45B);
    expect(before45b, "vor der Kürzung liegt der ganze Termin in §45b").toBe(APPT_COST_CENTS);

    await expect(
      reduceInvoice45bToPaidAmount({
        rootInvoiceId: inv45b.id,
        paidCents: PAID_CENTS,
        targetPot: "umwandlung_45a",
        actor: { userId: auth.user.id, isSuperAdmin: auth.user.isSuperAdmin, ipAddress: "127.0.0.1" },
      }),
    ).rejects.toThrow();

    // Rollback: Original-Rechnung unverändert gültig, §45b-Verbrauch unverändert.
    const all = await listInvoices(customerId);
    expect(all.find((i) => i.id === inv45b.id)?.status, "Original bleibt versendet").toBe("versendet");
    expect(
      await liveConsumptionCents(customerId, POT_45B),
      "§45b-Verbrauch unverändert nach Rollback",
    ).toBe(APPT_COST_CENTS);
  }, 180_000);
});
