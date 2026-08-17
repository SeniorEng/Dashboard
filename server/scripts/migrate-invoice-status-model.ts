/**
 * Status-Modell-Umstellung — auditierter Einmal-Lauf.
 *
 * Spezifikation: `docs/rechnungsstatus-zielmodell.md`, Abschnitt 5.
 * Zählung, die die Grundlage bestätigt: `scripts/rechnungsstatus/zaehlung.sql`.
 *
 * ── Was er tut ──────────────────────────────────────────────────────────
 * Drei Abbildungen, mehr nicht:
 *
 *   avis_erhalten            → versendet
 *   teilweise_bezahlt        → versendet
 *   stornorechnung/entwurf   → abgeschlossen
 *
 * Alles andere bleibt unverändert. Der Lauf fasst weder Beträge noch Belege
 * noch `sent_at`/`paid_at` an.
 *
 * ── Warum Einmal-Lauf und nicht map-on-read ─────────────────────────────
 * Der Status steht auf KEINEM Dokument und in keiner ZUGFeRD-Datei. Was GoBD
 * schützt — der ausgegebene Beleg und die Buchung — wird nicht berührt; die
 * Spalte ist interner Vorgangs-Zustand und wird ohnehin bei jedem
 * Zahlungsabgleich fortgeschrieben.
 *
 * Map-on-read hätte den Altwert konserviert und jeden künftigen Leser
 * gezwungen, die Abbildung zu kennen — derselbe Zweitbegriff, den dieser Umbau
 * beseitigt. Die aufgegebene Umkehrbarkeit ersetzt der Audit-Eintrag je Zeile:
 * aus ihm ist der Vorher-Zustand jederzeit rekonstruierbar.
 *
 * ── Ausführung ──────────────────────────────────────────────────────────
 *   tsx server/scripts/migrate-invoice-status-model.ts            # Trockenlauf
 *   tsx server/scripts/migrate-invoice-status-model.ts --apply    # schreibend
 *
 * Der schreibende Lauf gehört auf PRODUKTION (Replit), nicht auf die Box, und
 * erst nach ausdrücklicher Freigabe des Trockenlauf-Ergebnisses.
 *
 * WICHTIG — REIHENFOLGE: Dieser Lauf muss VOR dem Deploy des neuen Codes
 * stattfinden. Der neue Code kennt die Altwerte nicht mehr; `parseInvoiceStatus`
 * wirft bei ihnen. Umgekehrt ist der Lauf gegen den ALTEN Code unproblematisch:
 * er schreibt nur Spaltenwerte und hängt an keiner neuen Funktion.
 *
 * Nach „angewendet + verifiziert" wird diese Datei GELÖSCHT und durch ein
 * Protokoll unter `docs/corrections/` ersetzt (CLAUDE.md).
 */

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { invoices } from "@shared/schema";
import { auditService } from "../services/audit";

/** Wer den Lauf verantwortet — landet in jedem Audit-Eintrag. */
const ACTING_USER_ID = Number(process.env.STATUS_MIGRATION_ACTOR_USER_ID ?? "1");

interface Abbildung {
  name: string;
  /** Kandidaten-Bedingung. */
  where: ReturnType<typeof and>;
  ziel: "versendet" | "abgeschlossen";
  /** Was die Zählung vom 17.08. erwartet — Abweichung ist kein Abbruch, aber ein Hinweis. */
  erwartet: number;
}

const ABBILDUNGEN: Abbildung[] = [
  {
    name: "avis_erhalten -> versendet",
    where: and(eq(invoices.status, "avis_erhalten")),
    ziel: "versendet",
    erwartet: 54,
  },
  {
    name: "teilweise_bezahlt -> versendet",
    where: and(eq(invoices.status, "teilweise_bezahlt")),
    ziel: "versendet",
    erwartet: 0,
  },
  {
    name: "stornorechnung/entwurf -> abgeschlossen",
    where: and(eq(invoices.invoiceType, "stornorechnung"), eq(invoices.status, "entwurf")),
    ziel: "abgeschlossen",
    erwartet: 114,
  },
];

