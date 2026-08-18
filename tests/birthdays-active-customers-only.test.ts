import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  apiGet, apiGetAs, getAuthCookie, loginAs, createTestCustomer, cleanupCustomer,
  createTestEmployee, deactivateTestEmployee, uniqueId, type AuthCookie,
} from "./test-utils";
import { db } from "../server/lib/db";
import { customers, customerContracts } from "@shared/schema";
import { eq, inArray } from "drizzle-orm";

/**
 * Task 6hHW39Gx — Geburtstage nur für AKTIVE Kunden.
 *
 * ── Der Zustand, den das ablöst ─────────────────────────────────────────
 * Beide Ansichten zeigten jeden nicht gelöschten Kunden:
 *
 *   - Die Admin-Sicht rief `getActiveCustomersWithBirthday`. Der Name
 *     behauptete einen Aktiv-Filter, die Bedingung war aber nur
 *     `deleted_at IS NULL`.
 *   - Die Mitarbeiter-Sicht rief `getCustomersByIds` und filterte GAR NICHT.
 *
 * Gekündigte, pausierte und auf `inaktiv` gesetzte Kunden bekamen damit
 * Geburtstagsgrüße.
 *
 * ── Was hier geprüft wird ───────────────────────────────────────────────
 * Erschöpfend über den Lebenszyklus: laufend gehört rein, pausiert und
 * gekündigt raus — und zwar in BEIDEN Ansichten. Dazu die Naht, an der die
 * impliziten Kopplungen sitzen: dass der Aktiv-Filter das Selbst-Scoping der
 * Mitarbeiter-Sicht nicht ersetzt, sondern nur verkleinert.
 */

interface BirthdayEntry {
  id: number;
  type: "employee" | "customer";
  name: string;
  daysUntil: number;
}

