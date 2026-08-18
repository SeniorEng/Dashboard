import { describe, expect, it } from "vitest";
import {
  bucketize,
  completedCardSummary,
  fertigeNachweiseVon,
  type CustomerOverviewItem,
} from "../../client/src/features/service-records/components/overview-sections";

function makeItem(overrides: Partial<CustomerOverviewItem>): CustomerOverviewItem {
  return {
    customerId: 0,
    customerName: "",
    monthlyRecords: [],
    singleRecords: [],
    documentedCount: 0,
    undocumentedCount: 0,
    totalAppointments: 0,
    coveredBySingleCount: 0,
    coveredByMonthlyCount: 0,
    uncoveredDocumentedCount: 0,
    status: "ready",
    canCreateRecord: false,
    ...overrides,
  };
}

/** In welchen Abschnitten steht dieser Kunde? Erschöpfend, kein Zweig ausgelassen. */
function abschnitteVon(buckets: ReturnType<typeof bucketize>, customerId: number): string[] {
  const treffer: string[] = [];
  if (buckets.needsDoc.some((i) => i.customerId === customerId)) treffer.push("needsDoc");
  if (buckets.ready.some((i) => i.customerId === customerId)) treffer.push("ready");
  if (buckets.awaitingSignature.some((i) => i.customerId === customerId)) treffer.push("awaitingSignature");
  if (buckets.completed.some((i) => i.customerId === customerId)) treffer.push("completed");
  if (buckets.orphans.some((i) => i.customerId === customerId)) treffer.push("orphans");
  return treffer;
}

