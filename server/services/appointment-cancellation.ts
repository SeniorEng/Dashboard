import { and, eq, isNull } from "drizzle-orm";
import {
  pruefeRechnungsSperre,
  rechnungsSperreMeldung,
  wickleBudgetZurueck,
} from "./appointment-budget-unwind";
import { db, type Tx } from "../lib/db";
import { appointments } from "@shared/schema";
import { appointmentsRepo } from "../repos";
import { AppError } from "../lib/errors";
import { storage } from "../storage";
import { auditService } from "./audit";
import {
  canCancelAppointment,
  discardsDocumentation,
  type PolicyUser,
} from "@shared/policies/appointments";
import { toPolicyAppointment, loadPolicyFlags } from "../lib/appointment-policy-adapter";

/**
 * SSoT für „einen Termin absagen": entscheiden → prüfen → rückabwickeln →
 * Status setzen → Audit.
 *
 * ── Was das ERSETZT ─────────────────────────────────────────────────────
 * Drei divergente Stellen, die dieselbe Frage unterschiedlich beantworteten:
 *  1. das Inline-Guard-Set im `single`-Zweig von
 *     `server/routes/appointment-series.ts` — prüfte NUR `status === "completed"`,
 *     sonst nichts: kein Lock, kein Monatsabschluss, keine Rückabwicklung, kein
 *     Audit.
 *  2. die Eignungsprüfung in `collectEligibleFutureIds` — prüfte Lock und
 *     Monatsabschluss, aber ebenfalls keine Rückabwicklung und kein Audit, und
 *     schützte `documenting` nicht.
 *  3. `bulkCancelSeriesAppointments` — ein nacktes `UPDATE status='cancelled'`.
 *
 * `collectEligibleFutureIds` bleibt als reiner SELEKTOR bestehen (welche Termine
 * sind gemeint), die Entscheidung „darf der weg?" liegt ab jetzt hier. Zwei
 * Begriffe derselben Frage wären genau der Zustand, aus dem der Defekt entstand.
 *
 * ── Zielniveau: Löschen, nicht Bulk ─────────────────────────────────────
 * Der Bulk-Pfad war selbst nackt; Vorbild ist `DELETE /api/appointments/:id`
 * (`server/routes/appointments.ts`). Von dort übernommen: Policy-Entscheidung,
 * race-sichere Lock-Prüfung IN der Transaktion, Storno der Budget-Transaktionen,
 * Freigabe der Hard-Holds hinter demselben Feature-Gate, Audit-Eintrag.
 *
 * ── Warum BEIDE Rückabwicklungen ────────────────────────────────────────
 * Gemessen an der Referenz-DB: `scheduled` trägt NIE eine `budget_transaction`,
 * aber in rund der Hälfte der Fälle einen `hold`. `documenting` kann BEIDES
 * tragen. Wer nur Holds freigäbe, ließe den `documenting`-Fall stumm falsch.
 *
 * Der Zustand, den das behebt, ist in Produktion messbar: `sweepOrphanHolds`
 * (`server/storage/budget/reservation-storage.ts`) meldet „storniert + Hold" seit
 * jeher als Waise — in der Referenz-DB 57,00 € auf einem stornierten Termin.
 * Der Detektor existierte, die Ursache blieb.
 */

export interface DiscardedDocumentation {
  id: number;
  date: string;
  status: string;
  verworfen: "Dokumentation";
}

/**
 * Muster Task #1883 (`PartialBillingConfirmationRequiredError`): der Eingriff
 * wird nicht verboten, sondern ausgewiesen. Ohne `confirmDiscardDocumentation`
 * bricht der ganze Aufruf ab und listet die betroffenen Termine; ein zweiter
 * Aufruf mit dem Flag führt aus.
 */
export class CancelDiscardsDocumentationError extends AppError {
  constructor(public readonly betroffene: DiscardedDocumentation[]) {
    super(
      409,
      "CANCEL_DISCARDS_DOCUMENTATION",
      `${betroffene.length === 1 ? "Für einen Termin wurde" : `Für ${betroffene.length} Termine wurden`} ` +
        "bereits Dokumentationen begonnen. Beim Absagen wird die begonnene Dokumentation verworfen " +
        "und kann nicht wiederhergestellt werden. Bitte ausdrücklich bestätigen.",
    );
    this.name = "CancelDiscardsDocumentationError";
  }
}

