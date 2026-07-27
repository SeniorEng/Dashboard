// shared/domain/budgets.ts
// Central source of truth for all budget rules per German care law (SGB XI, PUEG 2025)
import { formatEuroDE } from "../utils/money";
import { defaultStatutoryPotEnabled } from "./budget-selbstzahler-validator";

// ============================================
// §45b Entlastungsbetrag
// ============================================
// R-45B (siehe docs/budget-legal-spec.md): max. 131 €/Monat Entlastungsbetrag.
export const BUDGET_45B_MAX_MONTHLY_CENTS = 13100; // 131€ max per month

/**
 * Anker für den AUTO-Fallback (Kunde ohne expliziten Budget-Start: kein
 * Startwert, keine Monats-/Carryover-Zeile). Hier wird der zur Laufzeit aus der
 * Pflegegrad-Historie abgeleitete Beginn nur INNERHALB des laufenden Jahres als
 * Anker genutzt; ein Datum vor dem 1.1. des laufenden Jahres wird auf den
 * Jahresanfang angehoben. Begründung: Für einen nie eingerichteten Kunden gibt
 * es keine fachliche Grundlage, einen Vorjahres-Carryover (12 × 131 €)
 * automatisch zu materialisieren — ein echtes Restguthaben trägt der Operator
 * explizit (audit-pflichtig) als Übertrag ein. So bleibt der laufende
 * Jahresanteil ab Pflegegrad-Beginn sichtbar (z. B. Pflegegrad seit März → ab
 * März), ohne dass ein weit zurückliegender Pflegegrad rückwirkend einen
 * Übertrag erzeugt.
 */
export function floorAutoAnchor45bToCurrentYear(derivedISO: string, curYear: number): string {
  const floor = `${curYear}-01-01`;
  return derivedISO < floor ? floor : derivedISO;
}

// ============================================
// §45a Umwandlungsanspruch (40% of unused Pflegesachleistungen)
// ============================================
// Max monthly amounts per Pflegegrad (in cents)
// These are 40% of the Sachleistung amounts per §36 SGB XI
// R-45A (siehe docs/budget-legal-spec.md): 40 % der §36-Sachleistung je Pflegegrad.
export const BUDGET_45A_MAX_BY_PFLEGEGRAD: Record<number, number> = {
  1: 0,      // PG1: not eligible
  2: 31840,  // PG2: 318.40€ (40% of 796€)
  3: 59880,  // PG3: 598.80€ (40% of 1,497€)
  4: 74360,  // PG4: 743.60€ (40% of 1,859€)
  5: 91960,  // PG5: 919.60€ (40% of 2,299€)
};

// ============================================
// §39/§42a Gemeinsamer Jahresbetrag
// ============================================
// R-39 (siehe docs/budget-legal-spec.md): gemeinsamer Jahresbetrag §39/§42a.
export const BUDGET_39_42A_MAX_YEARLY_CENTS = 353900; // 3,539€/year (from July 2025)

// ============================================
// Budget Types
// ============================================
export const BUDGET_TYPES = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

export type BudgetType = typeof BUDGET_TYPES[number];

export const BUDGET_TYPE_LABELS: Record<BudgetType, string> = {
  entlastungsbetrag_45b: "§45b Entlastungsbetrag",
  umwandlung_45a: "§45a Umwandlungsanspruch",
  ersatzpflege_39_42a: "§39/§42a Gemeinsamer Jahresbetrag",
};

// ============================================
// Validation Functions
// ============================================

/**
 * Validate §45b monthly amount (max 131€)
 * Returns error message or null if valid
 */
export function validate45bAmount(amountCents: number): string | null {
  if (amountCents < 0) return "Betrag darf nicht negativ sein";
  if (amountCents > BUDGET_45B_MAX_MONTHLY_CENTS) {
    return `§45b Entlastungsbetrag darf maximal ${formatEuroDE(BUDGET_45B_MAX_MONTHLY_CENTS)}/Monat betragen`;
  }
  return null;
}

/**
 * Validate §45a monthly amount based on Pflegegrad
 * Returns error message or null if valid
 */
export function validate45aAmount(amountCents: number, pflegegrad: number | null): string | null {
  if (amountCents < 0) return "Betrag darf nicht negativ sein";
  if (!pflegegrad || pflegegrad < 2) {
    if (amountCents > 0) return "§45a Umwandlungsanspruch ist erst ab Pflegegrad 2 verfügbar";
    return null;
  }
  const maxCents = BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0;
  if (amountCents > maxCents) {
    return `§45a Umwandlungsanspruch darf bei Pflegegrad ${pflegegrad} maximal ${formatEuroDE(maxCents)}/Monat betragen`;
  }
  return null;
}

