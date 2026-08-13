/**
 * Task #1456 — Pre-Commit-Review Eligibilität (Phase 2): PURE SSoT der
 * Abrechnungs-Berechtigung pro Kunde.
 *
 * Diese Datei spiegelt EXAKT die Signatur-/Termin-Akzeptanz des echten
 * Generate-Pfads (`buildInvoiceDraft` in `server/services/invoice-calc.ts`). Der
 * Generate-Pfad importiert dieselben Helfer/Meldungen aus dieser Datei — es gibt
 * KEINE zweite Kopie der Regel, damit Review-Vorschau und tatsächliche
 * Erstellung niemals auseinanderdriften (Eligible im Review ⇒ Generate akzeptiert;
 * Blocked im Review ⇒ Generate lehnt mit identischer Begründung ab).
 *
 * Reine Domänen-Schicht: keine DB, keine Seiteneffekte, Integer-Cents irrelevant
 * (hier wird nicht gerechnet, nur klassifiziert).
 */

/** Maschinenlesbarer Grund, warum ein Kunde NICHT abgerechnet werden kann. */
export type BillingBlockReason =
  | "customer_signature_required"
  | "not_signed"
  | "no_appointments"
  | "already_billed";

/**
 * Wortgleiche Begründungen — identisch zu den `badRequest`-Meldungen, die
 * `buildInvoiceDraft` wirft. Der Generate-Pfad konsumiert diese Konstanten,
 * sodass Anzeige (Review) und Ablehnung (Generate) garantiert denselben Text
 * verwenden.
 */
export const BILLING_BLOCK_MESSAGES: Record<BillingBlockReason, string> = {
  customer_signature_required:
    "Bei Pflegekassen-Abrechnung muss der Leistungsnachweis vom Kunden unterschrieben sein — eine reine Mitarbeiter-Unterschrift genügt nicht.",
  not_signed:
    "Der Leistungsnachweis wurde noch nicht unterschrieben. Bitte lassen Sie den Leistungsnachweis zuerst vom Mitarbeiter unterschreiben.",
  no_appointments: "Der Leistungsnachweis enthält keine Termine.",
  already_billed: "Alle Termine aus dem Leistungsnachweis wurden bereits abgerechnet.",
};

/**
 * Task #1786 — Prägnante Kurz-Labels für die Inline-Anzeige in der Kundenzeile
 * (Karte „Noch zu erstellen"). Die ausführlichen Meldungen (`BILLING_BLOCK_MESSAGES`)
 * bleiben für Dialog/Vorschau; hier genügt ein knapper Grund-Hinweis im dezenten
 * Stil des bestehenden „noch X geplante Termine"-Vermerks.
 */
export const BILLING_BLOCK_SHORT_LABELS: Record<BillingBlockReason, string> = {
  customer_signature_required: "Kundenunterschrift fehlt",
  not_signed: "Nicht unterschrieben",
  no_appointments: "Keine Termine",
  already_billed: "Bereits abgerechnet",
};

/** Pflegekassen-Abrechnung (gesetzlich/privat) verlangt die Kundenunterschrift. */
export function isPflegekasseBillingType(billingType: string | null | undefined): boolean {
  return billingType === "pflegekasse_gesetzlich" || billingType === "pflegekasse_privat";
}

/**
 * Akzeptanz-Regel einer einzelnen Leistungsnachweis-Zeile (Task #1074):
 *  • Pflegekasse: NUR `completed` (Kundenunterschrift) zählt.
 *  • Selbstzahler: `completed` ODER `employee_signed`.
 * Identisch zur Filter-Logik in `buildInvoiceDraft`.
 */
export function isServiceRecordSignedForBilling(
  billingType: string | null | undefined,
  status: string,
): boolean {
  return isPflegekasseBillingType(billingType)
    ? status === "completed"
    : status === "completed" || status === "employee_signed";
}

/**
 * Task #1625 — Fakten der Dokumentations-Abdeckung eines Kunden im Zeitraum:
 * dokumentierte (`completed`) Termine vs. die davon durch aktive
 * Leistungsnachweise abgedeckten Termine. Identisch zu den Feldern, die
 * `/billing/eligible-customers` pro Kunde ausliefert.
 */
export interface DocumentationCoverage {
  completedAppointments: number;
  coveredAppointments: number;
}

