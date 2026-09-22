/**
 * P1 6hXqFcc2hRQfC9qp — der Riegel des Avis-Imports und die Vorschau davor.
 *
 * ── Warum hier ein Riegel STEHT, wo vorher ein anderer stand ─────────────
 * Die erste Fassung verglich zwei Zahlen AUS DER DATEI (Postensumme gegen
 * ausgewiesene Summe). Der Gate-2-Review und eine Messung an den echten
 * Prod-Dateien haben sie widerlegt:
 *
 *  1. Beide Zahlen laufen durch denselben `parseBetragCents`-Aufruf. Ein
 *     Skalenfehler — der Faktor 100 vom 21.09.2026 — skaliert beide und kürzt
 *     sich heraus.
 *  2. Auf der DAVASO-Paar-Struktur (alle 29 lesbaren Dateien) stehen Forderung
 *     und Zahlbetrag zeilenweise identisch, 66 von 66 Kopfzeilen exakt gleich.
 *     `abweichung = 0` ist dort eine Eigenschaft des Formats, kein Ergebnis.
 *
 * **Eine Prüfung, die per Konstruktion nicht fehlschlagen kann, ist keine.**
 * Als bestanden ausgewiesen ist sie schlimmer als keine.
 *
 * Der Riegel hängt deshalb an der Rechnung: `ZEM_RecNr` nennt sie, sie trägt
 * `gross_amount_cents`. Diese Zahl kommt aus der Datenbank, durch keinen
 * gemeinsamen Parser, unabhängig von jeder Dateikonvention. Genau dieser
 * Vergleich hat den Vorfall gefunden — er stand nur HINTER dem Import statt
 * davor.
 *
 * ── Warum es die Vorschau gibt ──────────────────────────────────────────
 * Die Avis-Dateien tragen Versichertennamen und -nummern. Sie können nur bei
 * Alrik geprüft werden — und ohne Vorschau hieße „prüfen" importieren.
 * **Ein Pfad, ein Schalter**: dieselbe `parseAvisCsv`, derselbe Riegel, nur
 * der Schreibteil fällt weg.
 *
 * Fixtures anonymisiert: echte Struktur, erfundene Beträge und Namen.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { apiPost, uniqueId } from "../test-utils";
import { db } from "../../server/lib/db";
import { auditLog, customers, invoices, paymentAdvices, paymentAdviceItems } from "../../shared/schema";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { withGobdMutation } from "../helpers/gobd";

const TAG = `vorschau-${Date.now()}`;

const seeded = { customerId: 0, invoiceIds: [] as number[] };

let zaehler = 7000 + Math.floor(Math.random() * 40000);
function naechsteNummer(): string {
  zaehler += 1;
  return `RE-2017-${zaehler}`;
}

async function legeRechnungAn(nummer: string, bruttoCents: number): Promise<number> {
  const [row] = await db.insert(invoices).values({
    invoiceNumber: nummer,
    customerId: seeded.customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: 3,
    billingYear: 2017,
    recipientName: "Test",
    grossAmountCents: bruttoCents,
    netAmountCents: bruttoCents,
    status: "versendet",
  }).returning({ id: invoices.id });
  seeded.invoiceIds.push(row.id);
  return row.id;
}

/** Kassen-CSV: `1;` Kopf, `2;` Posten, `3;` Summenzeile. */
function kassenCsv(posten: Array<{ nummer: string; euro: string }>, summeEuro: string): string {
  return [
    "1;200000000;Testempfaenger;",
    ...posten.map(p => `2;${p.nummer} Beispiel;${p.nummer};01.09.2017;${p.euro};+;EUR;`),
    `3;BELEG-${uniqueId()};15.09.2017;${summeEuro};DE00000000000000000000;`,
  ].join("\n");
}

/**
 * Die Avise DIESES Laufs — nicht `count(*)` ueber die Tabelle.
 *
 * Gate 2 (2. Durchgang, S7): die erste Fassung zaehlte alle `payment_advices`
 * vor und nach der Vorschau. Unter dem Orchestrator und in CI teilen sich
 * Testdateien eine DB; eine parallel laufende Datei, die ein Avis anlegt, hebt
 * den Zaehler zwischen den beiden Lesungen — und zwar als ROT, mit der Meldung
 * „die Vorschau hat einen Avis angelegt".
 *
 * Das ist derselbe Messfehler, den dieser PR bei `TL-1` abraeumt und
 * ausfuehrlich beschreibt — hier zwei Dateien weiter selbst eingebaut.
 * Gefunden hat ihn der Review, nicht ich: eine Fehlerklasse zu kennen schuetzt
 * nicht davor, sie zu wiederholen. Die Absicherung liegt im Review, nicht im
 * Bewusstsein des Schreibenden.
 */
