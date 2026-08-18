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
 *   stornorechnung/*         → abgeschlossen  (ausser `storniert`)
 *
 * Alles andere bleibt unverändert. Der Lauf fasst weder Beträge noch Belege
 * noch `sent_at`/`paid_at` an — nur die Spalte `status`.
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
 * ══════════════════════════════════════════════════════════════════════════
 * ABLAUF — die Reihenfolge ist Teil des Verfahrens, nicht ein Hinweis
 * ══════════════════════════════════════════════════════════════════════════
 *
 *   1. Trockenlauf (read-only, gern gegen die Replica)
 *   2. Freigabe des Trockenlauf-Ergebnisses
 *   3. SCHREIB-FREEZE der Abrechnung (kein Avis-Import, kein Qonto-Abgleich,
 *      keine Statuswechsel durch Bedienung)
 *   4. `--apply` gegen die Prod-Primary
 *   5. Publish (Coolify deployt bei Push)
 *   6. `--apply` ERNEUT — fängt Nachzügler, die zwischen 4 und 5 entstanden
 *      sind. Der Lauf ist idempotent; findet er nichts, endet er sauber.
 *   7. Nachprüfung (`--verify`) als Abnahmekriterium
 *   8. Freeze aufheben
 *
 * Warum der Freeze: bis zum Publish läuft der ALTE Code, und der schreibt die
 * Altwerte weiter (Avis-Import, Qonto-Teilzahlung, Status-Menü). Nach dem
 * Publish wirft `parseInvoiceStatus` bei so einer Zeile — und zwar nicht nur
 * für sie, sondern für den ganzen Lesepfad: eine einzige Zeile legt die
 * Rechnungsliste und das Cockpit-Board auf 500. Schritt 6 ist der Gürtel zum
 * Hosenträger, falls der Freeze undicht war.
 *
 * Umgekehrt ist der Lauf gegen den ALTEN Code unproblematisch: er schreibt nur
 * Spaltenwerte und hängt an keiner neuen Funktion. Kosmetische Nebenwirkung im
 * Fenster: der alte Code kennt `abgeschlossen` nicht, die 114 Storno-Belege
 * zeigen bis zum Publish ein leeres Status-Badge.
 *
 * ── Ausführung ──────────────────────────────────────────────────────────
 * Das Skript nimmt seine Verbindung AUSSCHLIESSLICH aus `DATABASE_URL`
 * (`server/lib/db.ts`) — es gibt keinen eigenen Ziel-Flag. Auf Replit ist die
 * Shell-`DATABASE_URL` NICHT zwingend die der Deployment-Umgebung; sie muss
 * deshalb ausdrücklich gesetzt werden:
 *
 *   DATABASE_URL="$PROD_DATABASE_URL" tsx server/scripts/migrate-invoice-status-model.ts
 *   DATABASE_URL="$PROD_DATABASE_URL" tsx server/scripts/migrate-invoice-status-model.ts --verify
 *   DATABASE_URL="$PROD_DATABASE_URL" NODE_ENV=production \
 *     tsx server/scripts/migrate-invoice-status-model.ts \
 *     --apply --user=<superadmin-id> --reason="Status-Modell-Umstellung #108" \
 *     --confirm-target=<host>/<datenbank>
 *
 * `--confirm-target` hat ZWEI Teile, und der zweite ist der eigentliche
 * Diskriminator: der Datenbankname wird an der offenen Verbindung erfragt
 * (`current_database()`), nicht aus der URL geparst. Grund: auf Replit heißt
 * der interne Host in Dev und Prod gleich (`helium`). Ein einteiliges
 * `--confirm-target=helium` hat einen Trockenlauf unbemerkt gegen `heliumdb`
 * laufen lassen, während Prod `neondb` ist — 0/0/633 statt 54/0/114.
 *
 * Nach „angewendet + verifiziert" wird diese Datei GELÖSCHT und durch ein
 * Protokoll unter `docs/corrections/` ersetzt (CLAUDE.md). Erst NACH Schritt 7
 * — Schritt 6 braucht sie noch.
 */