/**
 * Validate §39/§42a yearly amount (max 3,539€)
 * Returns error message or null if valid
 */
export function validate39_42aAmount(amountCents: number): string | null {
  if (amountCents < 0) return "Betrag darf nicht negativ sein";
  if (amountCents > BUDGET_39_42A_MAX_YEARLY_CENTS) {
    return `§39/§42a Gemeinsamer Jahresbetrag darf maximal ${formatEuroDE(BUDGET_39_42A_MAX_YEARLY_CENTS)}/Jahr betragen`;
  }
  return null;
}

/**
 * Get the max §45a amount for a given Pflegegrad
 */
export function get45aMaxForPflegegrad(pflegegrad: number | null): number {
  if (!pflegegrad || pflegegrad < 2) return 0;
  return BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? 0;
}

/**
 * Task #954 — Effektiver §45a-Monats-Cap (Cents), Single Source of Truth.
 *
 * §45a Umwandlungsanspruch ist ab Pflegegrad 2 ein gesetzlicher Anspruch. Fehlt
 * ein expliziter Kunden-Wert (`monthlyLimitCents`), greift der gesetzliche
 * Default nach Pflegegrad (`get45aMaxForPflegegrad`). Ein expliziter Wert hat
 * IMMER Vorrang (Override). PG<2 hat keinen Default → `null` (kein Cap-Beitrag,
 * Topf bleibt für Nicht-Anspruchsberechtigte unverändert).
 *
 * Wird sowohl von der Cap-Mathematik (`computeCapRemaining`) als auch vom
 * Allokations-Pfad (§45a-Monatsbetrag in `getCustomerBudgetAmounts`) genutzt,
 * damit Anzeige und Buchung denselben Default sehen — kein „Anzeige vs.
 * Buchung"-Drift (Task #423/#427).
 */
export function resolve45aMonthlyLimitCents(
  explicitMonthlyLimitCents: number | null | undefined,
  pflegegrad: number | null,
): number | null {
  if (explicitMonthlyLimitCents != null) return explicitMonthlyLimitCents;
  const statutory = get45aMaxForPflegegrad(pflegegrad);
  return statutory > 0 ? statutory : null;
}

// ============================================
// Cascade-Reihenfolge (Single Source of Truth, Task #441)
// ============================================
/**
 * Standard-Reihenfolge der Budget-Töpfe in der Cascade-Konsumption.
 *
 * Die Engine (`consumption-engine.ts`) iteriert in dieser Reihenfolge, sofern
 * keine kunden-spezifische `customer_budget_type_settings.priority`-Override
 * existiert. Hardcoded-Listen an anderen Stellen sind verboten — wer eine
 * neue Reihenfolge braucht, ändert hier zentral.
 *
 * BUG-19 (Facette A): Die Konstante ist bewusst MODUL-PRIVAT (kein `export`).
 * Der `enabled`-Wert hier ist der reine strukturelle Roh-Default (§45b an,
 * §45a/§39 aus) OHNE Anspruchs-Gate. Wer den effektiven Default eines Kunden
 * braucht, MUSS `effectiveDefaultPots(customer)` nutzen — das den
 * Selbstzahler-/Anspruchs-Gate (`defaultStatutoryPotEnabled`) anwendet. Ein
 * direkter Import dieser Konstante ist per eslint (`no-restricted-imports`) und
 * Architektur-Test verboten, weil er den Gate umgeht (z. B. §45b fälschlich
 * für Selbstzahler aktiv).
 */
const DEFAULT_BUDGET_POT_ORDER: ReadonlyArray<{
  budgetType: BudgetType;
  enabled: boolean;
  priority: number;
}> = [
  { budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1 },
  { budgetType: "umwandlung_45a", enabled: false, priority: 2 },
  { budgetType: "ersatzpflege_39_42a", enabled: false, priority: 3 },
];

/** Minimaler Kunden-Kontext, den `effectiveDefaultPots` für den Gate braucht. */
export interface DefaultPotCustomer {
  /** `customers.billingType` — `"selbstzahler"` ⇒ kein Anspruch auf §45b/§45a/§39. */
  billingType: string | null | undefined;
  /** `customers.pflegegrad` — §45a/§39 sind erst ab PG 2 verfügbar. */
  pflegegrad: number | null | undefined;
}

