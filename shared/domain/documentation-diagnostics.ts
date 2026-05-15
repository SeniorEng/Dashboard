/**
 * Pure Heuristik für die Admin-Diagnose hängender Dokumentationen.
 *
 * Eingabe: ein flaches Snapshot-Objekt aus Termin-Status, Signatur-Feldern,
 * dokumentierten Services und letzter relevanter Audit-Aktivität.
 * Ausgabe: eine kurze deutsche Bewertung mit Code, Schweregrad und Text.
 *
 * Keine I/O. Keine Imports aus `server/`. Test-Ziel: `tests/documentation-
 * diagnostics.test.ts`.
 */

import type { AppointmentStatus } from "./appointments";

export type DiagnosisSeverity = "info" | "warning" | "error";

export type DiagnosisCode =
  | "COMPLETED"
  | "NO_SHOW"
  | "CANCELLED"
  | "EXPIRED_UNSIGNED"
  | "NOT_STARTED"
  | "NO_SERVICES"
  | "MISSING_END_TIME"
  | "MISSING_SIGNATURE"
  | "READY_BUT_NOT_FINALIZED"
  | "IN_PROGRESS";

export interface DocumentationDiagnosisInput {
  status: AppointmentStatus;
  /** Termin-Datum (YYYY-MM-DD). */
  date: string;
  /** Tages-Stichtag, gegen den `date` verglichen wird (YYYY-MM-DD). */
  today: string;
  actualStart: string | null;
  actualEnd: string | null;
  hasSignatureData: boolean;
  /** Anzahl Services mit `actualDurationMinutes > 0`. */
  documentedServicesCount: number;
  /** Zeitstempel der letzten Audit-Aktivität (ISO-String) oder null. */
  lastActivityAt: string | null;
}

export interface DocumentationDiagnosis {
  code: DiagnosisCode;
  severity: DiagnosisSeverity;
  message: string;
}

function isInPast(date: string, today: string): boolean {
  return date < today;
}

/**
 * Liefert eine kurze, in Deutsch formulierte Bewertung, warum ein Termin
 * nicht im Status `completed` ist (bzw. dass er fertig ist).
 *
 * Reihenfolge der Prüfungen ist bewusst:
 *  1. Terminal-Status (`completed`, `customer_no_show`, `cancelled`,
 *     `expired_unsigned`) → eindeutige Aussage, ohne Heuristik.
 *  2. `scheduled` in der Vergangenheit → Mitarbeiter hat den Termin nie
 *     gestartet.
 *  3. `in-progress` → noch nicht beendet.
 *  4. `documenting` → genauere Differenzierung: keine Services, fehlende
 *     Endzeit, fehlende Unterschrift, oder „alles da, aber nicht final".
 */
export function diagnoseDocumentation(
  input: DocumentationDiagnosisInput,
): DocumentationDiagnosis {
  const {
    status,
    date,
    today,
    actualStart,
    actualEnd,
    hasSignatureData,
    documentedServicesCount,
    lastActivityAt,
  } = input;

  if (status === "completed") {
    return {
      code: "COMPLETED",
      severity: "info",
      message: "Termin ist vollständig dokumentiert und abgeschlossen.",
    };
  }

  if (status === "customer_no_show") {
    return {
      code: "NO_SHOW",
      severity: "info",
      message:
        "Termin wurde als \u201EKunde nicht angetroffen\u201C dokumentiert — keine reguläre Leistungsdokumentation nötig.",
    };
  }

  if (status === "cancelled") {
    return {
      code: "CANCELLED",
      severity: "info",
      message: "Termin wurde storniert.",
    };
  }

  if (status === "expired_unsigned") {
    return {
      code: "EXPIRED_UNSIGNED",
      severity: "error",
      message:
        "Termin wurde nicht rechtzeitig dokumentiert und beim Monatsabschluss auf \u201ENicht abgerechnet\u201C gesetzt. Eine nachträgliche Dokumentation ist nur durch die Geschäftsführung möglich.",
    };
  }

  if (status === "scheduled") {
    if (isInPast(date, today)) {
      const tail = lastActivityAt
        ? ` Letzte erfasste Aktivität: ${lastActivityAt}.`
        : " Es wurde keine Aktivität zu diesem Termin erfasst — der Mitarbeiter hat den Termin vermutlich nie gestartet.";
      return {
        code: "NOT_STARTED",
        severity: "warning",
        message: `Der Termin liegt in der Vergangenheit, wurde aber nie gestartet.${tail}`,
      };
    }
    return {
      code: "NOT_STARTED",
      severity: "info",
      message: "Termin ist geplant und liegt noch in der Zukunft.",
    };
  }

  if (status === "in-progress") {
    return {
      code: "IN_PROGRESS",
      severity: "warning",
      message:
        "Termin wurde gestartet, aber noch nicht beendet. Mitarbeiter hat den Besuch vermutlich nicht abgeschlossen.",
    };
  }

  // status === "documenting"
  if (documentedServicesCount === 0) {
    return {
      code: "NO_SERVICES",
      severity: "warning",
      message: actualStart
        ? "Termin wurde gestartet und beendet, aber es wurden keine Services dokumentiert."
        : "Termin wurde noch nicht dokumentiert — kein erfasster Service.",
    };
  }

  if (!actualEnd) {
    return {
      code: "MISSING_END_TIME",
      severity: "warning",
      message:
        "Services wurden erfasst, aber die Endzeit des Termins fehlt. Der Mitarbeiter hat die Dokumentation vermutlich nicht zu Ende geführt.",
    };
  }

  if (!hasSignatureData) {
    return {
      code: "MISSING_SIGNATURE",
      severity: "warning",
      message:
        "Services dokumentiert, aber Unterschrift fehlt. Der Mitarbeiter muss die Dokumentation mit der Kundenunterschrift abschließen.",
    };
  }

  return {
    code: "READY_BUT_NOT_FINALIZED",
    severity: "warning",
    message:
      "Alle Daten (Services und Unterschrift) sind erfasst, der Termin wurde aber nicht als abgeschlossen gespeichert. Vermutlich ist der Submit hängen geblieben.",
  };
}
