/**
 * Task #1746 — Konsumenten-Wächter für die Termin-Status-Partition.
 *
 * Task #1745 hat mit einem Exhaustiveness-Guard abgesichert, dass die Partition
 * FINAL/UNDOCUMENTED in `shared/domain/appointments.ts` selbst vollständig und
 * konsistent ist (`FINAL_APPOINTMENT_STATUSES` ∪ `UNDOCUMENTED_STATUSES` =
 * `PERSISTED_APPOINTMENT_STATUSES`). Damit ist die SSoT intern gesund.
 *
 * NOCH NICHT abgesichert war, dass die DREI Konsumenten der Partition ihre
 * „offen vs. terminal"-Entscheidung tatsächlich aus dieser SSoT beziehen und
 * KEINE eigene Status-Liste re-listen:
 *
 *   1. Monatsabschluss-Readiness   → `server/storage/time-tracking/month-closing.ts`
 *      (offene vs. abgeschlossene Termine über `FINAL_APPOINTMENT_STATUSES`).
 *   2. Leistungsnachweis-Blockade  → `server/storage/service-records-storage.ts`
 *      (`getUndocumentedAppointmentsForPeriod` über `UNDOCUMENTED_STATUSES`).
 *   3. Abrechnungs-Karte „Noch zu erstellen" (noch offene Termine pro Kunde)
 *      → `server/services/invoice-data.ts` (`getOpenAppointmentCountByCustomer`
 *      über `FINAL_APPOINTMENT_STATUSES`).
 *
 * Ein Konsument, der still eine eigene Status-Liste pflegt, würde weiter driften,
 * ohne dass ein Test anschlägt. Dieser Wächter fängt genau das ab:
 *
 *   (A) Positiv-Bindung: Jede der drei Dateien MUSS die erwartete Partitions-
 *       Konstante aus `shared/domain/appointments` importieren.
 *   (B) Negativ-Rand: KEINE dieser drei Dateien (und kein anderer Produktiv-
 *       Konsument) darf die Partition als Status-LITERALE in
 *       `in/notInArray(appointments.status, [ … ])` re-listen, statt die
 *       Konstante (`[...FINAL_APPOINTMENT_STATUSES]` / `UNDOCUMENTED_STATUSES`)
 *       zu spreaden. Ein Spread der Konstante enthält keine Quoted-Literale und
 *       ist damit per Konstruktion erlaubt.
 *
 * Jeder Detektor ist PUR und wird vom Real-Tree-Scan UND vom Negativ-Test mit
 * DERSELBEN Funktion aufgerufen — der Negativ-Test beweist nachweislich, dass
 * eine bewusste Verletzung das Gate bricht.
 *
 * Abgrenzung: Die orthogonale Frage „dokumentiert & unterschrieben?" (rohe
 * `signature_data`-Prüfungen) wird vom Schwester-Wächter A3 in
 * `ssot-imports.test.ts` abgedeckt; die Partitions-Vollständigkeit selbst vom
 * Exhaustiveness-Guard in `tests/unit/appointment-status-partition.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  collectScanFiles,
  stripComments,
  formatViolations,
  type ScanFile,
  type GuardViolation,
} from "./guard-helpers";

// ---------------------------------------------------------------------------
// Kanonische Konsumenten der Partition (Task #1746)
// ---------------------------------------------------------------------------

interface PartitionConsumer {
  rel: string;
  role: string;
  /** Mindestens eine dieser Konstanten muss aus `domain/appointments` importiert werden. */
  expected: string[];
}

const PARTITION_CONSUMERS: PartitionConsumer[] = [
  {
    rel: "server/storage/time-tracking/month-closing.ts",
    role: "Monatsabschluss-Readiness (offene vs. abgeschlossene Termine)",
    expected: ["FINAL_APPOINTMENT_STATUSES"],
  },
  {
    rel: "server/storage/service-records-storage.ts",
    role: "Leistungsnachweis-Blockade (`getUndocumentedAppointmentsForPeriod`)",
    expected: ["UNDOCUMENTED_STATUSES"],
  },
  {
    rel: "server/services/invoice-data.ts",
    role: "Abrechnungs-Karte „Noch zu erstellen\u201c (offene Termine pro Kunde)",
    expected: ["FINAL_APPOINTMENT_STATUSES", "UNDOCUMENTED_STATUSES"],
  },
];