/** Ein effektiver Default-Topf: Reihenfolge (priority) + anspruchs-gegateter `enabled`-Zustand. */
export interface EffectiveDefaultPot {
  budgetType: BudgetType;
  enabled: boolean;
  priority: number;
}

/**
 * BUG-19 (Facette A) — Single Source of Truth für die Default-Töpfe eines
 * Kunden, wenn KEINE persistierte `customer_budget_type_settings`-Zeile
 * existiert. Ersetzt jede direkte Nutzung von `DEFAULT_BUDGET_POT_ORDER`.
 *
 * Reihenfolge (priority) stammt aus der modul-privaten `DEFAULT_BUDGET_POT_ORDER`.
 * Der `enabled`-Zustand wird AUSSCHLIESSLICH über den bereits existierenden
 * Gate (`defaultStatutoryPotEnabled` → `validateSelbstzahlerBudget`) berechnet —
 * KEINE zweite Prüf-Kopie:
 *  - §45b ist default-aktiv, ABER nur für anspruchsberechtigte Kunden
 *    (Selbstzahler ⇒ aus).
 *  - §45a/§39+§42a sind grundsätzlich default-deaktiviert (Opt-in pro Kunde)
 *    und damit auch für Pflegegrad < 2 nie aktiv.
 *
 * Pure: kein DB-Zugriff. Anzeige- und Buchungspfad rufen denselben Resolver,
 * damit kein „Anzeige vs. Buchung"-Drift der Default-Aktivierung entsteht.
 */
export function effectiveDefaultPots(customer: DefaultPotCustomer): EffectiveDefaultPot[] {
  return DEFAULT_BUDGET_POT_ORDER.map((pot) => ({
    budgetType: pot.budgetType,
    priority: pot.priority,
    enabled: defaultStatutoryPotEnabled(pot.budgetType, customer.billingType),
  }));
}

/** Persistierte `customer_budget_type_settings`-Zeile, soweit für die effektive Topf-Konfiguration relevant. */
export interface BudgetTypeSettingRow {
  budgetType: string;
  enabled: boolean;
  priority?: number | null;
  monthlyLimitCents?: number | null;
  yearlyLimitCents?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
}

/**
 * Effektive Konfiguration EINES Topfes nach Merge von persistierter Zeile und
 * Default. Ergebnis-Reihenfolge = Prioritätsreihenfolge.
 */
export interface ResolvedPotConfig {
  budgetType: BudgetType;
  /** persistierte Zeile ⇒ deren `enabled`; fehlende Zeile ⇒ Default (`effectiveDefaultPots`). */
  enabled: boolean;
  priority: number;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
  /** `null` ⇒ offene (unbeschränkte) Grenze. */
  validFrom: string | null;
  validTo: string | null;
}

/**
 * Task #1837 — SSoT für „welche Töpfe hat ein Kunde und wie sind sie
 * konfiguriert?". Merged die persistierten `customer_budget_type_settings`-
 * Zeilen mit den effektiven Defaults (`effectiveDefaultPots`):
 *
 *   - Zeile vorhanden ⇒ deren `enabled`/`validFrom`/`validTo`/`priority`/Limits.
 *     Eine DEAKTIVIERTE Zeile (`enabled=false`) bleibt deaktiviert — sie wird
 *     NICHT wie eine fehlende Zeile behandelt.
 *   - Zeile fehlt ⇒ Default-`enabled` aus `effectiveDefaultPots`, Fenster offen
 *     (unbeschränkt), keine Limits, Default-`priority`.
 *
 * ERSETZT den bisher inline in der Cascade (`consumption-engine.ts`) und im
 * Umbuchungs-Pfad (`rebook-storage.ts`) wiederholten Merge, damit Buchung,
 * Umbuchung und Vorschau die Topf-Aktivierung IDENTISCH ableiten (keine
 * „Anzeige vs. Buchung"-Drift; ein default-abgeleiteter §45b-Topf ist überall
 * gleich berechtigt). `resolve45bActivation` ist ein dünner Wrapper hierüber.
 *
 * Der §45b-Monatslimit-Sonderfall aus den Budget-Preferences (nur wenn KEINE
 * einzige Zeile existiert) bleibt bewusst DRAUSSEN — er ist ein DB-Read und
 * wird vom Cascade-Aufrufer NACH diesem Merge angewandt.
 *
 * Pure: kein DB-Zugriff.
 */
