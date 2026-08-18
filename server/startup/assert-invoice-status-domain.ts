/**
 * Task 6hHqw8c7 — Boot-Gate für den Rechnungs-Status.
 *
 * ── Der Vorfall, der es ausgelöst hat ───────────────────────────────────
 * Beim Status-Umbau (#108) galt eine Reihenfolge: die Datenmigration muss VOR
 * dem Deploy des neuen Codes laufen, weil der neue Code die Altwerte
 * (`avis_erhalten`, `teilweise_bezahlt`) nicht mehr kennt. Die Reihenfolge stand
 * im Skript-Docstring und im PR-Body. Am 18.08.2026 lief der Publish trotzdem
 * 28 Minuten VOR der Migration.
 *
 * Folge: 54 Zeilen trugen einen Wert, den `parseInvoiceStatus` ablehnt. Der Wurf
 * riss nicht die einzelne Zeile mit, sondern den ganzen Lesepfad —
 * `GET /api/billing` und das Cockpit-Board antworteten mit 500, die Abrechnung
 * war rund eine Stunde nicht bedienbar. Bemerkt wurde es an der Oberfläche,
 * nicht an einer Absicherung.
 *
 * ── Was dieses Gate ERSETZT ─────────────────────────────────────────────
 * Die Reihenfolge als bloße Anweisung in Dokumenten. Sie ist jetzt eine
 * Bedingung: bootet der neue Code gegen unmigrierte Daten, bricht er ab, statt
 * zu starten und im Betrieb zu 500en. Ein fehlgeschlagener Boot lässt die alte
 * Version online — der schadensärmere Ausgang.
 *
 * ── Bewusst eng ─────────────────────────────────────────────────────────
 * Nur `invoices.status`, kein allgemeines Wert-Validierungs-Framework. Ein
 * generisches Gate müsste für jede Spalte entscheiden, was „gültig" heißt, und
 * genau diese Entscheidung ist der Teil, den man nicht verallgemeinern kann.
 *
 * Abgegrenzt vom `critical-ssot-boot-gate` (#1339): das beantwortet „Ziel-Tabelle
 * leer, Quell-Tabellen weg, Leser hängen dran" — eine Datenverlust-Frage. Hier
 * geht es um den WERTEBEREICH einer vorhandenen Spalte. Verschiedene Fragen,
 * deshalb ein eigenes Gate statt eines weiteren `CRITICAL_SSOT_TARGETS`-Eintrags.
 *
 * ── Warum in JEDER Umgebung hart ────────────────────────────────────────
 * Das Preis-Gate warnt in Dev nur, weil eine leere `prices`-Tabelle dort
 * legitim ist. Hier gibt es kein legitimes Gegenstück: ein Status, den der Code
 * nicht lesen kann, ist in Dev genauso unbedienbar wie in Prod — die Dev-DB ist
 * ohnehin eine Prod-Kopie. Wer den Fall in Dev nur als Warnung sähe, bekäme ihn
 * in Prod als Ausfall.
 */
import { sql } from "drizzle-orm";
import { db } from "../lib/db";
import { log } from "../lib/log";
import { parseInvoiceStatus } from "@shared/schema/billing";

export class InvoiceStatusDomainError extends Error {
  readonly befunde: readonly string[];
  constructor(befunde: readonly string[], gesamt: number) {
    super(
      `BOOT ABGEBROCHEN — ${gesamt} Rechnung(en) tragen einen Status, den dieser Code nicht kennt.\n\n` +
      befunde.map((b) => `  ${b}`).join("\n") +
      `\n\nDiese Zeilen würden im Lesepfad eine Ausnahme auslösen und die\n` +
      `Rechnungsliste (GET /api/billing) sowie das Cockpit-Board mit 500\n` +
      `beantworten — nicht nur die betroffene Zeile, sondern die ganze Antwort.\n\n` +
      `Fast immer ist die Ursache die Reihenfolge: die Status-Migration muss VOR\n` +
      `dem Deploy laufen, nicht danach. Trockenlauf zuerst, dann --apply, dann\n` +
      `--verify. Der Weg steht im Kopfkommentar von\n` +
      `server/scripts/migrate-invoice-status-model.ts.\n\n` +
      `Der Boot bricht bewusst ab: so bleibt die alte Version online, statt dass\n` +
      `eine neue startet, die die Abrechnung nicht bedienen kann.`,
    );
    this.name = "InvoiceStatusDomainError";
    this.befunde = befunde;
  }
}

