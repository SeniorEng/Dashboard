/**
 * EINMAL-WERKZEUG — B3 [P1] beziffern: wie viel §45b-Verfügbarkeit erzeugen die
 * Legacy-`year`-Übertragszeilen zu viel?
 *
 * ── Der Befund ────────────────────────────────────────────────────────
 * `allocation-storage.ts` mischt zwei Schlüssel: Überträge werden über das
 * FENSTER gezählt (`:685-688`), `allocStart` aber über die SPALTE `year`
 * verschoben (`:689-698`), der Startwert über `a.year - 1` verdrängt
 * (`:902-904`). Bei einer Legacy-Zeile (`year = 2025`, Fenster 2026) zeigen
 * die drei auf verschiedene Jahre — die Monatsaufstockungen des Quelljahres
 * zählen dann ZUSÄTZLICH zu dem Übertrag, der sie bereits kondensiert.
 *
 * Der Effekt ist SQL nicht zugänglich; er entsteht im Zusammenspiel innerhalb
 * von `calculateAllocated45b`. Deshalb misst dieses Skript ihn über den echten
 * Lesepfad (`netAvailable45bAt`) — zweimal je Kunde, einmal mit der Zeile wie
 * sie ist, einmal mit auf das Fensterjahr korrigiertem `year`.
 *
 * ── WICHTIG: schreibt in einer Transaktion und rollt IMMER zurück ─────
 * Die korrigierte Sicht entsteht nur, wenn `year` in der DB tatsächlich anders
 * steht — `netAvailable45bAt` liest die Allocation selbst. Das Skript setzt den
 * Wert deshalb INNERHALB einer Transaktion und wirft am Ende, damit Postgres
 * zurückrollt. Es bleibt nichts zurück.
 *
 * Trotzdem: NUR gegen eine Prod-KOPIE fahren, nie gegen Prod. Der Guard unten
 * bricht bei erkennbar produktiver `DATABASE_URL` ab. Kein `--apply`, keine
 * dauerhafte Änderung, keine Korrektur — reines Messwerkzeug.
 *
 * ── One-off-Disziplin (CLAUDE.md) ────────────────────────────────────
 * Nach „angewendet + verifiziert" LÖSCHEN und durch ein Protokoll unter
 * `docs/corrections/<datum>_b3-legacy-year.md` ersetzen.
 *
 * Aufruf:
 *   DATABASE_URL=<prod-KOPIE> npx tsx server/scripts/b3-quantify-exposure.ts
 *   … --as-of=2026-06-30      Stichtag (Default: heute)
 *   … --json
 */
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { budgetAllocations } from "@shared/schema";
import { netAvailable45bAt } from "../storage/budget/net-available-45b";
import { formatEuroDE } from "@shared/utils/money";
import { todayISO } from "@shared/utils/datetime";

const BT = "entlastungsbetrag_45b";
const ROLLBACK = Symbol("rollback");

function stichtag(): string {
  const arg = process.argv.find(a => a.startsWith("--as-of="));
  if (!arg) return todayISO();
  const wert = arg.split("=")[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(wert)) {
    console.error(`[b3] --as-of erwartet YYYY-MM-DD, bekam: ${wert}`);
    process.exit(2);
  }
  return wert;
}

/** Fail-closed: bricht ab, wenn die DATABASE_URL nach Produktion aussieht. */
function assertKopie(): void {
  const url = process.env.DATABASE_URL ?? "";
  if (!url) { console.error("[b3] DATABASE_URL nicht gesetzt."); process.exit(2); }
  const host = (url.match(/@([^/:]+)/)?.[1] ?? "").toLowerCase();
  if (!host) { console.error("[b3] Host aus DATABASE_URL nicht lesbar — fail-closed."); process.exit(2); }
  const prodUrl = process.env.PROD_DATABASE_URL ?? "";
  const prodHost = (prodUrl.match(/@([^/:]+)/)?.[1] ?? "").toLowerCase();
  if (prodHost && host === prodHost) {
    console.error(`[b3] DATABASE_URL zeigt auf den PROD-Host (${host}). Abbruch.`);
    process.exit(2);
  }
  if (process.env.NODE_ENV === "production") {
    console.error("[b3] NODE_ENV=production — Abbruch.");
    process.exit(2);
  }
}