/** Geburtstag in `tage` Tagen, damit der Kunde ins Standard-Fenster fällt. */
function geburtstagIn(tage: number): string {
  const d = new Date();
  d.setDate(d.getDate() + tage);
  return `1940-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const angelegt: number[] = [];

async function kunde(opts: {
  name: string;
  status?: string;
  contractStatus?: string;
  contractEnd?: string | null;
}): Promise<number> {
  const backdated = new Date();
  backdated.setFullYear(backdated.getFullYear() - 1);
  const created = await createTestCustomer({
    vorname: opts.name,
    nachname: `LZ_${uniqueId()}`,
    geburtsdatum: geburtstagIn(5),
    createdAtOverride: backdated,
  });
  const id = created.id as number;
  angelegt.push(id);

  if (opts.status && opts.status !== "aktiv") {
    await db.update(customers).set({ status: opts.status }).where(eq(customers.id, id));
  }
  if (opts.contractStatus || opts.contractEnd) {
    await db.insert(customerContracts).values({
      customerId: id,
      contractStart: "2025-01-01",
      contractEnd: opts.contractEnd ?? null,
      status: opts.contractStatus ?? "active",
    } as never);
  }
  return id;
}

let laufendId = 0;
let pausiertId = 0;
let gekuendigtVertragId = 0;
let gekuendigtEndeId = 0;
let inaktivId = 0;
/** Laufender Kunde, der dem Test-Mitarbeiter NICHT zugewiesen ist. */
let laufendFremdId = 0;
let mitarbeiterId: number | null = null;
let mitarbeiterAuth: AuthCookie;

beforeAll(async () => {
  await getAuthCookie();
  laufendId = await kunde({ name: "Laufend", contractStatus: "active" });
  pausiertId = await kunde({ name: "Pausiert", contractStatus: "paused" });
  gekuendigtVertragId = await kunde({ name: "GekuendigtStatus", contractStatus: "terminated" });
  gekuendigtEndeId = await kunde({ name: "GekuendigtEnde", contractEnd: "2026-06-30" });
  inaktivId = await kunde({ name: "Inaktiv", status: "inaktiv", contractStatus: "active" });
  laufendFremdId = await kunde({ name: "LaufendFremd", contractStatus: "active" });

  const emp = await createTestEmployee({ isAdmin: false, nachnamePrefix: "LZBday" });
  mitarbeiterId = emp.id;
  // Zuweisen: alle Lebenszyklus-Faelle AUSSER dem Fremd-Kunden. Der bleibt
  // unzugewiesen und ist damit die Gegenprobe fuer das Scoping.
  await db.update(customers)
    .set({ primaryEmployeeId: emp.id })
    .where(inArray(customers.id, [laufendId, pausiertId, gekuendigtVertragId, gekuendigtEndeId, inaktivId]));
  mitarbeiterAuth = await loginAs(emp.email, emp.password);
});

afterAll(async () => {
  if (angelegt.length > 0) {
    await db.update(customers).set({ primaryEmployeeId: null }).where(inArray(customers.id, angelegt));
    await db.delete(customerContracts).where(inArray(customerContracts.customerId, angelegt));
  }
  for (const id of angelegt) await cleanupCustomer(id);
  await deactivateTestEmployee(mitarbeiterId);
});

describe("GET /api/birthdays — nur betreute Kunden (Task 6hHW39Gx)", () => {
  it("Admin-Sicht: laufend drin, pausiert/gekuendigt/inaktiv raus — erschoepfend", async () => {
    const res = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30");
    expect(res.status).toBe(200);
    const enthalten = new Set(
      res.data.filter((b) => b.type === "customer").map((b) => b.id),
    );

    // Erschoepfend: JEDE der fuenf Lagen wird geprueft, nicht nur die
    // erwarteten Ausschluesse. Ein zusaetzlicher Treffer faellt damit genauso
    // auf wie ein fehlender.
    const erwartung: Array<[string, number, boolean]> = [
      ["laufender Vertrag", laufendId, true],
      ["pausierter Vertrag", pausiertId, false],
      ["Vertrag terminated", gekuendigtVertragId, false],
      ["Vertragsende gesetzt", gekuendigtEndeId, false],
      ["Kunde inaktiv", inaktivId, false],
    ];
    for (const [was, id, sollDrin] of erwartung) {
      expect(enthalten.has(id), `${was} (id=${id})`).toBe(sollDrin);
    }
  });

  it("Mitarbeiter-Sicht: derselbe Filter — pausiert und gekuendigt sind auch hier raus", async () => {
    const res = await apiGetAs<BirthdayEntry[]>(mitarbeiterAuth, "/api/birthdays?days=30");
    expect(res.status).toBe(200);
    const enthalten = new Set(res.data.filter((b) => b.type === "customer").map((b) => b.id));

    const erwartung: Array<[string, number, boolean]> = [
      ["laufend + zugewiesen", laufendId, true],
      ["pausiert + zugewiesen", pausiertId, false],
      ["terminated + zugewiesen", gekuendigtVertragId, false],
      ["Vertragsende + zugewiesen", gekuendigtEndeId, false],
      ["inaktiv + zugewiesen", inaktivId, false],
    ];
    for (const [was, id, sollDrin] of erwartung) {
      expect(enthalten.has(id), `${was} (id=${id})`).toBe(sollDrin);
    }
  });

  it("NAHT: der Aktiv-Filter verkleinert die Zuweisungs-Menge, er ersetzt sie nicht", async () => {
    // Die Stelle, an der impliziten Kopplungen gern sitzen. `laufendFremd` ist
    // laufend und aktiv — er wuerde den Aktiv-Filter also passieren —, ist dem
    // Test-Mitarbeiter aber NICHT zugewiesen.
    //
    // Erscheint er trotzdem, hat der Filter das Selbst-Scoping ueberschrieben
    // (etwa weil jemand ihn auf „alle aktiven Kunden" gelegt hat, statt ihn
    // hinter `getAssignedCustomerIds` zu haengen). Genau dieser Fehler waere
    // ohne den Fall unsichtbar: alle anderen Zusicherungen blieben gruen.
    const res = await apiGetAs<BirthdayEntry[]>(mitarbeiterAuth, "/api/birthdays?days=30");
    expect(res.status).toBe(200);
    const enthalten = new Set(res.data.filter((b) => b.type === "customer").map((b) => b.id));
    expect(enthalten.has(laufendFremdId), "nicht zugewiesener laufender Kunde").toBe(false);

    // Gegenprobe: derselbe Kunde IST in der Admin-Sicht sichtbar — der Fall
    // oben misst also das Scoping und nicht etwa einen kaputten Fixture.
    const adminRes = await apiGet<BirthdayEntry[]>("/api/birthdays?days=30");
    const adminIds = new Set(adminRes.data.filter((b) => b.type === "customer").map((b) => b.id));
    expect(adminIds.has(laufendFremdId), "Admin muss ihn sehen").toBe(true);
  });
});
