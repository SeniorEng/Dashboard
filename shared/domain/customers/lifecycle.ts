/**
 * Lebenszyklus aktiver Kunden (Task #1194).
 *
 * Ein Kunde bleibt `customers.status = 'aktiv'`, auch nachdem sein Vertrag
 * beendet oder gekündigt wurde — erst ein späterer, manueller Wechsel auf
 * `inaktiv` beendet die aktive Phase. Damit Listen und Statistik trotzdem
 * „laufend" von „gekündigt" unterscheiden können, klassifiziert diese reine
 * Funktion einen aktiven Kunden anhand seines (jüngsten) Vertrags.
 *
 * Regel:
 *   aktiv UND (Vertragsende gesetzt ODER Vertragsstatus 'terminated')
 *     ⇒ "gekuendigt"
 *   sonst ⇒ "laufend"
 *
 * Diese Datei ist die zentrale Quelle (SSoT) der Klassifikation und darf
 * KEINE UI-, HTTP- oder DB-Abhängigkeiten besitzen.
 */

export type ActiveCustomerLifecycle = "laufend" | "gekuendigt";

export const ACTIVE_CUSTOMER_LIFECYCLE_LABELS: Record<ActiveCustomerLifecycle, string> = {
  laufend: "Laufend",
  gekuendigt: "Gekündigt",
};

/** Vertragsstatus, der einen aktiven Kunden als „gekündigt" markiert. */
export const TERMINATED_CONTRACT_STATUS = "terminated";

export interface ActiveLifecycleInput {
  /** Kundenstatus aus `customers.status` ("aktiv" | "inaktiv" | "gekuendigt"). */
  status: string | null | undefined;
  /**
   * Vertragsende des jüngsten Vertrags (`customer_contracts.contract_end`).
   * `null`/leer = unbefristet/laufend.
   */
  contractEnd?: string | null;
  /** Status des jüngsten Vertrags (`customer_contracts.status`). */
  contractStatus?: string | null;
}

/**
 * Klassifiziert einen aktiven Kunden in "laufend" oder "gekuendigt".
 *
 * Gibt `null` zurück, wenn der Kunde nicht `status='aktiv'` ist — die
 * Unterscheidung gilt ausschließlich innerhalb der aktiven Kohorte.
 */
export function classifyActiveCustomerLifecycle(
  input: ActiveLifecycleInput,
): ActiveCustomerLifecycle | null {
  if (input.status !== "aktiv") return null;
  const hasContractEnd =
    input.contractEnd != null && String(input.contractEnd).trim() !== "";
  const isTerminated = input.contractStatus === TERMINATED_CONTRACT_STATUS;
  return hasContractEnd || isTerminated ? "gekuendigt" : "laufend";
}

/**
 * True, wenn der Kunde ein „gekündigter aktiver Kunde" ist (aktiv, aber mit
 * beendetem/gekündigtem Vertrag). Für nicht-aktive Kunden immer `false`.
 */
export function isGekuendigterAktiverKunde(input: ActiveLifecycleInput): boolean {
  return classifyActiveCustomerLifecycle(input) === "gekuendigt";
}

/**
 * True, wenn der Kunde ein „laufender aktiver Kunde" ist (aktiv und ohne
 * beendeten/gekündigten Vertrag). Für nicht-aktive Kunden immer `false`.
 */
export function isLaufenderAktiverKunde(input: ActiveLifecycleInput): boolean {
  return classifyActiveCustomerLifecycle(input) === "laufend";
}