export interface CancelOptions {
  userId: number;
  /** Muster #1883 — ohne dieses Flag verweigert die Routine bei `documenting`. */
  confirmDiscardDocumentation?: boolean;
  ipAddress?: string;
}

export interface CancelResult {
  /** Tatsächlich abgesagte Termine. */
  cancelled: number[];
  /** Übersprungene mit Begründung (z.B. bereits abgesagt, gesperrt). */
  uebersprungen: Array<{ id: number; grund: string }>;
}

/**
 * Laedt die Entscheidungsgrundlage. `tx` gesetzt = Lesen UNTER dem FOR-UPDATE
 * der laufenden Transaktion (siehe B3-Kommentar in `cancelAppointments`).
 */
async function ladeEntscheidungsdaten(id: number, tx?: Tx) {
  // Ueber die Repo-Schicht, nicht per direktem `select` — der Soft-Delete-Filter
  // ist dort verankert und ein Architektur-Waechter erzwingt das
  // (`tests/architecture/soft-delete-coverage.test.ts`).
  const [appt] = tx
    ? await appointmentsRepo.selectFrom(tx).where(and(eq(appointments.id, id), isNull(appointments.deletedAt)))
    : [await storage.getAppointment(id)];
  if (!appt) return null;

  const flags = await loadPolicyFlags(id, appt);
  return { appt, policyAppt: toPolicyAppointment(appt, flags) };
}

/**
 * Sagt die genannten Termine ab. Wirft `CancelDiscardsDocumentationError`, wenn
 * mindestens einer eine begonnene Dokumentation verwerfen würde und das Flag
 * fehlt — dann wird NICHTS abgesagt (Bulk-Semantik wie #1883: ganzer Aufruf
 * bricht ab und listet, der zweite Aufruf führt alles aus).
 *
 * Termine, die die Policy ablehnt, werden übersprungen und begründet
 * zurückgemeldet — sie lassen den Aufruf nicht scheitern. Das entspricht dem
 * bisherigen Bulk-Verhalten (`collectEligibleFutureIds` filterte sie still); neu
 * ist, dass der Aufrufer den Grund erfährt.
 */
