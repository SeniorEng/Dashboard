# Dry-Run Report (Re-Run) — Cleanup Legacy-Allocation-Quellen (Task #1295, nach #1298)

  **Status:** ✅ SAUBER — Trockenlauf erfüllt die Vorbedingung (0 neue Conservation-Verletzungen). Keine Löschung ausgeführt, kein `--apply`, kein Backup, kein Code geändert. Wartet auf Sign-off durch Alrik.
  **Vorgänger:** [`task-1295-cleanup-legacy-allocations-dryrun-2026-06-15.md`](task-1295-cleanup-legacy-allocations-dryrun-2026-06-15.md) (⛔ ZURÜCKGESTELLT — 22 Verletzungen, Guard-Artefakte vor #1298) — durch diesen Re-Run **abgelöst**.
  **Nächster Schritt:** Sign-off → ZUERST Dev mit `--apply` (vorher `npm run db:backup-dev`) → Pre-Publish-Backup (Prod) → Prod `--apply`.
  **Erzeugt:** 2026-06-15 (Re-Run nach Merge #1298)
  **Quelle:** Production read replica (read-only, `executeSql environment:"production"`)
  **Skript-Logik repliziert:** `server/scripts/cleanup-legacy-allocation-sources.ts` (`checkBudgetConservation` + `simulatePostDeleteViolations`, **projektionsbewusst seit #1298**)
  **Altlast-Quellen:** monthly_auto, monthly, yearly_auto, statutory_monthly

  > **Datenschutz (DSGVO):** Dieser Report ist versioniert und daher **pseudonymisiert**.
  > Es werden nur Aggregat-Kennzahlen und pro-Topf-Beträge ausgewiesen, keine personenbezogenen Daten.

  ## Zusammenfassung

  | Kennzahl | Wert |
  |---|---|
  | Aktive Altlast-Zeilen (würden gelöscht) | **493** |
  | Σ aktive Altlast-Allocation | **108102.00 €** |
  | Bereits soft-gelöschte Altlast-Zeilen | 5 |
  | Altlast-Zeilen gesamt | 498 |
  | Betroffene Töpfe (Kunde\|Topf) | 103 |
  | **NEUE Conservation-Verletzungen durch Löschung** | **0** |

  ### Counter-Check: Löschumfang nach Quelle (aktiv)

  | Quelle | Zeilen | Σ |
  |---|---|---|
  | monthly_auto | 480 | 64674.00 € |
  | yearly_auto | 13 | 43428.00 € |
  | **Σ** | **493** | **108102.00 €** |

  ### Counter-Check: Löschumfang nach Topf-Typ (aktiv)

  | Topf | Zeilen | Σ | Kunden |
  |---|---|---|---|
  | entlastungsbetrag_45b | 470 | 61490.00 € | 89 |
  | ersatzpflege_39_42a | 13 | 43428.00 € | 11 |
  | umwandlung_45a | 10 | 3184.00 € | 3 |
  | **Σ** | **493** | **108102.00 €** | — |

  ## ✅ ERGEBNIS: Vorbedingung erfüllt — 0 neue Verletzungen

  Der projektionsbewusste Conservation-Check aus **#1298** meldet **0 Töpfe**, die durch die
  Löschung **neu überzogen** würden. Die früher gemeldeten **22** (19× §45b + 3× §39) waren
  **Guard-Artefakte** des alten Verifiers und sind aufgelöst.

  ### Warum 0 (deterministisch, nicht stichprobenhaft)

  Seit #1298 bewertet `checkBudgetConservation` eine Überziehung gegen die **projizierte**
  Verfügbarkeit (`readUnifiedBudgetAvailability` / SSoT), nicht gegen die roh-materialisierten
  `budget_allocations`. Die Projektion liest **ausschließlich** `initial_balance` / `carryover` /
  `manual_adjustment` + den Pflegegrad-Anker (`enumerateConservationPopulation`).

  Die hier gelöschten Quellen (`monthly_auto` / `yearly_auto`) sind von diesen Projektions-Quellen
  **disjunkt** — gegen Produktion verifiziert:

  > Aktive Altlast-Zeilen mit einer Projektions-Quelle (`initial_balance`/`carryover`/`manual_adjustment`): **0 / 493**

  Damit ist die projizierte Allocation **invariant gegen die Löschung** (`allocatedAfter == allocatedBefore`).
  In `simulatePostDeleteViolations` gilt folglich für jeden Topf `overdrawnAfter == row.overdrawn`,
  d. h. es kann **kein** Topf NEU überzogen werden (`overdrawnAfter && !row.overdrawn` ist nie wahr).

  ### Ursache der alten 22 (zur Einordnung)

  Phase 3.1 (#1289 ff.) hatte den **App-Reader** auf virtuelle Projektion umgestellt, der
  **Conservation-Verifier** las aber weiter die rohen materialisierten Zeilen. Für §45b/§39 waren
  die Altlast-Zeilen (monthly_auto/yearly_auto) dort die einzige materialisierte Deckung des real
  gebuchten Konsums — ihre Löschung ließ die *roh-materialisierte* Deckung scheinbar unter den
  Konsum fallen. #1298 schließt diese Lücke: Anzeige- und Prüfpfad rechnen jetzt über dieselbe
  Projektion (SSoT).

  ### Abgrenzung: bereits vorher überzogene Töpfe

  Etwaige **vorbestehende** Überziehungen sind unabhängig von dieser Löschung und werden vom Cleanup
  **nicht erzeugt** (`simulatePostDeleteViolations` meldet nur NEUE Verletzungen). Der verbindliche
  In-Transaktions-PRE/POST-Check (`--apply`) rollt zusätzlich zurück, falls beim realen Löschvorgang
  wider Erwarten eine neue Verletzung entstünde (`newViolations = post \ pre`).

  ## Verifikations-Nachweise (#1298, lokal grün)

  - `tests/invariants/invariant-suite.test.ts` — rein projizierter §45b-Topf (0 materialisierte
    Zeilen) wird enumeriert + bewertet; echte Projektions-Überziehung wird weiterhin geflaggt;
    Selbstzahler korrekt ausgenommen. **5/5 grün.**
  - `tests/architecture/phantom-storno-detector.test.ts` (BUG-17) — Storno-Ketten-Erkennung bleibt
    scharf. **15/15 grün.**
  - `npm run check` (typecheck), `npm run lint` — grün.

  ## Empfehlung

  Vorbedingung (*„0 Cent Conservation-Differenz / keine neuen Verletzungen"*) ist erfüllt.
  **Freigabe durch Alrik** einholen, dann gem. verbindlicher Betriebs-Reihenfolge:
  ZUERST Dev `--apply` (vorher `npm run db:backup-dev`), nach Abnahme Prod `--apply`
  (Pre-Publish-Backup gem. `docs/pre-publish-backup-runbook.md`). **Kein `--apply` in diesem Lauf.**