interface Zeile {
  customerId: number;
  allocationId: number;
  spalteYear: number;
  fensterJahr: number;
  istCents: number;
  sollCents: number;
  differenzCents: number;
}

async function main(): Promise<void> {
  assertKopie();
  const asOfIso = stichtag();
  const asJson = process.argv.includes("--json");

  // Legacy-Zeilen: `year` weicht vom Fensterjahr ab.
  const legacy = await db.select({
    id: budgetAllocations.id,
    customerId: budgetAllocations.customerId,
    year: budgetAllocations.year,
    validFrom: budgetAllocations.validFrom,
    expiresAt: budgetAllocations.expiresAt,
  }).from(budgetAllocations).where(and(
    eq(budgetAllocations.budgetType, BT),
    eq(budgetAllocations.source, "carryover"),
    isNull(budgetAllocations.deletedAt),
    ne(budgetAllocations.year, sql`EXTRACT(YEAR FROM ${budgetAllocations.validFrom})::int`),
  ));

  const out: Zeile[] = [];

  for (const l of legacy) {
    const fensterJahr = Number(l.validFrom.slice(0, 4));
    let istCents = 0;
    let sollCents = 0;

    try {
      await db.transaction(async (tx) => {
        // IST — Zeile wie sie ist.
        istCents = (await netAvailable45bAt(l.customerId, asOfIso, {}, tx)).availableCents;
        // SOLL — `year` auf das Fensterjahr korrigiert, NUR in dieser Transaktion.
        await tx.update(budgetAllocations)
          .set({ year: fensterJahr })
          .where(eq(budgetAllocations.id, l.id));
        sollCents = (await netAvailable45bAt(l.customerId, asOfIso, {}, tx)).availableCents;
        // Immer zurückrollen — dieses Skript ändert nichts.
        throw ROLLBACK;
      });
    } catch (err) {
      if (err !== ROLLBACK) throw err;
    }

    out.push({
      customerId: l.customerId, allocationId: l.id,
      spalteYear: l.year, fensterJahr,
      istCents, sollCents, differenzCents: istCents - sollCents,
    });
  }

  out.sort((a, b) => b.differenzCents - a.differenzCents);
  const summe = out.reduce((s, r) => s + r.differenzCents, 0);
  const betroffen = out.filter(r => r.differenzCents !== 0);

  if (asJson) {
    console.log(JSON.stringify({ asOfIso, rows: out, summeCents: summe }, null, 2));
    return;
  }

  console.log(`\nB3 — Über-Ansatz durch Legacy-\`year\`-Übertragszeilen, Stichtag ${asOfIso}\n`);
  if (out.length === 0) { console.log("Keine Legacy-Zeilen gefunden.\n"); return; }

  console.log("Kunde".padStart(7), "Alloc".padStart(7), "year".padStart(6), "Fenster".padStart(8),
              "IST".padStart(13), "SOLL".padStart(13), "Differenz".padStart(13));
  for (const r of out) {
    console.log(
      String(r.customerId).padStart(7), String(r.allocationId).padStart(7),
      String(r.spalteYear).padStart(6), String(r.fensterJahr).padStart(8),
      formatEuroDE(r.istCents).padStart(13),
      formatEuroDE(r.sollCents).padStart(13),
      formatEuroDE(r.differenzCents).padStart(13),
    );
  }
  console.log("\n--- Summen ---");
  console.log(`Legacy-Zeilen geprüft   : ${out.length}`);
  console.log(`davon mit Differenz     : ${betroffen.length}  (${new Set(betroffen.map(r => r.customerId)).size} Kunden)`);
  console.log(`Über-Ansatz gesamt      : ${formatEuroDE(summe)}`);
  console.log(
    "\nDifferenz = IST − SOLL: wieviel §45b-Verfügbarkeit die Zeile mit ihrem\n" +
    "abweichenden `year` MEHR erzeugt als mit korrigiertem. Positiv = zu viel.\n" +
    "Gemessen am Stichtag; in H1 ist der Effekt am größten, ab dem 01.07. fällt\n" +
    "der Übertrag ohnehin aus der Rechnung.\n",
  );
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[b3] Fehlgeschlagen:", err);
  process.exit(1);
});