export function resolveEffectivePotConfig(args: {
  customer: DefaultPotCustomer;
  typeSettings: BudgetTypeSettingRow[];
}): ResolvedPotConfig[] {
  const settingsMap = new Map(args.typeSettings.map((s) => [s.budgetType, s]));
  return effectiveDefaultPots(args.customer)
    .map((d) => {
      const s = settingsMap.get(d.budgetType);
      return {
        budgetType: d.budgetType,
        enabled: s ? s.enabled : d.enabled,
        priority: s?.priority ?? d.priority,
        monthlyLimitCents: s ? (s.monthlyLimitCents ?? null) : null,
        yearlyLimitCents: s?.yearlyLimitCents ?? null,
        validFrom: s?.validFrom ?? null,
        validTo: s?.validTo ?? null,
      };
    })
    .sort((a, b) => a.priority - b.priority);
}

/** Liegt `asOfDate` im (offen begrenzten) `validFrom..validTo`-Fenster? */
function isWithinPotWindow(
  validFrom: string | null | undefined,
  validTo: string | null | undefined,
  asOfDate: string,
): boolean {
  if (validFrom && asOfDate < validFrom) return false;
  if (validTo && asOfDate > validTo) return false;
  return true;
}

/** Grund, warum ein Topf zum Stichtag NICHT nutzbar ist. */
export type PotIneligibleReason =
  | "out_of_window_configured"
  | "disabled"
  | "not_yet_valid"
  | "expired";

/** Nutzbarkeit EINES Topfes zum Stichtag inkl. mitgeführter effektiver Konfiguration. */
export type PotEligibilityAt =
  | { config: ResolvedPotConfig; eligible: true }
  | { config: ResolvedPotConfig; eligible: false; reason: PotIneligibleReason };

/**
 * Task #1838 — EINE SSoT für „ist Topf X am Datum Y nutzbar?", die sowohl die
 * Neu-Buchung (Cascade in `consumption-engine.ts`) als auch die (Sammel-)
 * Umbuchung (`rebook-storage.ts`) verwenden. Beide leiten Existenz-/Fenster-/
 * Aktiviert-Logik IDENTISCH ab — keine zwei parallelen Ableitungen mehr.
 *
 * Entscheidung (dokumentiert in `docs/architecture/budget.md`): Das
 * EXISTENZ-Gate (`forEdit`) wird in BEIDE Pfade gehoben, NICHT in beiden
 * weggelassen. `forDate@Stichtag` liefert die zum Stichtag gültige Zeile
 * (Fenster-gefiltert, inkl. deaktivierter Zeilen), unterscheidet aber nicht
 * „Topf NIE konfiguriert" (⇒ anspruchs-gegateter Default) von „Topf
 * konfiguriert, aber Fenster deckt diesen Stichtag nicht" (⇒ überspringen).
 * Deshalb entscheidet bei fehlender Stichtags-Zeile die Existenz IRGENDEINER
 * Zeile (`configuredEverTypes`):
 *   - existiert eine ⇒ außerhalb des Fensters ⇒ NICHT nutzbar (kein Default),
 *   - existiert keine ⇒ echter Default über `resolveEffectivePotConfig`.
 * Eine vorhandene, DEAKTIVIERTE Zeile bleibt „nicht aktiviert".
 *
 * Rationale für „heben statt weglassen": Wenn ein Admin ein Gültigkeitsfenster
 * bewusst gesetzt hat, soll der Topf außerhalb dieses Fensters NICHT still über
 * den Default reaktiviert werden — weder bei der Buchung noch bei der Umbuchung.
 *
 * Pure: kein DB-Zugriff. Die Kapazität (verfügbare Cents) ist eine SEPARATE
 * Frage und wird hier NICHT geprüft.
 */
export function resolvePotEligibilityAt(args: {
  customer: DefaultPotCustomer;
  settingsAtDate: BudgetTypeSettingRow[];
  configuredEverTypes: Iterable<string>;
  asOfDate: string;
}): Map<BudgetType, PotEligibilityAt> {
  const { customer, settingsAtDate, configuredEverTypes, asOfDate } = args;
  const rowAtDate = new Set(settingsAtDate.map((s) => s.budgetType));
  const configuredEver = new Set(configuredEverTypes);
  const result = new Map<BudgetType, PotEligibilityAt>();
  for (const cfg of resolveEffectivePotConfig({ customer, typeSettings: settingsAtDate })) {
    const bt = cfg.budgetType;
    if (!rowAtDate.has(bt) && configuredEver.has(bt)) {
      result.set(bt, { config: cfg, eligible: false, reason: "out_of_window_configured" });
      continue;
    }
    if (!cfg.enabled) {
      result.set(bt, { config: cfg, eligible: false, reason: "disabled" });
      continue;
    }
    if (cfg.validFrom && asOfDate < cfg.validFrom) {
      result.set(bt, { config: cfg, eligible: false, reason: "not_yet_valid" });
      continue;
    }
    if (cfg.validTo && asOfDate > cfg.validTo) {
      result.set(bt, { config: cfg, eligible: false, reason: "expired" });
      continue;
    }
    result.set(bt, { config: cfg, eligible: true });
  }
  return result;
}

