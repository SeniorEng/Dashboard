import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { activeInvoiceCondition, activeInvoiceSqlRaw } from "../../server/lib/appointment-invoiced";
import { isStorniertInvoice } from "@shared/domain/billing-pipeline";

/**
 * Task #1908 — die drei Formulierungen von „zählt diese Rechnung noch?" MÜSSEN
 * im Gleichschritt bleiben:
 *   • `activeInvoiceCondition()` — Drizzle
 *   • `activeInvoiceSqlRaw(alias)` — Roh-SQL
 *   • `isStorniertInvoice(...)`   — TS auf geladenen Objekten
 *
 * Bisher stand das nur als Kommentar in der SSoT-Datei; nichts hat es erzwungen.
 * Der Architektur-Wächter A6b bewacht die AUFRUFSTELLEN — nicht, ob die drei
 * untereinander noch dasselbe bedeuten. Genau diese Lücke schließt diese Datei.
 *
 * BRAUCHT `DATABASE_URL`: `server/lib/appointment-invoiced.ts` importiert
 * `./db`, das beim Modul-Load ohne gesetzte URL wirft. Im CI-`tests`-Job ist sie
 * gesetzt (alle Shards laufen gegen eine DB); ein nackter lokaler
 * `vitest run tests/unit` ohne Env lässt diese Datei scheitern — dieselbe
 * Eigenschaft hat `tests/architecture/soft-delete-coverage.test.ts`. Lokal
 * deshalb mit Env fahren:
 *   `set -a; . ./.env.test.local; set +a; npx vitest run tests/unit/active-invoice-ssot.test.ts`
 *
 * Die beiden SQL-Formen sind bewusst NICHT stringgleich: die Drizzle-Bedingung
 * bindet die Literale als Parameter (`<> $1`), das Roh-SQL inlined sie
 * (`!= 'storniert'`). Verglichen wird deshalb die normalisierte Semantik:
 * Spalten, Operator-Richtung und die beiden Literale.
 */
const dialect = new PgDialect();
const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => dialect.sqlToQuery(q);

describe("Aktive-Rechnung-SSoT — die drei Formulierungen bleiben deckungsgleich", () => {
  it("Roh-SQL nennt beide Spalten, beide Literale und verneint beide", () => {
    const { sql: text, params } = render(activeInvoiceSqlRaw("i"));
    expect(text).toBe("i.status != 'storniert' AND i.invoice_type != 'stornorechnung'");
    // Literale sind inline, also KEINE Parameter — das ist der Unterschied zur
    // Drizzle-Form und der Grund, warum ein Stringvergleich hier scheitern würde.
    expect(params).toEqual([]);
  });

  it("Drizzle-Bedingung trägt dieselben Spalten und dieselben zwei Literale", () => {
    const { sql: text, params } = render(activeInvoiceCondition());
    expect(text).toContain('"status"');
    expect(text).toContain('"invoice_type"');
    // Zwei Ungleich-Vergleiche, nicht einer und nicht drei.
    expect(text.match(/<>/g) ?? []).toHaveLength(2);
    expect(params).toEqual(["storniert", "stornorechnung"]);
  });

  it("das TS-Prädikat entscheidet für jede Kombination wie die SQL-Formen", () => {
    // Wahrheitstabelle über beide Dimensionen. `isStorniertInvoice` ist die
    // Negation von „aktiv" — kippt eine der drei Formen, kippt hier eine Zeile.
    const faelle = [
      { status: "versendet", invoiceType: "rechnung", aktiv: true },
      { status: "entwurf", invoiceType: "rechnung", aktiv: true },
      { status: "bezahlt", invoiceType: "nachberechnung", aktiv: true },
      { status: "storniert", invoiceType: "rechnung", aktiv: false },
      { status: "versendet", invoiceType: "stornorechnung", aktiv: false },
      { status: "storniert", invoiceType: "stornorechnung", aktiv: false },
    ];
    for (const f of faelle) {
      expect(
        !isStorniertInvoice({ status: f.status, invoiceType: f.invoiceType }),
        `${f.status}/${f.invoiceType}`,
      ).toBe(f.aktiv);
    }
  });

  it("der Alias wird validiert (kein Roh-SQL über den Parameter)", () => {
    expect(() => activeInvoiceSqlRaw("i")).not.toThrow();
    expect(() => activeInvoiceSqlRaw("inv_2")).not.toThrow();
    expect(() => activeInvoiceSqlRaw("i; DROP TABLE invoices --")).toThrow(/unzulässiger/);
    expect(() => activeInvoiceSqlRaw("")).toThrow();
  });
});