/**
 * Task #1625 — PURE SSoT der „unvollständig dokumentiert"-Regel. Ein Kunde
 * gilt als partiell dokumentiert, wenn im Zeitraum dokumentierte Termine
 * existieren, aber weniger davon durch aktive Leistungsnachweise abgedeckt
 * sind als dokumentiert wurden. Genau dieses Signal zeigt das Frontend als
 * „Nur X/Y dokumentierte Termine im Leistungsnachweis" — es gibt KEINE zweite
 * Definition, damit Anzeige (Hinweis + Skip-Zähler) und der server-seitige
 * Skip in der Massenerstellung garantiert übereinstimmen.
 */
export function isPartiallyDocumented(coverage: DocumentationCoverage): boolean {
  return (
    coverage.completedAppointments > 0 &&
    coverage.coveredAppointments < coverage.completedAppointments
  );
}

/**
 * Task #1878 — Fakten der „im Monat vollständig abgerechnet?"-Regel.
 *  • `completedAppointments`      — dokumentierte (`completed`) Termine im Monat.
 *  • `signedAppointmentCount`     — Termine unter ABRECHENBAR-signierten LNs
 *    (kassen-/zahlerabhängig via `isServiceRecordSignedForBilling`; ein
 *    Pflegekassen-Termin mit NUR Mitarbeiter-Unterschrift zählt hier NICHT).
 *  • `unbilledAppointmentCount`   — davon NOCH NICHT abgerechnet.
 */
export interface MonthBillingCompletionFacts {
  completedAppointments: number;
  signedAppointmentCount: number;
  unbilledAppointmentCount: number;
}

/**
 * Task #1878 — PURE SSoT für den Ausschluss aus der Karte „Noch zu erstellen" /
 * dem Erstellen-Dialog. Ein Kunde gilt im Monat NUR dann als vollständig
 * abgerechnet (und darf verschwinden), wenn JEDER dokumentierte (`completed`)
 * Termin abrechenbar-signiert UND bereits abgerechnet ist.
 *
 * `billableSignedAndInvoiced = signedAppointmentCount − unbilledAppointmentCount`
 * (Termine unter abrechenbar-signierten LNs, die schon abgerechnet sind). Bleibt
 * darüber hinaus ein dokumentierter Termin offen
 * (`completedAppointments > billableSignedAndInvoiced`), ist der Monat NICHT
 * vollständig abgerechnet und der Kunde bleibt sichtbar — insbesondere ein
 * Pflegekassen-Termin mit nur `employee_signed` (fehlende Kundenunterschrift),
 * der weder abrechenbar-signiert noch abgerechnet ist (Fall „Bernd Funke").
 *
 * Ersetzt die frühere abdeckungs-basierte Bedingung
 * (`signed > 0 && unbilled === 0 && !isPartiallyDocumented`), die einen
 * `employee_signed`-LN kassenunabhängig als „abgedeckt" wertete und den Kunden
 * dadurch fälschlich als vollständig abgerechnet entfernte.
 */
export function isMonthFullyBilledAndSigned(f: MonthBillingCompletionFacts): boolean {
  const billableSignedAndInvoiced =
    f.signedAppointmentCount - f.unbilledAppointmentCount;
  return (
    f.completedAppointments > 0 &&
    billableSignedAndInvoiced >= f.completedAppointments
  );
}

/**
 * Task #1878 — Fakten der „wartet auf Kundenunterschrift?"-Regel auf Kunden-Ebene.
 *  • `coveredAppointments`    — dokumentierte Termine, die durch einen aktiven LN
 *    (Status `completed` ODER `employee_signed`) abgedeckt sind.
 *  • `signedAppointmentCount` — Termine unter ABRECHENBAR-signierten LNs.
 */
export interface AwaitingCustomerSignatureFacts {
  billingType: string | null | undefined;
  coveredAppointments: number;
  signedAppointmentCount: number;
}

/**
 * Task #1878 — PURE SSoT „wartet auf Kundenunterschrift" auf Kunden-Ebene. Ein
 * Pflegekassen-Kunde wartet auf die Kundenunterschrift, wenn im Monat mehr
 * dokumentierte Termine durch einen aktiven Leistungsnachweis abgedeckt als
 * abrechenbar-signiert sind — d.h. es existieren Termine unter einem nur
 * mitarbeiter-signierten (`employee_signed`) LN, denen die Kundenunterschrift
 * fehlt. Spiegelt den Side-Zustand „Wartet auf Kundenunterschrift" der
 * Pipeline-Übersicht (@shared/domain/billing-pipeline, Task #1874), damit die
 * Aufmerksamkeits-Zeile in der Liste zum Euro-Betrag der Übersicht passt.
 *
 * Dient NUR der wahrheitsgemäßen Inline-Kennzeichnung; die Block-Reihenfolge
 * (`classifyBillingEligibility`) bleibt spiegelbildlich zu `buildInvoiceDraft`.
 */