/** Persistierte (oder fehlende) §45b-Type-Settings-Zeile, soweit für die Aktivitäts-Auflösung relevant. */
export interface Budget45bSettingRow {
  enabled: boolean;
  validFrom: string | null | undefined;
  validTo: string | null | undefined;
}

/** Aufgelöster §45b-Aktivitäts-Zustand zum Stichtag. */
export interface Budget45bActivation {
  /** `enabled`-Zustand: aus der persistierten Zeile, sonst Default (`effectiveDefaultPots`). */
  enabled: boolean;
  /** Liegt der Stichtag im `validFrom..validTo`-Fenster? (fehlende Zeile ⇒ immer true). */
  inRange: boolean;
  /** §45b ist zum Stichtag wirksam (`enabled && inRange`). */
  active: boolean;
}

/**
 * BUG-19 (Facette A) — SSoT für „ist der §45b-Entlastungsbetrag zum Stichtag aktiv?".
 *
 * WICHTIG: Die §45b-Zeile MUSS OHNE `enabled`-Filter gesucht werden
 * (`typeSettings.find(s => s.budgetType === "entlastungsbetrag_45b")`). Eine
 * vorhandene, aber DEAKTIVIERTE Zeile (`enabled=false`) darf NICHT wie eine
 * FEHLENDE Zeile behandelt werden — sonst greift fälschlich die
 * Default-Aktivierung (`effectiveDefaultPots`), und ein bewusst abgeschalteter
 * §45b-Topf erscheint als aktiv (mit 0 € Topf ⇒ falsche „Budget
 * überschritten"-Warnung; Prod-Regression Kunde „Seidel, Wolfgang").
 *
 *   - Zeile vorhanden ⇒ deren `enabled` gilt; `inRange` = Stichtag in
 *     `validFrom..validTo` (offene Grenzen unbeschränkt).
 *   - Zeile fehlt      ⇒ Default aus `effectiveDefaultPots(billingType)`;
 *     `inRange` = true (kein Fenster ⇒ unbeschränkt).
 *
 * Pure: kein DB-Zugriff. Alle §45b-Aktiv-Prüfungen (unified-reader,
 * net-available-45b, summary-queries) rufen denselben Resolver — kein
 * „Anzeige vs. Buchung"-Drift und keine erneute Duplizierung der Logik.
 */
export function resolve45bActivation(args: {
  setting: Budget45bSettingRow | null | undefined;
  billingType: string | null | undefined;
  asOfDate: string;
}): Budget45bActivation {
  const { setting, billingType, asOfDate } = args;
  const cfg = resolveEffectivePotConfig({
    customer: { billingType, pflegegrad: null },
    typeSettings: setting
      ? [{
          budgetType: "entlastungsbetrag_45b",
          enabled: setting.enabled,
          validFrom: setting.validFrom ?? null,
          validTo: setting.validTo ?? null,
        }]
      : [],
  }).find((p) => p.budgetType === "entlastungsbetrag_45b")!;
  const inRange = isWithinPotWindow(cfg.validFrom, cfg.validTo, asOfDate);
  return { enabled: cfg.enabled, inRange, active: cfg.enabled && inRange };
}

/** Persistierte `customer_budget_type_settings`-Zeile, soweit für die Aktivitäts-Auflösung des Setup-Banners relevant. */
export interface PersistedBudgetPotRow {
  budgetType: string;
  enabled: boolean;
  /** `null` ⇒ offene (aktuell wirksame) Zeile; gesetzt ⇒ geschlossen. */
  validTo: string | null | undefined;
}