/**
 * Prüft jeden in `invoices.status` vorkommenden Wert gegen die SSoT.
 *
 * Validiert wird mit `parseInvoiceStatus` SELBST — nicht mit einer eigenen
 * Liste. Das ist der Punkt: das Gate stellt genau die Frage, an der der
 * Lesepfad später scheitert, und kann deshalb nicht von ihm abdriften. Eine
 * nachgebaute Werteliste wäre ein Zweitbegriff und würde beim nächsten
 * Status-Umbau still auseinanderlaufen.
 *
 * Leerer Bestand besteht: keine Zeilen ⇒ keine Befunde ⇒ Boot läuft weiter.
 * Fehlende Tabelle ebenfalls (frische DB vor dem Schema-Push).
 */
export interface StatusZeile {
  status: string;
  anzahl: number;
}

export interface StatusBefund {
  befunde: string[];
  betroffen: number;
}

/**
 * Der Entscheidungskern — rein, ohne Datenbank.
 *
 * Herausgezogen, weil sonst JEDER Testfall gegen die geteilte Leg-DB laufen
 * muesste. Genau daran ist die erste Fassung gescheitert: der Fall „leerer
 * Bestand" zaehlte die GANZE `invoices`-Tabelle, und in CI teilen sich die
 * Dateien eines Shard-Legs eine Datenbank ohne Truncate — 106 Rechnungen aus
 * `tests/billing/` liefen davor. Der Test war damit nicht isoliert, sondern
 * eine Wette auf die Shard-Verteilung.
 *
 * Mit reinem Kern sind die Faelle Tabellen-Ein-/Ausgabe: keine DB, keine
 * Reihenfolge-Annahme, keine Fremddaten.
 */
export function bewerteStatuszeilen(zeilen: readonly StatusZeile[]): StatusBefund {
  const befunde: string[] = [];
  let betroffen = 0;
  for (const zeile of zeilen) {
    try {
      // Der Kontext landet in der Meldung von `parseInvoiceStatus` und macht
      // aus „Wert unbekannt" ein „Wert unbekannt, N Zeilen betroffen".
      parseInvoiceStatus(zeile.status, `${zeile.anzahl} Zeile(n) in invoices.status`);
    } catch (err) {
      betroffen += zeile.anzahl;
      befunde.push(err instanceof Error ? err.message : String(err));
    }
  }
  return { befunde, betroffen };
}

export async function runInvoiceStatusBootGate(): Promise<void> {
  const vorhanden = await db.execute(
    sql`SELECT to_regclass('public.invoices') IS NOT NULL AS da`,
  ) as unknown;
  const vorhandenRows = Array.isArray(vorhanden)
    ? vorhanden
    : ((vorhanden as { rows?: unknown[] }).rows ?? []);
  if (!(vorhandenRows[0] as { da?: boolean } | undefined)?.da) {
    log("Rechnungs-Status-Gate: Tabelle `invoices` existiert noch nicht — übersprungen.", "startup");
    return;
  }

  const ergebnis = await db.execute(
    sql`SELECT status, count(*)::int AS anzahl FROM invoices GROUP BY status ORDER BY count(*) DESC`,
  ) as unknown;
  const zeilen = (Array.isArray(ergebnis)
    ? ergebnis
    : ((ergebnis as { rows?: unknown[] }).rows ?? [])) as Array<{ status: string; anzahl: number }>;

  const { befunde, betroffen } = bewerteStatuszeilen(zeilen);
  if (befunde.length > 0) {
    throw new InvoiceStatusDomainError(befunde, betroffen);
  }

  log(
    `Rechnungs-Status-Gate: ${zeilen.length} Statuswert(e) geprüft, alle bekannt.`,
    "startup",
  );
}
