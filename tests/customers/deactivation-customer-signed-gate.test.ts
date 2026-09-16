/**
 * Kundendeaktivierung: der Unterschriften-Check muss in der READINESS stehen,
 * nicht nur im Schreibpfad (Ticket 6hWcjpm3Q4V95Xwp).
 *
 * ── Der Fehler, den diese Datei festhält ────────────────────────────────
 * Trigger A („Leistungsnachweis ohne Kundenunterschrift") wurde zuerst NUR
 * in `POST /complete-deactivation` eingehängt. `GET /deactivation-readiness`
 * kannte ihn nicht. Folge in der Oberfläche:
 *
 *   1. Readiness meldet alle Bedingungen erfüllt → grüner Zweig,
 *      „der Kunde kann deaktiviert werden", Knopf aktiv.
 *   2. Klick → 409 „Bitte zuerst die Unterschriften einholen."
 *   3. Die Override-Schaltfläche wird NUR im nicht-bereit-Zweig gerendert
 *      → auch der Superadmin hat keinen Ausweg.
 *
 * Beim SELBSTZAHLER war das dauerhaft: dort ist ein `employee_signed`-
 * Nachweis abrechnungsfertig, die Rechnung existiert also, und alle vier
 * alten Checks lagen grün. Ist die Kundin verstorben oder die
 * Mitarbeiterin ausgeschieden, ist die Unterschrift nie nachzuholen — der
 * Kunde wäre nicht mehr deaktivierbar gewesen. Genau der Zustand, den
 * `workflows.ts` am Gate `allDocumented` als Fehler benennt.
 *
 * ── Warum der Aufbau ohne Termine ───────────────────────────────────────
 * Ohne Termine sind `allDocumented`, `allServiceRecords` und `allInvoiced`
 * trivial erfüllt, das Vertragsende ist erreicht. Damit liegen die vier
 * alten Checks grün und der Unterschriften-Check ist der EINZIGE Grund für
 * `ready === false`. Ein Aufbau mit Terminen würde dieselbe Aussage
 * treffen, aber nicht zeigen, dass sie allein an diesem Check hängt.
 *
 * ── Gegenprobe ──────────────────────────────────────────────────────────
 * Gegen den Vorzustand (Check nur im Schreibpfad) ist Test 1 ROT
 * (`ready` war `true`) und Test 2 GRÜN-aber-irreführend: der 409 kam, nur
 * war er von der Oberfläche aus unerreichbar. Test 1 ist der eigentliche
 * Wächter.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../server/lib/db";
import { auditLog, customers, monthlyServiceRecords } from "@shared/schema";
import {
  apiGet,
  apiPost,
  apiPatch,
  getAuthCookie,
  uniqueId,
  createTestCustomer,
  createTestEmployee,
  cleanupCustomer,
  deactivateTestEmployee,
} from "../test-utils";

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

let auth: Awaited<ReturnType<typeof getAuthCookie>>;
let customerId: number;
let employeeId: number;
let vertragsende: string;

beforeAll(async () => {
  auth = await getAuthCookie();
  expect(auth.user.isSuperAdmin, "Der Test braucht einen Superadmin — nur er darf uebergehen").toBe(true);

  const emp = await createTestEmployee({ nachnamePrefix: "SigGate" });
  employeeId = emp.id;
  // Selbstzahler: dort ist `employee_signed` abrechnungsfertig — der Fall,
  // in dem die vier alten Checks auch MIT Terminen gruen lagen.
  const cust = await createTestCustomer({
    nachname: `SigGate_${uniqueId()}`,
    billingType: "selbstzahler",
  });
  customerId = cust.id as number;

  // Vertragsende in der Vergangenheit — Gate „Vertragsende erreicht" erfuellt.
  const ende = new Date();
  ende.setDate(ende.getDate() - 3);
  vertragsende = ymd(ende);
  const start = new Date(ende);
  start.setMonth(start.getMonth() - 2);

  const vertrag = await apiPost<any>(`/api/admin/customers/${customerId}/contract`, {
    contractStart: ymd(start),
    contractEnd: vertragsende,
  });
  if (vertrag.status === 409) {
    const patch = await apiPatch<any>(`/api/admin/customers/${customerId}/contract`, {
      contractEnd: vertragsende,
    });
    expect(patch.status, JSON.stringify(patch.data)).toBe(200);
  } else {
    expect([200, 201], JSON.stringify(vertrag.data)).toContain(vertrag.status);
  }

  // Der einzige offene Posten: ein Nachweis mit Mitarbeiter-, aber ohne
  // Kundenunterschrift. Keine Termine — die anderen Gates bleiben gruen.
  await db.insert(monthlyServiceRecords).values({
    customerId, employeeId: auth.user.id,
    year: ende.getFullYear(), month: ende.getMonth() + 1,
    status: "employee_signed",
    employeeSignedAt: new Date(),
    customerSignedAt: null,
  });
});

afterAll(async () => {
  await cleanupCustomer(customerId);
  await deactivateTestEmployee(employeeId);
});

describe("Kundendeaktivierung — Unterschriften-Gate in der Readiness", () => {
  it("1 — die Readiness weist den Unterschriften-Check aus und setzt `ready` auf false", async () => {
    // DER Waechter dieser Datei. Vorher stand hier `ready === true`, und
    // die Oberflaeche versprach eine Deaktivierung, die der Server ablehnte.
    const res = await apiGet<any>(`/api/admin/customers/${customerId}/deactivation-readiness`);
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const check = res.data.checks.find((c: any) => c.key === "allCustomerSigned");
    expect(check, "der Check muss in der Readiness stehen, nicht nur im Schreibpfad").toBeDefined();
    expect(check.met, "ein Nachweis ohne Kundenunterschrift liegt an").toBe(false);
    expect(check.overridable, "sonst ist der Kunde bei verstorbener Kundin nie deaktivierbar").toBe(true);
    expect(check.detail).toContain("1");

    expect(res.data.ready, "die Oberflaeche darf nicht alles-erfuellt melden").toBe(false);

    // Gegenprobe: die vier alten Checks liegen gruen. Der neue ist damit
    // der EINZIGE Grund fuer `ready === false` — waere einer der anderen
    // rot, wuerde dieser Test auch ohne den neuen Check gruen.
    for (const key of ["contractEndReached", "allDocumented", "allServiceRecords", "allInvoiced"]) {
      const c = res.data.checks.find((x: any) => x.key === key);
      expect(c?.met, `${key} sollte erfuellt sein`).toBe(true);
    }
  });

  it("2 — ohne Override blockt der Schreibpfad mit 409", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${customerId}/complete-deactivation`, {
      deactivationReason: "verstorben",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(409);
    expect(res.data?.code).toBe("DEACTIVATION_BLOCKED");
    expect(res.data?.details?.unsignedRecords?.length).toBe(1);

    const [c] = await db.select({ status: customers.status })
      .from(customers).where(eq(customers.id, customerId));
    expect(c.status, "die Blockade muss auch wirken").toBe("aktiv");
  });

  it("3 — mit Override und Begruendung geht es durch, und die Spur nennt den Nachweis", async () => {
    const res = await apiPost<any>(`/api/admin/customers/${customerId}/complete-deactivation`, {
      deactivationReason: "verstorben",
      overrideBillingGates: true,
      overrideReason: "Kundin verstorben, Unterschrift nicht nachholbar",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const [c] = await db.select({ status: customers.status })
      .from(customers).where(eq(customers.id, customerId));
    expect(c.status).toBe("inaktiv");

    // Der Audit-Eintrag muss sagen, WELCHER Nachweis liegen blieb — nicht
    // nur, dass uebergangen wurde. Genau diese Information fehlte bei den
    // Bestandsfaellen 93 und 89.
    // Direkt gegen die Tabelle, nicht ueber einen Endpunkt in einem `if`:
    // eine Zusicherung, die stillschweigend uebersprungen werden kann, ist
    // keine.
    const eintraege = await db.select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "customer_updated"),
        eq(auditLog.entityType, "customer"),
        eq(auditLog.entityId, customerId),
      ));
    const treffer = eintraege
      .map(e => e.metadata as Record<string, unknown> | null)
      .find(m => m?.action === "complete_deactivation" && m?.override === true);

    expect(treffer, "der Override MUSS eine Audit-Spur haben").toBeDefined();
    expect(treffer!.skippedGates, "das uebergangene Gate wird benannt")
      .toContain("allCustomerSigned");
    expect(
      (treffer!.unsignedServiceRecords as unknown[] | undefined)?.length,
      "und der konkrete Nachweis, nicht nur die Tatsache",
    ).toBe(1);
  });

  it("4 — nach dem Override ist der Nachweis noch da und weiter unterschreibbar", async () => {
    // Dieselbe Zusage wie beim Dokumentations-Override: der offene Posten
    // verschwindet nicht, er wird nur nicht mehr zum Riegel. Waere er weg,
    // haette der Guard die Luecke verlagert statt sie zu schliessen.
    const rest = await db.select({ id: monthlyServiceRecords.id, status: monthlyServiceRecords.status })
      .from(monthlyServiceRecords)
      .where(eq(monthlyServiceRecords.customerId, customerId));
    expect(rest.length, "der Nachweis bleibt bestehen").toBe(1);
    expect(rest[0].status).toBe("employee_signed");
  });
});