/**
 * Task #1828 — SSoT für „Hat der Kunde mindestens einen aktiven/nutzbaren
 * Budget-Topf?". ERSETZT die frühere „gibt es eine persistierte DB-Zeile?"-
 * Prüfung des Setup-Banners (`computeBudgetSetupMarkers` serverseitig +
 * `id !== null` im Frontend).
 *
 * Eine persistierte offene Zeile (`validTo == null`) überschreibt den Default
 * mit ihrem `enabled`. Fehlt für einen Topf jede Zeile, gilt der effektive
 * Default aus `effectiveDefaultPots(customer)` — §45b ist für jeden
 * Nicht-Selbstzahler default-aktiv (ohne persistierte Zeile). Damit beantworten
 * Anzeige-Banner, Server-Marker und Buchungs-Engine „Topf konfiguriert/aktiv?"
 * identisch aus EINER SSoT — kein „persistierte Zeile nötig"-Drift mehr.
 *
 * Pure: kein DB-Zugriff.
 */
export function hasActiveBudgetPot(args: {
  customer: DefaultPotCustomer;
  persisted: PersistedBudgetPotRow[];
}): boolean {
  const persistedByType = new Map<string, PersistedBudgetPotRow>();
  for (const row of args.persisted) {
    // Nur offene Zeilen zählen; eine geschlossene Zeile (validTo gesetzt) ist
    // nicht wirksam und darf den Default nicht überschreiben.
    if (row.validTo == null) persistedByType.set(row.budgetType, row);
  }
  return effectiveDefaultPots(args.customer).some((pot) => {
    const persisted = persistedByType.get(pot.budgetType);
    return persisted ? persisted.enabled : pot.enabled;
  });
}

// ============================================
// Statutorische Cap-Clamping (Task #441)
// ============================================
/**
 * Clampt Customer-Settings-Limits gegen die gesetzlichen Maxima.
 *
 * Wo gebraucht:
 *   - `cap-calculator.ts:computeCapSlot` — bevor das Cap-Window rechnet,
 *     damit eine fehlerhafte Migration / ein UI-Bypass nie über dem
 *     gesetzlichen Maximum buchen kann.
 *   - Zod-Refines / Storage-Hooks bei `customer_budget_type_settings` —
 *     dieselbe Funktion, damit Anzeige- und Schreibpfad nicht driften.
 *
 * Verhalten:
 *   - `null`/`undefined` bleibt `null` (= kein Limit konfiguriert).
 *   - Negative Werte werden auf `0` geklemmt.
 *   - §45b: monthlyLimit gegen `BUDGET_45B_MAX_MONTHLY_CENTS`.
 *     §45b kennt seit Task #425 keinen echten Monats-Cap mehr, das Clampen
 *     stellt jedoch sicher, dass eine versehentlich migrierte Zahl > 131€
 *     nicht in DB-Refines durchrutscht.
 *   - §45a: monthlyLimit gegen `BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad]`.
 *     Ohne Pflegegrad ≥ 2 → Cap = 0.
 *   - §39/§42a: yearlyLimit gegen `BUDGET_39_42A_MAX_YEARLY_CENTS`.
 *   - Andere Töpfe: unverändert durchgereicht.
 */
export interface ClampedLimits {
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
}

export function clampToStatutoryMax(args: {
  budgetType: string;
  monthlyLimitCents: number | null | undefined;
  yearlyLimitCents: number | null | undefined;
  pflegegrad: number | null | undefined;
}): ClampedLimits {
  const clamp = (v: number | null | undefined, max: number): number | null => {
    if (v == null) return null;
    if (v < 0) return 0;
    return Math.min(v, max);
  };

  switch (args.budgetType) {
    case "entlastungsbetrag_45b":
      return {
        monthlyLimitCents: clamp(args.monthlyLimitCents, BUDGET_45B_MAX_MONTHLY_CENTS),
        yearlyLimitCents: args.yearlyLimitCents ?? null,
      };
    case "umwandlung_45a": {
      const pgMax = args.pflegegrad && args.pflegegrad >= 2
        ? (BUDGET_45A_MAX_BY_PFLEGEGRAD[args.pflegegrad] ?? 0)
        : 0;
      return {
        monthlyLimitCents: clamp(args.monthlyLimitCents, pgMax),
        yearlyLimitCents: args.yearlyLimitCents ?? null,
      };
    }
    case "ersatzpflege_39_42a":
      return {
        monthlyLimitCents: args.monthlyLimitCents ?? null,
        yearlyLimitCents: clamp(args.yearlyLimitCents, BUDGET_39_42A_MAX_YEARLY_CENTS),
      };
    default:
      return {
        monthlyLimitCents: args.monthlyLimitCents ?? null,
        yearlyLimitCents: args.yearlyLimitCents ?? null,
      };
  }
}
