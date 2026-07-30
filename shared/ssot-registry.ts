/**
 * SSoT-Registry — Task #1842 (SSoT-AP1).
 *
 * DIE eine maschinenlesbare Quelle der Wahrheit für „welche fachliche Frage hat
 * welche kanonische Funktion + welchen Guard?". Sie ersetzt die *Katalog*-Rolle
 * der verstreuten, hartkodierten Guard-Allowlists (`CAP_SLOT_IMPORT_ALLOWLIST`
 * etc.) und der reinen Prosa-Dokus (`docs/budget-ssot-audit.md`,
 * `docs/budget-ssot-inventory.md`). Die Guards beziehen ihre Allowlist künftig
 * aus dieser Registry statt sie hart zu halten; die Dokus bleiben als
 * Begründung/Erklärung (Pointer dort auf diese Datei).
 *
 * WICHTIG — ABHÄNGIGKEITSFREI HALTEN:
 *   Diese Datei importiert bewusst NICHTS (kein `fs`, kein `path`, kein
 *   `@shared/...`). Nur so bleibt sie von Vitest-Guards (unit-Project, keine DB),
 *   Server-Tooling UND späteren Konsumenten (jscpd-/dependency-cruiser-/
 *   ESLint-Spiegel-Regeln, Triage-Prozess) trivial konsumierbar. Die
 *   ESLint-Spiegel-Stufe kann die Registry — analog zum Präzedenzfall
 *   `eslint/soft-deletable-tables.mjs` (+ `.d.mts`) — als generiertes `.mjs`
 *   konsumieren.
 *
 * TRENNUNG WHO vs. HOW:
 *   Die Registry beschreibt WER (kanonisches Symbol + erlaubte Pfade). WIE ein
 *   Verstoß erkannt wird (Detektor-Regex + Negativ-Test-Beweis) bleibt bewusst
 *   im jeweiligen Guard-Test.
 *
 * KONVENTIONEN:
 *   - Alle Pfade sind repo-relativ mit „/"-Trennern.
 *   - In `SsotGuard.allowlist` bedeutet ein Pfad MIT abschließendem „/" ein
 *     Verzeichnis-Präfix (z. B. `shared/domain/budget/` erlaubt die ganze
 *     Domain-Schicht). Ohne Slash ist es ein exakter Datei-Pfad.
 *   - Ein Eintrag kann MEHRERE Guards mit je EIGENER Allowlist haben — dieselbe
 *     fachliche Frage wird an unterschiedlichen „Rändern" (Import-Rand,
 *     Aufruf-Rand, Formel-Rand …) mit je eigenen erlaubten Dateien bewacht.
 */

export interface SsotCanonical {
  /** Exportierter Symbolname der kanonischen Funktion/Konstante. */
  symbol: string;
  /** Repo-relativer Modulpfad, der `symbol` definiert und exportiert. */
  module: string;
}

export interface SsotGuard {
  /** Repo-relativer Pfad des Architektur-/Guard-Tests. */
  test: string;
  /**
   * Name der Allowlist-Konstante im Guard (falls der Guard eine führt). Der
   * Guard-Test SOLL diese Liste über `ssotGuardAllowlist(entryId, allowlistName)`
   * aus der Registry beziehen statt sie hart zu halten.
   */
  allowlistName?: string;
  /**
   * Erlaubte Dateien/Präfixe für diese Allowlist (Präfix-Konvention: siehe
   * Datei-Kopf). Nur gesetzt, wenn `allowlistName` gesetzt ist.
   */
  allowlist?: readonly string[];
}

