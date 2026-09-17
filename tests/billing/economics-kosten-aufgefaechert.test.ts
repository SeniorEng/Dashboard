/**
 * Ticket 6hWgVqw2C8442hcG — unterer Block der Umsatz-Kachel („was es mich kostet").
 *
 * ── Was hier geprüft wird ────────────────────────────────────────────────
 * Zwei Sammelzeilen sind aufgefächert worden:
 *   - EINE `kilometer`-Zeile über alle drei km-Arten → berechenbare km
 *     (Anfahrt + Kunden-km) UND `kilometer_zeiterfassung` getrennt.
 *   - EINE `gemeinkosten`-Restzeile → sechs `overhead_*`-Zeilen.
 *
 * Es ist eine Änderung der SICHT, kein neuer Rechenweg. Genau das muss der
 * Test belegen: **dieselben Beträge, feiner geschnitten.** Deshalb prüft er
 * durchgehend Summen-Identitäten, nicht Einzelwerte — ein Test, der die
 * Einzelbeträge festschriebe, würde die Fixture messen und nicht die Zusage.
 *
 * ── Warum eine eigene Fixture MIT Zeiterfassungs-km ──────────────────────
 * Die km-Zweiteilung ist nur an einem Monat sichtbar, in dem es überhaupt
 * Zeiterfassungs-km gibt. `tests/economics-effective-rate-drift.test.ts` legt
 * keine an — dort sind alte und neue Fassung zahlengleich, ein Regress bliebe
 * dort unentdeckt. Diese Datei schließt die Lücke.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { readBillingEconomics } from "../../server/storage/billing/economics-reader";
import { computeMonthCloseCutoff } from "@shared/utils/month-close-cutoff";
import { uniqueId, createTestCustomer, cleanupCustomer } from "../test-utils";

/**
 * Eigenes Jahr/Monat-Fenster. Der Reader liest alles im Abrechnungsmonat, also
 * ist das Paar maßgeblich — nicht das Jahr allein (geprüft:
 * `grep -rn "YEAR = 2049" tests/` ist leer).
 */
const YEAR = 2049;
const MONTH = 4;

/** Zeiterfassungs-km: werden dem Kunden NIE berechnet, kosten aber Lohn. */
const TE_KM = 12.5;
/** Overhead-Zeit in zwei verschiedenen Kategorien — die Auffächerung braucht ≥2. */
const BUERO_MIN = 90;
const VERTRIEB_MIN = 45;

let userId = 0;
let customerId = 0;
/** Zweiter Mitarbeiter: hat NUR einen geplanten Termin, kein Ist. */
let nurGeplantUserId = 0;
/** Dritter Termin: geplant und NIEMANDEM zugewiesen. */
const UNZUGEORDNET_MIN = 30;
/** Minuten je Termin — ein dokumentierter und ein geplanter, gleiche Dauer. */
const TERMIN_MIN = 60;

