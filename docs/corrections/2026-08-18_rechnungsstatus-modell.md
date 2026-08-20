# Rechnungsstatus-Modell — Umstellung der Altwerte (Einmal-Lauf)

- **Datum der Korrektur:** 18.08.2026
- **Task:** #1886 / 6hHqw8c7 · Spezifikation `docs/rechnungsstatus-zielmodell.md`, Abschnitt 5
- **Skript (gelöscht nach Anwendung):** `server/scripts/migrate-invoice-status-model.ts`,
  eingeführt in `10db8bf8` (18.08.2026), gemerged über PR #108
- **Zählung, die die Grundlage bestätigte:** `scripts/rechnungsstatus/zaehlung.sql`

## Problem

Das Statusmodell wurde auf fünf Werte verengt (vier für Rechnungen, ein
eigener für Storno-Dokumente). Zwei Altwerte (`avis_erhalten`,
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

**168 Zeilen** der Tabelle `invoices` wurden umgestellt:

| Abbildung | Zeilen |
|---|---|
| `avis_erhalten` → `versendet` | 54 |
| `teilweise_bezahlt` → `versendet` | 0 |
| `stornorechnung/*` → `abgeschlossen` | **114** |
| **Summe** | **168** |

Die 114 Storno-Dokumente sind der größere Teil und gehören ausdrücklich in
diesen Nachweis — eine frühere Fassung dieses Protokolls nannte nur die 54
Altwert-Zeilen und wies damit zwei Drittel der GoBD-relevanten
Statusänderungen nicht aus.

Nach dem Lauf: Verify meldete **0/0/0** — keine Altwerte, keine unbekannten
Werte, keine Zeile ohne Zuordnung. Die Abrechnung war anschließend live und
bedienbar.

## Audit-Referenz

Jede Umstellung schrieb einen Audit-Eintrag; suchbar über `invoices.status`
in Verbindung mit dem Lauf-Zeitpunkt (18.08.2026). Der vollständige Nachweis
ist git-Historie (`10db8bf8`, PR #108) + DB-Audit-Log + dieses Protokoll.

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
Skript entfallen: sechs ihrer sieben Fälle prüften die Migrationsfunktion
selbst und sind mit ihr gegenstandslos. Die eine dauerhaft gültige Aussage —
`abgeschlossen` auf einer normalen Rechnung muss werfen — ist in
`tests/architecture/billing-pipeline-stage-identity.test.ts` abgedeckt.
Die davon getrennte Frage „kann der Code jeden Wert in `invoices.status`
lesen?" beantwortet `tests/unit/release-verify-status-domain.test.ts`.