async function eigeneAvise() {
  return db.select({ id: paymentAdvices.id })
    .from(paymentAdvices)
    .where(like(paymentAdvices.fileName, `${TAG}%`));
}

async function sende(csvContent: string, extra: Record<string, unknown> = {}) {
  return apiPost<Record<string, unknown>>("/api/admin/qonto/payment-advices", {
    fileName: `${TAG}-${Math.random().toString(36).slice(2, 8)}.csv`,
    csvContent,
    ...extra,
  });
}

beforeAll(async () => {
  const [row] = await db.insert(customers).values({
    name: `AVIS-VORSCHAU-${uniqueId()}`,
    address: "Teststr. 1",
    zipCode: "09000",
    city: "Testort",
  }).returning({ id: customers.id });
  seeded.customerId = row.id;
});

afterAll(async () => {
  const angelegt = await db.select({ id: paymentAdvices.id })
    .from(paymentAdvices).where(like(paymentAdvices.fileName, `${TAG}%`));
  const ids = angelegt.map(a => a.id);
  if (ids.length) {
    await db.delete(paymentAdviceItems).where(inArray(paymentAdviceItems.paymentAdviceId, ids));
    await db.delete(paymentAdvices).where(inArray(paymentAdvices.id, ids));
  }
  if (seeded.invoiceIds.length) {
    // `versendet` ist finalisiert — der GoBD-Trigger verbietet den Hard-Delete.
    // Der dokumentierte Bypass gilt transaktions-lokal und nur im Teardown.
    await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_audit_log_mutation = 'on'`);
      await tx.delete(auditLog).where(and(
        eq(auditLog.entityType, "invoice"),
        inArray(auditLog.entityId, seeded.invoiceIds),
      ));
    });
    await withGobdMutation(tx => tx.delete(invoices).where(inArray(invoices.id, seeded.invoiceIds)));
  }
  if (seeded.customerId) {
    await db.delete(customers).where(eq(customers.id, seeded.customerId));
  }
});

describe("Avis-Import — der Riegel hängt an der Rechnung", () => {
  it("AV-1 – der Skalenfehler vom 21.09. wird abgelehnt", async () => {
    // Der Vorfall, nachgebaut: die Datei nennt das Hundertfache der Rechnung.
    // Genau das lief am 21.09.2026 in Prod durch und fiel erst an einer
    // „Überzahlung" von 28.149,66 € im UI auf.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 7000);                       // Rechnung: 70,00 €
    const res = await sende(kassenCsv([{ nummer, euro: "7.000,00" }], "7.000,00"));

    expect(res.status, JSON.stringify(res.data)).toBe(400);
    expect(res.data.code).toBe("AVIS_RECHNUNGSABGLEICH");
    expect(String(res.data.message)).toContain(nummer);
  });

  it("AV-2 – und der datei-interne Vergleich hätte ihn durchgelassen", async () => {
    // Der Beleg, warum der Riegel getauscht werden musste. Dieselbe Datei:
    // die Postensumme stimmt mit der ausgewiesenen Summe überein, weil BEIDE
    // durch denselben Parser laufen. `abweichung = 0` — und der Betrag ist
    // trotzdem hundertfach falsch.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 7000);
    const res = await sende(kassenCsv([{ nummer, euro: "7.000,00" }], "7.000,00"));

    const p = (res.data.details as Record<string, unknown>)?.pruefsumme as Record<string, unknown>;
    expect(p.abweichungCents, "der datei-interne Vergleich hätte den Fehler gefunden").toBe(0);
  });

  it("AV-3 – eine stimmige Datei geht durch", async () => {
    const a = naechsteNummer();
    const b = naechsteNummer();
    await legeRechnungAn(a, 15000);
    await legeRechnungAn(b, 123490);
    const res = await sende(kassenCsv(
      [{ nummer: a, euro: "150,00" }, { nummer: b, euro: "1.234,90" }], "1.384,90",
    ));

    expect(res.status, JSON.stringify(res.data)).toBe(200);
  });

  it("AV-4 – „keine Rechnung im System“ ist NICHT „geprüft und in Ordnung“", async () => {
    // Alriks Entscheidung (D): Reste werden als „nicht unabhängig geprüft"
    // ausgewiesen, nicht als bestanden — und sie blockieren nicht. Wie viele
    // es sind, soll der Vorschau-Lauf zeigen, statt dass wir es raten.
    const unbekannt = naechsteNummer();                       // keine Rechnung dazu
    const res = await sende(kassenCsv([{ nummer: unbekannt, euro: "150,00" }], "150,00"),
                            { dryRun: true });

    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const abgleich = res.data.abgleich as Record<string, unknown>;
    expect(abgleich.ungeprueft).toBe(1);
    expect(abgleich.bestaetigt, "ungeprüft als bestanden gezählt").toBe(0);
    expect(abgleich.ueberzahlungen).toBe(0);
    const befund = (abgleich.befunde as Array<Record<string, unknown>>)[0];
    expect(befund.status).toBe("ungeprueft");
    expect(String(befund.grund)).toMatch(/nicht unabhaengig geprueft/);
  });


  it("AV-12 – eine Unterzahlung wird gemeldet, nicht abgelehnt (gemessener Fall)", async () => {
    // ── Kein konstruierter Fall: die Zahlen stammen aus Avis_ICL01267.csv ──
    // RE-2026-0213, Forderung 117,19 €, gezahlt 58,16 €, Skonto 0, Kürzung 0.
    // Eine von 66 gemessenen Kopfzeilen weicht ab — um 59,03 € nach unten,
    // ohne dass die Datei einen Grund nennt.
    //
    // Er ist der einzige echte Prüfstein für diesen Pfad, und er zeigt genau,
    // warum er nicht blockieren darf: meine erste Fassung des Riegels hätte
    // diese eine Zeile von 66 abgewiesen. Ein Riegel, der Fachlichkeit zum
    // Fehler macht, ist kein strengerer Riegel, sondern ein falscher.
    //
    // Und er zeigt die Grenze: weil beide Abzugsspalten leer sind, ist diese
    // Kürzung aus der Datei heraus NICHT von einem Parse-Fehler zu
    // unterscheiden. Deshalb wird sie einzeln gemeldet statt stillschweigend
    // gebucht — „gemeldet" ist die ehrliche Mitte zwischen „abgelehnt" und
    // „als geprüft ausgewiesen".
    //
    // Rechnungsnummer test-lokal (RE-2017-*), damit sie nicht mit einem Beleg
    // aus der Prod-Kopie-DB kollidiert; die BETRÄGE sind die gemessenen.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 11719);                      // Forderung 117,19 €
    const res = await sende(kassenCsv([{ nummer, euro: "58,16" }], "58,16"), { dryRun: true });

    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const abgleich = res.data.abgleich as Record<string, unknown>;
    expect(abgleich.unterzahlungen).toBe(1);
    expect(abgleich.ueberzahlungen).toBe(0);
    expect(abgleich.bestaetigt, "Unterzahlung als bestätigt gezählt").toBe(0);

    const befund = (abgleich.befunde as Array<Record<string, unknown>>)[0];
    // `rechnung − abzug − avis` aus der SSoT: POSITIV bei Unterzahlung.
    expect(befund.differenzCents, "die gemessene Differenz von 59,03 €").toBe(5903);
    expect(befund.abzugCents, "die Abzugsspalten sind in den echten Dateien leer").toBe(0);
    expect(String(befund.grund)).toMatch(/Kuerzung durch die Kasse/);
  });


  it("AV-13 – die Toleranz kommt aus der SSoT, nicht aus diesem Riegel", async () => {
    // „Deckt diese Zahlung diese Rechnung?" hat eine SSoT
    // (`classifyPaymentDifference`, Toleranz 100 ct). Eine eigene Toleranz im
    // Import-Riegel wäre ein Zweitbegriff derselben Frage — ausgerechnet in
    // dem PR, der Zweitbegriffe abräumt — und liefe irgendwann anders als die,
    // gegen die der Zahlungspfad prüft.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 10000);                      // 100,00 €
    const res = await sende(kassenCsv([{ nummer, euro: "99,50" }], "99,50"), { dryRun: true });

    const abgleich = res.data.abgleich as Record<string, unknown>;
    expect(abgleich.bestaetigt, "50 ct liegen in der Toleranz der SSoT").toBe(1);
    expect(abgleich.unterzahlungen).toBe(0);
  });

  it("AV-5 – die Prüfung nutzt NICHT den Betrags-Fallback (sonst wäre sie zirkulär)", async () => {
    // Der tragende Strukturtest. Der Posten nennt eine Rechnungsnummer, die es
    // nicht gibt — sein Betrag trifft aber exakt eine offene Rechnung. Würde
    // die Prüfung über den Betrag auflösen, fände sie diese Rechnung und
    // bestätigte den Betrag mit sich selbst: eine Prüfung, die per
    // Konstruktion nie eine Abweichung melden kann.
    const fremd = naechsteNummer();
    await legeRechnungAn(fremd, 9999);                        // 99,99 € liegt offen
    const erfunden = `RE-2017-000${Math.floor(Math.random() * 900) + 100}`;

    const res = await sende(kassenCsv([{ nummer: erfunden, euro: "99,99" }], "99,99"),
                            { dryRun: true });

    const abgleich = res.data.abgleich as Record<string, unknown>;
    expect(abgleich.bestaetigt, "über den Betrag aufgelöst und sich selbst bestätigt").toBe(0);
    expect(abgleich.ungeprueft).toBe(1);
  });

  it("AV-6 – ein DAVASO-Block: Zahlbetrag aus der Kopfzeile, Skonto zugeschlagen", async () => {
    // Zwei Zusagen in einem Fall, beide am echten Dateiaufbau:
    //
    //  1. Der Posten kommt aus der KOPFZEILE (keine `ZEM_BelegNr`) und trägt
    //     `KTR_BTR_Zahlg` — 95,00 €, nicht die Forderung von 100,00 € aus der
    //     Belegzeile darunter.
    //  2. Skonto erklärt die Differenz und wird zugeschlagen, damit beide
    //     Seiten dieselbe Größe meinen: die Forderung.
    //
    // Dass die Abzugsspalten in den echten Dateien durchweg leer sind (0 von 66),
    // ändert nichts an der Zusage — das Format führt sie, und wenn sie einmal
    // gefüllt kommen, darf der Riegel nicht danebenliegen.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 10000);                      // Forderung 100,00 €
    const davaso = [
      "LfdNr,AVISNr,KTR_IK,KTR_Name,ZEM_IK,ZEM_IBAN,ZEM_BelegNr,ZEM_VorgangsNr,ZEM_RecNr,ZEM_RecDatum,ZEM_BTR_Forderg,KTR_BTR_Zahlg,KTR_BTR_Skonto,KTR_BTR_DTA_Kuerzg,Datum_ZahlungAusfuehrg",
      `1,TST,100000000,Testkasse,200000000,DE00,,V-1,${nummer},01.08.2017,100.00,95.00,5.00,0.00,15.09.2017`,
      `2,TST,100000000,Testkasse,200000000,DE00,B-1,V-1,${nummer},01.08.2017,100.00,,0.00,,`,
    ].join("\n");

    const res = await sende(davaso, { dryRun: true });
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const posten = res.data.items as Array<Record<string, unknown>>;
    expect(posten, "die Belegzeile wurde zu einem eigenen Posten").toHaveLength(1);
    expect(posten[0].betragCents, "die Forderung statt der Zahlung gelesen").toBe(9500);

    const abgleich = res.data.abgleich as Record<string, unknown>;
    expect(abgleich.bestaetigt, JSON.stringify(abgleich)).toBe(1);
    expect(abgleich.ueberzahlungen).toBe(0);
  });

  it("AV-14 – eine ausgewiesene Kürzung hebt die Unterzahlung NICHT auf", async () => {
    // Gate 2 (2. Durchgang, S3): `skontoCents = skonto + kuerzung` geht
    // rechnerisch auf, überlädt aber den Begriff. Die SSoT versteht unter
    // `skontoCents` einen GEWÄHRTEN Nachlass; eine Kassen-Kürzung ist ein
    // AUFERLEGTER Abzug — ein Streitfall, kein Rabatt.
    //
    // Zusammengeworfen wäre eine ausgewiesene Kürzung zu `bestaetigt`
    // geworden: die Rechnung gälte als gedeckt, obwohl Geld fehlt. Genau der
    // ICL01267-Fall, nur mit Begründung in der Datei — und er wäre damit
    // unsichtbar geworden.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 10000);                      // Forderung 100,00 €
    const davaso = [
      "LfdNr,AVISNr,KTR_IK,KTR_Name,ZEM_IK,ZEM_IBAN,ZEM_BelegNr,ZEM_VorgangsNr,ZEM_RecNr,ZEM_RecDatum,ZEM_BTR_Forderg,KTR_BTR_Zahlg,KTR_BTR_Skonto,KTR_BTR_DTA_Kuerzg,Datum_ZahlungAusfuehrg",
      `1,TST,100000000,Testkasse,200000000,DE00,,V-1,${nummer},01.08.2017,100.00,80.00,0.00,20.00,15.09.2017`,
      `2,TST,100000000,Testkasse,200000000,DE00,B-1,V-1,${nummer},01.08.2017,100.00,,0.00,,`,
    ].join("\n");

    const res = await sende(davaso, { dryRun: true });
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const abgleich = res.data.abgleich as Record<string, unknown>;
    expect(abgleich.unterzahlungen, "die Kürzung wurde als Nachlass verrechnet").toBe(1);
    expect(abgleich.bestaetigt).toBe(0);

    const befund = (abgleich.befunde as Array<Record<string, unknown>>)[0];
    expect(befund.kuerzungCents, "die Kürzung wird nicht ausgewiesen").toBe(2000);
    expect(befund.abzugCents, "die Kürzung steckt im Skonto-Feld").toBe(0);
    expect(befund.differenzCents).toBe(2000);
  });

  it("AV-15 – eine Gutschrift reißt nicht die ganze Datei mit", async () => {
    // Gate 2 (2. Durchgang, S4): Storno-Rechnungen tragen negatives Brutto.
    // Ein Zahlbetrag dagegen ergibt IMMER `overpaid` — und weil `ueberzahlung`
    // blockiert, hätte eine einzige solche Referenz die ganze Datei abgelehnt.
    //
    // Das ist kein Befund, sondern ein Vergleich ohne Aussage: hier steht
    // keine Forderung, gegen die etwas gezahlt worden sein könnte.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, -5000);                      // Gutschrift −50,00 €
    const ok = naechsteNummer();
    await legeRechnungAn(ok, 15000);

    const res = await sende(kassenCsv(
      [{ nummer, euro: "50,00" }, { nummer: ok, euro: "150,00" }], "200,00",
    ), { dryRun: true });

    expect(res.status, JSON.stringify(res.data)).toBe(200);
    const abgleich = res.data.abgleich as Record<string, unknown>;
    expect(abgleich.ueberzahlungen, "die Gutschrift hat die Datei abgelehnt").toBe(0);
    expect(abgleich.ungeprueft).toBe(1);
    expect(abgleich.bestaetigt, "der stimmige Posten fiel mit").toBe(1);

    const gutschrift = (abgleich.befunde as Array<Record<string, unknown>>)
      .find(b => b.status === "ungeprueft");
    expect(String(gutschrift?.grund)).toMatch(/Gutschrift|Storno/);
  });
});

describe("Avis-Import — die Vorschau", () => {
  it("AV-7 – die Vorschau parst und schreibt NICHTS", async () => {
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 15000);
    const vorher = await eigeneAvise();

    const res = await sende(kassenCsv([{ nummer, euro: "150,00" }], "150,00"), { dryRun: true });

    expect(res.status).toBe(200);
    expect(res.data.dryRun).toBe(true);
    expect(res.data.itemCount).toBe(1);

    const nachher = await eigeneAvise();
    expect(nachher.length, "die Vorschau hat einen Avis angelegt").toBe(vorher.length);
  });

  it("AV-8 – die Vorschau zeigt, WAS verglichen wurde", async () => {
    // Alriks Bedingung aus Weiche 2: ein grünes Ergebnis ohne sichtbaren
    // Vergleich gilt nicht als bestanden, sondern als ungeklärt. Deshalb
    // trägt die Antwort den Befund je Posten UND die Quelle der
    // datei-internen Zahl — samt der Angabe, ob sie überhaupt aus anderen
    // Zeilen stammt als die Posten.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 15000);
    const res = await sende(kassenCsv([{ nummer, euro: "150,00" }], "150,00"), { dryRun: true });

    const befund = (res.data.abgleich as { befunde: Array<Record<string, unknown>> }).befunde[0];
    expect(befund.avisCents).toBe(15000);
    expect(befund.rechnungCents, "die Vergleichszahl fehlt in der Ausgabe").toBe(15000);
    expect(befund.status).toBe("bestaetigt");

    const p = res.data.pruefsumme as Record<string, unknown>;
    expect(String(p.quelle).length, "ohne Quelle ist die Zahl nicht nachprüfbar").toBeGreaterThan(3);
    expect(p.ausAnderenZeilen, "die `3;`-Zeile ist eine eigene Zeile").toBe(true);
  });

  it("AV-9 – der Riegel gilt für die Vorschau GENAUSO", async () => {
    // Eine Vorschau, die durchwinkt, was der Import ablehnt, wäre schlimmer
    // als keine: sie verspräche einen Import, der dann scheitert.
    const nummer = naechsteNummer();
    await legeRechnungAn(nummer, 7000);
    const res = await sende(kassenCsv([{ nummer, euro: "7.000,00" }], "7.000,00"), { dryRun: true });

    expect(res.status).toBe(400);
    expect(res.data.code).toBe("AVIS_RECHNUNGSABGLEICH");
  });

  it("AV-10 – eine Vorschau ohne Dateiinhalt wird abgelehnt, statt zu schreiben", async () => {
    // Gate-2-Befund S2: die `dryRun`-Abzweigung lag innerhalb des
    // `csvContent`-Blocks. Ein Request mit `objectPath` lief daran vorbei und
    // legte einen echten Avis an. Eine Vorschau, die schreibt, ist die
    // gefährlichste Zusage von allen — man prüft im Vertrauen darauf, dass
    // nichts passiert.
    const vorher = await eigeneAvise();

    const res = await apiPost<Record<string, unknown>>("/api/admin/qonto/payment-advices", {
      fileName: `${TAG}-ohne-inhalt.csv`,
      objectPath: "/irgendwo/avis.csv",
      dryRun: true,
    });

    expect(res.status).toBe(400);
    expect(res.data.code).toBe("AVIS_VORSCHAU_OHNE_INHALT");

    const nachher = await eigeneAvise();
    expect(nachher.length, "die Vorschau hat einen Avis angelegt").toBe(vorher.length);
  });

  it("AV-11 – Vorschau und echter Import sehen DASSELBE", async () => {
    // Die tragende Zusage: ein Pfad, ein Schalter.
    const a = naechsteNummer();
    const b = naechsteNummer();
    await legeRechnungAn(a, 15000);
    await legeRechnungAn(b, 123490);
    const csv = kassenCsv([{ nummer: a, euro: "150,00" }, { nummer: b, euro: "1.234,90" }], "1.384,90");
    const dateiname = `${TAG}-paar.csv`;

    const vorschau = await apiPost<Record<string, unknown>>(
      "/api/admin/qonto/payment-advices", { fileName: dateiname, csvContent: csv, dryRun: true },
    );
    expect(vorschau.status).toBe(200);

    const echt = await apiPost<Record<string, unknown>>(
      "/api/admin/qonto/payment-advices", { fileName: dateiname, csvContent: csv },
    );
    expect(echt.status, JSON.stringify(echt.data)).toBe(200);

    const adviceId = Number((echt.data.advice as { id: number })?.id ?? echt.data.id);
    const [gespeichert] = await db.select().from(paymentAdvices).where(eq(paymentAdvices.id, adviceId));
    const posten = await db.select().from(paymentAdviceItems)
      .where(eq(paymentAdviceItems.paymentAdviceId, adviceId));

    const kopf = vorschau.data.header as Record<string, unknown>;
    expect(gespeichert.gesamtBetragCents, "Vorschau und Import nennen verschiedene Summen")
      .toBe(kopf.gesamtBetragCents);
    expect(posten.length).toBe(vorschau.data.itemCount);
    expect(posten.map(p => p.betragCents).sort((x, y) => x - y))
      .toEqual((vorschau.data.items as Array<{ betragCents: number }>)
        .map(i => i.betragCents).sort((x, y) => x - y));
  });
});
