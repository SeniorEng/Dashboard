# Dry-Run Report — Cleanup Legacy-Allocation-Quellen (Task #1295)

  > **⚠️ ARCHIVIERT / ABGELÖST:** Dieser Lauf entstand VOR #1298. Die hier gemeldeten 22 neuen
  > Verletzungen waren **Guard-Artefakte** des alten, nicht-projektionsbewussten Verifiers.
  > Maßgeblich ist der Re-Run nach #1298:
  > [`task-1295-cleanup-legacy-allocations-dryrun-rerun-2026-06-15.md`](task-1295-cleanup-legacy-allocations-dryrun-rerun-2026-06-15.md)
  > (Ergebnis: **0 neue Verletzungen**, Vorbedingung erfüllt).

  **Status:** ⛔ ZURÜCKGESTELLT (DEFERRED) — Trockenlauf NICHT sauber, keine Löschung ausgeführt, kein `--apply`, kein Backup, kein Code geändert. **→ Abgelöst durch den #1298-Re-Run (s. o.).**
  **Nächster Schritt:** Folgeaufgabe #1298 (Conservation-Check projektionsfähig machen), danach Dry-Run wiederholen → Sign-off → Pre-Publish-Backup → `--apply`. **(#1298 gemerged, Re-Run erfolgt.)**
  **Erzeugt:** 2026-06-15T12:03:54.056Z
  **Quelle:** Production read replica (read-only, `executeSql environment:"production"`)
  **Skript-Logik repliziert:** `server/scripts/cleanup-legacy-allocation-sources.ts` (`checkBudgetConservation` + `simulatePostDeleteViolations`)
  **Altlast-Quellen:** monthly_auto, monthly, yearly_auto, statutory_monthly

  > **Datenschutz (DSGVO):** Dieser Report ist versioniert und daher **pseudonymisiert**.
  > Kundennamen sind entfernt, Kunden-IDs durch laufende Tokens (`K01…`, `P01…`) ersetzt.
  > Die Zuordnung Token → echte Kunden-ID liegt NICHT im Repository, sondern nur im
  > Roh-Dry-Run-Lauf (kontrollierter Zugriff). Es werden nur Aggregat-Kennzahlen und
  > pro-Topf-Beträge ausgewiesen, keine personenbezogenen Daten.

  ## Zusammenfassung

  | Kennzahl | Wert |
  |---|---|
  | Aktive Altlast-Zeilen | 493 |
  | Σ aktive Altlast-Allocation | 108102.00 € |
  | Betroffene Töpfe (Kunde\|Topf) | 103 |
  | Bereits überzogene Töpfe (vorher) | 4 |
  | **NEUE Conservation-Verletzungen durch Löschung** | **22** |
  | Altlast-Töpfe ohne Konsum (safe) | 19 |

  ## ⚠️ ERGEBNIS: Vorbedingung NICHT erfüllt

  Die Aufgabe erwartet *„0 Cent Conservation-Differenz / keine neuen Verletzungen"*.
  Der Trockenlauf gegen Produktion zeigt **22 Töpfe**, die durch die
  Löschung **neu überzogen** würden. Das `--apply` würde im Skript selbst abbrechen
  (`simulatePostDeleteViolations` > 0 ⇒ ABBRUCH).

  ### Ursache (fachlich)
  Phase 3.1 hat den **App-Reader** umgestellt (§45b/§45a/§39 werden virtuell projiziert,
  `calculateAllocated45b` etc.). Der **Conservation-Verifier** `checkBudgetConservation`
  liest jedoch weiterhin die **rohen materialisierten** `budget_allocations`. Für §45b/§39
  sind diese Altlast-Zeilen (monthly_auto/yearly_auto) aktuell die einzige bzw. wesentliche
  materialisierte Deckung des real gebuchten Konsums. Sie *„tragen aktiv Konsum"* im Sinne
  der No-Overdraw-Invariante — exakt der Fall, vor dem das Skript warnt
  (*„NICHT löschen, bevor das fachlich geklärt ist"*).

  ### Neu überzogene Töpfe (22) — pseudonymisiert

  | Kunde (Token) | Topf | allocated vorher | allocated nachher | netKonsum |
  |---|---|---|---|---|
  | K01 | entlastungsbetrag_45b | 1130.50 € | 344.50 € | 667.75 € |
  | K02 | entlastungsbetrag_45b | 1048.00 € | 131.00 € | 255.97 € |
  | K03 | entlastungsbetrag_45b | 1111.75 € | 325.75 € | 599.08 € |
  | K04 | ersatzpflege_39_42a | 3539.00 € | 0.00 € | 165.43 € |
  | K04 | entlastungsbetrag_45b | 1566.00 € | 780.00 € | 1387.95 € |
  | K05 | entlastungsbetrag_45b | 786.00 € | 0.00 € | 632.75 € |
  | K06 | entlastungsbetrag_45b | 1113.50 € | 327.50 € | 737.87 € |
  | K07 | entlastungsbetrag_45b | 1101.90 € | 315.90 € | 365.21 € |
  | K08 | entlastungsbetrag_45b | 786.00 € | 0.00 € | 93.70 € |
  | K08 | ersatzpflege_39_42a | 3539.00 € | 0.00 € | 1281.36 € |
  | K09 | entlastungsbetrag_45b | 1640.64 € | 854.64 € | 998.92 € |
  | K10 | entlastungsbetrag_45b | 1060.52 € | 274.52 € | 483.36 € |
  | K11 | entlastungsbetrag_45b | 1828.95 € | 1042.95 € | 1148.00 € |
  | K12 | entlastungsbetrag_45b | 1099.92 € | 313.92 € | 399.28 € |
  | K13 | entlastungsbetrag_45b | 1179.00 € | 393.00 € | 1020.37 € |
  | K14 | ersatzpflege_39_42a | 960.00 € | 0.00 € | 674.63 € |
  | K15 | entlastungsbetrag_45b | 1179.00 € | 393.00 € | 699.63 € |
  | K16 | entlastungsbetrag_45b | 786.00 € | 0.00 € | 130.38 € |
  | K17 | entlastungsbetrag_45b | 524.00 € | 0.00 € | 422.62 € |
  | K18 | entlastungsbetrag_45b | 524.00 € | 0.00 € | 181.24 € |
  | K19 | entlastungsbetrag_45b | 524.00 € | 0.00 € | 134.23 € |
  | K20 | entlastungsbetrag_45b | 262.00 € | 131.00 € | 187.74 € |

  ### Verteilung der neuen Verletzungen nach Topf-Typ
  - ersatzpflege_39_42a: 3
  - entlastungsbetrag_45b: 19

  ### Bereits vorher überzogene Töpfe (unabhängig von der Löschung) — pseudonymisiert
  - P01 | entlastungsbetrag_45b: allocated 262.00 €, netKonsum 302.50 €
  - P02 | entlastungsbetrag_45b: allocated 51.00 €, netKonsum 432.42 €
  - P03 | entlastungsbetrag_45b: allocated 131.00 €, netKonsum 165.46 €
  - P04 | entlastungsbetrag_45b: allocated 0.00 €, netKonsum 77.93 €

  ## Empfehlung
  **Cleanup NICHT mit `--apply` ausführen.** Vor einer Löschung muss fachlich/architektonisch
  geklärt werden, wie die No-Overdraw-Invariante für die virtuell projizierten Töpfe
  (§45b/§45a/§39) ohne die materialisierten Altlast-Zeilen abgesichert wird (z. B.
  `checkBudgetConservation` um die Projektion erweitern, oder nur Töpfe ohne Konsum löschen).
  Sign-off durch Alrik erforderlich. Umsetzung der Vorbedingung: Folgeaufgabe **#1298**.
