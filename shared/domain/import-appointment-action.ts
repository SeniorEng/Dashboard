/**
 * Task #819: Single-Source-of-Truth für die Ableitung der Default-Import-Aktion
 * einer abgeglichenen Excel-Zeile. Vorher war diese Status→Aktion-Logik mehrfach
 * (Preview-Default + Checkbox-Toggle in der UI) dupliziert und konnte driften.
 *
 * Drei fachliche Ergebnisse:
 *  - `create`  → neue Zeile, es gibt keinen Bestandstermin (Status `new`).
 *  - `update`  → Bestandstermin existiert UND es gibt ein Feld-Diff
 *                (Duplikat mit Abweichung) ODER ein geplanter Termin wird
 *                auf `completed` hochgestuft (Status `upgrade`).
 *  - `noop`    → Bestandstermin existiert, aber identisch (kein Diff) oder die
 *                Zeile darf nicht angefasst werden (Cutoff/Fehler).
 */
export type ImportActionKind = "create" | "update" | "noop";

/** Konkrete Aktion, wie sie an den Execute-Endpoint geschickt wird. */
export type ImportRowAction = "import" | "update" | "upgrade" | "skip";

export interface ImportActionInput {
  status: "new" | "duplicate" | "upgrade" | "beyond_cutoff" | "error";
  /** Liegt ein Feld-Diff gegenüber dem Bestandstermin vor? */
  hasDiff: boolean;
}

/**
 * Fachliche Klassifikation der Zeile (create/update/noop) — UI-unabhängig.
 */
export function classifyImportAction(input: ImportActionInput): ImportActionKind {
  switch (input.status) {
    case "new":
      return "create";
    case "upgrade":
      return "update";
    case "duplicate":
      return input.hasDiff ? "update" : "noop";
    case "beyond_cutoff":
    case "error":
    default:
      return "noop";
  }
}

/**
 * Default-Aktion (für Execute-Payload + UI-Checkbox/Select) aus dem Status
 * abgeleitet. Identische Duplikate (`noop`) werden bewusst auf `skip` gesetzt,
 * damit der GoBD-Import keine unveränderten Bestandstermine sinnlos neu schreibt.
 */
export function determineImportAction(input: ImportActionInput): ImportRowAction {
  const kind = classifyImportAction(input);
  if (kind === "create") return "import";
  if (kind === "noop") return "skip";
  // kind === "update": geplante Termine werden hochgestuft, echte Duplikate aktualisiert.
  return input.status === "upgrade" ? "upgrade" : "update";
}

/**
 * Aktion, wenn der Nutzer die Zeile in der UI per Checkbox AKTIVIERT.
 * (Status entscheidet, ob importiert/aktualisiert/hochgestuft wird.)
 */
export function actionWhenSelected(
  status: ImportActionInput["status"],
): ImportRowAction {
  if (status === "upgrade") return "upgrade";
  if (status === "duplicate") return "update";
  return "import";
}
