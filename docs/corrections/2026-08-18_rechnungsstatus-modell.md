# Rechnungsstatus-Modell — Umstellung der Altwerte (Einmal-Lauf)

- **Datum der Korrektur:** 18.08.2026
- **Task:** #1886 / 6hHqw8c7 · Spezifikation `docs/rechnungsstatus-zielmodell.md`, Abschnitt 5
- **Skript (gelöscht nach Anwendung):** `server/scripts/migrate-invoice-status-model.ts`,
  eingeführt in `10db8bf8` (18.08.2026), gemerged über PR #108
- **Zählung, die die Grundlage bestätigte:** `scripts/rechnungsstatus/zaehlung.sql`

## Problem

Das Statusmodell wurde auf sechs Werte verengt. Zwei Altwerte (`avis_erhalten`,
`teilweise_bezahlt`) und die Storno-Dokument-Zustände kannte der neue Code nicht
mehr — `parseInvoiceStatus` wirft bei ihnen, und der Wurf reißt nicht die
einzelne Zeile mit, sondern den ganzen Lesepfad: `GET /api/billing` und das
Cockpit-Board antworten mit 500.

## Maßnahme

Drei Abbildungen, mehr nicht:

| von | nach |
|---|---|
| `avis_erhalten` | `versendet` |
| `teilweise_bezahlt` | `versendet` |
| `stornorechnung/*` (außer `storniert`) | `abgeschlossen` |

Beträge, Belege, `sent_at` und `paid_at` blieben unangetastet — geschrieben
wurde ausschließlich die Spalte `status`, per Compare-and-swap
(`WHERE status IN (…)` + `returning()`-Längenprüfung), damit ein paralleler
Schreiber nicht überfahren wird.

## Vorher / Nachher

54 Zeilen trugen einen Altwert. Nach dem Lauf: Verify meldete **0/0/0** —
keine Altwerte, keine unbekannten Werte, keine Zeile ohne Zuordnung. Die
Abrechnung war anschließend live und bedienbar.

## Was daraus gebaut wurde

Der Vorfall am selben Tag — der Publish lief **28 Minuten vor** dieser
Migration, die Abrechnung war rund eine Stunde nicht bedienbar — ist der Grund
für den gatenden Release-Step (`scripts/migrate.sh`, Schritte 0a–2, PR #115).
Die Prüfung „kann der auszuliefernde Code den vorhandenen Datenstand lesen?"
steht seitdem als `scripts/release-verify.ts` im Deploy-Pfad und ist an
dieselbe SSoT `parseInvoiceStatus` gebunden.

## Nachweis

git-Historie (`10db8bf8`, PR #108) · DB-Audit-Log · dieses Protokoll.
Die begleitende Testdatei `tests/billing/status-migration.test.ts` ist mit dem
Skript entfallen: sie prüfte die Idempotenz eines Laufs, den es nicht mehr gibt.
Die dauerhaft gültige Aussage — der Code muss jeden Wert in `invoices.status`
lesen können — lebt in `tests/unit/release-verify-status-domain.test.ts` weiter.
