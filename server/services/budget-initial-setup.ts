import { budgetStorage } from "../storage/budget-storage";
import type { DbClient } from "../storage/budget/types";
import type { BudgetAllocation } from "@shared/schema";
import { todayISO, parseLocalDate } from "@shared/utils/datetime";
import { formatEuroDE } from "@shared/utils/money";
import { floorAutoAnchor45bToCurrentYear } from "@shared/domain/budgets";
import { carryoverExpiresAtFor } from "@shared/domain/budget/expiry-45b";
import {
  eligible45bCarryoverMonths,
  max45bStartValueCents,
  max45bCarryoverCents,
  resolve45bAccrualAnchor,
} from "@shared/domain/budget/carryover-eligibility";
import { validateSelbstzahlerBudget } from "@shared/domain/budget-selbstzahler-validator";
import { validatePflegegradBudget } from "@shared/domain/budget-pflegegrad-validator";
import { getCustomerCareLevelHistory } from "../storage/customer-mgmt/care-level";
import { auditService } from "./audit";

/**
 * Typisierter Fehler des Initial-Budget-Setups. Trägt HTTP-Status + Wire-Code,
 * damit sowohl die Route (`POST /budget/:id/initial-budget`) als auch der
 * konsolidierte Kunden-Anlage-Flow (`POST /customers`) denselben Fehler in das
 * einheitliche Wire-Format (`error`/`code`/`message`) übersetzen können — ohne
 * dass diese reine Logik ein `res`-Objekt kennt.
 */
export class BudgetInitialSetupError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BudgetInitialSetupError";
  }
}

export interface ApplyInitialBudgetParams {
  customerId: number;
  budgetType: string;
  /**
   * Startwert fuer den Stichmonat. `null`/`undefined` = **keine Angabe**,
   * `0` = **festgestellte Null**.
   *
   * Die Unterscheidung ist fachlich, nicht kosmetisch (Alrik, 22.09.2026,
   * Inventur-Lesart): „0,00 EUR" heisst „aus dem Vorjahr ist nichts uebrig",
   * und das ist eine Aussage, kein leeres Feld. Vorher war der Typ
   * `number` und der Aufrufer schrieb `?? 0` — die Unterscheidung war damit
   * schon VOR dieser Funktion verloren.
   */
  currentMonthAmountCents?: number | null;
  /** Uebertrag aus dem Vorjahr. Dieselbe Semantik: `null` = keine Angabe. */
  carryoverAmountCents?: number | null;
  /** RAW-Anker (Pflegegrad-Beginn / Stichmonat), ungekappt. */
  budgetStartDate: string;
  /** Bereits geladene Kundenstammdaten für die Intent-Validierung. */
  customer: { billingType: string | null | undefined; pflegegrad: number | null | undefined };
  userId?: number;
  /** Optionale Tx — alle Schreibvorgänge laufen dann atomar im äußeren Commit. */
  tx?: DbClient;
  /** IP für das Audit-Log (optional). */
  ip?: string | null;
}

/**
 * SSoT für die Erfassung eines Startbudgets (`initial_balance` + §45b-Carryover
 * + Anker-Preferences) eines Budget-Topfes. Spiegelt 1:1 die Logik der Route
 * `POST /budget/:customerId/initial-budget`, wirft aber typisierte Fehler statt
 * `res`-Responses zu senden und honoriert eine optionale Transaktion.
 *
 * Verwendet von:
 *  - `routes/budget.ts` (Standalone-Route, übersetzt den Fehler in eine Response)
 *  - `lib/customer-creation-helpers.ts` (atomarer Kunden-Anlage-Flow, pro Topf)
 *
 * §45b-Kappung (Task #856/#860/#959) und die §45a/§39-In-place-Aktivierung
 * (Task #705/#876) sind hier zentralisiert — siehe Inline-Kommentare.
 */
/** `MM/JJJJ` fuer Fehlermeldungen — eine Stelle, damit die Form nicht driftet. */
function monatJahr(year: number, month: number): string {
  return `${String(month).padStart(2, "0")}/${year}`;
}

