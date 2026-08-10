/**
 * Task #1238 (Phase 0.2 — Architektur-Wächter) — SSoT-Import-Wächter.
 *
 * Hintergrund: Drift zwischen Anzeige und Buchung entsteht, sobald dieselbe
 * fachliche Frage an zwei Orten beantwortet wird. Diese Fitness-Functions
 * verankern drei SSoTs am Import-/Definitions-Rand (statisch, KEINE
 * Laufzeit-Änderung):
 *
 *   A1  „Verfügbar?" / Cap — `computeCapSlot` (Cap-SSoT) und `computeCapRemaining`
 *       (pure Cap-Math) dürfen nur Budget-intern importiert werden; Verfügbarkeit
 *       wird über `readUnifiedBudgetAvailability` gelesen, nicht selbst gerechnet.
 *   A2  „Monat zu?" — `get(Admin)MonthClosingReadiness` darf nur im
 *       Monatsabschluss-SSoT-Modul DEFINIERT werden (Fassade = Property-Zuweisung,
 *       keine Re-Definition).
 *   A3  „Dokumentiert?" — keine eigene `signature_data IS [NOT] NULL`- bzw.
 *       `isNull/isNotNull(signatureData)`-Bedingung außerhalb der dokumentiert-SSoT
 *       (`server/lib/appointment-signed.ts`).
 *   A4  „Verteilung über Töpfe?" / Kaskade — `planCascade` (Cascade-SSoT) darf nur
 *       Budget-intern AUFGERUFEN werden (Definition + Buchung/Reservierung/Re-
 *       Derivation); kein neuer Aufrufer baut eine eigene Topf-Verteilung.
 *   A5  „Privatanteil erlaubt?" — keine eigene `acceptsPrivatePayment || selbstzahler`-
 *       Formel außerhalb der Privatzahler-SSoT (`isPrivatePaymentAllowed` in
 *       `shared/domain/budget-selbstzahler-validator.ts`).
 *   A6  „Termin auf einer AKTIVEN Rechnung?" — das Storno-Paar
 *       (`status != 'storniert'` UND `invoice_type != 'stornorechnung'`) darf
 *       nur in der SSoT (`server/lib/appointment-invoiced.ts`) an
 *       `invoice_line_items.appointment_id` gebunden werden — weder korreliert
 *       (`li.appointment_id = a.id`) noch mengen-produzierend
 *       (`a.id IN (SELECT … appointment_id …)`).
 *
 * Zusammen mit den Schwester-Wächtern (`budget-single-reader.test.ts` für die
 * §45b-/Cap-Verfügbarkeits-SSoT, `budget-default-pots-ssot.test.ts` für die
 * Default-Aktivierung) decken diese fünf Detektoren die vier fachlichen Budget-
 * Fragen ab — Bestandsaufnahme: docs/budget-ssot-audit.md.
 *
 * Jeder Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen — der Negativ-Test beweist nachweislich, dass
 * eine bewusste Verletzung das Gate bricht.
 */
import { describe, it, expect } from "vitest";
import { parseSource, collectNamedFunctions } from "./ast-grep-helpers";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";
import { ssotGuardAllowlist } from "@shared/ssot-registry";

// ---------------------------------------------------------------------------
// A1 — Cap-/Verfügbarkeits-SSoT (Import-Rand)
// ---------------------------------------------------------------------------

/** `computeCapSlot` darf nur in diesen Budget-internen Dateien importiert werden. */
const CAP_SLOT_IMPORT_ALLOWLIST = new Set<string>([
  "server/storage/budget/unified-reader.ts",
  "server/storage/budget/summary-queries.ts",
  "server/storage/budget/consumption-engine.ts",
]);

/**
 * `computeCapRemaining` (pure Cap-Math) darf nur vom Cap-Calculator und innerhalb
 * der Budget-Domain importiert werden (Pfad-Präfix-Allowlist).
 */
const CAP_REMAINING_IMPORT_ALLOWLIST = ["server/storage/budget/cap-calculator.ts", "shared/domain/budget/"];

/**
 * Matcht ein `import`/`export … { … SYM … } from "…"`-Statement (auch
 * mehrzeilig und mit Default-/Namespace-Präfix wie `import Foo, { SYM }`).
 * Re-Export-Spezifizierer (`export { SYM } from "…"`) sind eingeschlossen.
 */
function namedImportFromRe(symbol: string): RegExp {
  return new RegExp(
    String.raw`(?:import|export)\b[^{};]*\{[^}]*\b${symbol}\b[^}]*\}\s*from\s*["'][^"']+["']`,
  );
}

