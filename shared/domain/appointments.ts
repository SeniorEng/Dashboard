import type { Appointment, Weekday } from "../schema";
import { timeToMinutes, addMinutesToTime, formatDurationDisplay, parseLocalDate, isWeekend } from "../utils/datetime";
import { isHoliday } from "../utils/holidays";

// ============================================
// TYPES
// ============================================

// `expired_unsigned` ist KEIN persistierter Lebenszyklus-Status mehr (Task #1119).
// Es ist ausschließlich ein ABGELEITETES Anzeige-Label ("Nicht abgerechnet"), das
// `deriveAppointmentDisplayStatus()` zur Laufzeit erzeugt, wenn ein Monat geschlossen
// ist und der Termin nicht dokumentiert+unterschrieben ist. Es darf NIE in die
// Spalte `appointments.status` geschrieben werden.
export type AppointmentStatus = "scheduled" | "documenting" | "completed" | "cancelled" | "expired_unsigned" | "customer_no_show";

export type ServiceType = "Hauswirtschaft" | "Alltagsbegleitung" | "Erstberatung";
export type TravelOriginType = "home" | "appointment";

// ============================================
// CONSTANTS
// ============================================

/**
 * Alle Status, die tatsächlich in `appointments.status` persistiert werden.
 * `expired_unsigned` ist KEIN persistierter Status (nur ein Anzeige-Label,
 * siehe oben) und daher hier bewusst nicht enthalten. Diese Liste ist die
 * Basis, aus der die Partition „terminal vs. offen" abgeleitet wird — es gibt
 * keine zweite, von Hand gepflegte Gegenliste.
 */
export const PERSISTED_APPOINTMENT_STATUSES = [
  "scheduled",
  "documenting",
  "completed",
  "cancelled",
  "customer_no_show",
] as const satisfies readonly AppointmentStatus[];

/**
 * Task #1743 — SSoT der terminalen (abgeschlossenen) Terminstatus. Ein Termin
 * mit einem dieser Status ist fachlich „fertig" und zählt NICHT mehr als
 * offen/geplant; alle anderen persistierten Status gelten als offen (siehe
 * `UNDOCUMENTED_STATUSES`, das genau als Komplement hieraus abgeleitet wird).
 * `expired_unsigned` ist kein persistierter Status (nur ein Anzeige-Label,
 * siehe oben) und daher hier bewusst nicht enthalten.
 *
 * Diese eine Liste beantwortet die fachliche Frage „ist dieser Termin noch
 * offen?" für ALLE Stellen, die sie brauchen: die Monatsabschluss-Readiness
 * (offene vs. abgeschlossene Termine), die Leistungsnachweis-Blockade
 * (`UNDOCUMENTED_STATUSES`) UND die Abrechnungs-Übersicht („noch offene
 * Termine" pro Kunde in der Karte „Noch zu erstellen"). Keine zweite
 * Definition, damit alle drei nie auseinanderdriften.
 */
export const FINAL_APPOINTMENT_STATUSES = [
  "completed",
  "cancelled",
  "customer_no_show",
] as const satisfies readonly AppointmentStatus[];

const STATUS_ORDER: Record<AppointmentStatus, number> = {
  "scheduled": 0,
  "documenting": 1,
  "completed": 2,
  "cancelled": 3,
  "expired_unsigned": 4,
  "customer_no_show": 5,
};

export const STATUS_LABELS: Record<AppointmentStatus, string> = {
  "scheduled": "Geplant",
  "documenting": "Dokumentation",
  "completed": "Abgeschlossen",
  "cancelled": "Storniert",
  "expired_unsigned": "Nicht abgerechnet",
  "customer_no_show": "Kunde nicht angetroffen",
};

// ============================================
// DOKUMENTIERT-&-UNTERSCHRIEBEN — geteiltes Prädikat (Task #1119)
// ============================================

/** Unterschrifts-Evidenz eines Termins (status + direkte/Leistungsnachweis-Signatur). */
export interface AppointmentSignatureEvidence {
  status: AppointmentStatus | string;
  /** Direkte Termin-Unterschrift (`appointments.signature_data`) liegt vor. */
  hasDirectSignature: boolean;
  /**
   * Termin ist mit einem unterschriebenen Leistungsnachweis verknüpft
   * (`monthly_service_records.status` in 'employee_signed'/'completed').
   */
  hasSignedServiceRecord: boolean;
}