export function isAwaitingCustomerSignature(
  f: AwaitingCustomerSignatureFacts,
): boolean {
  return (
    isPflegekasseBillingType(f.billingType) &&
    f.coveredAppointments > f.signedAppointmentCount
  );
}

/**
 * Task #1771 — PURE SSoT der Reifegruppierung „hat noch offene Termine?". Ein
 * Kunde gilt als „noch offen", wenn im gewählten Monat mindestens ein offener
 * (geplanter) Termin verbleibt. Die Zahl der offenen Termine liefert der Server
 * aus DER EINEN `FINAL_APPOINTMENT_STATUSES`-SSoT
 * (`getClusterAmountAppointmentsByCustomer`); hier wird nur die Schwelle (> 0)
 * angewandt. Dieselbe Regel nutzen die Karte „Noch zu erstellen" (Gruppierung
 * „Bereit zum Abrechnen" vs. „Dokumentation ausstehend") UND der Reife-Scope im
 * Split-Knopf „Alle erstellen", damit beide nie auseinanderlaufen.
 */
export function hasOpenAppointments(c: { openAppointments?: number | null }): boolean {
  return (c.openAppointments ?? 0) > 0;
}

/**
 * Task #1813 — PURE SSoT der „Nachberechnung"-Regel (spät unterschriebene
 * Nachzügler). Ein Kunde ist eine Nachberechnung, wenn im Zeitraum bereits
 * eine Rechnung existiert (also ein Teil der signierten Termine schon
 * abgerechnet ist) UND weitere signierte Termine noch offen sind. Genau dieser
 * Fall entsteht seit dem Late-Signing-Fix (spät unterschriebene Termine tauchen
 * korrekt wieder zur Abrechnung auf) — er ist KEIN Fehler und KEINE
 * Doppelabrechnung. Sowohl die Liste („Noch zu erstellen") als auch der
 * Vorschau-Dialog konsumieren DIESE eine Regel, damit die Kennzeichnung nie
 * auseinanderläuft.
 */
export interface LateSignedFollowUpFacts {
  /** Termine unter signierten LNs (bereits abgerechnete + noch offene). */
  signedAppointmentCount: number;
  /** Davon NOCH NICHT abgerechnet (= wird jetzt abgerechnet). */
  unbilledAppointmentCount: number;
}

export function isLateSignedFollowUp(f: LateSignedFollowUpFacts): boolean {
  return (
    f.unbilledAppointmentCount > 0 &&
    f.signedAppointmentCount > f.unbilledAppointmentCount
  );
}

/**
 * Anzahl der nachträglich unterschriebenen Termine, die jetzt abgerechnet
 * werden (= die noch nicht abgerechneten signierten Termine). 0, wenn es sich
 * nicht um eine Nachberechnung handelt.
 */
export function lateSignedFollowUpCount(f: LateSignedFollowUpFacts): number {
  return isLateSignedFollowUp(f) ? f.unbilledAppointmentCount : 0;
}

export type BillingEligibilityStatus = "eligible" | "blocked";

/** Eingangsfakten der Klassifikation (vom Server aus denselben Readern gefüllt). */
export interface BillingEligibilityFacts {
  billingType: string | null | undefined;
  /** Status ALLER aktiven Leistungsnachweise des Kunden im Zeitraum. */
  serviceRecordStatuses: readonly string[];
  /** Anzahl Termine unter den signierten LNs (vor „bereits abgerechnet"-Filter). */
  signedAppointmentCount: number;
  /** Anzahl davon, die NOCH NICHT abgerechnet sind. */
  unbilledAppointmentCount: number;
}

export interface BillingEligibilityResult {
  status: BillingEligibilityStatus;
  reason: BillingBlockReason | null;
  message: string | null;
}

/**
 * Klassifiziert die Abrechnungsberechtigung eines Kunden in DERSELBEN Reihenfolge
 * wie `buildInvoiceDraft`:
 *   1. kein signierter LN              → Signatur-Block (kassen-/zahlerabhängig)
 *   2. signiert, aber 0 Termine        → `no_appointments`
 *   3. alle Termine bereits abgerechnet → `already_billed`
 *   4. sonst                           → `eligible`
 */