describe("bucketize — Mischzustand in ALLEN Abschnitten (Task #1914)", () => {
  /**
   * Der belegte Fall: Sonja Krause (K218), August 2026, Mitarbeiterin Mandy
   * Buchmann (U21).
   *
   *   2213 · 05.08. dokumentiert, in LN 616
   *   2355 · 11.08. dokumentiert, in LN 646
   *   2411 · 17.08. dokumentiert, in LN 687
   *   2446 · 17.08. dokumentiert, KEINE Abdeckung  → bündelbar
   *   2451 · 26.08. geplant                        → offen
   *
   * Zähler des Servers (korrekt, unverändert): doc=4, undoc=1, total=5,
   * abgedeckt=3, uncovered=1.
   *
   * Vor #1914 unterdrückte `bucketize` die Zustands-Abschnitte, sobald ein
   * Kunde offene oder bündelbare Arbeit hatte. Sonjas drei FERTIGE Nachweise
   * verschwanden dadurch komplett aus dem Monats-Überblick — die Badge-Zeile
   * zeigte 20/1/2 statt 20/1/3.
   */
  const sonja = makeItem({
    customerId: 218,
    customerName: "Sonja Krause",
    monthlyRecords: [
      { id: 616, status: "completed" },
      { id: 646, status: "completed" },
      { id: 687, status: "completed" },
    ],
    documentedCount: 4,
    undocumentedCount: 1,
    totalAppointments: 5,
    coveredByMonthlyCount: 3,
    uncoveredDocumentedCount: 1,
  });

  it("Sonja steht in GENAU drei Abschnitten — und nicht bei „Wartet auf Unterschrift“", () => {
    const buckets = bucketize([sonja]);
    // Erschöpfend: alle fünf Abschnitte werden geprüft, nicht nur die erwarteten.
    // Ein zusätzlicher Treffer fällt damit genauso auf wie ein fehlender.
    expect(abschnitteVon(buckets, 218)).toEqual(["needsDoc", "ready", "completed"]);
  });

  it("die drei Badge-Zahlen der Übersicht: 1 offen · 1 bündelbar · 1 fertig", () => {
    // Im Original 20/1/3 über alle Kunden; hier isoliert auf Sonja, damit der
    // Fall ohne die 19 übrigen Kunden lesbar bleibt. Der Punkt ist die DRITTE
    // Zahl: sie war 0 und muss 1 sein.
    const buckets = bucketize([sonja]);
    expect(buckets.needsDoc.length).toBe(1);
    expect(buckets.ready.length).toBe(1);
    expect(buckets.completed.length).toBe(1);
    expect(buckets.awaitingSignature.length).toBe(0);
    expect(buckets.orphans.length).toBe(0);
  });

  it("die „erstellt“-Karte behauptet nicht, der ganze Monat sei fertig", () => {
    // Der zweite Teil des Fundes. Die Karte trug `totalAppointments` — für
    // Sonja „5 Termine", obwohl nur 3 in einem Nachweis liegen. Neben einer
    // Aktions-Karte desselben Kunden ist das schlicht falsch.
    expect(completedCardSummary(sonja)).toBe("3 von 5 Terminen abgedeckt · 3 Sammel-LN");

    // „abgedeckt" statt „Termine": die Zahl misst, wie viele Termine in einem
    // Nachweis LIEGEN — nicht, wie viele fertig unterschrieben sind. Die
    // Abdeckungs-Semantik zaehlt auch unsignierte Nachweise mit (out of scope),
    // also sagt die Karte, was die Zahl bedeutet, statt Erledigung zu behaupten.
    //
    // Gegenprobe: ist wirklich alles abgedeckt, entfällt die Relativierung —
    // sonst prüfte der Fall oben nur, dass irgendwo „von" steht.
    const komplett = makeItem({
      customerId: 219,
      monthlyRecords: [{ id: 700, status: "completed" }],
      documentedCount: 3,
      totalAppointments: 3,
      coveredByMonthlyCount: 3,
    });
    expect(completedCardSummary(komplett)).toBe("3 Termine abgedeckt · 1 Sammel-LN");
  });

  it("unsignierter Nachweis NEBEN offenen Terminen — beides sichtbar", () => {
    // Der zweite geforderte Fall. Vorher gewann die Aktions-Seite und der
    // wartende Nachweis war im Abschnitt unsichtbar; er tauchte nur im
    // Hinweis-Banner auf. Jetzt steht er dort, wo er hingehört — und das Banner
    // zieht sich zurück (`pending-banner-customer-scope.test.ts`).
    const gemischtWartend = makeItem({
      customerId: 99,
      customerName: "Mira Mischzustand",
      monthlyRecords: [{ id: 999, status: "employee_signed" }],
      documentedCount: 5,
      undocumentedCount: 2,
      totalAppointments: 7,
      coveredByMonthlyCount: 3,
      uncoveredDocumentedCount: 2,
    });
    const buckets = bucketize([gemischtWartend]);
    expect(abschnitteVon(buckets, 99)).toEqual(["needsDoc", "ready", "awaitingSignature"]);
    // KEIN `completed`: es gibt keinen einzigen fertigen Nachweis.
    expect(buckets.completed).toEqual([]);
  });

  it("wartender und fertiger Nachweis nebeneinander — beide Zustände gelten", () => {
    // Rosali-Demirev-Fall (#718): ein wartender Sammel-LN und ein fertiger
    // Einzel-LN. Beide Aussagen sind wahr, also erscheint sie in beiden
    // Zustands-Abschnitten. Vorher gewann „wartet" und der fertige Nachweis war
    // nicht anklickbar.
    const rosali = makeItem({
      customerId: 2,
      customerName: "Rosali Demirev",
      monthlyRecords: [{ id: 82, status: "pending" }],
      singleRecords: [{ id: 83, status: "completed", recordType: "single" }],
      documentedCount: 3,
      totalAppointments: 3,
      coveredBySingleCount: 1,
      coveredByMonthlyCount: 2,
    });
    expect(abschnitteVon(bucketize([rosali]), 2)).toEqual(["awaitingSignature", "completed"]);

    // Und die gruene Karte darf den WARTENDEN Nachweis nicht als erstellten
    // ausgeben. Die erste Fassung zaehlte ungefiltert und sagte
    // „3 Termine · 1 Sammel-LN · 1 Einzel-LN" — der Sammel-LN 82 steht zwei
    // Zeilen tiefer unter „Unterschrift offen".
    expect(completedCardSummary(rosali)).toBe("3 Termine abgedeckt · 1 Einzel-LN");
  });

  it("die „erstellt“-Karte verlinkt auf einen FERTIGEN Nachweis, nie auf einen wartenden", () => {
    // Vorher nahm die Karte `monthlyRecords[0]` ungefiltert. Seit ein Kunde
    // gleichzeitig hier und unter „Wartet auf Unterschrift" stehen kann, zeigte
    // die gruene Karte damit auf den UNSIGNIERTEN Nachweis — und der fertige war
    // von dort aus gar nicht erreichbar.
    const rosali = makeItem({
      customerId: 2,
      monthlyRecords: [{ id: 82, status: "pending" }],
      singleRecords: [{ id: 83, status: "completed", recordType: "single" }],
      totalAppointments: 3,
      coveredBySingleCount: 1,
      coveredByMonthlyCount: 2,
    });
    const fertig = fertigeNachweiseVon(rosali);
    expect(fertig.monthly).toEqual([]);
    expect(fertig.single.map((r) => r.id)).toEqual([83]);
  });

  it("Sonderfall „Nachweis ganz ohne Termine“ bleibt der Prüfauftrag", () => {
    // Muss die Entkopplung überleben: ein fertiger Nachweis ohne einen
    // einzigen aktiven Termin ist kein Erfolg, sondern eine Auffälligkeit —
    // er gehört in `orphans`, nicht unter „erstellt".
    const verwaist = makeItem({
      customerId: 8,
      customerName: "Otto Ohnetermin",
      monthlyRecords: [{ id: 800, status: "completed" }],
      totalAppointments: 0,
    });
    expect(abschnitteVon(bucketize([verwaist]), 8)).toEqual(["orphans"]);
  });

  it("Kunde ohne jede Aktivität erscheint nirgends", () => {
    // Die Gegenprobe zur Entkopplung: „in jedem zutreffenden Abschnitt" darf
    // nicht zu „überall" werden.
    const still = makeItem({ customerId: 9, customerName: "Leo Leer" });
    const buckets = bucketize([still]);
    expect(abschnitteVon(buckets, 9)).toEqual([]);
  });

  it("Invarianten: keine Doppelung INNERHALB eines Abschnitts, niemand fällt heraus", () => {
    // Die frühere Invariante „Aktion und Zustand schliessen sich aus" ist mit
    // #1914 aufgehoben — sie war die Ursache des Fundes, nicht sein Schutz.
    // Was weiterhin gilt und hier gemessen wird:
    //   1. innerhalb eines Abschnitts steht niemand doppelt
    //   2. jeder Kunde mit Aktivität erscheint mindestens einmal
    const stillerKunde = makeItem({ customerId: 9, customerName: "Leo Leer" });
    const items = [
      sonja,
      stillerKunde,
      makeItem({
        customerId: 4, customerName: "Doris Doku",
        undocumentedCount: 2, totalAppointments: 2,
      }),
      makeItem({
        customerId: 5, customerName: "Erika Ready",
        documentedCount: 4, totalAppointments: 4, uncoveredDocumentedCount: 4,
      }),
      makeItem({
        customerId: 7, customerName: "Petra Pending-Single",
        singleRecords: [{ id: 700, status: "pending", recordType: "single" }],
        documentedCount: 1, totalAppointments: 1, coveredBySingleCount: 1,
      }),
    ];
    const buckets = bucketize(items);

    for (const [name, liste] of Object.entries(buckets)) {
      const ids = liste.map((i) => i.customerId);
      expect(new Set(ids).size, `${name}: derselbe Kunde doppelt`).toBe(ids.length);
    }

    for (const item of items) {
      const treffer = abschnitteVon(buckets, item.customerId);
      const hatAktivitaet =
        item.undocumentedCount > 0 ||
        item.uncoveredDocumentedCount > 0 ||
        item.monthlyRecords.length > 0 ||
        item.singleRecords.length > 0;
      expect(treffer.length > 0, `Kunde ${item.customerId} unsichtbar`).toBe(hatAktivitaet);
    }
  });

  it("sortiert JEDEN Abschnitt nach Nachname — nicht nur den ersten", () => {
    // Der Name versprach vorher mehr als der Koerper: geprueft wurde nur
    // `needsDoc`. Die Sortierung von `awaitingSignature` war im alten Testsatz
    // ausdruecklich abgedeckt und ging beim Umschreiben verloren.
    const seidel = makeItem({
      customerId: 1, customerName: "Wolfgang Seidel",
      undocumentedCount: 1, uncoveredDocumentedCount: 1, totalAppointments: 2,
      monthlyRecords: [{ id: 11, status: "pending" }],
      singleRecords: [{ id: 12, status: "completed", recordType: "single" }],
      coveredBySingleCount: 1,
    });
    const demirev = makeItem({
      customerId: 2, customerName: "Rosali Demirev",
      undocumentedCount: 1, uncoveredDocumentedCount: 1, totalAppointments: 2,
      monthlyRecords: [{ id: 21, status: "pending" }],
      singleRecords: [{ id: 22, status: "completed", recordType: "single" }],
      coveredBySingleCount: 1,
    });
    const buckets = bucketize([seidel, demirev]);
    const erwartet = ["Rosali Demirev", "Wolfgang Seidel"];
    for (const [name, liste] of Object.entries(buckets)) {
      if (liste.length === 0) continue;
      expect(liste.map((i) => i.customerName), `${name} unsortiert`).toEqual(erwartet);
    }
    // Gegenprobe: die Schleife oben prueft nur nicht-leere Abschnitte — es
    // muessen also welche dabei sein, sonst misst sie nichts.
    expect(buckets.needsDoc.length + buckets.ready.length
      + buckets.awaitingSignature.length + buckets.completed.length).toBe(8);
  });

  it("nur ein wartender EINZEL-Nachweis reicht fuer „Wartet auf Unterschrift“", () => {
    // Stand im alten Testsatz als eigener Fall und ging beim Umschreiben
    // verloren — ausgerechnet Einzel-LN waren danach der blinde Fleck des
    // Banner-Lockstep.
    const petra = makeItem({
      customerId: 7, customerName: "Petra Pending-Single",
      singleRecords: [{ id: 700, status: "pending", recordType: "single" }],
      documentedCount: 1, totalAppointments: 1, coveredBySingleCount: 1,
    });
    expect(abschnitteVon(bucketize([petra]), 7)).toEqual(["awaitingSignature"]);
  });
});