/**
 * EINZIGE Quelle der Wahrheit für „dokumentiert & unterschrieben":
 * Termin ist `completed` UND besitzt eine direkte ODER Leistungsnachweis-Unterschrift.
 *
 * Die server-seitigen SQL-Spiegelungen liegen in `server/lib/appointment-signed.ts`
 * und MÜSSEN mit dieser Logik in lockstep bleiben.
 */
export function isAppointmentDocumentedAndSigned(evidence: AppointmentSignatureEvidence): boolean {
  if (evidence.status !== "completed") return false;
  return evidence.hasDirectSignature || evidence.hasSignedServiceRecord;
}

/**
 * EINZIGE Quelle der Wahrheit für „dokumentiert" (= Arbeit erbracht): Ein Termin
 * gilt als dokumentiert, sobald sein Status `completed` ist — UNABHÄNGIG von einer
 * Unterschrift (Task #1496). Die Unterschrift entscheidet nur über die Kunden-/
 * Pflegekassen-Abrechnung (`isAppointmentDocumentedAndSigned`), nicht mehr über
 * „Nicht abgerechnet"/Lohn.
 *
 * Die server-seitige SQL-Spiegelung liegt in `server/lib/appointment-signed.ts`
 * (`appointmentDocumentedCondition`/`documentedSqlRaw`) und MUSS mit dieser Logik
 * in lockstep bleiben.
 */
export function isAppointmentDocumented(status: AppointmentStatus | string): boolean {
  return status === "completed";
}

/**
 * Leitet den ANZEIGE-Status eines Termins ab. `expired_unsigned` ("Nicht abgerechnet")
 * entsteht ausschließlich hier zur Laufzeit: wenn der Monat geschlossen ist und der
 * Termin NICHT dokumentiert ist (= nicht `completed`) — und er kein bereits
 * dokumentiertes Terminal-Ergebnis (`cancelled`/`customer_no_show`) ist (Task #1496:
 * von der Unterschrift entkoppelt). Der persistierte Status bleibt unverändert.
 */
export function deriveAppointmentDisplayStatus(
  status: AppointmentStatus,
  opts: { isMonthClosed: boolean },
): AppointmentStatus {
  if (status === "cancelled" || status === "customer_no_show") return status;
  if (opts.isMonthClosed && !isAppointmentDocumented(status)) return "expired_unsigned";
  return status;
}

// ============================================
// STATUS DEFINITIONS FOR SERVICE RECORDS
// ============================================
//
// Diese Definitionen legen fest, welche Termin-Status für
// Leistungsnachweise als "dokumentiert" gelten.
//
// Workflow für Leistungsnachweise:
// 1. Termin durchführen → Status wechselt direkt zu "documenting"
// 2. Dokumentation ausfüllen (Dauer, Notizen, etc.)
// 3. Termin abschließen → Status wechselt zu "completed"
// 4. Leistungsnachweis erstellen (wenn ALLE Termine des Monats "completed" sind)
// 5. Unterschriften einholen (Mitarbeiter, dann Kunde)
//
// Ein Termin gilt als "dokumentiert" für Leistungsnachweise, wenn:
// - Status = "completed" (Termin wurde durchgeführt und dokumentiert)
//
// Ein Termin gilt als "undokumentiert" (blockiert Leistungsnachweis), wenn:
// - Status = "scheduled" (noch nicht durchgeführt)
// - Status = "documenting" (Dokumentation noch nicht abgeschlossen)
// ============================================

/**
 * Status, die einen Leistungsnachweis blockieren (= noch offene Termine).
 * Solange Termine mit diesen Status existieren, kann kein Leistungsnachweis
 * erstellt werden.
 *
 * SSoT: Abgeleitet als exaktes Komplement von `FINAL_APPOINTMENT_STATUSES`
 * über allen persistierten Status. „Offen" und „terminal" sind damit per
 * Konstruktion eine einzige Partition — es gibt keine zweite, von Hand
 * gepflegte Liste, die auseinanderdriften könnte.
 */
export const UNDOCUMENTED_STATUSES: AppointmentStatus[] = PERSISTED_APPOINTMENT_STATUSES.filter(
  (s) => !(FINAL_APPOINTMENT_STATUSES as readonly AppointmentStatus[]).includes(s),
);