export function classifyBillingEligibility(
  facts: BillingEligibilityFacts,
): BillingEligibilityResult {
  const signedRecordCount = facts.serviceRecordStatuses.filter((s) =>
    isServiceRecordSignedForBilling(facts.billingType, s),
  ).length;

  if (signedRecordCount === 0) {
    const reason: BillingBlockReason = isPflegekasseBillingType(facts.billingType)
      ? "customer_signature_required"
      : "not_signed";
    return { status: "blocked", reason, message: BILLING_BLOCK_MESSAGES[reason] };
  }
  if (facts.signedAppointmentCount === 0) {
    return {
      status: "blocked",
      reason: "no_appointments",
      message: BILLING_BLOCK_MESSAGES.no_appointments,
    };
  }
  if (facts.unbilledAppointmentCount === 0) {
    return {
      status: "blocked",
      reason: "already_billed",
      message: BILLING_BLOCK_MESSAGES.already_billed,
    };
  }
  return { status: "eligible", reason: null, message: null };
}

/**
 * Task #1885 — PURE SSoT der Gruppe „Leistungsnachweis fehlt noch". Ein Kunde hat
 * im Monat dokumentierte (`completed`) Termine, aber KEINER davon ist durch einen
 * aktiven Leistungsnachweis abgedeckt (`coveredAppointments === 0`) — es wurde also
 * noch gar kein LN erstellt. Abgegrenzt von `isPartiallyDocumented` (dort existiert
 * bereits ein LN, der nur einen Teil abdeckt: `0 < covered < completed`): diese
 * Gruppe ist der Vorschritt davor (noch gar kein LN). Dadurch bleibt das Verhalten
 * von `isPartiallyDocumented` für Kunden mit vorhandenem LN (`covered ≥ 1`)
 * unverändert. Rein additiv (#1885 macht LN-lose Kunden erstmals sichtbar).
 */
export function isServiceRecordMissing(c: DocumentationCoverage): boolean {
  return c.completedAppointments > 0 && c.coveredAppointments === 0;
}

/**
 * Task #1905 — Reifegruppe eines Kunden in der Karte „Noch zu erstellen". Genau
 * EINE Gruppe pro Kunde, jetzt DREI statt fünf:
 *  • `documentation_pending` — die Arbeit des Monats ist noch nicht vollständig
 *                              dokumentiert: es sind noch offene (geplante)
 *                              Termine da ODER weniger Termine durch einen
 *                              aktiven Leistungsnachweis abgedeckt als
 *                              dokumentiert (`covered < completed`, inklusive
 *                              „noch gar kein LN", `covered === 0`).
 *  • `proof_pending`         — vollständig dokumentiert (`covered === completed`),
 *                              aber es fehlt der GÜLTIGE Nachweis: kein
 *                              abrechenbar signierter Leistungsnachweis. Umfasst
 *                              ausdrücklich „dokumentiert, aber vom Kunden nicht
 *                              unterschrieben" (Pflegekasse mit nur
 *                              `employee_signed`) — ohne Kundenunterschrift ist
 *                              der Nachweis nicht gültig. NICHT abrechenbar.
 *  • `ready`                 — vollständig dokumentiert UND vollständig signiert,
 *                              keine offenen Termine mehr. Nachberechnungen
 *                              (nachträglich signierte Nachzügler) bleiben hier.
 *
 * ERSETZT die frühere Fünf-Wert-Gruppierung (`has_open_appointments`,
 * `service_record_missing`, `partially_documented`, `signature_blocked`,
 * `ready`). Die Abbildung ist vollständig: offene Termine, „kein LN" und
 * teildokumentiert fallen zusammen nach `documentation_pending`;
 * `signature_blocked` nach `proof_pending`; `ready` bleibt `ready`, AUSSER der
 * Kunde wartet noch auf eine Kundenunterschrift — genau dieser Fall ist der Bug,
 * den #1905 schließt (siehe `classifyBillingMaturity`).
 */
export type BillingMaturityGroup = "ready" | "documentation_pending" | "proof_pending";

/** Eingangsfakten der Reifegruppierung — schon vom Server gelieferte Felder. */
export interface BillingMaturityFacts {
  openAppointments?: number | null;
  completedAppointments: number;
  coveredAppointments: number;
  /**
   * Task #1905 — für `isAwaitingCustomerSignature` nötig (Zahler-Typ entscheidet,
   * ob die Kundenunterschrift verlangt wird). Der Server liefert das Feld auf
   * `BillingCustomerItem` bereits mit; die Gruppierung liest es nur zusätzlich.
   */
  billingType: string | null | undefined;
  /** Termine unter ABRECHENBAR-signierten LNs (dito, bereits geliefert). */
  signedAppointmentCount: number;
  eligibility: { status: BillingEligibilityStatus; reason: BillingBlockReason | null };
}