export async function applyInitialBudget(params: ApplyInitialBudgetParams): Promise<BudgetAllocation[]> {
  const { customerId, budgetType, customer, userId, tx } = params;
  const currentMonthAmountCents = params.currentMonthAmountCents ?? null;
  const carryoverAmountCents = params.carryoverAmountCents ?? null;
  const rawBudgetStartDate = params.budgetStartDate;

  // Selbstzahler-/Pflegegrad-Block via geteilte reine Validatoren (Task #705/
  // #716/#722). Wirft typisiert statt eine Response zu senden.
  const sz = validateSelbstzahlerBudget({
    billingType: customer.billingType,
    intent: { budgetType },
  });
  if (!sz.ok) throw new BudgetInitialSetupError(sz.httpStatus, sz.code, sz.message);
  const pg = validatePflegegradBudget({
    pflegegrad: customer.pflegegrad,
    intent: { budgetType },
  });
  if (!pg.ok) throw new BudgetInitialSetupError(pg.httpStatus, pg.code, pg.message);

  // §45b-Onboarding-Baseline: Startwert-/Carryover-Zeilen aufs laufende Jahr
  // boden (Task #860), identisch zum §45b-Lesepfad. Der RAW-Anker bleibt für
  // §45a/§39 in den Preferences erhalten.
  let budgetStartDate = rawBudgetStartDate;
  if (budgetType === "entlastungsbetrag_45b") {
    const now = parseLocalDate(todayISO());
    budgetStartDate = floorAutoAnchor45bToCurrentYear(budgetStartDate, now.getFullYear());
  }
  const startDate = parseLocalDate(budgetStartDate);
  const year = startDate.getFullYear();

  /**
   * ENTWEDER Startwert ODER Uebertrag — nie beides (Alrik, 24.09.2026).
   *
   * ── Warum das eine Ablehnung ist und keine Warnung ──────────────────────
   * Seit dem Scharfschalten der Inventur-Lesart verdraengt ein Startwert fuer
   * Monat M jede Zuweisung, deren Gueltigkeit vor M beginnt. Dieser Pfad
   * schreibt beide in EINER Transaktion: der Uebertrag traegt
   * `validFrom = ${year}-01-01` und `year = year`, der Startwert einen Monat
   * desselben Jahres — `displacedByReset` ist damit IMMER wahr.
   *
   * Gemessen: Startwert 100,00 EUR + Uebertrag 500,00 EUR ab 01/2026 ergaben
   * einen Anspruch von 755,00 EUR statt 1.255,00 EUR. Der Uebertrag war
   * eingegeben, gegen seinen eigenen Cap validiert, quittiert — und
   * wirkungslos.
   *
   * **Angenommen, quittiert, verworfen ist die schlechteste Kombination** —
   * derselbe Satz steht ein paar Zeilen tiefer schon einmal, fuer einen
   * anderen Fall. Eine Warnung waere hier zu wenig: der Anwender hat keine
   * Moeglichkeit, „beides" zu meinen.
   *
   * Fachlich: eine Inventur SCHLIESST den Uebertrag ein. Wer den Restbestand
   * kennt, nennt ihn; wer ihn nicht kennt, nennt den Uebertrag. Die Frage im
   * Assistenten lautet deshalb „Ist der aktuelle Restbestand bekannt
   * (Kassenauskunft)?".
   *
   * Hier und nicht im Client: der Client kann die Felder ausblenden, aber
   * `POST /initial-budget` ist ein eigener Weg (Drei-Schichten-Pflicht, #164).
   */
  if (
    budgetType === "entlastungsbetrag_45b"
    && currentMonthAmountCents != null
    // `> 0`, nicht `!= null` — ABWEICHUNG von der woertlichen Vorgabe
    // („beide gleichzeitig geht nicht mehr"), mit Absicht und Begruendung:
    //
    // Der Schaden, gegen den die Regel gebaut ist, heisst „stille
    // Verdraengung" — ein eingegebener Uebertrag wird validiert, quittiert und
    // ist wirkungslos. Bei einem 0-EUR-Uebertrag geht kein Wert verloren; die
    // Angabe heisst „aus dem Vorjahr ist nichts uebrig" und widerspricht der
    // Inventur nicht.
    //
    // Gemessen, was die kategorische Fassung kostete: `NS-4` (Alriks
    // 0-EUR-Entscheidung vom 22.09.2026 auf dem Schreibpfad) und der geteilte
    // Fixture-Helfer `tests/helpers/budget-scenarios.ts` uebergeben beide
    // grundsaetzlich einen 0-EUR-Uebertrag neben dem Startwert — vier
    // Testdateien fielen, keine davon wegen eines echten Konflikts.
    //
    // Der teure Fall bleibt abgelehnt: Startwert 0 EUR NEBEN einem Uebertrag
    // von 500 EUR (`EO-5`) — dort verschwindet der Uebertrag vollstaendig.
    && (carryoverAmountCents ?? 0) > 0
  ) {
    throw new BudgetInitialSetupError(
      400,
      "BUDGET_45B_STARTWERT_ODER_UEBERTRAG",
      "Startwert und Übertrag aus dem Vorjahr schließen sich aus: ein Startwert "
      + "ist eine Bestandsaufnahme und enthält den Übertrag bereits. "
      + "Ist der aktuelle Restbestand bekannt (z. B. aus einer Kassenauskunft), "
      + "nur den Startwert angeben — sonst nur den Übertrag.",
    );
  }

  // §45b-Akkumulations-Obergrenzen (Task #959): Startwert + Carryover dürfen das
  // rechtlich mögliche Maximum nicht überschreiten. Accrual-Anker = frühester
  // Pflegegrad-Beginn (Care-Level-Historie), Fallback = RAW-Budget-Start.
  if (budgetType === "entlastungsbetrag_45b") {
    const careLevelHistory = await getCustomerCareLevelHistory(customerId);
    const accrualAnchor = resolve45bAccrualAnchor(careLevelHistory, rawBudgetStartDate);

    if (currentMonthAmountCents != null && currentMonthAmountCents > 0) {
      const startCap = max45bStartValueCents(accrualAnchor, budgetStartDate);
      if (currentMonthAmountCents > startCap) {
        throw new BudgetInitialSetupError(
          400,
          "BUDGET_45B_START_VALUE_EXCEEDED",
          `§45b-Startguthaben darf höchstens ${formatEuroDE(startCap)} betragen (rechtlich mögliche Ansammlung bis zum Startmonat). Eingegeben: ${formatEuroDE(currentMonthAmountCents)}.`,
        );
      }
    }

    if (carryoverAmountCents != null && carryoverAmountCents > 0) {
      const carryoverCap = max45bCarryoverCents(
        eligible45bCarryoverMonths(accrualAnchor, year),
      );
      if (carryoverAmountCents > carryoverCap) {
        throw new BudgetInitialSetupError(
          400,
          "BUDGET_45B_CARRYOVER_EXCEEDED",
          `§45b-Übertrag aus ${year - 1} darf höchstens ${formatEuroDE(carryoverCap)} betragen (im Vorjahr berechtigte Monate). Eingegeben: ${formatEuroDE(carryoverAmountCents)}.`,
        );
      }
    }
  }

  // §45a/§39_42a: Topf idempotent in-place aktivieren, damit der Read-Pfad den
  // Startwert nicht herausfiltert (Task #705/#876).
  if ((budgetType === "umwandlung_45a" || budgetType === "ersatzpflege_39_42a") && currentMonthAmountCents != null && currentMonthAmountCents > 0) {
    await budgetStorage.ensureBudgetTypeEnabledInPlace(customerId, budgetType, budgetStartDate, tx);
  }

  const allocations: BudgetAllocation[] = [];

  /**
   * ── Schranke 6 (Gate 2 zu #163, S6) ──────────────────────────────────
   * Hier stand `> 0`. Eine 0 wurde nach der Validierung **verworfen** — und
   * die Route meldete trotzdem `201 Created` mit einem Audit-Eintrag, der
   * `currentMonthAmountCents: 0` behauptet, waehrend in der DB nichts steht.
   * **Angenommen, quittiert, verworfen** ist die schlechteste Kombination:
   * der Audit-Eintrag ist dann kein Beleg mehr, sondern eine Behauptung.
   *
   * Geprueft wird jetzt die ANGABE (`!= null`), nicht ihre Hoehe. Der
   * Lesepfad haengt ohnehin an der Existenz der Zeile
   * (`initialBalanceMonths` filtert auf sie), nicht am Betrag.
   */
  if (currentMonthAmountCents != null) {
    const expiresAt = budgetType === "ersatzpflege_39_42a" ? `${year}-12-31` : null;
    const startMonth = startDate.getMonth() + 1;

    /**
     * ── Ein Wiederholungs-Versuch darf keinen erfassten Startwert ueberschreiben ──
     *
     * `upsertInitialBalanceAllocation` macht bei vorhandener aktiver Zeile
     * fuer dasselbe `(Kunde, Topf, Jahr, Monat)` ein
     * `UPDATE ... SET amount_cents = <neuer Wert>`. Auf dem ANLAGE-Pfad ist
     * das harmlos (es gibt noch nichts). Auf dem WIEDERHOL-Pfad nicht: der
     * Banner „Startbudgets erneut versuchen"
     * (`client/src/features/customers/components/admin/customer-detail-sections.tsx`)
     * spielt einen GESPEICHERTEN Payload ab, und dessen Kontrakt kann „keine
     * Angabe" nicht ausdruecken — er traegt dann `0`. Ein Klick haette einen
     * inzwischen erfassten Startwert still auf 0 gesetzt.
     *
     * Alriks Vorgabe vom 24.09.2026: **entweder idempotent ueber denselben
     * Payload, oder Konflikt melden.** Genau das steht hier:
     *  - gleicher Betrag  -> kein Fehler, der Upsert laeuft und aendert nichts;
     *  - anderer Betrag   -> `409`, nichts wird geschrieben.
     *
     * Die Schranke sitzt bewusst HIER und nicht in
     * `upsertInitialBalanceAllocation`: der Startwert-EDITOR
     * (`POST /budget/:id/initial-balance/:budgetType`) geht an
     * `applyInitialBudget` vorbei und MUSS weiter korrigieren duerfen. Eine
     * Schranke in der Storage-Funktion haette ihm das genommen.
     */
    const bestehend = await budgetStorage.findActiveInitialBalance(
      { customerId, budgetType, year, month: startMonth }, tx,
    );
    if (bestehend != null && bestehend.amountCents !== currentMonthAmountCents) {
      throw new BudgetInitialSetupError(
        409,
        "BUDGET_INITIAL_BALANCE_CONFLICT",
        `Für ${monatJahr(year, startMonth)} ist bereits ein Startwert von `
        + `${formatEuroDE(bestehend.amountCents)} erfasst. Dieser Vorgang würde ihn auf `
        + `${formatEuroDE(currentMonthAmountCents)} ändern. Wenn das gewollt ist, den `
        + `Startwert im Budget-Editor ändern — die Anlage überschreibt ihn nicht.`,
      );
    }

    await budgetStorage.upsertInitialBalanceAllocation({
      customerId,
      budgetType,
      year,
      month: startMonth,
      amountCents: currentMonthAmountCents,
      validFrom: budgetStartDate,
      expiresAt,
      notes: `Startguthaben ${year}`,
    }, userId, tx);
    const allAllocations = await budgetStorage.getInitialBalanceAllocations(customerId, budgetType, tx);
    if (allAllocations.length > 0) allocations.push(allAllocations[0]);
  }

  if (carryoverAmountCents != null && budgetType === "entlastungsbetrag_45b") {
    // validFrom auf Jahresanfang (Task #116/#601), Zieljahr-konsistent zu
    // `ensureYearlyCarryover45b` (verhindert Doppel-Carryover via Auto-Dedup).
    const carryoverAllocation = await budgetStorage.createBudgetAllocation({
      customerId,
      budgetType: "entlastungsbetrag_45b",
      year,
      month: null,
      amountCents: carryoverAmountCents,
      source: "carryover",
      validFrom: `${year}-01-01`,
      // Frist aus der SSoT (Welle 2): dasselbe Datum speist `carryoverWindowFor`
      // und den Verfalls-Boden im Lesepfad. Als Literal war es die Kopie, die
      // beim Verschieben der Frist still zurueckgeblieben waere — und damit den
      // Window-Dedup gegen den Auto-Pfad ausgehebelt haette.
      expiresAt: carryoverExpiresAtFor(year),
      notes: `Übertrag aus ${year - 1}`,
    }, userId, tx);
    allocations.push(carryoverAllocation);
  }

  // Task #1204 — Es gibt keinen persistierten kunden-weiten `budget_start_date`
  // mehr; der Anker wird zur Laufzeit pro Topf aus der Pflegegrad-Historie
  // abgeleitet (§45a/§39 roh, §45b aufs laufende Jahr gebodet). Daher wird hier
  // keine Anker-Preference mehr geschrieben; der `initial_balance`-Startwert oben
  // trägt den Stichmonat selbst.

  if (userId) {
    await auditService.log(userId, "budget_initial_setup", "budget", customerId, {
      customerId,
      budgetType,
      currentMonthAmountCents,
      carryoverAmountCents,
      budgetStartDate,
      allocationIds: allocations.map(a => a.id),
    }, params.ip ?? undefined);
  }

  return allocations;
}