function abbruch(nachricht: string): never {
  console.error(`\nABBRUCH: ${nachricht}`);
  console.error("Es wurde nichts geschrieben.");
  process.exit(1);
}

async function main() {
  const apply = process.argv.includes("--apply");
  console.log("Status-Modell-Umstellung");
  console.log(apply ? "MODUS: SCHREIBEND (--apply)\n" : "MODUS: Trockenlauf (kein --apply)\n");

  // ── Vorprüfung: trägt irgendeine Zeile einen Wert, den weder das alte noch
  //    das neue Modell kennt? Dann ist die Grundlage der Spec unvollständig,
  //    und der Lauf hat hier nichts zu suchen.
  const unbekannt = await db
    .select({ status: invoices.status, anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .groupBy(invoices.status);
  const bekannt = new Set([
    "entwurf", "versendet", "bezahlt", "storniert", "abgeschlossen",
    "avis_erhalten", "teilweise_bezahlt",
  ]);
  const fremd = unbekannt.filter(z => !bekannt.has(z.status));
  if (fremd.length > 0) {
    abbruch(
      `Unbekannte Status in der Datenbank: ${fremd.map(f => `${f.status} (${f.anzahl})`).join(", ")}. ` +
      `Erst klären, dann migrieren — die Zähl-Abfrage (Block F) hätte das melden müssen.`,
    );
  }

  // ── Kandidaten je Abbildung
  let gesamt = 0;
  const plaene: Array<{ abb: Abbildung; ids: number[] }> = [];
  for (const abb of ABBILDUNGEN) {
    const zeilen = await db
      .select({ id: invoices.id, nummer: invoices.invoiceNumber, status: invoices.status })
      .from(invoices)
      .where(abb.where);
    plaene.push({ abb, ids: zeilen.map(z => z.id) });
    gesamt += zeilen.length;

    const hinweis = zeilen.length === abb.erwartet
      ? ""
      : `   (Zählung vom 17.08. erwartete ${abb.erwartet} — Prod ist weitergelaufen, das ist normal)`;
    console.log(`  ${abb.name}: ${zeilen.length} Zeilen${hinweis}`);
  }

  console.log(`\n  Summe: ${gesamt} Zeilen`);

  if (!apply) {
    console.log("\nTrockenlauf beendet. Nichts geschrieben.");
    console.log("Vor dem schreibenden Lauf: dieses Ergebnis freigeben lassen.");
    return;
  }

  if (gesamt === 0) {
    console.log("\nNichts zu tun.");
    return;
  }

  // ── Schreiben. Ein Audit-Eintrag JE ZEILE, in derselben Transaktion.
  //
  // Bewusst nicht ein Sammel-Eintrag: die Spur soll sagen, welche Rechnung
  // welchen Vorher-Wert hatte. Ein Eintrag über „168 Zeilen umgestellt" wäre
  // für eine Rückrechnung wertlos.
  await db.transaction(async tx => {
    for (const { abb, ids } of plaene) {
      if (ids.length === 0) continue;
      const vorher = await tx
        .select({ id: invoices.id, nummer: invoices.invoiceNumber, status: invoices.status })
        .from(invoices)
        .where(inArray(invoices.id, ids));

      await tx.update(invoices).set({ status: abb.ziel }).where(inArray(invoices.id, ids));

      for (const z of vorher) {
        await auditService.log(
          ACTING_USER_ID,
          "invoice_status_changed",
          "invoice",
          z.id,
          {
            invoiceNumber: z.nummer,
            previousStatus: z.status,
            newStatus: abb.ziel,
            reason: "status_model_migration",
            abbildung: abb.name,
            spec: "docs/rechnungsstatus-zielmodell.md",
          },
          undefined,
          tx,
        );
      }
      console.log(`  ${abb.name}: ${ids.length} umgestellt`);
    }
  });

  console.log(`\n${gesamt} Zeilen umgestellt, ${gesamt} Audit-Einträge geschrieben.`);
  console.log("Danach: Code deployen, dieses Skript löschen, Protokoll unter docs/corrections/ ablegen.");
}

main()
  .then(() => process.exit(0))
  .catch(err => {
    console.error(err);
    process.exit(1);
  });