import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "../lib/db";
import { invoices } from "@shared/schema";
import { auditService } from "../services/audit";
import { parseProdWriteArgs, assertProdWriteAllowedOrThrow } from "./lib/prod-write-gate";

/** Ab welcher Abweichung vom Erwartungswert der Trockenlauf laut wird. */
const ABWEICHUNG_LAUT_FAKTOR = 3;

interface Abbildung {
  name: string;
  where: ReturnType<typeof and>;
  ziel: "versendet" | "abgeschlossen";
  /** Was die Zählung vom 17.08. erwartet. Abweichung ist kein Abbruch, aber ein Hinweis. */
  erwartet: number;
}

const ABBILDUNGEN: Abbildung[] = [
  {
    name: "avis_erhalten -> versendet",
    // Typ-Filter: eine `stornorechnung` mit Altwert gehört nach `abgeschlossen`,
    // nicht nach `versendet`. Heute 0 Zeilen — aber ohne den Filter widerspräche
    // der Lauf dem Zielmodell, sobald es eine gäbe.
    where: and(eq(invoices.status, "avis_erhalten"), ne(invoices.invoiceType, "stornorechnung")),
    ziel: "versendet",
    erwartet: 54,
  },
  {
    name: "teilweise_bezahlt -> versendet",
    where: and(eq(invoices.status, "teilweise_bezahlt"), ne(invoices.invoiceType, "stornorechnung")),
    ziel: "versendet",
    erwartet: 0,
  },
  {
    name: "stornorechnung/* -> abgeschlossen",
    // Nicht nur `entwurf`, sondern jeder Ausgangsstatus, in dem ein
    // Storno-Dokument real vorkommt. AUSGENOMMEN bleibt `storniert`: eine
    // stornierte Storno-Rechnung ist ein eigener Vorgang, den dieser Lauf
    // nicht anfasst. Alles ausserhalb dieser Liste meldet die Vorpruefung —
    // stillschweigend liegenbleiben soll nichts.
    where: and(
      eq(invoices.invoiceType, "stornorechnung"),
      inArray(invoices.status, ["entwurf", "avis_erhalten", "teilweise_bezahlt"]),
    ),
    ziel: "abgeschlossen",
    erwartet: 114,
  },
];

/**
 * Abbruch als WURF, nicht als `process.exit`.
 *
 * Der CLI-Pfad (`main`) faengt ihn und beendet mit Code 1. Der Grund fuer die
 * Trennung: das Ziel-/Berechtigungs-Gate darf `--apply` niemals gegen eine
 * Test-DB lassen — damit waere der Schreibpfad ohne diese Trennung UNTESTBAR,
 * und ausgerechnet das riskanteste Stueck des PRs haette keinen Test.
 * Deshalb liegt das Gate in `main`, die Migration in einer aufrufbaren
 * Funktion. (Derselbe Aufbau wie `cleanup-duplicate-monthly-proofs.ts`.)
 */
class MigrationsAbbruch extends Error {}

function abbruch(nachricht: string): never {
  throw new MigrationsAbbruch(nachricht);
}

function euro(cents: number | null): string {
  return `${((cents ?? 0) / 100).toFixed(2)} €`;
}

/**
 * Alle Annahmen der Spec, einzeln nachgerechnet — die sieben Bedingungen aus
 * Block F der Zähl-SQL.
 *
 * Die erste Fassung prüfte genau EINE davon (unbekannter Status) und erbte den
 * Rest aus einer Zählung, die einen Tag älter war als der Lauf. „Die Grundlage
 * stimmt" war damit eine Behauptung, kein Befund.
 */
