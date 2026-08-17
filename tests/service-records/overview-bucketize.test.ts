import { describe, expect, it } from "vitest";
import {
  bucketize,
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

describe("bucketize — Wolfgang/Rosali regression (Task #718)", () => {
  // Mirror of the Ursula-Mai-2026 production case described in the task.
  const wolfgang = makeItem({
    customerId: 1,
    customerName: "Wolfgang Seidel",
    monthlyRecords: [{ id: 81, status: "pending" }],
    singleRecords: [],
    documentedCount: 3,
    undocumentedCount: 0,
    totalAppointments: 3,
    coveredByMonthlyCount: 3,
    uncoveredDocumentedCount: 0,
  });

  const rosali = makeItem({
    customerId: 2,
    customerName: "Rosali Demirev",
    monthlyRecords: [{ id: 82, status: "pending" }],
    singleRecords: [{ id: 83, status: "completed", recordType: "single" }],
    documentedCount: 3,
    undocumentedCount: 0,
    totalAppointments: 3,
    coveredBySingleCount: 1,
    coveredByMonthlyCount: 2,
    uncoveredDocumentedCount: 0,
  });

  const completedOnly = makeItem({
    customerId: 3,
    customerName: "Carla Completed",
    monthlyRecords: [{ id: 90, status: "completed" }],
    documentedCount: 2,
    totalAppointments: 2,
    coveredByMonthlyCount: 2,
  });

  const onlyOpenAppointments = makeItem({
    customerId: 4,
    customerName: "Doris Doku",
    documentedCount: 0,
    undocumentedCount: 2,
    totalAppointments: 2,
  });

  const readyToCreate = makeItem({
    customerId: 5,
    customerName: "Erika Ready",
    documentedCount: 4,
    undocumentedCount: 0,
    totalAppointments: 4,
    uncoveredDocumentedCount: 4,
  });

  // Der Mischzustand, der im laufenden Monat der Normalfall ist: etwas schon
  // im Nachweis, eines dokumentiert aber noch nicht gebuendelt, eines offen.
  const gemischt = makeItem({
    customerId: 6,
    customerName: "Sonja Zwischen",
    monthlyRecords: [{ id: 91, status: "completed" }],
    documentedCount: 4,
    undocumentedCount: 1,
    totalAppointments: 5,
    coveredByMonthlyCount: 3,
    uncoveredDocumentedCount: 1,
  });

  it("Mischzustand: derselbe Kunde steht in BEIDEN Aktions-Kategorien", () => {
    // Vorher brach die Einordnung bei `needsDoc` ab; der dokumentierte, noch
    // nicht gebuendelte Termin war in keiner sichtbaren Kategorie — unsichtbar
    // und dadurch unabrechenbar. Beide Handlungen sind moeglich, also muessen
    // beide sichtbar sein.
    const buckets = bucketize([gemischt]);
    expect(buckets.needsDoc.map((i) => i.customerId)).toEqual([6]);
    expect(buckets.ready.map((i) => i.customerId)).toEqual([6]);
    // Und NICHT zusaetzlich in einer Zustands-Kategorie: solange es etwas zu
    // tun gibt, ist „wartet auf Unterschrift" nicht die Aussage der Zeile.
    expect(buckets.awaitingSignature).toEqual([]);
    expect(buckets.completed).toEqual([]);
  });

  it("puts Wolfgang and Rosali into the awaiting-signature bucket exactly once", () => {
    const buckets = bucketize([wolfgang, rosali, completedOnly, onlyOpenAppointments, readyToCreate]);
    const awaitingIds = buckets.awaitingSignature.map((i) => i.customerId);
    expect(awaitingIds).toEqual([2, 1]); // Demirev before Seidel by Nachname
    expect(buckets.completed.map((i) => i.customerId)).toEqual([3]);
    expect(buckets.needsDoc.map((i) => i.customerId)).toEqual([4]);
    expect(buckets.ready.map((i) => i.customerId)).toEqual([5]);
  });

  it("invariant: jeder Kunde taucht auf, und Aktion und Zustand schliessen sich aus", () => {
    // Die Invariante war frueher „genau ein Bucket". Das gilt seit der
    // Lockerung nicht mehr: die beiden AKTIONS-Kategorien duerfen sich
    // ueberlappen, weil ein Kunde gleichzeitig offene und buendelbare Termine
    // haben kann. Was weiterhin gilt und hier gemessen wird:
    //   1. kein Kunde mit Aktivitaet faellt heraus
    //   2. wer in einer Aktions-Kategorie steht, steht in KEINER Zustands-
    //      Kategorie — sonst behauptete die Uebersicht „fertig" und „zu tun"
    //      ueber dieselbe Zeile
    //   3. innerhalb einer Kategorie steht niemand doppelt
    const items = [wolfgang, rosali, completedOnly, onlyOpenAppointments, readyToCreate, gemischt];
    const buckets = bucketize(items);

    const aktion = [...buckets.needsDoc, ...buckets.ready].map((i) => i.customerId);
    const zustand = [...buckets.awaitingSignature, ...buckets.completed, ...buckets.orphans]
      .map((i) => i.customerId);

    for (const liste of [buckets.needsDoc, buckets.ready, buckets.awaitingSignature, buckets.completed, buckets.orphans]) {
      const ids = liste.map((i) => i.customerId);
      expect(new Set(ids).size, "innerhalb einer Kategorie doppelt").toBe(ids.length);
    }
    for (const id of aktion) {
      expect(zustand, `Kunde ${id} steht in Aktion UND Zustand`).not.toContain(id);
    }
    expect(new Set([...aktion, ...zustand])).toEqual(new Set(items.map((i) => i.customerId)));
  });

  it("action buckets keep priority over awaiting-signature when the customer ALSO has open work", () => {
    // Customer has a pending monthly record AND still uncovered documented
    // appointments. Action takes priority — they belong in `ready`, not in
    // `awaitingSignature` (the banner still surfaces the pending record).
    const mixed = makeItem({
      customerId: 99,
      customerName: "Mixed Case",
      monthlyRecords: [{ id: 999, status: "pending" }],
      documentedCount: 5,
      undocumentedCount: 0,
      totalAppointments: 5,
      uncoveredDocumentedCount: 2,
    });
    const buckets = bucketize([mixed]);
    expect(buckets.ready.map((i) => i.customerId)).toEqual([99]);
    expect(buckets.awaitingSignature).toEqual([]);
  });

  it("customer with ONLY a pending single record (no monthly) still lands in awaiting-signature", () => {
    const pendingSingleOnly = makeItem({
      customerId: 7,
      customerName: "Petra Pending-Single",
      singleRecords: [{ id: 700, status: "pending", recordType: "single" }],
      documentedCount: 1,
      totalAppointments: 1,
      coveredBySingleCount: 1,
    });
    const buckets = bucketize([pendingSingleOnly]);
    expect(buckets.awaitingSignature.map((i) => i.customerId)).toEqual([7]);
    expect(buckets.completed).toEqual([]);
  });
});