export function detectCapSsotImportViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  const capSlotRe = namedImportFromRe("computeCapSlot");
  const capRemainingRe = namedImportFromRe("computeCapRemaining");
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    const code = stripComments(content);
    if (capSlotRe.test(code) && !CAP_SLOT_IMPORT_ALLOWLIST.has(rel)) {
      out.push({
        file: rel,
        detail: "importiert `computeCapSlot` (Cap-SSoT) außerhalb der Budget-internen Allowlist",
      });
    }
    if (
      capRemainingRe.test(code) &&
      !CAP_REMAINING_IMPORT_ALLOWLIST.some((p) => rel === p || rel.startsWith(p))
    ) {
      out.push({
        file: rel,
        detail: "importiert `computeCapRemaining` (pure Cap-Math) außerhalb von cap-calculator.ts / shared/domain/budget/",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A2 — Monatsabschluss-Readiness-SSoT (Definitions-Rand)
// ---------------------------------------------------------------------------

const READINESS_CANONICAL = "server/storage/time-tracking/month-closing.ts";
const READINESS_NAME_RE = /MonthClosingReadiness$/;

export function detectReadinessDefinitionViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (rel === READINESS_CANONICAL) continue;
    const astRoot = parseSource(content, rel.endsWith(".tsx"));
    for (const { name, line } of collectNamedFunctions(astRoot)) {
      if (READINESS_NAME_RE.test(name)) {
        out.push({ file: rel, line, detail: `definiert \`${name}\` außerhalb des Readiness-SSoT-Moduls` });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A2b — Readiness-Blocker-Aggregation (Definitions-Rand, struktureller Scan)
// ---------------------------------------------------------------------------

/**
 * A2 oben erkennt eine zweite Readiness nur am FUNKTIONSNAMEN
 * (`…MonthClosingReadiness`). Drift entsteht aber auch ohne diesen Namen: indem
 * irgendwo die DREI Monatsabschluss-Blocker — offene Termine, fehlende
 * Unterschriften, offene Zeiteinträge — erneut zu einer eigenen
 * „abschließbar?"-Entscheidung zusammengebaut werden. Genau diese Aggregation
 * IST die Readiness-Berechnung und lebt ausschließlich im SSoT-Modul.
 *
 * Dieser Detektor erkennt eine parallele Aggregation STRUKTURELL (nicht über den
 * Namen): ein File außerhalb des SSoT-Moduls, das den Offene-Termine-Blocker
 * (Status-Ausschluss `notInArray(… "completed"/"cancelled"/"customer_no_show")`)
 * mit MINDESTENS einem weiteren Blocker-Signal kombiniert — der
 * „fehlende Unterschrift"-Bedingung ODER der Zeiteinträge-Aktivitäts-Aggregation.
 *
 * Bewusst NICHT erfasst (orthogonale Frage „Monat zu?"): reine
 * `isMonthClosed(...)` / `monthCloseCache`-Boolean-Lookups (z. B.
 * `server/services/appointment-import-reconcile.ts`). Sie LESEN den bereits
 * gefällten Abschluss-Status und bauen KEINE eigene Blocker-Aggregation — sie
 * sind damit per Konstruktion ausgenommen (siehe A2b-Negativ-Test, der das
 * explizit beweist).
 */
const READINESS_AGGREGATION_ALLOWLIST = new Set<string>([READINESS_CANONICAL]);

/** Offene-Termine-Blocker: Status-Ausschluss über das „erledigt"-Triple. */
function hasOpenAppointmentsBlocker(code: string): boolean {
  const excludes = /\bnotInArray\b/.test(code) || /\bNOT\s+IN\b/i.test(code);
  return (
    excludes &&
    /["']completed["']/.test(code) &&
    /["']cancelled["']/.test(code) &&
    /["']customer_no_show["']/.test(code)
  );
}

/** „Fehlende Unterschrift"-Blocker-Bedingung (dokumentiert-SSoT-Prädikate). */
const UNSIGNED_BLOCKER_RE =
  /\b(?:appointmentCompletedButUnsignedCondition|completedButUnsignedSqlRaw|documentedAndSignedSqlRaw)\b/;

/** Zeiteinträge-Aktivitäts-Aggregation. */
const TIME_ENTRY_AGG_RE = /\b(?:employeeTimeEntries|employee_time_entries)\b/;

export function detectReadinessAggregationViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (READINESS_AGGREGATION_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (!hasOpenAppointmentsBlocker(code)) continue;
    const unsigned = UNSIGNED_BLOCKER_RE.test(code);
    const timeEntries = TIME_ENTRY_AGG_RE.test(code);
    if (!unsigned && !timeEntries) continue;
    const signals = [
      "Offene-Termine-Status-Ausschluss",
      unsigned ? "„fehlende Unterschrift\u201c-Bedingung" : null,
      timeEntries ? "Zeiteinträge-Aktivitäts-Aggregation" : null,
    ].filter(Boolean).join(" + ");
    out.push({
      file: rel,
      detail: `aggregiert Monatsabschluss-Blocker erneut (${signals}) außerhalb des Readiness-SSoT-Moduls`,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// A3 — „Dokumentiert?"-SSoT (Query-Rand)
// ---------------------------------------------------------------------------

/**
 * Die einzige Datei mit der rohen Unterschrift-Null-Prüfung ist die SSoT selbst;
 * die Migration `migrate-expired-unsigned-appointments.ts` ist eine bewusste,
 * dokumentierte Einmal-Korrektur (kein Request-Pfad).
 *
 * Verifikation (Task #1279, Phase 2/2.2): Bestätigt, dass die fachliche Frage
 * „Termin dokumentiert & unterschrieben?" genau EINE Quelle hat
 * (`server/lib/appointment-signed.ts` + reines Prädikat in
 * `shared/domain/appointments.ts`). Alle realen Konsumenten importieren sie:
 * Lexware-Export (`documentedAndSignedSqlRaw`/`completedButUnsignedSqlRaw`),
 * Monatsabschluss-Scheduler (`appointmentNotDocumentedCondition` +
 * `completedButUnsignedSqlRaw` für die „fehlende Unterschrift"-Erinnerung),
 * Monatsabschluss-Storage (`appointmentCompletedButUnsignedCondition`) und
 * Invarianten (`appointmentDocumentedAndSignedCondition`). Der A3-Test unten ist
 * ein HARTER, build-brechender CI-Gate (`expect.fail`, kein Warning) — Teil der
 * Architektur-Fitness-Functions in der CI-Pflicht. Eine bewusst eingeschleuste
 * Eigen-Prüfung bricht ihn (siehe A3-Negativ-Test).
 */
const DOCUMENTED_PREDICATE_ALLOWLIST = new Set<string>([
  "server/lib/appointment-signed.ts",
  "server/startup/migrate-expired-unsigned-appointments.ts",
]);

const RAW_SIGNATURE_NULL_RE = /signature_data\s+IS\s+(?:NOT\s+)?NULL/i;
const DRIZZLE_SIGNATURE_NULL_RE = /\b(?:isNull|isNotNull)\s*\(\s*[A-Za-z0-9_.]*\bsignatureData\b/;

export function detectDocumentedPredicateViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (DOCUMENTED_PREDICATE_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (RAW_SIGNATURE_NULL_RE.test(code)) {
      out.push({ file: rel, detail: "baut eine eigene rohe `signature_data IS [NOT] NULL`-Bedingung statt der dokumentiert-SSoT" });
    }
    if (DRIZZLE_SIGNATURE_NULL_RE.test(code)) {
      out.push({ file: rel, detail: "baut eine eigene `isNull/isNotNull(signatureData)`-Bedingung statt der dokumentiert-SSoT" });
    }
  }
  return out;
}

/**
 * Import-Rand des PRIMITIVS `hasDirectSignatureSqlRaw`.
 *
 * Das Primitiv beantwortet nur die Tatsachen-Teilfrage `signature_data IS NOT
 * NULL` — ohne `status`-Gate und ohne den Leistungsnachweis-Zweig. Es ist damit
 * genau das, was die meisten Aufrufer NICHT wollen: wer „dokumentiert &
 * unterschrieben?" fragt, braucht `documentedAndSignedSqlRaw`.
 *
 * Warum dieser zweite Rand nötig ist: Vor der Einführung des Primitivs fing der
 * A3-Query-Rand oben JEDE eigene Unterschrifts-Prüfung ab — eine rohe Bedingung
 * war die einzige Möglichkeit, und die war gesperrt. Seit es das Primitiv gibt,
 * genügt ein `import { hasDirectSignatureSqlRaw }`, um dieselbe zu enge Prüfung
 * an beliebiger Stelle zu bauen, ohne dass A3 sich meldet. Der Import-Rand
 * stellt die Abdeckung wieder her, die das Primitiv sonst aufgeweicht hätte.
 *
 * Gleiche Bauart wie `CAP_SLOT_IMPORT_ALLOWLIST` (A1) und
 * `CASCADE_CALL_ALLOWLIST` (A4).
 */
const DIRECT_SIGNATURE_IMPORT_ALLOWLIST = new Set<string>([
  // Abrechnungs-Pipeline: braucht die drei Teilflags EINZELN und komponiert sie
  // in `assignAppointmentStage` (shared/domain/billing-pipeline.ts).
  "server/storage/billing/pipeline-reader.ts",
]);

export function detectDirectSignatureImportViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  const re = namedImportFromRe("hasDirectSignatureSqlRaw");
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (DIRECT_SIGNATURE_IMPORT_ALLOWLIST.has(rel)) continue;
    if (re.test(stripComments(content))) {
      out.push({
        file: rel,
        detail:
          "importiert das Primitiv `hasDirectSignatureSqlRaw` außerhalb der Allowlist — " +
          "es beantwortet NUR `signature_data IS NOT NULL`, ohne status-Gate und ohne " +
          "Leistungsnachweis-Zweig",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A4 — Cascade-/Verteilungs-SSoT (Aufruf-Rand)
// ---------------------------------------------------------------------------

/**
 * `planCascade` (shared/domain/budget/plan-cascade.ts) ist die EINE pure
 * Verteilungs-Funktion: Sie schichtet einen Termin-/Rechnungs-Betrag
 * deterministisch über die statutorischen Töpfe (Cascading-Allocation) plus den
 * terminalen Selbstzahler-/Privat-Topf. Damit nicht erneut eine parallele
 * Topf-Verteilung entsteht, ist der PRODUKTIVE Aufruf auf eine Allowlist
 * beschränkt: die Definition selbst, der Buchungs-Pfad (`consumption-engine`),
 * der Reservierungs-/Hold-Pfad (`reservation-storage`) und die netto-null-
 * Re-Derivation der Rechnung (`invoice-data`). Ein reiner Import/Doku-Hinweis
 * (kein `(`) triggert bewusst nicht.
 */
const CASCADE_CALL_ALLOWLIST = new Set<string>([
  "shared/domain/budget/plan-cascade.ts", // Definition (die Verteilungs-SSoT).
  "server/storage/budget/consumption-engine.ts", // Buchung.
  "server/storage/budget/reservation-storage.ts", // Reservierung / Hold.
  "server/services/invoice-data.ts", // netto-null Re-Derivation.
]);

const CASCADE_CALL_RE = /\bplanCascade\s*\(/;

export function detectCascadeCallViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (CASCADE_CALL_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (CASCADE_CALL_RE.test(code)) {
      out.push({
        file: rel,
        detail: "ruft `planCascade` (Cascade-/Verteilungs-SSoT) außerhalb der Budget-internen Allowlist auf",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A5 — Privatzahler-Entscheidungs-SSoT (Formel-Rand)
// ---------------------------------------------------------------------------

/**
 * Die Frage „Darf dieser Kunde einen privaten (19 %-)Anteil bekommen?" wird
 * ausschließlich von `isPrivatePaymentAllowed`
 * (shared/domain/budget-selbstzahler-validator.ts) beantwortet — die EINE
 * Definition der Formel `acceptsPrivatePayment || billingType === "selbstzahler"`.
 * Drift entsteht, sobald ein Buchungs-/Rebook-/Reservierungs-/Import-/Split-Pfad
 * diese Oder-Verknüpfung selbst hinschreibt, statt die SSoT aufzurufen. Der
 * Detektor erkennt genau diese hand-gerollte Formel (beide Token in einer
 * `||`-Verknüpfung auf einer logischen Zeile) außerhalb der SSoT-Datei.
 */
const PRIVATE_PAYMENT_FORMULA_ALLOWLIST = new Set<string>([
  "shared/domain/budget-selbstzahler-validator.ts",
]);

const PRIVATE_FORMULA_RE_A = /acceptsPrivatePayment[^;\n]{0,80}\|\|[^;\n]{0,80}selbstzahler/;
const PRIVATE_FORMULA_RE_B = /selbstzahler[^;\n]{0,80}\|\|[^;\n]{0,80}acceptsPrivatePayment/;

export function detectPrivatePaymentFormulaViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (PRIVATE_PAYMENT_FORMULA_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    if (PRIVATE_FORMULA_RE_A.test(code) || PRIVATE_FORMULA_RE_B.test(code)) {
      out.push({
        file: rel,
        detail: "baut die Privatanteil-Formel (`acceptsPrivatePayment || selbstzahler`) selbst statt `isPrivatePaymentAllowed`",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A6 — „Termin auf einer AKTIVEN Rechnung?"-SSoT (Query-Rand)
// ---------------------------------------------------------------------------

/**
 * Task #1892 — „Liegt dieser Termin auf einer AKTIVEN Rechnung?" (weder selbst
 * storniert noch Stornorechnung) war dreizehnfach handgeschrieben: teils
 * wortgleich, teils als Kern mit zusätzlichem Scope (Kunde, Abrechnungs-
 * Zeitraum, Entwurfs-Ausschluss). Genau so entsteht Drift zwischen „gilt als
 * abgerechnet" in Anzeige, Schutz-Guard und Abrechnungs-Engine.
 *
 * Die SSoT ist `server/lib/appointment-invoiced.ts`: `activeInvoiceCondition`
 * (Drizzle) und die Roh-SQL-Zwillinge `activeInvoiceForAppointmentExistsSqlRaw`,
 * `latestActiveInvoiceForAppointmentLateralRaw`, `activeInvoicedAppointmentIdsSqlRaw`.
 * Enger gescopte Aufrufer komponieren sie mit ihren Zusatzbedingungen — die
 * Zusatz-Scopes bleiben sichtbar, „aktiv" wird nicht neu formuliert.
 *
 * ABGRENZUNG (bewusst eng): Erkannt wird nur das Storno-Paar, das an
 * `invoice_line_items.appointment_id` GEBUNDEN ist — in beiden Schreibrichtungen:
 * `li.appointment_id = <termin>` / `IN (…)` UND die Umkehrform
 * `<termin>.id [NOT] IN (SELECT … appointment_id …)`. Die reine Frage „ist diese
 * RECHNUNG aktiv?" — Geld-Aggregate über aktive Rechnungen, in denen `appointments`
 * nur als Attributions-Join oder `appointment_id IS NOT NULL` vorkommt (z. B.
 * `revenue.ts` Umsatz-Summen) — ist eine ANDERE fachliche Frage mit eigenem,
 * noch offenem Konsolidierungs-Vorhaben und wird absichtlich NICHT mitgefangen;
 * sonst wäre die Allowlist eine Attrappe.
 *
 * Allowlist kommt aus der Registry (`appointment-active-invoice`) und enthält
 * NUR die SSoT-Datei selbst. Jede andere Stelle komponiert — auch
 * `rebook-guards.ts` („bereits GESTELLTE Rechnung" = aktiv UND kein Entwurf):
 * der Entwurfs-Ausschluss steht dort als Zusatz-Scope neben der SSoT, statt das
 * Storno-Paar ein zweites Mal zu definieren.
 */
const ACTIVE_INVOICE_PREDICATE_ALLOWLIST = new Set<string>(
  ssotGuardAllowlist("appointment-active-invoice", "ACTIVE_INVOICE_PREDICATE_ALLOWLIST"),
);

/** Fenster um ein Vorkommen herum — grob eine SQL-/Query-Anweisung. */
const ACTIVE_INVOICE_WINDOW = 600;

const RAW_STORNO_STATUS_RE = /status\s*!=\s*'storniert'/i;
const RAW_STORNO_TYPE_RE = /invoice_type\s*!=\s*'stornorechnung'/i;
/**
 * Termin-BINDUNG, nicht bloße Erwähnung — zwei Formen, beide erkannt:
 *
 *   (a) korreliert: `li.appointment_id = a.id`, `li.appointment_id IN (…)`
 *   (b) mengen-produzierend: `SELECT [DISTINCT] li.appointment_id FROM
 *       invoice_line_items …` — die Zutat der Umkehrform
 *       `a.id IN (SELECT … appointment_id …)` / `p.id NOT IN (SELECT …)`.
 *       Ohne (b) schlüpft dieselbe Frage einfach andersherum geschrieben durch.
 *
 * Ein reiner Attributions-Join (`JOIN appointments a ON a.id = li.appointment_id`),
 * ein blanker `appointment_id IS NOT NULL`-Filter und Zähl-Aggregate
 * (`COUNT(DISTINCT li.appointment_id)`) matchen bewusst NICHT — das sind
 * Geld-/Mengen-Aggregate über aktive Rechnungen, keine Frage nach EINEM Termin.
 */
const RAW_APPOINTMENT_BOUND_RE = /\bappointment_id\s*(?:=|IN\s*\()/i;

/**
 * Die Projektion steht VOR dem `invoice_line_items`-Token, deshalb ein
 * Rückblick. Der Anker `FROM\s+$` bindet sie an GENAU dieses `FROM` — die
 * Projektion muss die sein, die aus `invoice_line_items` liest. Ohne den Anker
 * wäre die Regex tabellenblind und würde eine daneben stehende
 * `SELECT sra.appointment_id FROM service_record_appointments`-Projektion auf
 * ein benachbartes Geld-Aggregat beziehen (Falsch-Positiv).
 *
 * `[^()]*` hält Aggregate draußen: `SUM(li.total_cents)` und
 * `COUNT(DISTINCT li.appointment_id)` enthalten Klammern und matchen nicht —
 * sie projizieren keine Termin-MENGE.
 */
const RAW_APPOINTMENT_ID_PROJECTED_RE =
  /SELECT\s+(?:DISTINCT\s+)?[^()]*\bappointment_id\b[^()]*\bFROM\s+$/i;

/** Rückblick-Spanne vor dem `invoice_line_items`-Vorkommen. */
const ACTIVE_INVOICE_LOOKBEHIND = 200;

const DRIZZLE_STORNO_STATUS_RE = /\bne\(\s*[A-Za-z0-9_.]*\.status\s*,\s*"storniert"\s*\)/;
const DRIZZLE_STORNO_TYPE_RE = /\bne\(\s*[A-Za-z0-9_.]*\.invoiceType\s*,\s*"stornorechnung"\s*\)/;

export function detectActiveInvoicePredicateViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (ACTIVE_INVOICE_PREDICATE_ALLOWLIST.has(rel)) continue;
    // Whitespace normalisieren, damit das Fenster über Zeilenumbrüche greift.
    const code = stripComments(content).replace(/\s+/g, " ");

    for (const m of code.matchAll(/invoice_line_items/g)) {
      const w = code.slice(m.index, m.index + ACTIVE_INVOICE_WINDOW);
      if (!RAW_STORNO_STATUS_RE.test(w) || !RAW_STORNO_TYPE_RE.test(w)) continue;
      const back = code.slice(Math.max(0, m.index - ACTIVE_INVOICE_LOOKBEHIND), m.index);
      const bound = RAW_APPOINTMENT_BOUND_RE.test(w);
      const projected = RAW_APPOINTMENT_ID_PROJECTED_RE.test(back);
      if (bound || projected) {
        out.push({
          file: rel,
          detail:
            "baut das Storno-Paar in Roh-SQL selbst an `invoice_line_items.appointment_id` statt " +
            "`activeInvoiceForAppointmentExistsSqlRaw` / `latestActiveInvoiceForAppointmentLateralRaw` / " +
            "`activeInvoicedAppointmentIdsSqlRaw`",
        });
        break;
      }
    }

    for (const m of code.matchAll(/invoiceLineItems\.appointmentId/g)) {
      const w = code.slice(m.index, m.index + ACTIVE_INVOICE_WINDOW);
      if (DRIZZLE_STORNO_STATUS_RE.test(w) && DRIZZLE_STORNO_TYPE_RE.test(w)) {
        out.push({
          file: rel,
          detail:
            "baut das Storno-Paar als Drizzle-Bedingung selbst statt `activeInvoiceCondition()` zu komponieren",
        });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A7 — „Gehört dieser Termin dem Mitarbeiter?"-SSoT (Leistungsnachweis-Umfang)
// ---------------------------------------------------------------------------

/**
 * Task #1896 — Der Umfang eines Leistungsnachweises („nur eigene Termine") war
 * zweimal formuliert: als private Funktion `employeeFilter` und wortgleich
 * inline in `getServiceRecordsOverview`. Die Inline-Kopie war der Grund, warum
 * die Regel überhaupt umgangen werden konnte, ohne dass es auffiel.
 *
 * SSoT ist jetzt `appointmentBelongsToEmployeeScope`
 * (`shared/domain/service-record-scope.ts`) mit dem SQL-Spiegel
 * `employeeServiceRecordScopeCondition` (`server/lib/service-record-scope.ts`).
 *
 * ABGRENZUNG (bewusst eng): Das Paar `assigned OR performed` beantwortet im
 * Repo MEHRERE Fragen — „welche Kunden sieht der Mitarbeiter?"
 * (`customers-storage.ts`), „welche Termine sind seine Arbeitszeit?"
 * (`appointments-storage.ts` / Zeiterfassung), „hat er noch offene Termine?"
 * (Deaktivierungs-Guard). Die alle einzusammeln hieße, verschiedene Fragen zu
 * einer zu erklären, und die Allowlist wäre eine Attrappe. Erkannt wird deshalb
 * nur das Paar in Dateien, die AUCH die Leistungsnachweis-Tabellen anfassen —
 * genau dort, wo die Frage „was darf in MEINEN Nachweis?" gestellt wird.
 */
const SERVICE_RECORD_SCOPE_ALLOWLIST = new Set<string>(
  ssotGuardAllowlist("service-record-employee-scope", "SERVICE_RECORD_SCOPE_ALLOWLIST"),
);

/** Kennzeichnet eine Datei als Leistungsnachweis-Kontext. */
const SERVICE_RECORD_CONTEXT_RE =
  /\b(monthlyServiceRecords|serviceRecordAppointments|monthly_service_records|service_record_appointments)\b/;

/** Fenster hinter einem `or(` — grob eine Bedingungs-Gruppe. */
const SCOPE_PAIR_WINDOW = 300;

/**
 * Beide Spalten als Drizzle-Interpolation mit `=` und einem `OR` dazwischen,
 * in beiden Reihenfolgen. Deckt die SQL-Template-Schreibweise ab.
 */
const SCOPE_PAIR_TEMPLATE_RE =
  /\.(?:assignedEmployeeId|performedByEmployeeId)\}?\s*=[^;]{0,160}\bOR\b[^;]{0,160}\.(?:assignedEmployeeId|performedByEmployeeId)\}?\s*=/;

export function detectServiceRecordScopeViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (SERVICE_RECORD_SCOPE_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content).replace(/\s+/g, " ");
    if (!SERVICE_RECORD_CONTEXT_RE.test(code)) continue;

    let hit = false;

    // Drizzle-Form: or( eq|inArray(*.assignedEmployeeId, …), eq|inArray(*.performedByEmployeeId, …) )
    for (const m of code.matchAll(/\bor\(/g)) {
      const w = code.slice(m.index, m.index + SCOPE_PAIR_WINDOW);
      if (
        /\b(?:eq|inArray)\(\s*[A-Za-z0-9_.]*\.assignedEmployeeId\s*,/.test(w) &&
        /\b(?:eq|inArray)\(\s*[A-Za-z0-9_.]*\.performedByEmployeeId\s*,/.test(w)
      ) {
        hit = true;
        break;
      }
    }

    // SQL-Template-Form mit camelCase-Interpolation — GENAU die Schreibweise der
    // entfernten `employeeFilter`:
    //   sql`(${appointments.assignedEmployeeId} = ${id} OR ${appointments.performedByEmployeeId} = ${id})`
    // Sie ist weder `or(eq(...))` noch snake_case-Roh-SQL und lief deshalb an
    // den beiden anderen Regeln vorbei. Der wahrscheinlichste Rückfall ist,
    // genau diese Zeile zurückzuschreiben — sie war zehn Monate lang der
    // Bestand.
    if (!hit && SCOPE_PAIR_TEMPLATE_RE.test(code)) hit = true;

    // Roh-SQL-Form: beide Spalten mit `=` und einem `OR` dazwischen.
    if (
      !hit &&
      /assigned_employee_id\s*=[^;]{0,120}\bOR\b[^;]{0,120}performed_by_employee_id\s*=/i.test(code)
    ) {
      hit = true;
    }
    if (
      !hit &&
      /performed_by_employee_id\s*=[^;]{0,120}\bOR\b[^;]{0,120}assigned_employee_id\s*=/i.test(code)
    ) {
      hit = true;
    }

    if (hit) {
      out.push({
        file: rel,
        detail:
          "formuliert den Leistungsnachweis-Umfang (`assigned ODER performed`) selbst, statt " +
          "`employeeServiceRecordScopeCondition()` / `appointmentBelongsToEmployeeScope()` zu benutzen",
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// A8 — „Termin zur Re-Dokumentation zurueckgeben"-SSoT (Definitions-Rand)
// ---------------------------------------------------------------------------

/**
 * Task #70-FINDING — Der Reopen (Budget reversen, Holds freigeben, Signatur
 * leeren, Status auf `documenting`) war dreifach geschrieben. Zwei der Kopien
 * machten nur den halben Weg und liessen die Budget-Buchung stehen; weil der
 * Dokumentations-Pfad beim erneuten Abschluss eine vorhandene, nicht-stornierte
 * Buchung UEBERNIMMT statt neu zu buchen, war die Folge eine stille
 * UNTERbuchung — geld- und GoBD-relevant.
 *
 * Erkannt wird die Signatur des halben Wegs: ein Schreibvorgang, der den Status
 * auf `documenting` setzt UND im selben Zug die Termin-Signatur leert. Das ist
 * genau das, was die SSoT tut — wer es selbst schreibt, umgeht sie.
 *
 * ABGRENZUNG: `status: "documenting"` allein ist NICHT genug (der Start-Pfad
 * `/appointments/:id/end` setzt ihn ohne jeden Reopen-Charakter, ebenso die
 * Einmal-Migration fuer `expired_unsigned`). Erst die Kombination mit dem
 * Leeren von `signatureData` macht es zum Reopen.
 */
const APPOINTMENT_REOPEN_ALLOWLIST = new Set<string>(
  ssotGuardAllowlist("appointment-reopen", "APPOINTMENT_REOPEN_ALLOWLIST"),
);

/** Fenster um ein `documenting`-Vorkommen — grob ein Update-Objekt. */
const REOPEN_WINDOW = 400;

export function detectAppointmentReopenViolations(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (APPOINTMENT_REOPEN_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content).replace(/\s+/g, " ");

    for (const m of code.matchAll(/status:\s*["']documenting["']/g)) {
      const start = Math.max(0, m.index - REOPEN_WINDOW / 2);
      const w = code.slice(start, m.index + REOPEN_WINDOW);
      if (/signatureData:\s*null/.test(w)) {
        out.push({
          file: rel,
          detail:
            "setzt `status: 'documenting'` und leert die Termin-Signatur selbst, statt " +
            "`reopenAppointmentForRedocumentation()` zu rufen — die Budget-Rueckbuchung fehlt dabei",
        });
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architektur — SSoT-Import-Wächter (Task #1238)", () => {
  const regexScanFiles = collectScanFiles(["server", "shared", "client/src"], { includeTsx: true });
  const readinessScanFiles = collectScanFiles(["server", "shared"]);

  it("A1: `computeCapSlot`/`computeCapRemaining` werden nur aus dem Cap-SSoT importiert", () => {
    const v = detectCapSsotImportViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Cap-/Verfügbarkeits-SSoT verletzt — die folgende(n) Datei(en) importieren die Cap-Mathematik direkt:\n" +
          formatViolations(v) +
          "\n\nVerfügbarkeit/Cap MUSS über `readUnifiedBudgetAvailability` " +
          "(server/storage/budget/unified-reader.ts) gelesen werden. Ist der Import " +
          "ein bewusst neuer Budget-interner Konsument, ergänze die Allowlist in " +
          "tests/architecture/ssot-imports.test.ts.",
      );
    }
  });

  it("A1 (Negativ): ein bewusst eingebauter Cap-Import wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-cap-route.ts",
        content: `import { computeCapSlot } from "../storage/budget/cap-calculator";\nexport const x = 1;`,
      },
      {
        rel: "client/src/features/budget/fake-cap-math.ts",
        content: `import { computeCapRemaining } from "@shared/domain/budget/cap-math";`,
      },
    ];
    const v = detectCapSsotImportViolations(synthetic);
    expect(v.map((h) => h.file)).toEqual([
      "server/routes/fake-cap-route.ts",
      "client/src/features/budget/fake-cap-math.ts",
    ]);
  });

  it("A2: Readiness-Funktionen werden nur im Monatsabschluss-SSoT-Modul definiert", () => {
    const v = detectReadinessDefinitionViolations(readinessScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Readiness-SSoT verletzt — `get(Admin)MonthClosingReadiness` außerhalb des SSoT-Moduls definiert:\n" +
          formatViolations(v) +
          "\n\nDie Monatsabschluss-Readiness lebt ausschließlich in " +
          "server/storage/time-tracking/month-closing.ts. Importiere/rufe sie auf, " +
          "statt sie neu zu definieren.",
      );
    }
  });

  it("A2 (Negativ): eine bewusst eingebaute Readiness-Definition wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-readiness.ts",
        content: `export async function getMonthClosingReadiness() {\n  return { ready: true };\n}`,
      },
    ];
    const v = detectReadinessDefinitionViolations(synthetic);
    expect(v.length).toBeGreaterThan(0);
    expect(v[0].file).toBe("server/routes/fake-readiness.ts");
  });

  it("A2b: keine zweite Readiness-Blocker-Aggregation außerhalb des SSoT-Moduls", () => {
    const v = detectReadinessAggregationViolations(readinessScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Readiness-SSoT verletzt — Monatsabschluss-Blocker außerhalb des SSoT-Moduls erneut aggregiert:\n" +
          formatViolations(v) +
          "\n\nDie Frage „abschließbar?\u201c (offene Termine + fehlende Unterschriften + " +
          "Zeiteinträge-Aktivität) wird ausschließlich in " +
          "server/storage/time-tracking/month-closing.ts beantwortet. Lies das Ergebnis " +
          "über `get(Admin)MonthClosingReadiness`, statt die Blocker selbst zusammenzubauen. " +
          "Reine `isMonthClosed`/`monthCloseCache`-Lookups (Frage „Monat zu?\u201c) sind hiervon " +
          "ausgenommen.",
      );
    }
  });

  it("A2b (Negativ): eine eingeschleuste Blocker-Aggregation wird erkannt, reine isMonthClosed-Lookups nicht", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-readiness-aggregation.ts",
        content:
          `const open = await db.select().from(appointments).where(` +
          `notInArray(appointments.status, ["completed", "cancelled", "customer_no_show"]));\n` +
          `const unsigned = await db.select().from(appointments).where(appointmentCompletedButUnsignedCondition());\n` +
          `const activity = await db.select().from(employeeTimeEntries);\n` +
          `const ready = open.length === 0 && unsigned.length === 0 && activity.length > 0;`,
      },
      {
        rel: "server/services/fake-month-closed-lookup.ts",
        content:
          `const monthCloseCache = new Map<string, boolean>();\n` +
          `const closed = await isMonthClosed(employeeId, dateStr);\n` +
          `if (closed) return;`,
      },
    ];
    const v = detectReadinessAggregationViolations(synthetic);
    expect(v.map((h) => h.file)).toEqual(["server/routes/fake-readiness-aggregation.ts"]);
  });

  it("A3: keine eigene `signature_data`-/`signatureData`-Bedingung außerhalb der dokumentiert-SSoT", () => {
    const v = detectDocumentedPredicateViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Dokumentiert-SSoT verletzt — eigene Unterschrift-Null-Prüfung gefunden:\n" +
          formatViolations(v) +
          "\n\nDie Frage „dokumentiert & unterschrieben?" +
          "\u201c gehört ausschließlich in server/lib/appointment-signed.ts " +
          "(bzw. das reine Prädikat in shared/domain/appointments.ts). Nutze die dort " +
          "exportierten Bedingungen statt einer eigenen signature_data-Prüfung.",
      );
    }
  });

  it("A3b: `hasDirectSignatureSqlRaw` wird nur aus der Allowlist importiert", () => {
    const v = detectDirectSignatureImportViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Primitiv-Import außerhalb der Allowlist gefunden:\n" +
          formatViolations(v) +
          "\n\n`hasDirectSignatureSqlRaw` ist das PRIMITIV (nur die Tatsache " +
          "„liegt eine direkte Unterschrift vor?\u201c). Wer „dokumentiert & " +
          "unterschrieben?\u201c meint, nimmt `documentedAndSignedSqlRaw`. Ist der " +
          "neue Aufrufer wirklich ein Komponist, der die Teilflags EINZELN braucht, " +
          "ergänze DIRECT_SIGNATURE_IMPORT_ALLOWLIST in dieser Datei.",
      );
    }
  });

  it("A3b (Negativ): ein Primitiv-Import außerhalb der Allowlist wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-primitive-import.ts",
        content: 'import { hasDirectSignatureSqlRaw } from "../lib/appointment-signed";',
      },
    ];
    expect(detectDirectSignatureImportViolations(synthetic)).toHaveLength(1);
    // Die Allowlist-Datei selbst darf ihn importieren.
    expect(
      detectDirectSignatureImportViolations([
        {
          rel: "server/storage/billing/pipeline-reader.ts",
          content: 'import { hasDirectSignatureSqlRaw } from "../../lib/appointment-signed";',
        },
      ]),
    ).toHaveLength(0);
  });

  it("A3 (Negativ): eine bewusst gebaute completed-/signature-Bedingung wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-doc-raw.ts",
        content: "const q = sql`a.status = 'completed' AND a.signature_data IS NOT NULL`;",
      },
      {
        rel: "server/routes/fake-doc-drizzle.ts",
        content: `const q = and(eq(appointments.status, "completed"), isNotNull(appointments.signatureData));`,
      },
    ];
    const v = detectDocumentedPredicateViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-doc-drizzle.ts",
      "server/routes/fake-doc-raw.ts",
    ]);
  });

  it("A4: `planCascade` wird nur Budget-intern aufgerufen", () => {
    const v = detectCascadeCallViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Cascade-SSoT verletzt — die folgende(n) Datei(en) rufen `planCascade` außerhalb der Allowlist auf:\n" +
          formatViolations(v) +
          "\n\nDie Verteilung eines Betrags über die Töpfe (Cascading-Allocation + " +
          "Selbstzahler-Rest) gibt es nur EINMAL — `planCascade` " +
          "(shared/domain/budget/plan-cascade.ts). Buche/reserviere/derive über die " +
          "bestehenden Pfade, statt eine eigene Topf-Verteilung zu bauen. Ist die Datei " +
          "ein bewusst neuer Budget-interner Aufrufer, ergänze die Allowlist hier UND " +
          "dokumentiere ihn in docs/budget-ssot-audit.md.",
      );
    }
  });

  it("A4 (Negativ): ein bewusst eingebauter `planCascade`-Aufruf wird erkannt, ein Import nicht", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-cascade-route.ts",
        content: `const { splits } = planCascade(cost, pots);`,
      },
      {
        rel: "server/routes/fake-cascade-import.ts",
        content: `import { planCascade } from "@shared/domain/budget/plan-cascade";`,
      },
    ];
    const v = detectCascadeCallViolations(synthetic);
    expect(v.map((h) => h.file)).toEqual(["server/routes/fake-cascade-route.ts"]);
  });

  it("A5: keine eigene `acceptsPrivatePayment || selbstzahler`-Formel außerhalb der Privatzahler-SSoT", () => {
    const v = detectPrivatePaymentFormulaViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Privatzahler-SSoT verletzt — hand-gerollte Privatanteil-Formel gefunden:\n" +
          formatViolations(v) +
          "\n\nDie Frage „Privatanteil erlaubt?\u201c gehört ausschließlich in " +
          "`isPrivatePaymentAllowed` (shared/domain/budget-selbstzahler-validator.ts). " +
          "Importiere/rufe sie auf, statt `acceptsPrivatePayment || selbstzahler` selbst " +
          "zu kombinieren.",
      );
    }
  });

  it("A5 (Negativ): eine bewusst eingebaute Privatanteil-Formel wird erkannt, der SSoT-Aufruf nicht", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-private-a.ts",
        content: `const allowed = customer.acceptsPrivatePayment || customer.billingType === "selbstzahler";`,
      },
      {
        rel: "server/routes/fake-private-b.ts",
        content: `const allowed = billingType === "selbstzahler" || acceptsPrivatePayment;`,
      },
      {
        rel: "server/routes/fake-private-ssot.ts",
        content: `const allowed = isPrivatePaymentAllowed({ billingType, acceptsPrivatePayment });`,
      },
    ];
    const v = detectPrivatePaymentFormulaViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-private-a.ts",
      "server/routes/fake-private-b.ts",
    ]);
  });

  it("A6: das Storno-Paar wird nur in der Aktive-Rechnung-SSoT an `appointment_id` gebunden", () => {
    const v = detectActiveInvoicePredicateViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Aktive-Rechnung-SSoT verletzt — eigenes Storno-Prädikat am Termin gefunden:\n" +
          formatViolations(v) +
          "\n\nDie Frage „Liegt dieser Termin auf einer AKTIVEN Rechnung?“ gehört " +
          "ausschließlich in `server/lib/appointment-invoiced.ts`. Komponiere " +
          "`activeInvoiceCondition()` (Drizzle) bzw. nutze " +
          "`activeInvoiceForAppointmentExistsSqlRaw` / " +
          "`latestActiveInvoiceForAppointmentLateralRaw` / " +
          "`activeInvoicedAppointmentIdsSqlRaw` (Roh-SQL) und hänge deinen " +
          "Zusatz-Scope (Kunde, Zeitraum …) daneben, statt „aktiv“ neu zu formulieren.",
      );
    }
  });

  it("A8: der Reopen wird nur in der Reopen-SSoT geschrieben", () => {
    const v = detectAppointmentReopenViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Reopen-SSoT verletzt — eigener Reopen (documenting + Signatur leeren) gefunden:\n" +
          formatViolations(v) +
          "\n\nDer Reopen gehoert ausschliesslich in `server/lib/appointment-reopen.ts`. " +
          "Wer ihn selbst schreibt, laesst die Budget-Buchung stehen — und der " +
          "Dokumentations-Pfad uebernimmt sie beim erneuten Abschluss, statt neu zu " +
          "buchen: stille Unterbuchung.",
      );
    }
  });

  it("A8 (Negativ): der halbe Reopen wird erkannt, `documenting` ohne Signatur-Leerung und der SSoT-Aufruf nicht", () => {
    const synthetic: ScanFile[] = [
      {
        // Genau die entfernte Kopie -> Verstoss.
        rel: "server/routes/admin/fake-revoke.ts",
        content: `await storage.updateAppointment(entityId, {
          signatureData: null,
          signatureHash: null,
          signedAt: null,
          signedByUserId: null,
          status: "documenting",
        } as any);`,
      },
      {
        // `documenting` OHNE Signatur-Leerung (Start-Pfad) -> kein Verstoss.
        rel: "server/routes/fake-end.ts",
        content: `await storage.updateAppointment(id, { status: "documenting", actualStart: now });`,
      },
      {
        // SSoT benutzt -> kein Verstoss.
        rel: "server/routes/fake-caller.ts",
        content: `const facts = await reopenAppointmentForRedocumentation(appointment, userId, txClient);`,
      },
    ];
    const v = detectAppointmentReopenViolations(synthetic);
    expect(v.map((h) => h.file)).toEqual(["server/routes/admin/fake-revoke.ts"]);
  });

  it("A7: der Leistungsnachweis-Umfang wird nur in der Scope-SSoT formuliert", () => {
    const v = detectServiceRecordScopeViolations(regexScanFiles);
    if (v.length > 0) {
      expect.fail(
        "Leistungsnachweis-Umfangs-SSoT verletzt — eigenes `assigned ODER performed` im LN-Kontext:\n" +
          formatViolations(v) +
          "\n\nDie Frage \u201egeh\u00f6rt dieser Termin dem Mitarbeiter?\u201c geh\u00f6rt in " +
          "`shared/domain/service-record-scope.ts` (Pr\u00e4dikat) bzw. " +
          "`server/lib/service-record-scope.ts` (SQL-Spiegel). Beantwortet die Stelle " +
          "eine ANDERE Frage (Kundensicht, Arbeitszeit, offene Termine), geh\u00f6rt sie " +
          "nicht in eine Datei mit den Leistungsnachweis-Tabellen \u2014 sonst wird der " +
          "Umfang zum zweiten Mal definiert.",
      );
    }
  });

  it("A7 (Negativ): alle drei Schreibweisen im LN-Kontext werden erkannt, dieselbe Formel ohne LN-Bezug und der SSoT-Aufruf nicht", () => {
    const synthetic: ScanFile[] = [
      {
        // Drizzle-Kopie IM LN-Kontext -> Verstoss.
        rel: "server/storage/fake-sr-drizzle.ts",
        content: `const rows = await db.select().from(monthlyServiceRecords)
          .leftJoin(appointments, and(
            eq(appointments.customerId, customers.id),
            or(
              eq(appointments.assignedEmployeeId, employeeId),
              eq(appointments.performedByEmployeeId, employeeId),
            ),
          ));`,
      },
      {
        // Roh-SQL-Kopie IM LN-Kontext -> Verstoss.
        rel: "server/storage/fake-sr-raw.ts",
        content: `const q = sql\`SELECT 1 FROM service_record_appointments sra
          JOIN appointments a ON a.id = sra.appointment_id
          WHERE (a.assigned_employee_id = 7 OR a.performed_by_employee_id = 7)\`;`,
      },
      {
        // Die ORIGINAL-Schreibweise der entfernten `employeeFilter`
        // (SQL-Template, camelCase) IM LN-Kontext -> Verstoss. Sie lief an den
        // ersten beiden Regeln vorbei; ohne diesen Fall waere der Waechter
        // gegen den wahrscheinlichsten Rueckfall blind.
        rel: "server/storage/fake-sr-template.ts",
        content: `import { monthlyServiceRecords } from "@shared/schema";
          function employeeFilter(employeeId: number) {
            return sqlBuilder\`(\${appointments.assignedEmployeeId} = \${employeeId} OR \${appointments.performedByEmployeeId} = \${employeeId})\`;
          }`,
      },
      {
        // Mengen-Variante `or(inArray, inArray)` IM LN-Kontext -> Verstoss.
        rel: "server/storage/fake-sr-inarray.ts",
        content: `const rows = await db.select().from(serviceRecordAppointments)
          .where(or(
            inArray(appointments.assignedEmployeeId, ids),
            inArray(appointments.performedByEmployeeId, ids),
          ));`,
      },
      {
        // Dieselbe Formel, aber ANDERE Frage (keine LN-Tabelle) -> kein Verstoss.
        rel: "server/storage/fake-worktime.ts",
        content: `const filter = or(
          eq(appointments.assignedEmployeeId, employeeId),
          eq(appointments.performedByEmployeeId, employeeId),
        );`,
      },
      {
        // SSoT benutzt -> kein Verstoss.
        rel: "server/storage/fake-sr-ssot.ts",
        content: `const rows = await db.select().from(monthlyServiceRecords)
          .where(and(employeeServiceRecordScopeCondition(employeeId)));`,
      },
    ];
    const v = detectServiceRecordScopeViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/storage/fake-sr-drizzle.ts",
      "server/storage/fake-sr-inarray.ts",
      "server/storage/fake-sr-raw.ts",
      "server/storage/fake-sr-template.ts",
    ]);
  });

  it("A6 (Negativ): termin-gebundene Kopien (beide Schreibrichtungen) werden erkannt, Aggregate ohne Termin-Bindung und der SSoT-Aufruf nicht", () => {
    const synthetic: ScanFile[] = [
      {
        // Roh-SQL-Kopie, korreliert auf einen Termin → Verstoß.
        rel: "server/storage/fake-raw-copy.ts",
        content: `const q = sql\`EXISTS (SELECT 1 FROM invoice_line_items li
          JOIN invoices i ON i.id = li.invoice_id
          WHERE li.appointment_id = a.id
            AND i.status != 'storniert' AND i.invoice_type != 'stornorechnung')\`;`,
      },
      {
        // Drizzle-Kopie → Verstoß.
        rel: "server/services/fake-drizzle-copy.ts",
        content: `const rows = await db.select({ appointmentId: invoiceLineItems.appointmentId })
          .from(invoiceLineItems)
          .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
          .where(and(
            inArray(invoiceLineItems.appointmentId, ids),
            ne(invoicesTable.status, "storniert"),
            ne(invoicesTable.invoiceType, "stornorechnung"),
          ));`,
      },
      {
        // Umkehrform `<termin>.id IN (SELECT … appointment_id …)` → Verstoß.
        // Genau die Schreibweise, durch die eine Kopie sonst grün durchläuft.
        rel: "server/storage/statistics/fake-in-form.ts",
        content: `const q = sql\`SELECT SUM(a.duration_promised) FROM appointments a
          WHERE a.deleted_at IS NULL AND a.id IN (
            SELECT DISTINCT li.appointment_id
            FROM invoice_line_items li JOIN invoices i ON i.id = li.invoice_id
            WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
              AND li.appointment_id IS NOT NULL)\`;`,
      },
      {
        // Geld-Aggregat über aktive Rechnungen: Termin nur als
        // Attributions-Join bzw. NOT-NULL-Filter, Projektion ist eine Summe →
        // bewusst KEIN Verstoß (andere fachliche Frage, eigenes Vorhaben).
        rel: "server/storage/statistics/fake-revenue.ts",
        content: `const q = sql\`SELECT SUM(li.total_cents) FROM invoice_line_items li
          JOIN invoices i ON i.id = li.invoice_id
          JOIN appointments a ON a.id = li.appointment_id
          WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
            AND li.appointment_id IS NOT NULL\`;`,
      },
      {
        // Zähl-Aggregat: `COUNT(DISTINCT …appointment_id)` ist keine Projektion
        // der Termin-Menge → ebenfalls KEIN Verstoß.
        rel: "server/storage/statistics/fake-count.ts",
        content: `const q = sql\`SELECT COUNT(DISTINCT li.appointment_id) FROM invoice_line_items li
          JOIN invoices i ON i.id = li.invoice_id
          WHERE i.status != 'storniert' AND i.invoice_type != 'stornorechnung'
            AND li.appointment_id IS NOT NULL\`;`,
      },
      {
        // Korrekte Nutzung der SSoT → kein Verstoß.
        rel: "server/storage/fake-ssot-user.ts",
        content: `const q = sql\`SELECT \${activeInvoiceForAppointmentExistsSqlRaw("a.id")} AS is_invoiced\`;
          const w = and(inArray(invoiceLineItems.appointmentId, ids), activeInvoiceCondition());`,
      },
      {
        // Auskommentierte Kopie → `stripComments` entfernt sie, kein Verstoß.
        rel: "server/storage/fake-commented-out.ts",
        content: `// WHERE li.appointment_id = a.id AND i.status != 'storniert'
          //   AND i.invoice_type != 'stornorechnung' — invoice_line_items
          const q = 1;`,
      },
    ];
    const v = detectActiveInvoicePredicateViolations(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/services/fake-drizzle-copy.ts",
      "server/storage/fake-raw-copy.ts",
      "server/storage/statistics/fake-in-form.ts",
    ]);
  });
});
