/**
 * Lebenszyklus aktiver Kunden (Task #1194).
 *
 * Ein Kunde bleibt `customers.status = 'aktiv'`, auch nachdem sein Vertrag
 * beendet oder gekündigt wurde — erst ein späterer, manueller Wechsel auf
 * `inaktiv` beendet die aktive Phase. Damit Listen und Statistik trotzdem
 * „laufend" von „gekündigt" unterscheiden können, klassifiziert diese reine
 * Funktion einen aktiven Kunden anhand seines (jüngsten) Vertrags.
 *
 * Regel (Reihenfolge ist Teil der Aussage):
 *   aktiv UND (Vertragsende gesetzt ODER Vertragsstatus 'terminated')
 *     ⇒ "gekuendigt"
 *   aktiv UND Vertragsstatus 'paused'
 *     ⇒ "pausiert"
 *   sonst ⇒ "laufend"
 *
 * ── Warum „pausiert" dazugekommen ist (Task 6hHW39Gx) ───────────────────
 * `customer_contracts.status` kennt seit jeher `active | paused | terminated`.
 * Die Klassifikation prüfte aber nur `terminated` — ein PAUSIERTER Vertrag fiel
 * damit in den `sonst`-Zweig und wurde als „laufend" ausgewiesen. Die
 * Kundenlisten behaupteten also von einem Kunden, dessen Betreuung ruht, sie
 * laufe. Das war keine fehlende Funktion, sondern eine falsche Aussage.
 *
 * Aufgefallen ist es bei den Geburtstags-Ansichten: die sollen pausierte Kunden
 * nicht anschreiben, und es gab kein Prädikat, das sie erkennt. Statt dafür
 * einen zweiten Begriff neben dem Lebenszyklus zu bauen, wurde der Lebenszyklus
 * vervollständigt — eine SSoT pro fachlicher Frage.
 *
 * Die Reihenfolge: ein beendeter Vertrag schlägt einen pausierten. Wer
 * gekündigt hat, dessen Betreuung ruht nicht, sie ist vorbei.
 *
 * Diese Datei ist die zentrale Quelle (SSoT) der Klassifikation und darf
 * KEINE UI-, HTTP- oder DB-Abhängigkeiten besitzen.
 */

/**
 * Alle Lebenszyklus-Werte, in Anzeige-Reihenfolge.
 *
 * Als Konstante, damit Zähl-Endpunkt und Filter-Leiste darüber iterieren
 * können, statt die Werte aufzuzählen — ein vierter Wert wäre sonst in der
 * Oberfläche unsichtbar, obwohl die Klassifikation ihn liefert.
 */
export const ACTIVE_CUSTOMER_LIFECYCLES = ["laufend", "pausiert", "gekuendigt"] as const;
export type ActiveCustomerLifecycle = (typeof ACTIVE_CUSTOMER_LIFECYCLES)[number];

export const ACTIVE_CUSTOMER_LIFECYCLE_LABELS: Record<ActiveCustomerLifecycle, string> = {
  laufend: "Laufend",
  pausiert: "Pausiert",
  gekuendigt: "Gekündigt",
};

/** Vertragsstatus, der einen aktiven Kunden als „gekündigt" markiert. */
export const TERMINATED_CONTRACT_STATUS = "terminated";
/** Vertragsstatus, der die Betreuung ruhen lässt, ohne sie zu beenden. */
export const PAUSED_CONTRACT_STATUS = "paused";

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
  if (hasContractEnd || isTerminated) return "gekuendigt";
  if (input.contractStatus === PAUSED_CONTRACT_STATUS) return "pausiert";
  return "laufend";
}

/**
 * True, wenn der Kunde ein „gekündigter aktiver Kunde" ist (aktiv, aber mit
 * beendetem/gekündigtem Vertrag). Für nicht-aktive Kunden immer `false`.
 */
export function isGekuendigterAktiverKunde(input: ActiveLifecycleInput): boolean {
  return classifyActiveCustomerLifecycle(input) === "gekuendigt";
}

/**
 * True, wenn der Kunde ein „laufender aktiver Kunde" ist (aktiv, Vertrag weder
 * beendet noch pausiert). Für nicht-aktive Kunden immer `false`.
 *
 * Das ist zugleich die Antwort auf „wird dieser Kunde gerade betreut?" — die
 * Frage, an der die Geburtstags-Ansichten hängen. Bewusst KEIN eigenes zweites
 * Prädikat dafür: es wäre derselbe Begriff unter anderem Namen.
 */
export function isLaufenderAktiverKunde(input: ActiveLifecycleInput): boolean {
  return classifyActiveCustomerLifecycle(input) === "laufend";
}

/**
 * True, wenn die Betreuung ruht (aktiv, Vertrag pausiert, nicht beendet).
 * Für nicht-aktive Kunden immer `false`.
 */
export function isPausierterAktiverKunde(input: ActiveLifecycleInput): boolean {
  return classifyActiveCustomerLifecycle(input) === "pausiert";
}