async function insertTimeEntry(opts: {
  entryType: string;
  minutes: number | null;
  km: number;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO employee_time_entries
      (user_id, entry_type, entry_date, duration_minutes, kilometers, is_full_day)
    VALUES (
      ${userId}, ${opts.entryType}, ${`${YEAR}-${String(MONTH).padStart(2, "0")}-12`},
      ${opts.minutes}, ${opts.km}, false
    )
  `);
}

beforeAll(async () => {
  const tag = uniqueId();
  const u = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, vorname, nachname, is_active)
    VALUES (
      ${`kosten-${tag}@example.com`}, 'x', ${`Kosten Fixture ${tag}`},
      'Kosten', ${`Fixture-${tag}`}, true
    )
    RETURNING id
  `);
  userId = Number((u.rows[0] as Record<string, unknown>).id);

  await insertTimeEntry({ entryType: "bueroarbeit", minutes: BUERO_MIN, km: 0 });
  await insertTimeEntry({ entryType: "vertrieb", minutes: VERTRIEB_MIN, km: TE_KM });

  // Zwei Hauswirtschafts-Termine im selben Monat: einer dokumentiert (das Ist),
  // einer geplant. Ohne den zweiten waeren die Potenzial-Zusagen trivial gruen —
  // Potenzial und Ist waeren schlicht gleich.
  const kunde = await createTestCustomer({ vorname: "KASK", nachname: `Pot_${tag}` });
  customerId = kunde.id as number;
  const svc = await db.execute(sql`
    SELECT id FROM services WHERE code = 'hauswirtschaft' LIMIT 1
  `);
  const serviceId = Number((svc.rows[0] as Record<string, unknown>).id);

  const terminFuer = async (
    empId: number | null, status: string, tag2: string, minuten: number,
  ) => {
    const r = await db.execute(sql`
      INSERT INTO appointments (
        customer_id, created_by_user_id, assigned_employee_id, performed_by_employee_id,
        appointment_type, date, scheduled_start, scheduled_end, duration_promised,
        status, travel_origin_type, travel_kilometers, travel_minutes, customer_kilometers
      ) VALUES (
        ${customerId}, ${userId}, ${empId},
        ${status === "completed" ? empId : null},
        'Kundentermin', ${`${YEAR}-${String(MONTH).padStart(2, "0")}-${tag2}`},
        '09:00', '10:00', ${minuten}, ${status}, 'home', 0, 0, 0
      ) RETURNING id
    `);
    const apptId = Number((r.rows[0] as Record<string, unknown>).id);
    await db.execute(sql`
      INSERT INTO appointment_services
        (appointment_id, service_id, planned_duration_minutes, actual_duration_minutes)
      VALUES (${apptId}, ${serviceId}, ${minuten},
        ${status === "completed" ? minuten : null})
    `);
  };
  const termin = (status: string, tag2: string) =>
    terminFuer(userId, status, tag2, TERMIN_MIN);

  await termin("completed", "10");
  await termin("scheduled", "20");

  // Zweiter Mitarbeiter mit AUSSCHLIESSLICH geplanter Arbeit. Ohne ihn ist die
  // Zeile `for (const id of potenzialProMa.keys()) ensure(id)` im Reader toter
  // Code — und PO-3 belegte nicht, wofuer es zitiert wird.
  const u2 = await db.execute(sql`
    INSERT INTO users (email, password_hash, display_name, vorname, nachname, is_active)
    VALUES (${`kask2-${tag}@example.com`}, 'x', ${`Nur Geplant ${tag}`},
            'Nur', ${`Geplant-${tag}`}, true)
    RETURNING id
  `);
  nurGeplantUserId = Number((u2.rows[0] as Record<string, unknown>).id);
  await terminFuer(nurGeplantUserId, "scheduled", "21", TERMIN_MIN);

  // Dritter Termin: geplant, aber NIEMANDEM zugewiesen. Faellt ohne den
  // `mitUnzugeordneten`-Zweig lautlos aus dem Potenzial — waehrend der obere
  // Block ihn unter „noch geplant" zaehlt.
  await terminFuer(null, "scheduled", "22", UNZUGEORDNET_MIN);
});

afterAll(async () => {
  // Über den Benutzer aufräumen, nicht über eine ID-Liste: `sql` expandiert ein
  // Array als Tupel, nicht als Array-Literal — `ANY(...)` liefe auf 42809.
  if (userId) {
    await db.execute(sql`DELETE FROM employee_time_entries WHERE user_id = ${userId}`);
  }
  // `cleanupCustomer` ruft den Purge-Endpunkt, der HART loescht — keine
  // FK-Cascade, wie hier zuerst stand. Und er SCHLUCKT Fehler: schlaegt er
  // fehl, stirbt das `DELETE FROM users` darunter an der Fremdschluessel-
  // Beziehung, und der Fehler erscheint als raetselhafter afterAll-Abbruch
  // statt als Cleanup-Fehler.
  if (customerId) await cleanupCustomer(customerId);
  if (userId) await db.execute(sql`DELETE FROM users WHERE id = ${userId}`);
  if (nurGeplantUserId) {
    await db.execute(sql`DELETE FROM users WHERE id = ${nurGeplantUserId}`);
  }
});