export interface SsotEntry {
  /** Stabile, kebab-case Maschinen-ID (z. B. „budget-availability"). */
  id: string;
  /** Die fachliche Frage in Klartext (Deutsch). */
  question: string;
  /**
   * Kanonische Funktion(en). Meist genau eine; ein Frage-Paar (pure Mathe +
   * DB-Reader) darf beide listen. Leer NUR bei einer reinen Absenz-Invariante
   * (siehe `budget-anchor`: es gibt bewusst KEIN persistiertes Anker-Feld — der
   * Anker wird zur Laufzeit pro Topf abgeleitet).
   */
  canonical: readonly SsotCanonical[];
  /**
   * Literale, die AUSSCHLIESSLICH dieser SSoT gehören (Enum-Strings, Cent-
   * Konstanten-Namen, Sätze). Bewusst simple String-Liste; Erweiterung später
   * additiv.
   */
  ownedLiterals: readonly string[];
  /** Guard-Tests, die diese SSoT erzwingen (mindestens einer). */
  guards: readonly SsotGuard[];
  /**
   * ESLint-Config-Objekt-Namen (aus `eslint.config.js`), die diese SSoT
   * flankieren — rein informativ (z. B. `restrictDefaultPotOrderImport`).
   */
  eslintRules: readonly string[];
}

const SSOT_IMPORTS_GUARD = "tests/architecture/ssot-imports.test.ts";
const SINGLE_READER_GUARD = "tests/architecture/budget-single-reader.test.ts";

/**
 * Der Seed. Jede Allowlist ist BYTE-IDENTISCH aus der heutigen Guard-Konstante
 * übernommen (kein semantischer Wechsel). Die zwei umgestellten Guards
 * (`budget-single-reader.test.ts`, `budget-pot-eligibility-ssot.test.ts`) lesen
 * ihre Liste ab jetzt aus dieser Registry; der Rest folgt inkrementell.
 */
