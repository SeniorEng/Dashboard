/**
 * Task #1376: SSoT für die erlaubten Rechnungs-Status-Übergänge.
 *
 * Diese Map ERSETZT die zuvor lokal im Handler `PATCH /billing/:id/status`
 * definierte `allowedTransitions`-Konstante. Sowohl der Einzel-Statuswechsel
 * als auch der neue Sammel-Statuswechsel (`POST /billing/bulk-status`) lesen
 * dieselbe Quelle, damit beide Pfade niemals auseinanderdriften.
 *
 * Lebenszyklus (Status-Umbau, `docs/rechnungsstatus-zielmodell.md`):
 *   Entwurf → Versendet → Bezahlt (+ Storniert als Terminal fuer alles
 *   Terminale). Storno-DOKUMENTE stehen auf `abgeschlossen` und bewegen sich
 *   nicht.
 *
 * `avis_erhalten` ist ENTFALLEN: der Zahlungsavis ist eine Zuordnungs-Mechanik,
 * kein Zustand. `teilweise_bezahlt` ist ENTFALLEN: es ist ein Badge aus der
 * Zahlungssumme.
 *
 * Diese Map gilt jetzt fuer ALLE Schreibpfade — auch den Zahlungsabgleich, der
 * seine zulaessigen Ausgangs-Status ueber `statusesAllowedToTransitionTo`
 * daraus ableitet statt sie handzuschreiben.
 *
 * Task #1434 / #66: "versendet" → "entwurf" ist ENTFERNT. Der Übergang war der
 * Einstieg in die Belegnummern-Wiedervergabe: zurücksetzen leerte `sentAt`,
 * danach griff der Entwurfs-Löschpfad, die Rechnung verschwand hart und ihre
 * Nummer wurde neu vergeben — dieselbe Belegnummer bezeichnete zwei Dokumente.
 *
 * ERSETZT durch zwei getrennte, jeweils ausdrückliche Wege:
 *  - Inhaltliche Änderung einer ausgegebenen Rechnung → **Storno +
 *    Neuausstellung** (bestehender Flow, neue Nummer, Original referenziert).
 *  - Versehentliche Markierung, nichts versandt → `POST /:id/revoke-sent-mark`,
 *    das die Ausgabe-Marke ausdrücklich und protokolliert zurücknimmt. Kein
 *    stiller Status-Flip über den generischen Status-Endpunkt.
 *
 * Task #1822: "teilweise_bezahlt" (Teilzahlung) ist ein ABGELEITETER Status —
 * er wird NUR durch den Zahlungsabgleich vergeben (versendet/avis_erhalten →
 * teilweise_bezahlt), niemals manuell über den Status-Endpoint. Diese Map steuert
 * ausschließlich den MANUELLEN Statuswechsel; die Zahlungs-Schreibpfade setzen
 * den Status über eigene geguardete Direkt-Updates (nicht über diese Map).
 * Deshalb ist "teilweise_bezahlt" hier NUR als Ausgangs-Status (`from`)
 * hinterlegt (manuell darf ein Sachbearbeiter eine teilbezahlte Rechnung noch
 * auf "bezahlt" akzeptieren oder stornieren), aber NICHT als manuelles Ziel.
 */
export const INVOICE_STATUS_TRANSITIONS: Record<string, string[]> = {
  entwurf: ["versendet", "storniert"],
  versendet: ["bezahlt", "storniert"],
  bezahlt: ["storniert"],
  storniert: [],
  // Storno-DOKUMENTE entstehen auf `abgeschlossen` und bleiben dort. Es gibt
  // keinen Uebergang hinaus — ein Storno-Dokument zu stornieren ist kein
  // Vorgang, den das Modell kennt. Wer den Storno rueckgaengig machen will,
  // stellt neu aus.
  abgeschlossen: [],
};