/**
 * AUF DIE FIXTURE GESCOPET (`employeeId`). Ungescopet setzten KO-4/KO-5/KO-7
 * voraus, dass im gesamten Shard-Leg niemand sonst in diesem Monat bucht — und
 * der Beleg dafür wäre ein Grep über eine Variablenschreibweise, nicht über die
 * Voraussetzung. Genau die CI-only-Kontamination, die CLAUDE.md als
 * Fehlerklasse ausweist. Mit dem Scope hängen die Zusagen nur noch an den
 * eigenen Daten.
 *
 * KO-1 und KO-8 wären auch ungescopet robust (sie prüfen Identitäten, keine
 * Absolutwerte) — sie laufen aus Einheitlichkeit mit.
 */
const read = () => readBillingEconomics(YEAR, MONTH, { employeeId: userId });

/**
 * OHNE Scope — nur fuer die zwei Zusagen, die ihn per Konstruktion nicht
 * vertragen: ein zweiter Mitarbeiter und ein Termin ohne Zuordnung sind mit
 * `employeeId`-Filter unsichtbar. Beide Tests pruefen Relationen (steht er
 * drin? ist die Gesamtsumme groesser als die Drilldown-Summe?), keine
 * Absolutwerte — fremde Daten im selben Fenster koennen sie nicht kippen.
 */
const readOhneScope = () => readBillingEconomics(YEAR, MONTH);