export const SSOT_REGISTRY: readonly SsotEntry[] = [
  {
    id: "budget-availability",
    question:
      "Wie viel Budget ist am Stichtag noch verfügbar? (Cap-Töpfe §45a/§39+§42a — aus dem Cap-Slot abgeleitet)",
    canonical: [
      // Cap-Slot-Berechnung (DB) …
      { symbol: "computeCapSlot", module: "server/storage/budget/cap-calculator.ts" },
      // … deren pure Cap-Math-Kern …
      { symbol: "computeCapRemaining", module: "shared/domain/budget/cap-math.ts" },
      // … und DER eine Verfügbarkeits-Reader (Task #874 I1).
      { symbol: "readUnifiedBudgetAvailability", module: "server/storage/budget/unified-reader.ts" },
    ],
    ownedLiterals: [],
    guards: [
      {
        // Import-Rand: `computeCapSlot` nur Budget-intern importierbar.
        test: SSOT_IMPORTS_GUARD,
        allowlistName: "CAP_SLOT_IMPORT_ALLOWLIST",
        allowlist: [
          "server/storage/budget/unified-reader.ts",
          "server/storage/budget/summary-queries.ts",
          "server/storage/budget/consumption-engine.ts",
        ],
      },
      {
        // Import-Rand: pure Cap-Math nur vom Cap-Calculator + Budget-Domain
        // (Pfad-Präfix `shared/domain/budget/`).
        test: SSOT_IMPORTS_GUARD,
        allowlistName: "CAP_REMAINING_IMPORT_ALLOWLIST",
        allowlist: ["server/storage/budget/cap-calculator.ts", "shared/domain/budget/"],
      },
      {
        // Konsum-Rand (Task #874 I1): Verfügbarkeit aus `.netUsedInWindowCents`
        // ableiten nur hier — `summary-queries.ts` ist Legacy-Reader/SSoT-
        // Fallback bis Phase 6 (Shadow-Soak), wird DANN entfernt.
        test: SINGLE_READER_GUARD,
        allowlistName: "ALLOWLIST",
        allowlist: [
          "server/storage/budget/unified-reader.ts",
          "shared/domain/budget/cap-math.ts",
          "server/storage/budget/summary-queries.ts",
        ],
      },
    ],
    eslintRules: [],
  },
  {
    id: "budget-availability-45b",
    question: "Wie viel §45b-Entlastungsbetrag ist am Stichtag verfügbar? (eigene Jahres-Mathematik)",
    canonical: [
      // Pure §45b-Schluss-Arithmetik (Floor + Holds + max(0, alloc − holds − consumedNet)).
      { symbol: "computeNetAvailable45b", module: "shared/domain/budget/net-available-45b.ts" },
      // Der eine DB-Reader, der sie füttert (Task #1348).
      { symbol: "netAvailable45bAt", module: "server/storage/budget/net-available-45b.ts" },
    ],
    ownedLiterals: [],
    guards: [
      {
        // Aufruf-Rand: produktiver `netAvailable45bAt`-Aufruf nur hier.
        // summary-queries = Forecast-Vorausschau (#1366); invoice-45b-reduction
        // = nachträgliche §45b-Rechnungs-Kürzung.
        test: SINGLE_READER_GUARD,
        allowlistName: "ALLOWLIST_45B",
        allowlist: [
          "server/storage/budget/net-available-45b.ts",
          "server/storage/budget/unified-reader.ts",
          "server/storage/budget/summary-queries.ts",
          "server/services/invoice-45b-reduction.ts",
        ],
      },
      {
        // Aufruf-Rand der puren Mathe: nur Definition + der eine DB-Reader.
        test: SINGLE_READER_GUARD,
        allowlistName: "ALLOWLIST_COMPUTE_45B",
        allowlist: [
          "shared/domain/budget/net-available-45b.ts",
          "server/storage/budget/net-available-45b.ts",
        ],
      },
    ],
    eslintRules: [],
  },
  {
    id: "appointment-documented-signed",
    question: "Ist ein Termin dokumentiert & unterschrieben? (bzw. dokumentiert-aber-unsigniert)",
    canonical: [
      { symbol: "isAppointmentDocumentedAndSigned", module: "shared/domain/appointments.ts" },
      { symbol: "documentedSqlRaw", module: "server/lib/appointment-signed.ts" },
    ],
    ownedLiterals: [],
    guards: [
      {
        // Query-Rand: rohe `signature_data IS [NOT] NULL` / `isNull(signatureData)`
        // nur in der SSoT + der bewussten Einmal-Migration.
        test: SSOT_IMPORTS_GUARD,
        allowlistName: "DOCUMENTED_PREDICATE_ALLOWLIST",
        allowlist: [
          "server/lib/appointment-signed.ts",
          "server/startup/migrate-expired-unsigned-appointments.ts",
        ],
      },
    ],
    eslintRules: [],
  },
  {
    id: "month-close-readiness",
    question: "Ist ein Monat für einen Mitarbeiter abschließbar? (Blocker-Aggregation der Readiness)",
    canonical: [
      { symbol: "getMonthClosingReadiness", module: "server/storage/time-tracking/month-closing.ts" },
    ],
    ownedLiterals: [],
    guards: [
      {
        // Definitions-/Aggregations-Rand: die drei Abschluss-Blocker dürfen nur
        // im Readiness-SSoT-Modul zu einer „abschließbar?"-Entscheidung
        // kombiniert werden.
        test: SSOT_IMPORTS_GUARD,
        allowlistName: "READINESS_AGGREGATION_ALLOWLIST",
        allowlist: ["server/storage/time-tracking/month-closing.ts"],
      },
    ],
    eslintRules: [],
  },
  {
    id: "price",
    question: "Welcher Preis/Lohn gilt für Kunde + Leistung am Stichtag? (Override → Standard → Katalog-Default)",
    canonical: [
      { symbol: "resolvePriceFor", module: "shared/domain/pricing/price-for.ts" },
      { symbol: "resolveWageFor", module: "shared/domain/pricing/wage-for.ts" },
    ],
    ownedLiterals: [],
    guards: [
      {
        // Lese-Rand: direkte Reads der Alt-Preis-Tabellen sind verboten (nur
        // über die konsolidierte `prices`/`priceFor`-SSoT). HINWEIS: der
        // Real-Tree-`it` ist bis zum #1303-Cutover `it.skip`; die Allowlist ist
        // final leer.
        test: "tests/architecture/price-ssot-read-path.test.ts",
        allowlistName: "POST_CUTOVER_ALLOWLIST",
        allowlist: [],
      },
    ],
    eslintRules: [],
  },
  {
    id: "default-budget-pots",
    question: "Welche Budget-Töpfe sind für einen Kunden default aktiv? (mit Selbstzahler-/Eligibility-Gate)",
    canonical: [{ symbol: "effectiveDefaultPots", module: "shared/domain/budgets.ts" }],
    ownedLiterals: ["DEFAULT_BUDGET_POT_ORDER"],
    guards: [
      // Der Guard erzwingt, dass `DEFAULT_BUDGET_POT_ORDER` modul-privat bleibt
      // (kein externer Import) — keine Pfad-Allowlist, sondern ein Token-Scan.
      { test: "tests/architecture/budget-default-pots-ssot.test.ts" },
    ],
    eslintRules: ["restrictDefaultPotOrderImport"],
  },
  {
    id: "pot-eligibility",
    question: "Ist Budget-Topf X am Stichtag Y nutzbar? (Existenz-/Fenster-/Aktiviert-Regel)",
    canonical: [{ symbol: "resolvePotEligibilityAt", module: "shared/domain/budgets.ts" }],
    ownedLiterals: [],
    guards: [
      {
        // Entscheidungs-Rand (Task #1839): Neu-Buchungs-Cascade UND Umbuchung
        // MÜSSEN die Nutzbarkeit aus der SSoT ableiten; kein inline-Fenster-Gate.
        test: "tests/architecture/budget-pot-eligibility-ssot.test.ts",
        allowlistName: "ELIGIBILITY_DECISION_PATHS",
        allowlist: [
          "server/storage/budget/consumption-engine.ts",
          "server/storage/budget/rebook-storage.ts",
        ],
      },
    ],
    eslintRules: [],
  },
  {
    id: "private-payment-eligibility",
    // Frage bewusst OHNE die wörtliche `||`-Formel formuliert: der A5-Guard in
    // ssot-imports.test.ts verbietet die hand-gerollte Privatanteil-Formel im
    // gesamten shared/-Baum (inkl. dieser Registry). Die kanonische Definition
    // steht in `isPrivatePaymentAllowed`.
    question: "Darf ein Kunde einen privaten (19 %-)Anteil erhalten? (Privatzahler-Berechtigung)",
    canonical: [{ symbol: "isPrivatePaymentAllowed", module: "shared/domain/budget-selbstzahler-validator.ts" }],
    ownedLiterals: [],
    guards: [
      {
        // Formel-Rand: die hand-gerollte `||`-Formel ist außerhalb der SSoT-Datei
        // verboten.
        test: SSOT_IMPORTS_GUARD,
        allowlistName: "PRIVATE_PAYMENT_FORMULA_ALLOWLIST",
        allowlist: ["shared/domain/budget-selbstzahler-validator.ts"],
      },
    ],
    eslintRules: [],
  },
  {
    id: "budget-cascade",
    question: "Wie wird ein Betrag über die Budget-Töpfe verteilt? (Cascading-Allocation + terminaler Privat-Topf)",
    canonical: [{ symbol: "planCascade", module: "shared/domain/budget/plan-cascade.ts" }],
    ownedLiterals: [],
    guards: [
      {
        // Aufruf-Rand: produktiver `planCascade`-Aufruf nur in Definition +
        // Buchung + Reservierung + netto-null Rechnungs-Re-Derivation.
        test: SSOT_IMPORTS_GUARD,
        allowlistName: "CASCADE_CALL_ALLOWLIST",
        allowlist: [
          "shared/domain/budget/plan-cascade.ts",
          "server/storage/budget/consumption-engine.ts",
          "server/storage/budget/reservation-storage.ts",
          "server/services/invoice-data.ts",
        ],
      },
    ],
    eslintRules: [],
  },
  {
    id: "budget-anchor",
    question: "Ab wann läuft ein Budget-Topf? (Anker — laufzeit-abgeleitet aus der Pflegegrad-Historie, NICHT persistiert)",
    // Absenz-Invariante (Task #1204): es gibt bewusst KEINE persistierte
    // `budget_start_date`-Spalte und damit kein einzelnes kanonisches Symbol —
    // der Anker wird pro Topf zur Laufzeit abgeleitet. Der Guard erzwingt die
    // Abwesenheit der Spalte im Prod-Code.
    canonical: [],
    ownedLiterals: [],
    guards: [
      {
        test: "tests/architecture/budget-anchor-ssot.test.ts",
        allowlistName: "ALLOWED_FILES",
        allowlist: ["server/startup/drop-budget-start-date-columns.ts"],
      },
    ],
    eslintRules: [],
  },
  {
    id: "statutory-caps",
    question: "Wie werden Budget-Beträge auf die gesetzlichen Höchstwerte geklemmt? (R-45B/R-45A/R-39)",
    canonical: [{ symbol: "clampToStatutoryMax", module: "shared/domain/budgets.ts" }],
    ownedLiterals: [
      "BUDGET_45B_MAX_MONTHLY_CENTS",
      "BUDGET_45A_MAX_BY_PFLEGEGRAD",
      "BUDGET_39_42A_MAX_YEARLY_CENTS",
    ],
    guards: [
      // Spec-Conformance (Task #1390): die Code-Konstanten müssen exakt der
      // Rechts-Spezifikation (`docs/budget-legal-spec.md`) entsprechen — keine
      // Pfad-Allowlist, sondern ein Literal-Vergleich gegen die Spec.
      { test: "tests/architecture/budget-legal-spec-conformance.test.ts" },
    ],
    eslintRules: [],
  },
  {
    id: "insurance-at-date",
    question:
      "Welcher Kostenträger gilt für einen Kunden an einem Stichtag? (Abrechnung/Versand: Stichtag = Ende des Abrechnungszeitraums, NICHT heute)",
    canonical: [
      // Der eine Row-Resolver (DB).
      {
        symbol: "resolveCustomerInsuranceAt",
        module: "server/storage/customer-mgmt/insurance.ts",
      },
      // Dessen SQL-Zwilling für Filter-/Gruppierungs-Joins.
      { symbol: "insuranceValidAt", module: "server/lib/insurance-period.ts" },
      // Die pure Zeitraum-/Stichtags-Semantik.
      { symbol: "billingPeriodAsOfISO", module: "shared/domain/insurance-period.ts" },
    ],
    ownedLiterals: [],
    guards: [
      {
        // Lese-Rand (Task #1893): kein direktes „aktuelle Zuordnung"-Lesen
        // (`valid_to IS NULL` / `isNull(customerInsuranceHistory.validTo)`)
        // außerhalb dieser Dateien. Erlaubt bleiben: die beiden SSoT-Module
        // selbst, das Schließen der Vorgängerzeile beim Wechsel, das Lösch-Gate
        // („wie viele Kunden haben diese Kasse AKTUELL?") sowie die
        // Stammdaten-/Dubletten-Pfade, für die „aktuell" fachlich richtig ist.
        test: "tests/architecture/insurance-at-date-ssot.test.ts",
        allowlistName: "CURRENT_INSURANCE_READ_ALLOWLIST",
        allowlist: [
          "server/storage/customer-mgmt/insurance.ts",
          "server/lib/insurance-period.ts",
          "server/storage/customers-storage.ts",
          "server/storage/customer-management.ts",
          "server/lib/duplicate-check.ts",
        ],
      },
    ],
    eslintRules: [],
  },
];