export async function cancelAppointments(
  ids: number[],
  user: PolicyUser,
  opts: CancelOptions,
  outerTx?: Tx,
): Promise<CancelResult> {
  if (ids.length === 0) return { cancelled: [], uebersprungen: [] };

  const erlaubt: number[] = [];
  const uebersprungen: Array<{ id: number; grund: string }> = [];
  const verwerfen: DiscardedDocumentation[] = [];

  for (const id of ids) {
    const daten = await ladeEntscheidungsdaten(id);
    if (!daten) {
      uebersprungen.push({ id, grund: "Termin nicht gefunden." });
      continue;
    }
    const entscheidung = canCancelAppointment(user, daten.policyAppt);
    if (!entscheidung.allowed) {
      uebersprungen.push({ id, grund: entscheidung.reason });
      continue;
    }
    if (discardsDocumentation(daten.policyAppt)) {
      verwerfen.push({
        id,
        date: daten.appt.date,
        status: daten.appt.status,
        verworfen: "Dokumentation",
      });
    }
    erlaubt.push(id);
  }

  if (verwerfen.length > 0 && !opts.confirmDiscardDocumentation) {
    throw new CancelDiscardsDocumentationError(verwerfen);
  }

  const cancelled: number[] = [];

  /**
   * Ein Termin: Rechnungspruefung → Rueckabwicklung → Status → Audit.
   *
   * Herausgezogen, damit das primaere Leg und die kaskadierten Co-Visit-Legs
   * NACHWEISLICH denselben Weg nehmen. Zwei Kopien waeren genau der Zustand,
   * aus dem der Defekt entstand — die Kaskade im PATCH-Pfad war so eine Kopie,
   * nur ohne Rueckabwicklung.
   *
   * Liefert `false`, wenn uebersprungen wurde (Grund steht dann in
   * `uebersprungen`).
   */
  const rueckabwickelnUndAbsagen = async (
    tx: Tx,
    id: number,
    dokumentationVerworfen: boolean,
    kaskadeVonLegId?: number,
    kontext?: { customerId: number | null; coVisitGroupId: string | null },
  ): Promise<boolean> => {
    // GoBD: NICHT zurueckbuchen, solange eine aktive Rechnung den Verbrauch
    // ausweist. Frage und Meldungstext kommen aus der Rueckabwicklungs-SSoT
    // (`appointment-budget-unwind.ts`) — dieselben, die der Loesch-Pfad und das
    // Serien-Verkuerzen benutzen.
    //
    // UEBERSPRINGEN statt werfen: diese Routine arbeitet Mengen ab, ein Abbruch
    // wuerde die uebrigen Termine mitreissen. Der Loesch-Pfad wirft, weil es
    // dort um genau einen Termin geht. Dieselbe Frage, bewusst verschiedene
    // Antwort — deshalb sind Pruefung und Reaktion getrennt.
    const sperre = await pruefeRechnungsSperre(id, tx);
    if (sperre) {
      uebersprungen.push({ id, grund: rechnungsSperreMeldung(sperre, "abgesagt") });
      return false;
    }

    const { reversedTransactionIds, holdsReleased } = await wickleBudgetZurueck(id, opts.userId, tx);

    await tx.update(appointments).set({ status: "cancelled" }).where(eq(appointments.id, id));

    await auditService.log(
      opts.userId,
      "appointment_cancelled",
      "appointment",
      id,
      {
        reversedTransactionIds,
        holdsReleased,
        // Aus dem FRISCHEN Stand, nicht aus der Vor-Transaktions-Runde
        // (`verwerfen`): wurde der Termin erst im Race-Fenster `documenting`
        // und lief mit gesetztem Flag durch, stuende dort `false`, obwohl eine
        // begonnene Dokumentation vernichtet wurde. Fuer die GoBD-Spur ist
        // genau das die Frage.
        documentationDiscarded: dokumentationVerworfen,
        // Beim Zusammenfuehren der Kaskade verloren gegangen und hier
        // zurueckgeholt: `customerId` ist im Audit-Service die durchgehende
        // Konvention fuer Termin-Ereignisse, `coVisitGroupId` macht die
        // Gruppe im Verlauf auffindbar. Kein Reader filtert heute darauf —
        // aber eine Spur, die weniger sagt als die vorherige, ist ein
        // Rueckschritt. (Gate-2 zu #128.)
        customerId: kontext?.customerId ?? undefined,
        coVisitGroupId: kontext?.coVisitGroupId ?? undefined,
        // Nur bei kaskadierten Partner-Legs gesetzt — damit im Verlauf jedes
        // Legs sichtbar ist, WARUM es abgesagt wurde (uebernommen aus dem
        // PATCH-Pfad, der dafuer `appointment_updated` benutzte).
        ...(kaskadeVonLegId != null ? { coVisitCascadeFromLegId: kaskadeVonLegId } : {}),
      },
      opts.ipAddress,
      tx,
    );
    return true;
  };

  const run = async (tx: Tx) => {
    for (const id of erlaubt) {
      // ── Race-sichere Re-Prüfung IN der Transaktion (Gate-2-Fund B3) ──────
      //
      // `lockAndCheckAppointmentLocked` nimmt ein FOR UPDATE auf die
      // Terminzeile und prüft die LN-Sperre. Eine frühere Fassung liess es
      // dabei bewenden — und behauptete im Kommentar, damit sei „die
      // Entscheidung" abgesichert. War sie nicht: Status und Policy wurden
      // AUSSERHALB der Transaktion ausgewertet, das UPDATE lief danach
      // bedingungslos. Zwei belegbare Löcher:
      //
      //  - `scheduled` → `documenting` im Zwischenraum: kein 409, die begonnene
      //    Dokumentation wäre wieder STILL vernichtet worden — der Defekt, den
      //    diese Routine behebt, nur schmaler.
      //  - `documenting` → `completed` nach bestätigtem Flag: ein
      //    abgeschlossener Termin wäre abgesagt und seine Consumption
      //    zurückgedreht worden. Storno-first umgangen, also genau die
      //    Invariante, die `canCancelAppointment` „ausnahmslos" nennt.
      //
      // Das Fenster ist nicht theoretisch: die Entscheidungsschleife oben macht
      // drei Queries je Termin über die ganze Kandidatenliste, bevor die
      // Transaktion überhaupt aufgeht.
      //
      // Deshalb wird hier ALLES neu ausgewertet, nicht nur die Sperre. Ein
      // zwischenzeitlich veränderter Termin wird ÜBERSPRUNGEN, nicht abgesagt —
      // niemals still verworfen.
      if (await storage.lockAndCheckAppointmentLocked(id, tx)) {
        uebersprungen.push({ id, grund: "Wurde zwischenzeitlich Teil eines unterschriebenen Leistungsnachweises." });
        continue;
      }

      const frisch = await ladeEntscheidungsdaten(id, tx);
      if (!frisch) {
        uebersprungen.push({ id, grund: "Termin ist zwischenzeitlich verschwunden." });
        continue;
      }
      const erneut = canCancelAppointment(user, frisch.policyAppt);
      if (!erneut.allowed) {
        uebersprungen.push({ id, grund: `Zwischenzeitlich geändert: ${erneut.reason}` });
        continue;
      }
      if (discardsDocumentation(frisch.policyAppt) && !opts.confirmDiscardDocumentation) {
        uebersprungen.push({
          id,
          grund: "Für diesen Termin wurde zwischenzeitlich eine Dokumentation begonnen. " +
            "Bitte erneut absagen und das Verwerfen bestätigen.",
        });
        continue;
      }

      const ok = await rueckabwickelnUndAbsagen(tx, id, discardsDocumentation(frisch.policyAppt), undefined,
        { customerId: frisch.appt.customerId, coVisitGroupId: frisch.appt.coVisitGroupId });
      if (!ok) continue;
      cancelled.push(id);

      // ── Co-Visit-Kaskade (Task #1615) ────────────────────────────────────
      //
      // Ein Co-Visit ist EIN Besuch mit zwei Legs. Wird eins abgesagt, muss das
      // andere mit — sonst bliebe ein Leg als `scheduled` stehen und, das ist
      // der Punkt hier, MIT SEINER BUDGET-BUCHUNG.
      //
      // Die Kaskade gab es bisher nur im PATCH-Pfad
      // (`server/routes/appointments.ts`), und dort als nacktes Status-Update:
      // kein Storno der Buchungen, keine Hold-Freigabe, kein
      // `appointment_cancelled`-Audit. Die kaskadierten Legs sind damit genau
      // die Menge, die geleakt hat. Hier laufen sie durch DIESELBE
      // Rueckabwicklung wie das primaere Leg.
      //
      // ZUR EIGNUNGSREGEL, weil sie bewusst ANDERS ist als beim primaeren Leg:
      // hier entscheidet NUR der Status (`scheduled`) plus die Lock-Pruefung,
      // nicht `canCancelAppointment`. Die volle Policy fragt unter anderem, ob
      // der Handelnde dem Termin zugewiesen ist — bei einem Co-Visit gehoert
      // das Partner-Leg per Konstruktion einem ANDEREN Mitarbeiter. Die volle
      // Policy anzuwenden hiesse, die Kaskade im Normalfall zu verhindern und
      // das Leg samt Buchung stehen zu lassen. Uebernommen aus dem PATCH-Pfad,
      // nicht neu erfunden.
      const gruppe = frisch.appt.coVisitGroupId;
      if (gruppe != null) {
        const partner = await storage.getCoVisitPartnerAppointments(gruppe, id, tx);
        for (const p of partner) {
          // Partner mit eigenem Ausgang (completed/no_show/bereits cancelled)
          // bleiben bestehen — eine Absage ist nur aus `scheduled` gueltig.
          // Das ist KEIN halber Einsatz: ein abgeschlossenes Leg ist ein
          // echtes Ergebnis, kein liegengebliebener Rest.
          if (p.status !== "scheduled") continue;

          // GATE-2-FUND (Monatsabschluss): die Eignungsregel hier laesst
          // `canCancelAppointment` bewusst aus, WEIL die Policy nach der
          // Zuweisung fragt und ein Partner-Leg per Konstruktion einem anderen
          // Mitarbeiter gehoert. Die Policy prueft daneben aber auch
          // `isMonthClosed && !isSuperAdmin` — und DIE faellt nicht unter diese
          // Begruendung. Ohne sie koennte ein Mitarbeiter durch Absage SEINES
          // Legs ein Partner-Leg in einem fuer den Partner ABGESCHLOSSENEN
          // Monat absagen und zurueckbuchen. Vorher betraf das nur den
          // PATCH-Pfad; ohne diese Zeilen traege die Konsolidierung es in ALLE
          // Aufrufer (Serien-Bulk, Serie beenden).
          const pDaten = await ladeEntscheidungsdaten(p.id, tx);
          // FAIL-CLOSED, nicht `?.`-durchfallen (Gate-3 zu #128): laesst sich
          // die Entscheidungsgrundlage des Partners nicht laden, ist der
          // Monatsabschluss UNBEKANNT — nicht "nicht geschlossen". Ein
          // optionaler Zugriff haette den Riegel in genau der Lage
          // uebersprungen, in der er nicht mehr pruefbar ist, und danach
          // Lock-Pruefung und Rueckabwicklung auf einem Termin gefahren, dessen
          // Zeile die Transaktion nicht mehr sieht (soft-geloescht im Fenster
          // zwischen Partner-Query und diesem Laden). Abbrechen ist hier auch
          // die konsistente Antwort: jede andere Partner-Ablehnung in dieser
          // Schleife bricht ebenfalls den ganzen Vorgang ab, statt einen halben
          // Einsatz zu hinterlassen.
          if (!pDaten) {
            throw new AppError(
              409,
              "APPOINTMENT_CO_VISIT_LOCKED",
              `Zwei-Kraefte-Einsatz — der Termin der zweiten Kraft (#${p.id}) hat sich waehrend des `
                + "Vorgangs veraendert und konnte nicht geprueft werden. Bitte erneut versuchen.",
            );
          }
          if (pDaten.policyAppt.isMonthClosed && !user.isSuperAdmin) {
            throw new AppError(
              409,
              "APPOINTMENT_CO_VISIT_LOCKED",
              `Zwei-Kraefte-Einsatz — der Termin der zweiten Kraft (#${p.id}) liegt in einem `
                + "abgeschlossenen Monat. Absagen ist dort nur durch die Geschaeftsfuehrung moeglich.",
            );
          }

          // GATE-2-FUND (halber Einsatz): kann der Partner NICHT mit, bricht
          // der ganze Vorgang ab — statt das primaere Leg abzusagen und den
          // Partner mit seiner Buchung stehen zu lassen.
          //
          // Genau diesen Zustand sollte #1615 verhindern, und der Loesch-Pfad
          // lehnt in derselben Lage bereits ab (`APPOINTMENT_CO_VISIT_LOCKED`).
          // Die Absage tat es nicht — sie meldete 200, waehrend ein halber
          // Einsatz zurueckblieb. Die Rechnungspruefung aus diesem PR haette
          // einen NEUEN Weg dorthin eroeffnet: Partner abgerechnet -> steht.
          if (await storage.lockAndCheckAppointmentLocked(p.id, tx)) {
            throw new AppError(
              409,
              "APPOINTMENT_CO_VISIT_LOCKED",
              `Zwei-Kraefte-Einsatz — der Termin der zweiten Kraft (#${p.id}) liegt auf einem `
                + "unterschriebenen Leistungsnachweis und bliebe stehen. Es entstuende ein halber Einsatz.",
            );
          }
          const partnerSperre = await pruefeRechnungsSperre(p.id, tx);
          if (partnerSperre) {
            throw new AppError(
              409,
              "APPOINTMENT_CO_VISIT_LOCKED",
              `Zwei-Kraefte-Einsatz — ${rechnungsSperreMeldung(partnerSperre, "der Einsatz abgesagt")}`,
            );
          }

          const partnerOk = await rueckabwickelnUndAbsagen(tx, p.id, false, id,
            { customerId: p.customerId ?? null, coVisitGroupId: gruppe });
          if (partnerOk) cancelled.push(p.id);
        }
      }
    }
  };

  if (outerTx) await run(outerTx);
  else await db.transaction(run);

  return { cancelled, uebersprungen };
}