describe("Umsatz-Kachel, unterer Block — Kosten aufgefächert", () => {
  it("KO-1 – die Zusage hält: Σ(Zeilen-Kosten) === Lohnkosten der Kopfzeile", async () => {
    // DIE Invariante des Vertrags. Sie galt für vier Zeilen und muss für zehn
    // genauso gelten — eine Auffächerung, die sie bricht, hätte Geld verloren
    // oder doppelt gezählt.
    const e = await read();
    const summe = e.byService.reduce((s, r) => s + r.costCents, 0);
    expect(summe).toBe(e.totals.laborCostCents);
  });

  it("KO-2 – jede Zeile gehört genau einem Block an", async () => {
    const e = await read();
    expect(e.byService.length).toBeGreaterThan(0);
    for (const r of e.byService) {
      expect(["leistung", "kosten_ohne_umsatz"], `Zeile ${r.key}`).toContain(r.group);
    }
  });

  it("KO-3 – `kosten_ohne_umsatz` heisst genau das: kein Erlös, keine Marge", async () => {
    // Die Eigenschaft, auf der die Darstellung beruht (Gedankenstrich statt
    // „0,00 €" / „0 %"). Stünde hier je ein Erlös, wäre die Zeile im falschen
    // Block — und die Kachel zeigte einen Strich, wo Geld ist.
    const e = await read();
    const ohne = e.byService.filter((r) => r.group === "kosten_ohne_umsatz");
    expect(ohne.length).toBeGreaterThan(0);
    for (const r of ohne) {
      expect(r.revenueCents, `Zeile ${r.key}`).toBe(0);
      // `0 - x` statt `-x`: bei x = 0 liefert die Negation -0, und `toBe`
      // vergleicht mit Object.is, wo -0 !== +0 gilt.
      expect(r.marginCents, `Zeile ${r.key}`).toBe(0 - r.costCents);
    }
  });

  it("KO-4 – die km-Zeile trägt NUR berechenbare km, die Zeiterfassung steht daneben", async () => {
    // Der Kern der km-Zweiteilung. Vorher steckten die 12,5 Zeiterfassungs-km
    // in derselben Zeile wie die Termin-km und verdünnten deren Marge; ihre
    // Kosten standen einem Erlös gegenüber, zu dem sie nichts beigetragen
    // hatten.
    const e = await read();
    const termin = e.byService.find((r) => r.key === "kilometer")!;
    const zeiterfassung = e.byService.find((r) => r.key === "kilometer_zeiterfassung")!;

    expect(termin).toBeDefined();
    expect(zeiterfassung).toBeDefined();
    expect(termin.group).toBe("leistung");
    expect(zeiterfassung.group).toBe("kosten_ohne_umsatz");

    // In diesem Monat gibt es KEINE Termine, also auch keine Termin-km.
    // Die Zeiterfassungs-km dürfen deshalb NICHT in der Termin-Zeile landen.
    expect(termin.quantity, "Zeiterfassungs-km sind in die Termin-Zeile geraten").toBe(0);
    expect(zeiterfassung.quantity).toBeCloseTo(TE_KM, 2);
    expect(zeiterfassung.costCents, "gefahrene km kosten Lohn").toBeGreaterThan(0);
    expect(zeiterfassung.revenueCents, "und werden nie berechnet").toBe(0);
  });

  it("KO-5 – die Marge der km-Zeile ist nicht mehr verdünnt", async () => {
    // Die Folge von KO-4, als eigene Aussage: die Termin-km-Zeile behauptet
    // keine Marge, die sie nicht hat. Ohne Termin-km ist sie schlicht leer —
    // vorher trug sie die Zeiterfassungs-Kosten und wies dafür eine negative
    // Marge aus, die keiner Leistung zuzuordnen war.
    const e = await read();
    const termin = e.byService.find((r) => r.key === "kilometer")!;
    expect(termin.costCents, "fremde km-Kosten in der Leistungs-Zeile").toBe(0);
    expect(termin.marginCents).toBe(0);
  });

  it("KO-6 – die Overhead-Kategorien stehen EINZELN und benannt", async () => {
    const e = await read();
    const overhead = e.byService.filter((r) => r.key.startsWith("overhead_"));

    // Sechs Kategorien: fünf Zeiterfassungs-Typen + Erstberatung.
    expect(overhead.length).toBe(6);
    expect(overhead.map((r) => r.key)).toContain("overhead_bueroarbeit");
    expect(overhead.map((r) => r.key)).toContain("overhead_vertrieb");
    expect(overhead.map((r) => r.key)).toContain("overhead_erstberatung");

    // Keine Zeile trägt den Rohschlüssel als Beschriftung. `erstberatung` ist
    // der Fall, der das verletzen würde: es ist kein Zeiterfassungs-Typ, also
    // kennt `getEntryTypeLabel` ihn nicht.
    for (const r of overhead) {
      expect(r.label, `Zeile ${r.key} zeigt den Rohschlüssel`).not.toBe(
        r.key.replace("overhead_", ""),
      );
      expect(r.label.length).toBeGreaterThan(0);
    }
  });

  it("KO-9 – mit Kassen-Filter wird Overhead NICHT gemessen und darf nichts behaupten", async () => {
    // Bei gesetzter Kasse ist Overhead nicht zurechenbar (`includeOverhead =
    // false`). Der Reader liefert die Zeilen trotzdem, dann mit 0 — die
    // Darstellung darf daraus keine Messung machen. Die Zusage der Kachel:
    // `splitEconomicsRows` blendet den Block aus, wenn weder Geld noch Menge
    // da ist. Hier wird die DATEN-Seite davon festgenagelt.
    const e = await readBillingEconomics(YEAR, MONTH, {
      employeeId: userId,
      insuranceProviderId: 1,
    });

    const ohne = e.byService.filter((r) => r.group === "kosten_ohne_umsatz");
    expect(ohne.length, "die Zeilen bleiben im Vertrag, nur leer").toBeGreaterThan(0);
    for (const r of ohne) {
      expect(r.costCents, `Zeile ${r.key} traegt Geld trotz Kassen-Filter`).toBe(0);
      expect(r.quantity, `Zeile ${r.key} traegt Menge trotz Kassen-Filter`).toBe(0);
    }

    // Und die Invariante hält auch in diesem Modus — sonst wäre die
    // Auffächerung nur im Normalfall korrekt.
    expect(e.byService.reduce((s, r) => s + r.costCents, 0)).toBe(e.totals.laborCostCents);
  });

  it("KO-10 – auch die UMSATZ-Seite summiert sich auf die Kopfzeile", async () => {
    // Das Gegenstück zu KO-1. Es fehlte: der Selbsttest in der Kachel prüft nur
    // die Kosten-Spalte, und genau deshalb könnte ein Erlös, der aus der
    // Zeilenmenge fällt, unentdeckt in `totals.revenueCents` liegen.
    const e = await read();
    expect(e.byService.reduce((s, r) => s + r.revenueCents, 0)).toBe(e.totals.revenueCents);
  });

  it("KO-7 – die beiden gebuchten Kategorien tragen ihre Kosten getrennt", async () => {
    // Die eigentliche Frage des Blocks: wofür zahle ich, ohne Geld dafür zu
    // bekommen? Eine Sammelzeile konnte sie nicht beantworten.
    const e = await read();
    const buero = e.byService.find((r) => r.key === "overhead_bueroarbeit")!;
    const vertrieb = e.byService.find((r) => r.key === "overhead_vertrieb")!;

    expect(buero.costCents).toBeGreaterThan(0);
    expect(vertrieb.costCents).toBeGreaterThan(0);

    // Büro ist teurer als Vertrieb, weil 90 min > 45 min bei gleichem Satz.
    //
    // BEWUSST keine Gleichung `buero === vertrieb * 2`: die Kosten entstehen
    // als `ROUND(min/60 × Satz)` PRO EINTRAG, also `ROUND(1,5·r)` gegen
    // `ROUND(0,75·r)`. Die Verdopplung bricht für jeden Satz mit `r % 4 === 2`
    // (1802 ⇒ 2703 vs. 1352). Beim heutigen Katalogsatz ginge sie auf — der
    // Test wäre dann von einem Lohnsatz abhängig, den dieses Ticket gar nicht
    // betrachtet, und würde rot, ohne dass am Produktionscode etwas falsch ist.
    expect(buero.costCents).toBeGreaterThan(vertrieb.costCents);
    // Die tragende Aussage: die Kategorien sind getrennt und summieren sich
    // vollständig — nicht, in welchem Verhältnis sie stehen.
    expect(buero.costCents + vertrieb.costCents).toBe(
      e.byService
        .filter((r) => r.key.startsWith("overhead_"))
        .reduce((s, r) => s + r.costCents, 0),
    );

    // Gegenrichtung: die nicht gebuchten Kategorien bleiben bei 0 — sonst
    // hätte die Auffächerung Kosten irgendwohin verteilt.
    const unbenutzt = e.byService.filter(
      (r) =>
        r.key.startsWith("overhead_") &&
        r.key !== "overhead_bueroarbeit" &&
        r.key !== "overhead_vertrieb",
    );
    expect(unbenutzt.reduce((s, r) => s + r.costCents, 0)).toBe(0);
  });

  it("PO-1 – Potenzial gibt es NUR, wo geplant wird", async () => {
    // `null` heisst „die Frage ist fuer diese Zeile nicht gestellt". Geplante km
    // kennt das System nicht (Anfahrt entsteht bei der Dokumentation), Overhead
    // wird nicht je Monat geplant. Eine 0 behauptete „nichts geplant".
    const e = await read();
    for (const r of e.byService) {
      const erwartetNull = r.key !== "hauswirtschaft" && r.key !== "alltagsbegleitung";
      if (erwartetNull) {
        expect(r.potentialRevenueCents, `Zeile ${r.key} traegt ein Potenzial`).toBeNull();
        expect(r.potentialCostCents, `Zeile ${r.key} traegt Potenzial-Kosten`).toBeNull();
      } else {
        expect(r.potentialRevenueCents, `Zeile ${r.key} ohne Potenzial`).not.toBeNull();
        expect(r.potentialCostCents, `Zeile ${r.key} ohne Potenzial-Kosten`).not.toBeNull();
      }
    }
  });

  it("PO-2 – das Ist ist IM Potenzial enthalten, nicht daneben", async () => {
    // Die Zusage der Darstellung: „Potenzial (ganzer Monat)" neben „Ist
    // (dokumentiert)". Waere das Ist nicht enthalten, waeren die zwei Spalten
    // nicht vergleichbar und die Differenz bedeutungslos.
    //
    // Der Filter ist `POTENTIAL_APPOINTMENT_STATUSES` = `completed` plus die
    // offenen — `completed` ist also per Konstruktion dabei. Hier wird die
    // FOLGE geprueft, damit eine spaetere Aenderung am Filter auffaellt.
    const e = await read();
    for (const r of e.byService) {
      if (r.potentialRevenueCents === null) continue;
      expect(
        r.potentialRevenueCents,
        `Zeile ${r.key}: Potenzial kleiner als das bereits Geleistete`,
      ).toBeGreaterThanOrEqual(r.revenueCents);
      expect(r.potentialCostCents!).toBeGreaterThanOrEqual(r.costCents);
    }
  });

  it("PO-4 – der GEPLANTE Termin hebt das Potenzial ueber das Ist", async () => {
    // Die eigentliche Aussage der Spalte. Zwei gleich lange HW-Termine, einer
    // dokumentiert, einer geplant ⇒ das Potenzial ist doppelt so gross wie das
    // Ist. Waere der Status-Filter versehentlich derselbe, stuende hier 1:1.
    const e = await read();
    const hw = e.byService.find((r) => r.key === "hauswirtschaft")!;
    expect(hw.revenueCents, "der dokumentierte Termin fehlt").toBeGreaterThan(0);
    expect(
      hw.potentialRevenueCents,
      "der geplante Termin zaehlt nicht ins Potenzial",
    ).toBe(hw.revenueCents * 2);
    expect(hw.potentialCostCents).toBe(hw.costCents * 2);
  });

  it("PO-3 – wer NUR geplante Arbeit hat, steht trotzdem im Drilldown", async () => {
    // Die Zusage, fuer die dieser Test zitiert wird. Sie braucht einen
    // UNGESCOPETEN Read und einen zweiten Mitarbeiter: mit `employeeId`-Scope
    // kann `byEmp` nur die eine Person enthalten, und die hat ein Ist — die
    // Reader-Zeile `for (const id of potenzialProMa.keys()) ensure(id)` waere
    // dann toter Code, und der Test belegte nichts.
    const e = await readOhneScope();
    const emp = e.byEmployee.find((x) => x.employeeId === nurGeplantUserId);
    expect(emp, "Mitarbeiter mit nur geplanter Arbeit fehlt im Drilldown").toBeDefined();
    expect(emp!.revenueCents, "er hat kein Ist").toBe(0);
    const hw = emp!.services.find((r) => r.key === "hauswirtschaft")!;
    expect(hw.potentialRevenueCents, "…aber ein Potenzial").toBeGreaterThan(0);
  });

  it("PO-5 – ein Termin OHNE Zuordnung zaehlt ins Gesamt-Potenzial", async () => {
    // `assigned_employee_id` ist nullable, und bei einem geplanten Termin ist
    // `performed_by_employee_id` per Definition leer. Ohne eigenen Zweig fiele
    // der Termin aus dem Potenzial — waehrend der OBERE Block der Kachel ihn
    // unter „noch geplant" zaehlt. Zwei Bloecke auf derselben Karte, die sich
    // widersprechen, und die Spalte heisst „Potenzial (GANZER Monat)".
    //
    // Er kann keinem Drilldown zugeschlagen werden, also MUSS die Gesamtsumme
    // groesser sein als die Summe der Mitarbeiter-Zeilen — genau um seinen
    // Betrag.
    const e = await readOhneScope();
    const gesamt = e.byService.find((r) => r.key === "hauswirtschaft")!;
    const summeDrilldown = e.byEmployee.reduce((s, emp) => {
      const row = emp.services.find((r) => r.key === "hauswirtschaft");
      return s + (row?.potentialRevenueCents ?? 0);
    }, 0);

    const unzugeordnet = gesamt.potentialRevenueCents! - summeDrilldown;
    expect(
      unzugeordnet,
      "der unzugeordnete Termin fehlt im Gesamt-Potenzial",
    ).toBeGreaterThan(0);
    // 30 min gegen 60 min bei gleichem Preis ⇒ genau die Haelfte eines
    // zugeordneten Termins.
    const hwIst = e.byService.find((r) => r.key === "hauswirtschaft")!;
    expect(unzugeordnet * 2).toBe(hwIst.revenueCents);
  });

  it("PO-6 – im ABGESCHLOSSENEN Monat faellt das Potenzial auf das Ist zurueck", async () => {
    // Weg B (Alrik, 17.09.2026). Die Spalte beantwortet „was kommt noch" — und
    // nach dem Monatsabschluss kommt nichts mehr. Ein `scheduled`-Termin in
    // einem geschlossenen Monat wird ueberall sonst als „Nicht abgerechnet"
    // ausgewiesen; ihn hier weiter als Erloespotenzial zu fuehren, behauptete
    // Geld, das das System selbst schon abgeschrieben hat.
    //
    // Der Stichtag kommt als Parameter, nicht aus der Wanduhr — sonst waere
    // dieser Test nur an einem bestimmten Kalendertag gruen.
    const cutoff = computeMonthCloseCutoff(YEAR, MONTH);
    const [cy, cm, cd] = cutoff.split("-").map(Number);
    const einTagNachCutoff = new Date(Date.UTC(cy, cm - 1, cd + 1))
      .toISOString().slice(0, 10);

    const offen = await readBillingEconomics(YEAR, MONTH, {
      employeeId: userId, asOfDate: cutoff,
    });
    const zu = await readBillingEconomics(YEAR, MONTH, {
      employeeId: userId, asOfDate: einTagNachCutoff,
    });

    const hwOffen = offen.byService.find((r) => r.key === "hauswirtschaft")!;
    const hwZu = zu.byService.find((r) => r.key === "hauswirtschaft")!;

    // Am Cutoff-Tag SELBST ist der Monat noch offen — dort gilt das Potenzial
    // weiter, und der geplante Termin ist drin.
    expect(
      hwOffen.potentialRevenueCents,
      "am Cutoff-Tag ist der Monat noch offen",
    ).toBeGreaterThan(hwOffen.revenueCents);

    // Einen Tag spaeter: Potenzial === Ist, der geplante Termin zaehlt nicht
    // mehr als Erloes, der er nie wird.
    expect(hwZu.potentialRevenueCents, "Potenzial faellt auf Ist").toBe(hwZu.revenueCents);
    expect(hwZu.potentialCostCents).toBe(hwZu.costCents);

    // Gegenrichtung: das IST darf sich dabei nicht veraendert haben. Der
    // Monatsabschluss ist eine Aussage ueber die Zukunft, nicht ueber das
    // bereits Geleistete.
    expect(hwZu.revenueCents, "das Ist haengt nicht am Abschluss").toBe(hwOffen.revenueCents);
    expect(hwZu.costCents).toBe(hwOffen.costCents);
  });

  it("KO-8 – der Mitarbeiter-Drilldown hat dieselbe Form wie die Gesamt-Sicht", async () => {
    // Beide kommen aus derselben Funktion; driften sie auseinander, zeigt das
    // Aufklappen einer Zeile eine andere Gliederung als die Tabelle darüber.
    const e = await read();
    const emp = e.byEmployee.find((x) => x.employeeId === userId);
    expect(emp, "die Fixture muss als Mitarbeiter-Zeile auftauchen").toBeDefined();
    expect(emp!.services.map((r) => r.key).sort()).toEqual(
      e.byService.map((r) => r.key).sort(),
    );
    expect(emp!.services.reduce((s, r) => s + r.costCents, 0)).toBe(emp!.costCents);
  });
});