export const PFLEGEGRAD_OPTIONS = [1, 2, 3, 4, 5] as const;

export const DURATION_OPTIONS = [15, 30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180, 195, 210, 225, 240] as const;

// ============================================
// TIME FORMATTING UTILITIES
// ============================================

export function formatTimeSlot(time: string | null): string {
  if (!time) return "--:--";
  return time.slice(0, 5);
}

export function formatDuration(minutes: number): string {
  return formatDurationDisplay(minutes, "verbose");
}

export function doTimesOverlap(
  start1: string,
  end1: string,
  start2: string,
  end2: string
): boolean {
  const s1 = timeToMinutes(start1);
  const e1 = timeToMinutes(end1);
  const s2 = timeToMinutes(start2);
  const e2 = timeToMinutes(end2);
  return s1 < e2 && s2 < e1;
}


export function getEndTime(
  scheduledStart: string,
  scheduledEnd: string | null,
  durationPromised: number | null
): string {
  if (scheduledEnd) {
    return formatTimeSlot(scheduledEnd);
  }
  if (scheduledStart && durationPromised) {
    return addMinutesToTime(scheduledStart, durationPromised).slice(0, 5);
  }
  return "--:--";
}

interface ServiceInfo {
  hasHauswirtschaft: boolean;
  hasAlltagsbegleitung: boolean;
  hasErstberatung: boolean;
  hasBoth: boolean;
  label: string;
  primaryType: ServiceType | null;
}

interface CardServiceInfo extends ServiceInfo {
  borderClass: string;
}

const ALLOWED_CANCELLATION_SOURCES: AppointmentStatus[] = ["scheduled"];
const ALLOWED_NO_SHOW_SOURCES: AppointmentStatus[] = ["scheduled", "documenting"];

export function isValidStatusTransition(
  currentStatus: AppointmentStatus,
  targetStatus: AppointmentStatus
): boolean {
  if (targetStatus === "cancelled" && ALLOWED_CANCELLATION_SOURCES.includes(currentStatus)) {
    return true;
  }
  if (targetStatus === "customer_no_show" && ALLOWED_NO_SHOW_SOURCES.includes(currentStatus)) {
    return true;
  }
  if (currentStatus === "completed" && targetStatus === "documenting") {
    return true;
  }
  const currentIndex = STATUS_ORDER[currentStatus];
  const targetIndex = STATUS_ORDER[targetStatus];
  return targetIndex === currentIndex || targetIndex === currentIndex + 1;
}

export function canModifyAppointment(status: AppointmentStatus): boolean {
  return status !== "completed" && status !== "customer_no_show";
}

// ============================================
// "DOKU UNVOLLSTÄNDIG" — ABLEITUNG
// ============================================
//
// Ein Termin gilt als „Doku unvollständig" und wird in Termin-Listen
// gelb markiert, wenn er entweder
//   1) im Status `documenting` hängt (Mitarbeiter hat angefangen, aber
//      nicht abgeschlossen) — unabhängig vom Datum, ODER
//   2) im Status `scheduled` geblieben ist UND das geplante Termin-Ende
//      bereits in der Vergangenheit liegt.
//
// Bewusst NICHT als „Doku unvollständig" gelten: `completed`, `cancelled`,
// `expired_unsigned`, `customer_no_show`.

function formatLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatLocalTime(d: Date): string {
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function isDocumentationOverdue(
  appointment: {
    status: AppointmentStatus | string;
    date: string;
    scheduledStart?: string | null;
    scheduledEnd?: string | null;
    durationPromised?: number | null;
  },
  now: Date = new Date(),
): boolean {
  if (appointment.status === "documenting") return true;
  if (appointment.status !== "scheduled") return false;
  if (!appointment.date) return false;

  const todayIso = formatLocalIsoDate(now);
  if (appointment.date < todayIso) return true;
  if (appointment.date > todayIso) return false;

  // Heute: nur überfällig, wenn das geplante Ende bereits passiert ist.
  let end: string | null = appointment.scheduledEnd ? appointment.scheduledEnd.slice(0, 5) : null;
  if (!end && appointment.scheduledStart && appointment.durationPromised) {
    end = addMinutesToTime(appointment.scheduledStart, appointment.durationPromised).slice(0, 5);
  }
  if (!end) return false;
  return end < formatLocalTime(now);
}


export type DocumentationAgeBucket = "overdue" | "this-week" | "today";

export const DOCUMENTATION_AGE_BUCKET_LABELS: Record<DocumentationAgeBucket, string> = {
  "overdue": "Älter als 7 Tage",
  "this-week": "Diese Woche",
  "today": "Heute",
};

export const DOCUMENTATION_AGE_BUCKET_ORDER: DocumentationAgeBucket[] = ["overdue", "this-week", "today"];

function startOfLocalDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function daysOverdue(
  appointment: { date: string },
  now: Date = new Date(),
): number {
  const today = startOfLocalDay(now);
  const apt = startOfLocalDay(parseLocalDate(appointment.date));
  const ms = today.getTime() - apt.getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export function getDocumentationAgeBucket(
  appointment: { date: string },
  now: Date = new Date(),
): DocumentationAgeBucket {
  const days = daysOverdue(appointment, now);
  if (days > 7) return "overdue";
  if (days >= 1) return "this-week";
  return "today";
}

export function canEditNotes(status: AppointmentStatus): boolean {
  return status === "scheduled" || status === "documenting";
}

export const STATUS_PRIORITY: Record<AppointmentStatus, number> = {
  "documenting": 0,
  "scheduled": 1,
  "completed": 2,
  "cancelled": 3,
  "expired_unsigned": 4,
  "customer_no_show": 5,
};


export function getCardServiceInfoFromAppointment(appointment: {
  appointmentType: string;
  serviceType: string | null;
  durationPromised: number | null;
  status: string;
}): CardServiceInfo {
  const { appointmentType, serviceType, durationPromised } = appointment;
  
  if (appointmentType === "Erstberatung") {
    return {
      hasHauswirtschaft: false,
      hasAlltagsbegleitung: false,
      hasErstberatung: true,
      hasBoth: false,
      label: "Erstberatung",
      primaryType: "Erstberatung",
      borderClass: "bg-purple-500",
    };
  }

  const hasHauswirtschaft = serviceType === "Hauswirtschaft" || serviceType === "Hauswirtschaft & Alltagsbegleitung";
  const hasAlltagsbegleitung = serviceType === "Alltagsbegleitung" || serviceType === "Hauswirtschaft & Alltagsbegleitung";
  const hasBoth = hasHauswirtschaft && hasAlltagsbegleitung;

  let label: string;
  let primaryType: ServiceType | null = null;
  let borderClass: string;

  if (hasBoth) {
    label = "Hauswirtschaft & Alltagsbegleitung";
    primaryType = "Hauswirtschaft";
    borderClass = "";
  } else if (hasHauswirtschaft) {
    label = "Hauswirtschaft";
    primaryType = "Hauswirtschaft";
    borderClass = "bg-amber-500";
  } else if (hasAlltagsbegleitung) {
    label = "Alltagsbegleitung";
    primaryType = "Alltagsbegleitung";
    borderClass = "bg-sky-500";
  } else {
    label = serviceType || "Kundentermin";
    primaryType = null;
    borderClass = "bg-teal-500";
  }

  return { hasHauswirtschaft, hasAlltagsbegleitung, hasErstberatung: false, hasBoth, label, primaryType, borderClass };
}


interface TravelOriginSuggestion {
  suggestedOrigin: TravelOriginType;
  previousAppointment: Appointment | null;
  previousCustomerName?: string;
}

function getScheduledEndMinutes(apt: Appointment): number {
  if (apt.scheduledEnd) {
    return timeToMinutes(apt.scheduledEnd);
  }
  if (apt.scheduledStart && apt.durationPromised) {
    return timeToMinutes(apt.scheduledStart) + apt.durationPromised;
  }
  return timeToMinutes(apt.scheduledStart);
}

export function suggestTravelOrigin(
  currentAppointment: Appointment,
  sameDayAppointments: (Appointment & { customerName?: string })[]
): TravelOriginSuggestion {
  const currentStartMinutes = timeToMinutes(currentAppointment.scheduledStart);
  
  const appointmentsBefore = sameDayAppointments
    .filter(apt => apt.id !== currentAppointment.id)
    .map(apt => ({
      ...apt,
      scheduledStartMinutes: timeToMinutes(apt.scheduledStart),
      scheduledEndMinutes: getScheduledEndMinutes(apt),
    }))
    .filter(apt => apt.scheduledStartMinutes < currentStartMinutes)
    .sort((a, b) => b.scheduledStartMinutes - a.scheduledStartMinutes);

  if (appointmentsBefore.length > 0) {
    const previous = appointmentsBefore[0];
    const gapMinutes = currentStartMinutes - previous.scheduledEndMinutes;
    
    if (gapMinutes >= 0 && gapMinutes <= 60) {
      return {
        suggestedOrigin: "appointment",
        previousAppointment: previous,
        previousCustomerName: previous.customerName,
      };
    }
  }

  return {
    suggestedOrigin: "home",
    previousAppointment: null,
  };
}

export function validateServiceDocumentationFromServices(
  services: Array<{ actualDurationMinutes: number; details?: string | null; serviceName?: string }>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  const hasAny = services.some(s => s.actualDurationMinutes > 0);
  if (!hasAny) {
    errors.push("Mindestens ein Service muss dokumentiert werden");
    return { valid: false, errors };
  }

  for (const s of services) {
    if (s.actualDurationMinutes > 0 && s.details && s.details.length > 120) {
      errors.push(`${s.serviceName || 'Service'} Details dürfen maximal 120 Zeichen haben`);
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================
// BOOKING DATE RULES (SSoT)
// ============================================

/**
 * Liegt das Datum mehr als 3 Monate vor "heute"?
 *
 * Pure Datums-Regel — zentrale Quelle für den Far-Past-Check, dessen Ergebnis
 * die Create-Policy als `isFarPast`-Flag konsumiert (die Policy bleibt damit
 * frei von "now"-Logik). `now` ist für Tests injizierbar.
 */
export function isMoreThan3MonthsInPast(dateStr: string, now: Date = new Date()): boolean {
  const date = parseLocalDate(dateStr);
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  threeMonthsAgo.setHours(0, 0, 0, 0);
  return date < threeMonthsAgo;
}

/**
 * SSoT: Ab welchem Datum darf eine Serien-MASSENOPERATION Termine anfassen?
 *
 * Antwort: nie vor heute. Vergangene Termine sind geleistete Arbeit — sie
 * werden dokumentiert und abgerechnet, nicht durch eine Serien-Entscheidung
 * von morgen mit weggeräumt.
 *
 * ── Die Lücke (Replit-#1913) ────────────────────────────────────────────
 * Drei Aufrufer leiteten ihren Stichtag aus einem Datum ab, das in der
 * Vergangenheit liegen KANN, und gaben ihn ungefiltert an
 * `getFutureSeriesAppointments` weiter — die filtert nur `>= fromDate`, sie
 * kennt „heute" nicht:
 *
 *  - Absage `this_and_future`  → `appointment.date` des angeklickten Termins
 *  - Änderung `this_and_future` → dasselbe
 *  - Serie verkürzen            → Tag nach dem vom Nutzer gesetzten `newEndDate`
 *
 * Klickt jemand auf einem VERGANGENEN Termin „dieser und alle folgenden",
 * trifft die Operation alle Termine ab jenem vergangenen Tag — also auch
 * bereits geleistete. Ein abgesagter Termin ist danach nicht dokumentierbar,
 * nicht abrechenbar und in keiner Liste; die Arbeit verschwindet lautlos.
 *
 * Beim Verkürzen ist die Folge härter — dort werden die Termine nicht abgesagt,
 * sondern gelöscht.
 *
 * ── Ehrlich zur Herkunft ────────────────────────────────────────────────
 * Anlass war ein Ticket über 13 angeblich so verlorene Termine. Die Prüfung
 * gegen Produktion hat das WIDERLEGT: die 13 erklären sich durch Urlaub,
 * Verlegungen innerhalb desselben Tages, einen Betreuerwechsel und
 * Serien-Änderungen (alter Termin abgesagt, neuer angelegt). Es war ein
 * Fehlalarm, und die betroffene Mitarbeiterin hat bestätigt, dass kein Besuch
 * fehlt.
 *
 * Die LÜCKE bleibt davon unberührt: sie ist am Code ablesbar und im Test
 * belegt (mit herausgenommenem Boden werden vergangene Termine mit abgesagt
 * bzw. gelöscht). Wer diesen Boden später in Frage stellt, soll nicht auf eine
 * Schadenszahl stoßen, die es nie gab — sondern auf den Mechanismus.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Die dreimal wiederholte Zeile
 *   `const fromDate = mode === "all_future" ? today : appointment.date;`
 * bzw. ihr Gegenstück in der Verkürzen-Route. Der `all_future`-Zweig war schon
 * immer richtig (er nimmt `today`) — die Regel stand also bereits im Code, nur
 * auf den anderen Zweig nicht angewandt. Ab jetzt beantwortet EINE Funktion die
 * Frage für alle Aufrufer.
 *
 * ── „heute" ist hier richtig, nicht die asOf-Falle ──────────────────────
 * CLAUDE.md warnt vor `todayISO()` statt `asOf`. Der Fall hier ist der
 * umgekehrte: die Frage lautet wörtlich „was liegt noch VOR mir?", und die ist
 * nur gegen den Zeitpunkt der Handlung zu beantworten. `heute` wird deshalb
 * hereingereicht (über die Uhr-SSoT `todayISO()`, damit Tests es stellen
 * können) statt hier gelesen.
 */
export function seriesBulkFloorDate(gewuenschtesStartdatum: string, heuteIso: string): string {
  return gewuenschtesStartdatum > heuteIso ? gewuenschtesStartdatum : heuteIso;
}

// ============================================
// SERIES DATE GENERATION (SSoT)
// ============================================
//
// Eine Quelle für die Wochentags-/Biweekly-Expansion einer Terminserie.
// Server (`validateSeriesDates`/`createSeriesAppointments`) UND Client-Vorschau
// (`use-new-appointment-form`) nutzen dieselbe Funktion, damit die angezeigte
// Vorschau exakt den tatsächlich angelegten Terminen entspricht.

const WEEKDAY_TO_JS_DAY: Record<Weekday, number> = {
  mo: 1,
  di: 2,
  mi: 3,
  do: 4,
  fr: 5,
};

export interface GeneratedDate {
  date: string;
  skipped: boolean;
  skipReason?: string;
}

function parseSeriesDate(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatSeriesDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Erzeugt alle Termin-Daten einer Serie zwischen `startDate` und `endDate`.
 *
 * Wochen werden Montag-ausgerichtet gezählt (ISO), damit `biweekly` jede zweite
 * Kalenderwoche trifft. Wochenenden und Feiertage werden als `skipped`-Einträge
 * markiert (nicht entfernt), Biweekly-Pausenwochen werden still ausgelassen.
 */
export function generateSeriesDates(
  startDate: string,
  endDate: string,
  weekdays: Weekday[],
  frequency: "weekly" | "biweekly",
): GeneratedDate[] {
  const start = parseSeriesDate(startDate);
  const end = parseSeriesDate(endDate);

  const targetDays = new Set(weekdays.map(w => WEEKDAY_TO_JS_DAY[w]));

  const results: GeneratedDate[] = [];
  const current = new Date(start);

  const weekStart = new Date(start);
  weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));

  let weekNumber = 0;
  let lastWeekStart = weekStart.getTime();

  while (current <= end) {
    const currentWeekStart = new Date(current);
    currentWeekStart.setDate(currentWeekStart.getDate() - ((currentWeekStart.getDay() + 6) % 7));

    if (currentWeekStart.getTime() !== lastWeekStart) {
      weekNumber++;
      lastWeekStart = currentWeekStart.getTime();
    }

    const dayOfWeek = current.getDay();
    const dateStr = formatSeriesDate(current);

    if (targetDays.has(dayOfWeek)) {
      const shouldSkipBiweekly = frequency === "biweekly" && weekNumber % 2 !== 0;

      if (shouldSkipBiweekly) {
        // skip silently for biweekly
      } else if (isWeekend(dateStr)) {
        results.push({ date: dateStr, skipped: true, skipReason: "Wochenende" });
      } else {
        const holidayName = isHoliday(dateStr);
        if (holidayName) {
          results.push({ date: dateStr, skipped: true, skipReason: `Feiertag: ${holidayName}` });
        } else {
          results.push({ date: dateStr, skipped: false });
        }
      }
    }

    current.setDate(current.getDate() + 1);
  }

  return results;
}