/**
 * PURE SSoT der Reifegruppierung. Komponiert dieselben Prädikate wie Anzeige und
 * Server-Skip (`hasOpenAppointments`, `isPartiallyDocumented`,
 * `isAwaitingCustomerSignature`, `eligibility.status`) — KEINE zweite parallele
 * Regel, damit Anzeige und Erstellungs-Pfad nie auseinanderlaufen.
 *
 * Präzedenz (fachlich entschieden, Task #1905): Dokumentation VOR Nachweis VOR
 * bereit. Ein Kunde, bei dem beides offen ist, wird als Dokumentations-Fall
 * gemeldet — das ist der Schritt, der zuerst dran ist.
 */
/**
 * Task #1905 — PURE SSoT: „Ist ALLES Dokumentierte dieses Kunden abrechenbar?"
 * — also vollständig in einem Leistungsnachweis erfasst UND gültig signiert,
 * OHNE die noch offenen Termine zu betrachten.
 *
 * Das ist genau die Frage, die der #1883-Guard beim Erstellen stellt: er bildet
 * seine Ausschluss-Menge ausschließlich aus `completed`-Terminen
 * (`buildInvoiceDraft` → `completedRows`), ein noch nicht durchgeführter Termin
 * kann ihn also nie auslösen. Deshalb ist sie von `hasOpenAppointments`
 * unabhängig — und deshalb braucht der Sammel-Dialog sie getrennt von der
 * Cluster-Zuordnung, um vorherzusagen, ob ein Lauf ohne Bestätigung durchgeht.
 *
 * ERSETZT den kontrafaktischen Aufruf `classifyBillingMaturity({ ...c,
 * openAppointments: 0 }) === "ready"` im Dialog. Der war zwar korrekt, hing aber
 * still an der internen Präzedenz von `classifyBillingMaturity`: käme dort ein
 * weiterer Faktor in den Dokumentations-Zweig, hätte der Dialog klammheimlich
 * seine Bedeutung geändert, ohne dass ein Test darauf zeigt. Als benanntes
 * Prädikat ist die Regel sichtbar und wird von BEIDEN Seiten importiert.
 */
export function isFullyBillableIgnoringOpen(c: BillingMaturityFacts): boolean {
  return (
    !isPartiallyDocumented(c) &&
    !isAwaitingCustomerSignature(c) &&
    c.eligibility.status === "eligible"
  );
}

export function classifyBillingMaturity(c: BillingMaturityFacts): BillingMaturityGroup {
  // 1. Dokumentation ausstehend: noch offene Termine ODER nicht alle
  //    dokumentierten Termine in einem aktiven LN erfasst. `isPartiallyDocumented`
  //    (`covered < completed`) deckt beide Unterfälle ab — auch „noch gar kein LN"
  //    (`covered === 0`), der bis #1905 eine eigene Gruppe hatte. Ein durchgeführter,
  //    aber nicht dokumentierter Termin ist ein Dokumentations-Rückstand, kein
  //    Nachweis-Rückstand.
  if (hasOpenAppointments(c) || isPartiallyDocumented(c)) return "documentation_pending";
  // 2./3. Ab hier ist alles dokumentiert erfasst; es entscheidet nur noch der
  //    Nachweis — dieselbe Frage, die `isFullyBillableIgnoringOpen` beantwortet
  //    (dort auch die Herleitung, warum sie von offenen Terminen unabhängig ist).
  //
  //    Nachweis ausstehend: vollständig dokumentiert, aber kein gültiger
  //    (= abrechenbar signierter) Leistungsnachweis.
  //
  //    `isAwaitingCustomerSignature` ist hier der Kern-Fix von #1905. Ein
  //    Pflegekassen-Kunde mit einem kundensignierten UND einem nur
  //    mitarbeiter-signierten LN ist insgesamt `eligible` (der signierte Teil ist
  //    abrechenbar) und landete deshalb unter „Bereit zum Abrechnen" — während die
  //    Zeile gleichzeitig inline „Kundenunterschrift fehlt" meldete. Beim Erstellen
  //    fiel der nicht kundensignierte Termin aus der Rechnung (Unterberechnung; nur
  //    der #1883-Guard hielt sie auf). Die fehlende Kundenunterschrift schlägt
  //    `ready` jetzt ausdrücklich.
  //
  //    Alle übrigen Block-Gründe (not_signed/no_appointments/already_billed) fallen
  //    ebenfalls hierher: nicht bereit, Grund per Inline-Label.
  return isFullyBillableIgnoringOpen(c) ? "ready" : "proof_pending";
}
