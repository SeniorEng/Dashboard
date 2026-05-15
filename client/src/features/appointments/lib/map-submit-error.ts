import { ApiError } from "@/lib/api/client";

/**
 * Beschreibung des zuletzt fehlgeschlagenen Doku-Submits für die UI.
 * Wird vom Doku-Hook in den persistenten Fehler-Banner gerendert.
 */
export interface SubmitErrorView {
  message: string;
  code?: string;
  errorCode?: string;
  isAlreadyCompleted: boolean;
  isSignatureLocked: boolean;
  /** Darf der Nutzer "Erneut speichern" klicken? */
  canRetry: boolean;
  /**
   * Soll der Browser nach kurzer Anzeige zurück auf die Tagesübersicht navigieren?
   * Setzen wir für die finalen 4xx-Fälle (ALREADY_COMPLETED, SIGNATURE_LOCKED) auf
   * true, damit der Nutzer nicht in einem leeren Formular hängen bleibt.
   */
  shouldNavigateBack: boolean;
}

/**
 * Übersetzt einen Mutation-Fehler in das, was die Mobile-Doku im
 * Fehler-Banner anzeigt. Pure Funktion (kein React, kein Router, keine Toasts),
 * damit wir das Verhalten in Vitest unter `node`-Env absichern können.
 *
 * Konventionen:
 * - `ApiError.details.errorCode` ist die fachliche Sub-Klassifikation, die der
 *   Server in `data.error` mitschickt (z.B. "ALREADY_COMPLETED").
 * - Bei finalen 4xx-Fehlern lassen wir keinen Retry zu — der Server hat klar
 *   gesagt, dass weitere Versuche nichts ändern.
 * - Bei Netzwerk-/Server-Fehlern erlauben wir den manuellen Retry über den
 *   Banner-Button, auch wenn `submitWithRetry` intern bereits aufgegeben hat.
 */
export function mapSubmitError(error: Error): SubmitErrorView {
  const apiErr = error instanceof ApiError ? error : null;
  const errorCode = (apiErr?.details?.errorCode as string | undefined) ?? undefined;
  const isAlreadyCompleted = errorCode === "ALREADY_COMPLETED";
  const isSignatureLocked = errorCode === "SIGNATURE_LOCKED";

  let message = error.message;
  if (isAlreadyCompleted) {
    message = "Dieser Termin wurde bereits abgeschlossen. Sie werden zurück zur Tagesübersicht geleitet.";
  } else if (isSignatureLocked) {
    message =
      "Dieser Termin hat bereits eine gesperrte Unterschrift und kann nicht erneut dokumentiert werden. Sie werden zurück zur Tagesübersicht geleitet.";
  } else if (apiErr?.code === "NETWORK_ERROR") {
    message = "Keine Verbindung. Bitte prüfen Sie Ihre Internetverbindung und versuchen Sie es erneut.";
  }

  return {
    message,
    code: apiErr?.code,
    errorCode,
    isAlreadyCompleted,
    isSignatureLocked,
    canRetry: !isAlreadyCompleted && !isSignatureLocked,
    shouldNavigateBack: isAlreadyCompleted || isSignatureLocked,
  };
}