/** Liefert den Registry-Eintrag mit `id` oder wirft (unbekannte id = Fehler). */
export function getSsotEntry(id: string): SsotEntry {
  const entry = SSOT_REGISTRY.find((e) => e.id === id);
  if (!entry) {
    throw new Error(
      `SSoT-Registry: kein Eintrag mit id "${id}". Bekannte ids: ${SSOT_REGISTRY.map((e) => e.id).join(", ")}`,
    );
  }
  return entry;
}

/**
 * Liefert die (repo-relative) Allowlist eines Guards aus der Registry. Guards
 * beziehen ihre erlaubten Pfade hierüber, statt sie hart zu halten. Wirft, wenn
 * der Eintrag oder die benannte Allowlist fehlt.
 */
export function ssotGuardAllowlist(entryId: string, allowlistName: string): readonly string[] {
  const entry = getSsotEntry(entryId);
  const guard = entry.guards.find((g) => g.allowlistName === allowlistName);
  if (!guard || !guard.allowlist) {
    const known =
      entry.guards
        .map((g) => g.allowlistName)
        .filter((n): n is string => Boolean(n))
        .join(", ") || "(keine)";
    throw new Error(
      `SSoT-Registry: Eintrag "${entryId}" hat keine Allowlist "${allowlistName}". Bekannte Allowlists: ${known}`,
    );
  }
  return guard.allowlist;
}