// ---------------------------------------------------------------------------
// (A) Positiv-Bindung — Import der Partitions-Konstante
// ---------------------------------------------------------------------------

/**
 * Matcht ein `import { … SYM … } from "…domain/appointments"`-Statement (auch
 * mehrzeilig und mit Default-/Namespace-Präfix). Der Modulpfad wird bewusst nur
 * über das Suffix `domain/appointments` erkannt, damit sowohl der Alias
 * (`@shared/domain/appointments`) als auch ein relativer Pfad greift.
 */
function importsPartitionConstant(code: string, symbol: string): boolean {
  const re = new RegExp(
    String.raw`import\b[^{};]*\{[^}]*\b${symbol}\b[^}]*\}\s*from\s*["'][^"']*domain/appointments["']`,
  );
  return re.test(code);
}

export function detectMissingPartitionImport(
  files: ScanFile[],
  consumers: PartitionConsumer[] = PARTITION_CONSUMERS,
): GuardViolation[] {
  const out: GuardViolation[] = [];
  const byRel = new Map(files.map((f) => [f.rel, f]));
  for (const consumer of consumers) {
    const file = byRel.get(consumer.rel);
    if (!file) {
      out.push({
        file: consumer.rel,
        detail: `Konsument (${consumer.role}) nicht gefunden — Pfad umbenannt/verschoben? Wächter aktualisieren.`,
      });
      continue;
    }
    const code = stripComments(file.content);
    const ok = consumer.expected.some((sym) => importsPartitionConstant(code, sym));
    if (!ok) {
      out.push({
        file: consumer.rel,
        detail: `bezieht die „offen vs. terminal\u201c-Entscheidung (${consumer.role}) nicht aus der SSoT — erwartet Import einer von {${consumer.expected.join(", ")}} aus shared/domain/appointments`,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (B) Negativ-Rand — keine re-gelisteten Status-Literale
// ---------------------------------------------------------------------------

/**
 * Erkennt eine hand-gerollte Partition: ein `in/notInArray(<…>.status, [ … ])`
 * auf der `appointments.status`-Spalte, dessen Literal-Array die Partition
 * re-listet — entweder das TERMINALE Triple (`completed` + `cancelled` +
 * `customer_no_show` = `FINAL_APPOINTMENT_STATUSES`) ODER das OFFENE Paar
 * (`scheduled` + `documenting` = `UNDOCUMENTED_STATUSES`).
 *
 * Bewusst NICHT erfasst (andere fachliche Frage, kein Re-List der Partition):
 *   - ein Spread der Konstante (`[...FINAL_APPOINTMENT_STATUSES]`) — enthält
 *     keine Quoted-Literale, matcht daher nie.
 *   - Teilmengen, die eine andere Frage stellen: z. B.
 *     `notInArray(status, ["cancelled", "customer_no_show"])` (Aktivitäts-Gate,
 *     ohne `completed`) oder `inArray(status, ["completed", "documenting"])`
 *     (Stunden-Sicht) — beide sind KEIN Re-List der Partition und bleiben
 *     erlaubt (siehe Negativ-Test).
 */
const STATUS_ARRAY_RE =
  /(?:not)?[iI]nArray\s*\(\s*[A-Za-z0-9_.]*\.status\s*,\s*\[([^\]]*)\]/g;

function hasLiteral(body: string, lit: string): boolean {
  return new RegExp(`["']${lit}["']`).test(body);
}

/** Nur diese Datei DEFINIERT die Partition (und listet die Werte legitim). */
const PARTITION_LITERAL_ALLOWLIST = new Set<string>([
  "shared/domain/appointments.ts",
]);

export function detectPartitionLiteralRelist(files: ScanFile[]): GuardViolation[] {
  const out: GuardViolation[] = [];
  for (const { rel, content } of files) {
    if (rel.startsWith("tests/")) continue;
    if (PARTITION_LITERAL_ALLOWLIST.has(rel)) continue;
    const code = stripComments(content);
    const re = new RegExp(STATUS_ARRAY_RE.source, "g");
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      const body = m[1];
      const completed = hasLiteral(body, "completed");
      const cancelled = hasLiteral(body, "cancelled");
      const noShow = hasLiteral(body, "customer_no_show");
      const scheduled = hasLiteral(body, "scheduled");
      const documenting = hasLiteral(body, "documenting");

      const terminalRelist = completed && cancelled && noShow;
      const openRelist = scheduled && documenting && !completed && !cancelled && !noShow;

      if (terminalRelist) {
        out.push({
          file: rel,
          detail:
            "re-listet die TERMINALE Partition (completed/cancelled/customer_no_show) als Literale in `in/notInArray(appointments.status, …)` — spreade `[...FINAL_APPOINTMENT_STATUSES]`",
        });
      } else if (openRelist) {
        out.push({
          file: rel,
          detail:
            "re-listet die OFFENE Partition (scheduled/documenting) als Literale in `in/notInArray(appointments.status, …)` — nutze `UNDOCUMENTED_STATUSES`",
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Architektur — Termin-Status-Partition-Konsumenten (Task #1746)", () => {
  const scanFiles = collectScanFiles(["server", "shared", "client/src"], { includeTsx: true });

  it("A: die drei Konsumenten importieren ihre „offen vs. terminal\u201c-Entscheidung aus der SSoT", () => {
    const v = detectMissingPartitionImport(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Partitions-SSoT verletzt — Konsument bezieht „offen vs. terminal\u201c nicht aus shared/domain/appointments:\n" +
          formatViolations(v) +
          "\n\nDie Frage „ist dieser Termin noch offen?\u201c hat GENAU EINE Partition " +
          "(FINAL_APPOINTMENT_STATUSES / UNDOCUMENTED_STATUSES in shared/domain/appointments.ts). " +
          "Importiere die passende Konstante, statt eine eigene Status-Liste zu pflegen.",
      );
    }
  });

  it("A (Negativ): eine fehlende Partitions-Import-Bindung wird erkannt", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/storage/time-tracking/month-closing.ts",
        content: `import { something } from "@shared/domain/other";\nexport const x = 1;`,
      },
      {
        rel: "server/storage/service-records-storage.ts",
        content: `import { UNDOCUMENTED_STATUSES } from "@shared/domain/appointments";`,
      },
      {
        rel: "server/services/invoice-data.ts",
        content: `import { FINAL_APPOINTMENT_STATUSES } from "@shared/domain/appointments";`,
      },
    ];
    const v = detectMissingPartitionImport(synthetic);
    expect(v.map((h) => h.file)).toEqual(["server/storage/time-tracking/month-closing.ts"]);
  });

  it("A (Negativ): ein umbenannter/verschobener Konsument bricht das Gate", () => {
    const v = detectMissingPartitionImport([]); // keine Datei gefunden
    expect(v.map((h) => h.file).sort()).toEqual(
      PARTITION_CONSUMERS.map((c) => c.rel).sort(),
    );
  });

  it("B: kein Produktiv-Konsument re-listet die Partition als Status-Literale", () => {
    const v = detectPartitionLiteralRelist(scanFiles);
    if (v.length > 0) {
      expect.fail(
        "Partitions-SSoT verletzt — hand-gerollte Status-Liste statt der Partitions-Konstante:\n" +
          formatViolations(v) +
          "\n\nSpreade `[...FINAL_APPOINTMENT_STATUSES]` bzw. nutze `UNDOCUMENTED_STATUSES` " +
          "(shared/domain/appointments.ts), statt die Status-Werte selbst aufzuzählen.",
      );
    }
  });

  it("B (Negativ): ein Re-List der Partition wird erkannt, andere Teilmengen & der Konstanten-Spread nicht", () => {
    const synthetic: ScanFile[] = [
      {
        rel: "server/routes/fake-terminal-relist.ts",
        content: `const q = notInArray(appointments.status, ["completed", "cancelled", "customer_no_show"]);`,
      },
      {
        rel: "server/routes/fake-open-relist.ts",
        content: `const q = inArray(appointments.status, ["scheduled", "documenting"]);`,
      },
      {
        rel: "server/routes/fake-constant-spread.ts",
        content: `const q = notInArray(appointments.status, [...FINAL_APPOINTMENT_STATUSES]);`,
      },
      {
        rel: "server/routes/fake-activity-gate.ts",
        content: `const q = notInArray(appointments.status, ["cancelled", "customer_no_show"]);`,
      },
      {
        rel: "server/routes/fake-hours-view.ts",
        content: `const q = inArray(appointments.status, ["completed", "documenting"]);`,
      },
    ];
    const v = detectPartitionLiteralRelist(synthetic);
    expect(v.map((h) => h.file).sort()).toEqual([
      "server/routes/fake-open-relist.ts",
      "server/routes/fake-terminal-relist.ts",
    ]);
  });
});