/**
 * Übergänge, die AUSSCHLIESSLICH die Zahlungs-Rücknahme gehen darf.
 *
 * ── Wie das gefunden wurde ──────────────────────────────────────────────
 * Beim Vereinheitlichen der Schreib-Regime (Status-Umbau) lief der
 * Qonto-Unmatch erstmals durch die Übergangs-Prüfung — und scheiterte mit
 * „bezahlt → versendet nicht erlaubt". Zu Recht: die Map war nie für ihn
 * geschrieben, sie beschrieb den MANUELLEN Weg. Solange der Zahlungspfad daran
 * vorbeilief, ist niemandem aufgefallen, dass sie unvollständig ist.
 *
 * ── Warum eine eigene Map und nicht ein Eintrag mehr oben ───────────────
 * `bezahlt → versendet` ist legitim, wenn eine gebundene Zahlung wegfällt —
 * das Geld ist weg, die Rechnung wartet wieder. Es ist NICHT legitim als
 * Handgriff im Status-Menü: eine bezahlte Rechnung zurückzustufen, ohne dass
 * eine Zahlung storniert wurde, verschleiert einen Zahlungseingang.
 *
 * Die Rücknahme trägt ihre Rechtfertigung im Vorgang (die Zuordnung wurde
 * gelöst, das ist auditiert). Ein Mensch im Status-Menü trüge sie nicht.
 * Deshalb: eigene Map, ausdrücklich benannt, greppbar — statt die Regel für
 * alle aufzuweichen.
 */
export const INVOICE_STATUS_REVERSAL_TRANSITIONS: Record<string, string[]> = {
  bezahlt: ["versendet"],
};

/**
 * Aus welchen Status darf die ZAHLUNGS-RÜCKNAHME nach `ziel` zurückfallen?
 *
 * Das Gegenstück zu `statusesAllowedToTransitionTo` für die Rücknahme-Map.
 * Die Compare-and-Swap-Pfade des Zahlungsabgleichs leiten daraus ihr
 * `WHERE status = …` ab, damit die Map an BEIDEN Rücknahme-Stellen trägt und
 * nicht an einer deklariert und an der anderen hingeschrieben wird.
 */
export function statusesAllowedToReverseTo(ziel: string): string[] {
  return Object.entries(INVOICE_STATUS_REVERSAL_TRANSITIONS)
    .filter(([, ziele]) => ziele.includes(ziel))
    .map(([von]) => von);
}

/**
 * Ist der Übergang `from → to` erlaubt?
 *
 * `zahlungsRuecknahme` schaltet die Rücknahme-Map zusätzlich frei. Sie wird
 * ausschließlich von den Qonto-Pfaden gesetzt, die eine Zahlungsbindung lösen.
 */
export function isAllowedInvoiceStatusTransition(
  from: string,
  to: string,
  opts?: { zahlungsRuecknahme?: boolean },
): boolean {
  if (INVOICE_STATUS_TRANSITIONS[from]?.includes(to)) return true;
  if (opts?.zahlungsRuecknahme) {
    return INVOICE_STATUS_REVERSAL_TRANSITIONS[from]?.includes(to) ?? false;
  }
  return false;
}

/**
 * Aus welchen Status heraus darf `ziel` erreicht werden? — die UMKEHRUNG der
 * Übergangs-Map.
 *
 * ── Wozu ────────────────────────────────────────────────────────────────
 * Die Zahlungs-Schreibpfade setzen den Status per Compare-and-Swap:
 * `UPDATE … SET status = 'bezahlt' WHERE id = ? AND status IN (…)`, danach
 * ein Längen-Check auf `returning()`. Das ist der richtige Weg — er ist
 * atomar und serialisiert konkurrierende Abgleiche ohne zusätzlichen Lock.
 *
 * Falsch war nur, dass die Liste der zulässigen Ausgangs-Status an SECHS
 * Stellen handgeschrieben stand — inklusive `avis_erhalten` und
 * `teilweise_bezahlt`, die es nach dem Umbau nicht mehr gibt. Die
 * Übergangs-SSoT beschrieb damit nur den manuellen Weg (Bestandsaufnahme, W3).
 *
 * Jetzt kommt die Liste aus derselben Map, und die Atomarität bleibt.
 */
export function statusesAllowedToTransitionTo(ziel: string): string[] {
  return Object.entries(INVOICE_STATUS_TRANSITIONS)
    .filter(([, ziele]) => ziele.includes(ziel))
    .map(([von]) => von);
}