async function vorpruefung(log: (z: string) => void): Promise<void> {
  const befunde: string[] = [];

  const bekannt = [
    "entwurf", "versendet", "bezahlt", "storniert", "abgeschlossen",
    "avis_erhalten", "teilweise_bezahlt",
  ];
  const fremdeStatus = await db
    .select({ status: invoices.status, anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .groupBy(invoices.status);
  for (const z of fremdeStatus.filter(z => !bekannt.includes(z.status))) {
    befunde.push(`unbekannter Status "${z.status}" (${z.anzahl} Zeilen)`);
  }

  const fremdeTypen = await db
    .select({ typ: invoices.invoiceType, anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .groupBy(invoices.invoiceType);
  for (const z of fremdeTypen.filter(z => !["rechnung", "stornorechnung", "nachberechnung"].includes(z.typ))) {
    befunde.push(`unbekannter Typ "${z.typ}" (${z.anzahl} Zeilen)`);
  }

  // `abgeschlossen` gehört AUSSCHLIESSLICH auf Storno-Dokumente. Diese
  // Invariante tritt an die Stelle des Block-F-Checks „unbekannter Status":
  // seit dem ersten `--apply` steht `abgeschlossen` legitim in der Spalte, also
  // kann er sie nicht mehr melden. Sie ist zugleich die EINZIGE Status×Typ-
  // Kombination, bei der `assignInvoiceStage` nach dem Deploy wirft.
  const [falschAbgeschlossen] = await db
    .select({ anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.status, "abgeschlossen"), ne(invoices.invoiceType, "stornorechnung")));
  if (falschAbgeschlossen.anzahl > 0) {
    befunde.push(
      `${falschAbgeschlossen.anzahl} Zeilen mit status='abgeschlossen', aber invoice_type <> 'stornorechnung'. ` +
      `Diese Kombination laesst assignInvoiceStage nach dem Deploy werfen.`,
    );
  }

  // Ein Migrationskandidat mit Zahlungsdatum: die Zählung nennt das als
  // ABWEICHUNG, die überall 0 sein MUSS. Wird die Zeile auf `versendet`
  // gehoben, behauptet sie „wartet auf Zahlung" und trägt zugleich ein
  // Zahlungsdatum — genau der Zustand, aus dem Doppelzuordnungen entstehen.
  const kandidatMitPaidAt = await db
    .select({ id: invoices.id, nummer: invoices.invoiceNumber, status: invoices.status })
    .from(invoices)
    .where(and(
      sql`${invoices.paidAt} IS NOT NULL`,
      or(
        inArray(invoices.status, ["avis_erhalten", "teilweise_bezahlt"]),
        and(eq(invoices.invoiceType, "stornorechnung"), eq(invoices.status, "entwurf")),
      ),
    ));
  for (const z of kandidatMitPaidAt) {
    befunde.push(`Migrationskandidat ${z.nummer} (id=${z.id}, ${z.status}) traegt paid_at`);
  }

  // Storno-Dokument ohne Original bzw. mit nicht-storniertem Original: dann
  // trägt die Begründung „der Vorgang ist am Original verbucht" nicht.
  const [ohneOriginal] = await db
    .select({ anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.invoiceType, "stornorechnung"), isNull(invoices.stornierteRechnungId)));
  if (ohneOriginal.anzahl > 0) {
    befunde.push(`${ohneOriginal.anzahl} Storno-Dokumente ohne Original-Referenz`);
  }

  const originale = db.$with("o").as(
    db.select({ id: invoices.id, status: invoices.status }).from(invoices),
  );
  const nichtStorniert = await db
    .with(originale)
    .select({ anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .innerJoin(originale, eq(originale.id, invoices.stornierteRechnungId))
    .where(and(eq(invoices.invoiceType, "stornorechnung"), ne(originale.status, "storniert")));
  if ((nichtStorniert[0]?.anzahl ?? 0) > 0) {
    befunde.push(`${nichtStorniert[0].anzahl} Storno-Dokumente, deren Original NICHT storniert ist`);
  }

  // Storno-Dokument in einem Status, den keine Abbildung trifft. Es stuerzt
  // nach dem Deploy nichts ab (der Typ kurzschliesst in `assignInvoiceStage`),
  // aber die Zeile bliebe liegen — und `mark-sent` lehnt sie danach ab, weil
  // der Storno-Zweig `abgeschlossen` verlangt. Ein still zurueckgelassenes,
  // unbedienbares Dokument.
  const stornoFremd = await db
    .select({ id: invoices.id, nummer: invoices.invoiceNumber, status: invoices.status })
    .from(invoices)
    .where(and(
      eq(invoices.invoiceType, "stornorechnung"),
      sql`${invoices.status} NOT IN ('entwurf','avis_erhalten','teilweise_bezahlt','abgeschlossen','storniert')`,
    ));
  for (const z of stornoFremd) {
    befunde.push(`Storno-Dokument ${z.nummer} (id=${z.id}) steht auf "${z.status}" — keine Abbildung trifft es`);
  }

  // Migrationskandidat nach `versendet` OHNE Versanddatum: er bekaeme keinen
  // Aging-Anker und altert nie. Laut Zaehlung tragen alle 54 ein `sent_at`.
  const ohneSentAt = await db
    .select({ id: invoices.id, nummer: invoices.invoiceNumber })
    .from(invoices)
    .where(and(
      inArray(invoices.status, ["avis_erhalten", "teilweise_bezahlt"]),
      ne(invoices.invoiceType, "stornorechnung"),
      isNull(invoices.sentAt),
    ));
  for (const z of ohneSentAt) {
    befunde.push(`${z.nummer} (id=${z.id}) wird nach 'versendet' gehoben, traegt aber kein sent_at`);
  }

  if (befunde.length > 0) {
    abbruch(
      `Die Annahmen der Spezifikation halten nicht mehr:\n` +
      befunde.map(b => `  - ${b}`).join("\n") +
      `\n\nErst klaeren, dann migrieren.`,
    );
  }
  log("  Vorpruefung: alle Annahmen halten.\n");
}

/** Nachprüfung — das Abnahmekriterium nach dem Deploy. */
async function nachpruefung(): Promise<void> {
  console.log("Nachpruefung (Abnahmekriterium)\n");
  const [legacy] = await db
    .select({ anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .where(inArray(invoices.status, ["avis_erhalten", "teilweise_bezahlt"]));
  const [falschAbgeschlossen] = await db
    .select({ anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(eq(invoices.status, "abgeschlossen"), ne(invoices.invoiceType, "stornorechnung")));
  const [stornoOffen] = await db
    .select({ anzahl: sql<number>`count(*)::int` })
    .from(invoices)
    .where(and(
      eq(invoices.invoiceType, "stornorechnung"),
      inArray(invoices.status, ["entwurf", "avis_erhalten", "teilweise_bezahlt"]),
    ));

  console.log(`  Zeilen mit Altwert (avis_erhalten/teilweise_bezahlt): ${legacy.anzahl}   [muss 0 sein]`);
  console.log(`  'abgeschlossen' auf Nicht-Storno:                     ${falschAbgeschlossen.anzahl}   [muss 0 sein]`);
  console.log(`  Storno-Dokumente noch nicht abgeschlossen:            ${stornoOffen.anzahl}   [muss 0 sein]`);

  const summe = legacy.anzahl + falschAbgeschlossen.anzahl + stornoOffen.anzahl;
  if (summe > 0) {
    abbruch(`Nachpruefung NICHT bestanden (${summe} Zeilen). Der Lauf ist idempotent — erneut mit --apply fahren.`);
  }
  console.log("\n  Bestanden. Das Status-Modell ist durchgaengig.");
}

export interface MigrationsOptionen {
  apply: boolean;
  /** Verantwortlicher fuer die Audit-Attribution. Pflicht bei `apply`. */
  userId?: number;
  /** Begruendung, landet in jedem Audit-Eintrag. Pflicht bei `apply`. */
  reason?: string;
  /** Fuer Tests: unterdrueckt die Konsolen-Ausgabe. */
  still?: boolean;
}

/**
 * Die eigentliche Migration — ohne Ziel-Gate, ohne `process.exit`.
 * Der CLI-Pfad unten setzt das Gate davor.
 */
export async function migriereStatusModell(opt: MigrationsOptionen): Promise<{ umgestellt: number }> {
  const args = { apply: opt.apply };
  const log = (z: string) => { if (!opt.still) console.log(z); };

  if (args.apply && (opt.userId === undefined || !opt.reason)) {
    abbruch("Schreibender Lauf ohne Verantwortlichen/Begruendung.");
  }
  const verantwortlich = args.apply
    ? { userId: opt.userId!, reason: opt.reason! }
    : null;

  await vorpruefung(log);

  // ── Kandidaten je Abbildung, MIT Nummern und Beträgen. Der Trockenlauf ist
  //    die Grundlage der Freigabe; drei nackte Zahlen tragen keine.
  let gesamt = 0;
  const plaene: Array<{ abb: Abbildung; ids: number[] }> = [];
  for (const abb of ABBILDUNGEN) {
    const zeilen = await db
      .select({
        id: invoices.id,
        nummer: invoices.invoiceNumber,
        status: invoices.status,
        brutto: invoices.grossAmountCents,
      })
      .from(invoices)
      .where(abb.where);
    plaene.push({ abb, ids: zeilen.map(z => z.id) });
    gesamt += zeilen.length;

    const summe = zeilen.reduce((s, z) => s + (z.brutto ?? 0), 0);
    log(`  ${abb.name}: ${zeilen.length} Zeilen, ${euro(summe)}`);

    if (zeilen.length !== abb.erwartet) {
      const laut = abb.erwartet === 0
        ? zeilen.length > 0
        : zeilen.length > abb.erwartet * ABWEICHUNG_LAUT_FAKTOR;
      log(
        laut
          ? `    !! ACHTUNG: erwartet waren ${abb.erwartet}. Das ist keine normale Fortschreibung — vor dem Schreiben klaeren.`
          : `    (Zaehlung vom 17.08. erwartete ${abb.erwartet} — Prod ist weitergelaufen, das ist normal)`,
      );
    }
    if (!args.apply) {
      for (const z of zeilen.slice(0, 10)) {
        log(`      ${z.nummer}  ${z.status} -> ${abb.ziel}  ${euro(z.brutto)}`);
      }
      if (zeilen.length > 10) log(`      … und ${zeilen.length - 10} weitere`);
    }
  }

  log(`\n  Summe: ${gesamt} Zeilen`);

  if (!args.apply) {
    log("\nTrockenlauf beendet. Nichts geschrieben.");
    log("Vor dem schreibenden Lauf: dieses Ergebnis freigeben lassen (Gate 4).");
    return { umgestellt: 0 };
  }

  if (gesamt === 0) {
    log("\nNichts zu tun.");
    return { umgestellt: 0 };
  }

  // ── Schreiben. Ein Audit-Eintrag JE ZEILE, in derselben Transaktion.
  // Was WIRKLICH geschrieben wurde — nicht, was geplant war. Das Abnahme-
  // protokoll dieses Laufs ist ein GoBD-Nachweisstueck; es darf keine Zahl
  // nennen, die nicht stattgefunden hat.
  let tatsaechlich = 0;
  await db.transaction(async tx => {
    for (const { abb, ids } of plaene) {
      if (ids.length === 0) continue;
      const vorher = await tx
        .select({ id: invoices.id, nummer: invoices.invoiceNumber, status: invoices.status })
        .from(invoices)
        .where(and(inArray(invoices.id, ids), abb.where))
        .for("update");

      // COMPARE-AND-SWAP: das WHERE wiederholt die Abbildungs-Bedingung.
      //
      // Die erste Fassung filterte hier nur nach `id` — und der Kandidaten-
      // SELECT lief ausserhalb der Transaktion, ohne Lock. Das ist
      // check-then-write auf Produktivdaten. Bestaetigt in diesen Sekunden
      // jemand einen Qonto-Match, setzt der alte Code die Rechnung auf
      // `bezahlt` mit `paid_at`; die Migration haette sie danach auf
      // `versendet` zurueckgedreht, OHNE `paid_at` zu leeren. Ergebnis: eine
      // bezahlte Rechnung altert wieder, wird gemahnt, und dieselbe Zahlung
      // laesst sich ein zweites Mal zuordnen.
      const geschrieben = await tx
        .update(invoices)
        .set({ status: abb.ziel })
        .where(and(inArray(invoices.id, ids), abb.where))
        .returning({ id: invoices.id });

      // Der Abgleich ist die eigentliche Zusicherung: weicht die Zahl ab, hat
      // sich die Datenlage zwischen Plan und Schreiben veraendert. Dann NICHT
      // weitermachen — die Transaktion rollt zurueck, der Lauf ist idempotent
      // und kann nach dem Klaeren wiederholt werden.
      // Alle DREI Mengen muessen sich decken.
      //
      // Der erste Entwurf verglich nur `geschrieben` gegen `vorher` — und
      // uebersah damit genau das Fenster, fuer das der Abgleich gebaut ist:
      // faellt eine Zeile zwischen PLAN (ausserhalb der Transaktion, ohne
      // Lock) und SPERRE weg, sind `vorher` und `geschrieben` beide kleiner
      // und trotzdem gleich. Der Lauf haette geschwiegen und anschliessend
      // „168 umgestellt" gemeldet, obwohl er weniger geschrieben hat.
      if (ids.length !== vorher.length || geschrieben.length !== vorher.length) {
        throw new Error(
          `${abb.name}: geplant ${ids.length}, gesperrt ${vorher.length}, geschrieben ${geschrieben.length}. ` +
          `Die Datenlage hat sich waehrend des Laufs veraendert — Rollback. ` +
          `Der Lauf ist idempotent: nach dem Klaeren erneut fahren.`,
        );
      }
      tatsaechlich += geschrieben.length;

      for (const z of vorher) {
        await auditService.log(
          verantwortlich!.userId,
          "invoice_status_changed",
          "invoice",
          z.id,
          {
            invoiceNumber: z.nummer,
            previousStatus: z.status,
            newStatus: abb.ziel,
            reason: "status_model_migration",
            operatorReason: verantwortlich!.reason,
            abbildung: abb.name,
            spec: "docs/rechnungsstatus-zielmodell.md",
          },
          undefined,
          tx,
        );
      }
    }
  });

  // Erst NACH dem Commit melden. Die frühere Fassung protokollierte innerhalb
  // der Transaktion — nach einem Rollback log sie die Konsole an.
  for (const { abb, ids } of plaene) {
    if (ids.length > 0) log(`  ${abb.name}: ${ids.length} umgestellt`);
  }
  log(`\n${tatsaechlich} Zeilen umgestellt, ${tatsaechlich} Audit-Eintraege geschrieben.`);
  log("Naechster Schritt: Publish, danach diesen Lauf WIEDERHOLEN (Nachzuegler), dann --verify.");
  return { umgestellt: tatsaechlich };
}

/**
 * CLI-Huelle: Flags lesen, Ziel-/Berechtigungs-Gate setzen, dann die Migration
 * aufrufen. Das Gate liegt AUSSCHLIESSLICH hier — siehe `MigrationsAbbruch`.
 */
async function main(): Promise<void> {
  const args = parseProdWriteArgs();

  if (process.argv.includes("--verify")) {
    await nachpruefung();
    return;
  }

  console.log("Status-Modell-Umstellung");
  console.log(args.apply ? "MODUS: SCHREIBEND (--apply)\n" : "MODUS: Trockenlauf (kein --apply)\n");

  let userId: number | undefined;
  let reason: string | undefined;
  if (args.apply) {
    // ZUERST das Gate: ein falsches Ziel soll auffliegen, bevor irgendetwas
    // gelesen wird.
    const v = await assertProdWriteAllowedOrThrow(
      args,
      "Die Status-Migration schreibt auf Abrechnungsdaten.",
    );
    console.log(`  Verantwortlich: ${v.displayName} (id=${v.userId})`);
    console.log(`  Begruendung:    ${v.reason}\n`);
    userId = v.userId;
    reason = v.reason;
  }

  await migriereStatusModell({ apply: args.apply, userId, reason });
}

// NUR beim direkten Aufruf. Ohne diese Schranke fuehrt schon der `import` in
// einem Test die komplette CLI aus — inklusive `process.exit`.
const direktAufgerufen = process.argv[1]
  ? import.meta.url === new URL(`file://${process.argv[1]}`).href
    || process.argv[1].endsWith("migrate-invoice-status-model.ts")
  : false;

if (direktAufgerufen) {
  main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const nachricht = err instanceof Error ? err.message : String(err);
    console.error(`\nABBRUCH: ${nachricht}`);
    console.error("Es wurde nichts geschrieben.");
    process.exit(1);
  });
}
