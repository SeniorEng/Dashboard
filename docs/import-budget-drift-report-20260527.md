# Budget-Ledger-Drift nach Excel-Import — Diagnose-Report

- **Stand:** 27.05.2026
- **Datenquelle:** Produktion (READ-ONLY-Replica)
- **Scope:** Nur Lesezugriff. KEINE Fixes, KEINE DB-Writes, KEINE Code-Änderungen.
- **Auftraggeber:** Task #697
- **Cross-Reference:** Task #696 (§45b "Gesamt zugewiesen 131 € zu hoch")

## 0. Zusammenfassung

| Kennzahl | Wert |
|---|---|
| Aktive Kunden mit Budget-Daten | ~150 |
| Budget-Transaktionen gesamt | 623 |
| Davon `consumption` | 512 |
| Davon `reversal` | 111 |
| Phantom-Stornos (Reversal ohne saubere Origin/Termin-Bindung) | **84 (25 Kunden, 4.434,18 €)** |
| Persistierte §45b-`monthly_auto`-Allokationen (sollten virtuell sein) | **470 Zeilen (89 Kunden, 61.490,00 €)** |
| Aktive Termine an gleichem Tag (Doppel-Konsum-Verdacht) | **14 Kunden, 18 Tage** |
| Termine mit Ledger-Minuten ≠ Service-Soll-Minuten | **25+ Termine, 12 Kunden** |
| Termine mit netto > 0 € obwohl `cancelled` / soft-deleted | 0 (keine Drift in diesem Kanal) |

**Root-Cause-Vermutung (sortiert nach € Auswirkung):**

1. **§45b `monthly_auto` wurde in die DB materialisiert** (61.490 € Phantom-Allocation, 89 Kunden). Erste Charge am 23.02.2026 11:35 UTC für 89 Kunden in einer Sekunde — sieht nach einem Backfill/Migration-Skript aus, das gegen das in `allocation-storage.ts` dokumentierte Virtual-Renewal-Modell verstößt. Das ist die wahrscheinliche Wurzel von Task #696.
2. **Import legt Duplikat-Termine an statt zu updaten**, wenn `scheduled_start` zwischen Excel und Bestand differiert (14 Kunden betroffen). Daraus entsteht Doppel-Konsum — sichtbar als doppelte Ledger-Minuten gegenüber `appointment_services` (Kunde 95: 6 Termine mit Faktor 2).
3. **Phantom-Stornos** aus dem KM-Rebook-Pfad: Reversal-Zeile zeigt auf eine Original-Tx, deren `appointment_id` aber NULL ist oder deren Termin soft-deleted wurde. Vermutlich legitime „Termin-Edit"-Reversals, aber 16 davon sind echte Orphans (`reversed_transaction_id` zeigt ins Leere).

## 1. Phantom-Stornos

**Definition:** Reversal-Transaktion erfüllt mindestens eine der folgenden Bedingungen:
- `reversed_transaction_id` zeigt auf eine nicht (mehr) existierende Transaktion (`orphan_no_original`)
- Die referenzierte Original-Tx hat selbst keine Termin-Bindung (`no_appt`)
- Termin existiert, ist aber soft-deleted (`soft_deleted_appt`)
- Die gleiche Original-Tx wurde mehrfach storniert (`double_storno`)

**Aggregat (Top 25 von 25 Kunden, Beträge in Cent):**

| customer_id | Name | reversal_count | total_cents | orphan_no_original | double_storno | soft_deleted_appt | no_appt |
|---|---|---:|---:|---:|---:|---:|---:|
| 95 | Kunde #95 | 14 | 75.994 | 12 | 0 | 0 | 2 |
| 39 | Kunde #39 | 12 | 46.899 | 1 | 0 | 2 | 9 |
| 54 | Kunde #54 | 6 | 44.195 | 0 | 0 | 0 | 6 |
| 77 | Kunde #77 | 8 | 26.131 | 3 | 0 | 0 | 5 |
| 72 | Kunde #72 | 6 | 25.425 | 4 | 0 | 6 | 0 |
| 92 | Kunde #92 | 4 | 22.294 | 2 | 0 | 0 | 2 |
| 57 | Kunde #57 | 5 | 19.420 | 0 | 0 | 0 | 5 |
| 63 | Kunde #63 | 4 | 17.861 | 0 | 0 | 2 | 2 |
| 66 | Kunde #66 | 2 | 16.040 | 0 | 0 | 0 | 2 |
| 153 | Kunde #153 | 1 | 12.675 | 0 | 0 | 1 | 0 |
| 76 | Kunde #76 | 2 | 12.608 | 1 | 0 | 0 | 1 |
| 52 | Kunde #52 | 1 | 12.590 | 1 | 0 | 0 | 0 |
| 58 | Kunde #58 | 3 | 12.262 | 2 | 0 | 0 | 1 |
| 81 | Kunde #81 | 2 | 12.083 | 0 | 0 | 0 | 2 |
| 75 | Kunde #75 | 2 | 12.041 | 0 | 0 | 0 | 2 |
| 55 | Kunde #55 | 2 | 11.845 | 0 | 0 | 0 | 2 |
| 78 | Kunde #78 | 1 | 8.323 | 0 | 0 | 0 | 1 |
| 53 | Walter Hofmann | 1 | 8.276 | 0 | 0 | 0 | 1 |
| 60 | (Kunde 60) | 1 | 8.189 | 0 | 0 | 1 | 0 |
| 106 | (Kunde 106) | 1 | 8.160 | 1 | 0 | 0 | 0 |
| 69 | (Kunde 69) | 2 | 7.708 | 0 | 0 | 0 | 2 |
| 136 | (Kunde 136) | 1 | 6.864 | 1 | 0 | 0 | 0 |
| 91 | (Kunde 91) | 1 | 5.949 | 0 | 0 | 0 | 1 |
| 83 | (Kunde 83) | 1 | 5.795 | 0 | 0 | 0 | 1 |
| 82 | (Kunde 82) | 1 | 3.791 | 0 | 0 | 0 | 1 |

**Phantom-Storno Transaktions-IDs je Kunde (alle 25 betroffenen Kunden, 84 Tx-IDs gesamt):**

| customer_id | Name | reversal_tx_ids | total_cents |
|---:|---|---|---:|
| 95 | Kunde #95 | 59, 88, 401, 403, 405, 407, 409, 411, 418, 419, 420, 421, 713, 744 | 75.994 |
| 39 | Kunde #39 | 115, 691, 693, 695, 699, 752, 770, 780, 874, 876, 878, 879 | 46.899 |
| 54 | Kunde #54 | 711, 715, 732, 733, 738, 742 | 44.195 |
| 77 | Kunde #77 | 370, 372, 374, 764, 768, 774, 776, 782 | 26.131 |
| 72 | Kunde #72 | 110, 111, 112, 113, 456, 457 | 25.425 |
| 92 | Kunde #92 | 34, 40, 703, 726 | 22.294 |
| 57 | Kunde #57 | 701, 766, 772, 778, 784 | 19.420 |
| 63 | Kunde #63 | 454, 455, 750, 786 | 17.861 |
| 66 | Kunde #66 | 709, 754 | 16.040 |
| 153 | Kunde #153 | 497 | 12.675 |
| 76 | Kunde #76 | 61, 697 | 12.608 |
| 52 | Kunde #52 | 109 | 12.590 |
| 58 | Kunde #58 | 30, 31, 730 | 12.262 |
| 81 | Kunde #81 | 728, 756 | 12.083 |
| 75 | Kunde #75 | 736, 758 | 12.041 |
| 55 | Kunde #55 | 740, 760 | 11.845 |
| 78 | Kunde #78 | 707 | 8.323 |
| 53 | Kunde #53 | 762 | 8.276 |
| 60 | Kunde #60 | 519 | 8.189 |
| 106 | Kunde #106 | 391 | 8.160 |
| 69 | Kunde #69 | 718, 746 | 7.708 |
| 136 | Kunde #136 | 417 | 6.864 |
| 91 | Kunde #91 | 748 | 5.949 |
| 83 | Kunde #83 | 722 | 5.795 |
| 82 | Kunde #82 | 720 | 3.791 |

**Notes-Pattern-Analyse (Top 20 Notes):**
- Mehrheit: `Storno von Transaktion #N` — klassische Reversal-Notes aus `transaction-storage.ts`.
- Auffällig: `Storno (Termin-Edit) von Transaktion #N` — kommt aus `server/storage/budget/km-rebook.ts` (KM-Rebook setzt bewusst `appointmentId: null` auf der Reversal-Zeile). Diese Reversals sind **by design ohne Termin-Bindung** und matchen die `no_appt`-Spalte oben. Sie sind nicht „phantom" im Sinne von „Fehler", aber im Aggregat zählen sie mit.
- `Storno von Transaktion #101 (Umbuchung)` — Hinweis auf Rebook-Pfad in `budget-storage` / `rebook-storage`.
- Mehrfach gleiche Note (`Storno von Transaktion #107` = 3, `#106` = 3) → Hinweis auf wiederholte Reversal-Erzeugung gegen dieselbe Original-Tx.

**Beobachtungen:**
- 16 Reversals (Spalte `orphan_no_original`) zeigen auf eine `reversed_transaction_id`, die im Replica nicht existiert. Das ist ein echter Foreign-Key-Drift und nicht durch `km-rebook` erklärbar.
- Kunde #95 hat alleine 12 Orphan-Reversals — das ist das größte Einzelproblem dieser Kategorie.
- `double_storno` ist überall 0 → keine doppelte Reversal-Erzeugung gegen dieselbe Quell-Tx.

## 2. Doppel-Konsum am selben Slot

**Definition (strikt, identischer Startzeitpunkt):** Aktive Termine (`deleted_at IS NULL`, `status <> 'cancelled'`, `appointment_type='Kundentermin'`) mit identischem `(customer_id, date, scheduled_start)`.

**Ergebnis strikt:** **0 Treffer.** Es gibt aktuell keinen Kunden mit zwei aktiven Terminen am exakt gleichen Slot.

**Definition (gelockert, gleicher Tag, beliebiger Start):** Zwei oder mehr aktive Termine am selben Tag → Verdacht auf Import-Duplikat, wenn die Termine inhaltlich (Dauer / KM) ähnlich sind.

| customer_id | Name | tage_mit_mehrfachterminen | termine_gesamt | Beispiele |
|---|---|---:|---:|---|
| 77 | Kunde #77 | 5 | 10 | 08.01.: #114 (10:00, 30 min, 8,5 km) + #115 (10:30, 60 min, 0 km); 13.01.: #116/#117; 22.01.: #119/#120; 29.01.: #121/#122; 09.03.: #270/#271 |
| 117 | (Kunde 117) | 2 | 4 | 10.04.: #230 (09:45) + #719 (11:15); 15.04.: #655 + #744 |
| 108 | (Kunde 108) | 2 | 4 | 11.02.: #165 (07:30, 90 min) + #166 (13:15, 120 min); 18.02.: #167 (13:00, 240 min) + #941 (16:00, 60 min) |
| 57 | Kunde #57 | 1 | 2 | 10.02.: #195 (15:30) + #525 (16:00) — beide 60 min, 2,0 km — sehr verdächtig identisch |
| 76 | Kunde #76 | 1 | 2 | 11.02.: #139 (09:00) + #513 (09:30) — beide 90 min, 17,0 km — verdächtig identisch |
| 78 | Kunde #78 | 1 | 2 | 11.05.: #896 (08:00, 45 min) + #1284 (11:00, 120 min) |
| 91 | (Kunde 91) | 1 | 2 | 21.01.: #90 + #91 |
| 95 | Kunde #95 | 1 | 2 | 20.02.: #154 (14:45, 60 min, 21,8 km) + #515 (13:45, 60 min, 21,8 km) — verdächtig identisch |
| 138 | (Kunde 138) | 1 | 2 | 15.04.: #232 + #741 |
| 39 | Kunde #39 | 1 | 2 | 18.03.: #303 (14:15) + #304 (15:30) |
| 163 | (Kunde 163) | 1 | 2 | 27.04.: #689 + #690 |
| 53 | Walter Hofmann | 1 | 2 | 17.03.: #306 (13:30) + #307 (14:00) |
| 54 | Kunde #54 | 1 | 2 | 16.02.: #144 (10:30, 165 min) + #514 (12:45, 30 min) |

**Klassifikation:**
- **Sehr wahrscheinlich Import-Duplikate** (gleiche Dauer + KM, IDs weit auseinander → einer war Bestand, einer kam neu): Kunden 57 (#195/#525), 76 (#139/#513), 95 (#154/#515).
- **Wahrscheinlich Import-Update-Fehler** (großer ID-Sprung): #719, #744, #741, #941, #1284, #515 etc. → Termine, die nach dem Erstanlegen via Import als neue Zeile erschienen, statt einen bestehenden Termin zu updaten.
- **Plausibel echt** (verschiedene Slots, verschiedene Dauern, kleine ID-Differenz): #114/#115, #116/#117, #270/#271, #303/#304.

Die Heuristik im Import-Pfad (`server/services/appointment-import.ts` → `findMatchKey`) verwendet `(customer_id, date, scheduled_start)` als Dedup-Key. Sobald die Excel-Quelle eine andere Startzeit liefert als der bestehende Termin im DB, wird KEIN Update erkannt und ein neuer Termin angelegt.

## 3. Ledger-vs-Termin-Drift

**Definition:** Pro Termin-ID summierte Netto-Werte aus `budget_transactions` (consumption − reversal) vs. Termin-Status / `appointment_services`-Summe.

| customer_id | Name | soft_del_mit_netto | cancelled_mit_netto | missing_appt | minuten_drift |
|---|---|---:|---:|---:|---:|
| 95 | Kunde #95 | 0 | 0 | 0 | **6** |
| 77 | Kunde #77 | 0 | 0 | 0 | 3 |
| 53 | Walter Hofmann | 0 | 0 | 0 | 2 |
| 175 | (Kunde 175) | 0 | 0 | 0 | 2 |
| 73 | (Kunde 73) | 0 | 0 | 0 | 1 |
| 75 | Kunde #75 | 0 | 0 | 0 | 1 |
| 91 | (Kunde 91) | 0 | 0 | 0 | 1 |
| 92 | Kunde #92 | 0 | 0 | 0 | 1 |
| 94 | (Kunde 94) | 0 | 0 | 0 | 1 |
| 108 | (Kunde 108) | 0 | 0 | 0 | 1 |
| 119 | (Kunde 119) | 0 | 0 | 0 | 1 |
| 130 | (Kunde 130) | 0 | 0 | 0 | 1 |

**Wichtige Negativ-Befunde:**
- `soft_del_mit_netto`, `cancelled_mit_netto`, `missing_appt` sind **überall 0**. Heißt: Es gibt keinen Kunden, bei dem ein soft-gelöschter oder stornierter Termin noch netto Budget verbraucht — der Reversal-/Soft-Delete-Pfad ist sauber.

**Minuten-Drift-Beispiele:**

| customer_id | appointment_id | date | start | ledger_min | svc_min | duration_promised | Befund |
|---|---:|---|---|---:|---:|---:|---|
| 95 | 515 | 2026-02-20 | 13:45 | 120 | 60 | 60 | Ledger doppelt — passt zu Doppel-Konsum 95@20.02. |
| 95 | 154 | 2026-02-20 | 14:45 | 120 | 60 | 60 | Ledger doppelt |
| 95 | 182 | 2026-03-02 | 13:15 | 180 | 90 | 90 | Ledger doppelt |
| 95 | 302 | 2026-03-17 | 14:00 | 180 | 90 | 120 | Ledger doppelt |
| 95 | 255 | 2026-03-23 | 13:15 | 180 | 90 | 90 | Ledger doppelt |
| 95 | 269 | 2026-03-30 | 13:15 | 180 | 90 | 90 | Ledger doppelt |
| 77 | 270 | 2026-03-09 | 08:45 | 120 | 60 | 60 | Ledger doppelt — passt zu Doppel-Konsum 77@09.03. |
| 77 | 271 | 2026-03-09 | 15:30 | 60 | 30 | 30 | Ledger doppelt |
| 77 | 272 | 2026-03-12 | 14:30 | 90 | 45 | 60 | Faktor 2 |
| 53 | 256 | 2026-03-23 | 11:00 | 120 | 60 | 120 | Ledger doppelt |
| 53 | 1298 | 2026-04-29 | 14:00 | 120 | 135 | 120 | Untererfassung |
| 73 | 755 | 2026-04-28 | 11:30 | 105 | 75 | 75 | Übererfassung |
| 119 | 179 | 2026-03-05 | 16:00 | 0 | 60 | 60 | Ledger leer (Konsum komplett storniert?) |
| 175 | 970 | 2026-04-30 | 15:00 | 90 | 135 | 90 | Untererfassung |
| 175 | 988 | 2026-05-05 | 11:45 | 90 | 120 | 105 | Untererfassung |

**Klares Muster bei Kunde 95 (6×) und Kunde 77 (3×):** Ledger-Minuten = exakt 2 × Service-Minuten. Hinweis auf doppelte Buchung beim Import (Konsum wurde zweimal eingespielt, einmal beim Anlegen des Termins, einmal beim „Update").

## 4. §45b-Allocation-Anomalien (Cross-Check zu Task #696)

**Erwartung laut Code** (`server/storage/budget/allocation-storage.ts` + `summary-queries.ts`): Für `entlastungsbetrag_45b` existieren in `budget_allocations` ausschließlich Zeilen mit
- `source = 'initial_balance'` (Startwert laufendes Jahr, max. 1 aktive Zeile)
- `source = 'carryover'` (Restguthaben aus Vorjahr, max. 1 aktive Zeile pro Quelljahr)
- `source = 'manual_adjustment'` (Korrekturen)

Monatliche Aufstockungen sind **virtuell** und werden in `calculateAllocated45b` zur Laufzeit gerechnet (Variante A mit `monthly_limit_cents`).

**Beobachtung Produktion:**

| Kennzahl | Wert |
|---|---:|
| Kunden mit `monthly` / `monthly_auto`-Allocation in §45b | **89** |
| `monthly` / `monthly_auto`-Zeilen gesamt | **470** |
| Summe persistierte `monthly` / `monthly_auto`-Cents | **6.149.000 (61.490 €)** |
| Erste Erzeugung | 2026-02-23 11:35:19 UTC |
| Letzte Erzeugung | 2026-04-02 07:58:00 UTC |

Pro betroffenem Kunden: meist 6 Zeilen × 13.100 Cent (= 786 €) für Januar–Juni 2026; einzelne Kunden auch 7 Zeilen (z.B. ID 149 mit 91.700 Cent = 917 €, inkl. Dezember 2025).

**Auszug betroffene Kunden (Top 25 von 89, alle Beträge in Cent):**

| customer_id | Name | initial_balance | carryover | persisted_monthly | initial_rows | carryover_rows |
|---|---|---:|---:|---:|---:|---:|
| 149 | Kunde #149 | 13.100 | 91.700 | **131.000** | 1 | 1 |
| 150 | Kunde #150 | 13.100 | 78.600 | **117.900** | 1 | 1 |
| 151 | Kunde #151 | 13.100 | 78.600 | **117.900** | 1 | 1 |
| 148 | Kunde #148 | 13.100 | — | **104.800** | 1 | 0 |
| 49 | Kunde #49 | — | 13.100 | **91.700** | 0 | 1 |
| 39 | Kunde #39 | — | 34.450 | **78.600** | 0 | 1 |
| 50 | (Kunde 50) | 85.150 | 85.150 | 78.600 | 1 | 1 |
| 51 | (Kunde 51) | 26.025 | 6.550 | 78.600 | 1 | 1 |
| 52 | Kunde #52 | 58.950 | 58.950 | 78.600 | 1 | 1 |
| 53 | Walter Hofmann | 60.250 | 60.250 | 78.600 | 1 | 1 |
| 54 | Kunde #54 | 39.000 | 39.000 | 78.600 | 1 | 1 |
| 55 | Kunde #55 | 75.325 | 75.325 | 78.600 | 1 | 1 |
| 56 | (Kunde 56) | 112.169 | 112.169 | 78.600 | 1 | 1 |
| 57 | Kunde #57 | 68.500 | 68.500 | 78.600 | 1 | 1 |
| 58 | Kunde #58 | 122.813 | 122.813 | 78.600 | 1 | 1 |
| 60 | (Kunde 60) | 121.175 | 121.175 | 78.600 | 1 | 1 |
| 63 | Kunde #63 | — | — | 78.600 | 0 | 0 |
| 67 | (Kunde 67) | — | 88.213 | 78.600 | 0 | 1 |
| 69 | (Kunde 69) | — | 134.275 | 78.600 | 0 | 1 |
| 76 | Kunde #76 | — | 128.700 | 78.600 | 0 | 1 |
| 77 | Kunde #77 | — | — | 78.600 | 0 | 0 |
| 80 | (Kunde 80) | — | 157.200 | 78.600 | 0 | 1 |
| 83 | (Kunde 83) | — | 145.685 | 78.600 | 0 | 1 |
| 90 | (Kunde 90) | — | 157.200 | 78.600 | 0 | 1 |
| 93 | (Kunde 93) | — | 157.200 | 78.600 | 0 | 1 |

**Auch problematisch:** Kunden 50, 52, 53, 54, 55, 56, 57, 58, 60 haben `initial_balance` UND `carryover` mit identischem Betrag — Hinweis darauf, dass derselbe €-Wert versehentlich in beiden Quellen angelegt wurde (Doppelung im Setup-Pfad oder Migration).

**Auswirkung im UI:** `summary-queries.ts → calculateAllocated45b` summiert `initial_balance` + `carryover` + dynamische Monatsallocation. Wenn zusätzlich persistierte `monthly_auto`-Zeilen existieren, werden diese in `getActiveAllocations()` mitgezählt → die UI-Karte „Gesamt zugewiesen" zeigt 131 € (bzw. 786 €) zu viel pro Monat-Stack. Das ist die plausibelste Erklärung für Task #696.

### 4a. Per-Kunde §45b Allocation/Reservation/Consumption-Tabelle

**Definitionen:**
- `allocated_db` = Summe aller aktiven Zeilen in `budget_allocations` für §45b (Cent).
- `initial` / `carryover` / `phantom_monthly` / `manual` = Aufschlüsselung nach `source` (aktive Zeilen).
- `reserved` = Summe `budget_transactions.amount_cents` mit `transaction_type='reservation'`. **In der gesamten Tabelle = 0** (es existieren nur `consumption` und `reversal`, keine `reservation`-Tx).
- `consumed` = SUM(consumption) − SUM(reversal) für §45b je Kunde (Cent).
- `rest_db` = `allocated_db − reserved − consumed` (was die UI heute als „Restguthaben" zeigt).
- `expected_allocated_may` = Soll-Wert per 27.05.2026 = `initial + carryover + manual + 5 × 13.100` (5 verstrichene Monate × 131 € virtuelle Monatsrate).
- `delta_phantom` = `allocated_db − (initial + carryover + manual)` = persistierter §45b-Übersummand, identisch mit `phantom_monthly`.

Alle Beträge in Cent. Vollständige Liste der 89 betroffenen Kunden:

| customer_id | name | allocated_db | initial | carryover | phantom_monthly | consumed | rest_db | expected_allocated_may | delta_phantom |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 149 | Kunde #149 | 235.800 | 13.100 | 91.700 | 131.000 | 0 | 235.800 | 170.300 | 131.000 |
| 150 | Kunde #150 | 209.600 | 13.100 | 78.600 | 117.900 | 0 | 209.600 | 157.200 | 117.900 |
| 151 | Kunde #151 | 209.600 | 13.100 | 78.600 | 117.900 | 0 | 209.600 | 157.200 | 117.900 |
| 148 | Kunde #148 | 117.900 | 13.100 | 0 | 104.800 | 0 | 117.900 | 78.600 | 104.800 |
| 49 | Kunde #49 | 104.800 | 0 | 13.100 | 91.700 | 25.597 | 79.203 | 78.600 | 91.700 |
| 39 | Kunde #39 | 113.050 | 0 | 34.450 | 78.600 | 30.788 | 82.262 | 100.000 | 78.600 |
| 50 | Kunde #50 | 248.900 | 85.150 | 85.150 | 78.600 | 44.992 | 203.908 | 235.800 | 78.600 |
| 51 | Kunde #51 | 111.175 | 26.025 | 6.550 | 78.600 | 35.415 | 75.760 | 98.075 | 78.600 |
| 52 | Kunde #52 | 196.500 | 58.950 | 58.950 | 78.600 | 39.985 | 156.515 | 183.400 | 78.600 |
| 53 | Kunde #53 | 199.100 | 60.250 | 60.250 | 78.600 | 55.689 | 143.411 | 186.000 | 78.600 |
| 54 | Kunde #54 | 156.600 | 39.000 | 39.000 | 78.600 | 86.695 | 69.905 | 143.500 | 78.600 |
| 55 | Kunde #55 | 229.250 | 75.325 | 75.325 | 78.600 | 39.265 | 189.985 | 216.150 | 78.600 |
| 56 | Kunde #56 | 302.938 | 112.169 | 112.169 | 78.600 | 58.086 | 244.852 | 289.838 | 78.600 |
| 57 | Kunde #57 | 215.600 | 68.500 | 68.500 | 78.600 | 68.379 | 147.221 | 202.500 | 78.600 |
| 58 | Kunde #58 | 324.226 | 122.813 | 122.813 | 78.600 | 13.902 | 310.324 | 311.126 | 78.600 |
| 59 | Kunde #59 | 158.838 | 40.119 | 40.119 | 78.600 | 23.073 | 135.765 | 145.738 | 78.600 |
| 60 | Kunde #60 | 320.950 | 121.175 | 121.175 | 78.600 | 11.904 | 309.046 | 307.850 | 78.600 |
| 61 | Kunde #61 | 187.676 | 54.538 | 54.538 | 78.600 | 23.304 | 164.372 | 174.576 | 78.600 |
| 62 | Kunde #62 | 265.276 | 93.338 | 93.338 | 78.600 | 0 | 265.276 | 252.176 | 78.600 |
| 63 | Kunde #63 | 78.600 | 0 | 0 | 78.600 | 55.605 | 22.995 | 65.500 | 78.600 |
| 64 | Kunde #64 | 203.050 | 62.225 | 62.225 | 78.600 | 59.661 | 143.389 | 189.950 | 78.600 |
| 65 | Kunde #65 | 277.026 | 99.213 | 99.213 | 78.600 | 32.183 | 244.843 | 263.926 | 78.600 |
| 66 | Kunde #66 | 170.300 | 45.850 | 45.850 | 78.600 | 60.225 | 110.075 | 157.200 | 78.600 |
| 67 | Kunde #67 | 166.813 | 0 | 88.213 | 78.600 | 37.001 | 129.812 | 153.713 | 78.600 |
| 68 | Kunde #68 | 176.675 | 0 | 98.075 | 78.600 | 49.088 | 127.587 | 163.575 | 78.600 |
| 69 | Kunde #69 | 212.875 | 0 | 134.275 | 78.600 | 37.232 | 175.643 | 199.775 | 78.600 |
| 70 | Kunde #70 | 175.420 | 0 | 96.820 | 78.600 | 26.440 | 148.980 | 162.320 | 78.600 |
| 71 | Kunde #71 | 150.300 | 0 | 71.700 | 78.600 | 22.678 | 127.622 | 137.200 | 78.600 |
| 72 | Kunde #72 | 111.350 | 0 | 32.750 | 78.600 | 39.517 | 71.833 | 98.250 | 78.600 |
| 73 | Kunde #73 | 127.540 | 0 | 48.940 | 78.600 | 29.900 | 97.640 | 114.440 | 78.600 |
| 74 | Kunde #74 | 110.190 | 0 | 31.590 | 78.600 | 18.612 | 91.578 | 97.090 | 78.600 |
| 75 | Kunde #75 | 155.092 | 0 | 76.492 | 78.600 | 48.431 | 106.661 | 141.992 | 78.600 |
| 76 | Kunde #76 | 207.300 | 0 | 128.700 | 78.600 | 48.630 | 158.670 | 194.200 | 78.600 |
| 77 | Kunde #77 | 78.600 | 0 | 0 | 78.600 | 0 | 78.600 | 65.500 | 78.600 |
| 78 | Kunde #78 | 130.261 | 0 | 51.661 | 78.600 | 19.159 | 111.102 | 117.161 | 78.600 |
| 79 | Kunde #79 | 208.238 | 0 | 129.638 | 78.600 | 29.547 | 178.691 | 195.138 | 78.600 |
| 80 | Kunde #80 | 235.800 | 0 | 157.200 | 78.600 | 0 | 235.800 | 222.700 | 78.600 |
| 81 | Kunde #81 | 139.973 | 0 | 61.373 | 78.600 | 30.366 | 109.607 | 126.873 | 78.600 |
| 82 | Kunde #82 | 110.337 | 0 | 31.737 | 78.600 | 7.124 | 103.213 | 97.237 | 78.600 |
| 83 | Kunde #83 | 224.285 | 0 | 145.685 | 78.600 | 5.795 | 218.490 | 211.185 | 78.600 |
| 84 | Kunde #84 | 209.600 | 0 | 131.000 | 78.600 | 0 | 209.600 | 196.500 | 78.600 |
| 85 | Kunde #85 | 118.743 | 0 | 40.143 | 78.600 | 0 | 118.743 | 105.643 | 78.600 |
| 86 | Kunde #86 | 164.064 | 0 | 85.464 | 78.600 | 30.736 | 133.328 | 150.964 | 78.600 |
| 87 | Kunde #87 | 106.052 | 0 | 27.452 | 78.600 | 17.772 | 88.280 | 92.952 | 78.600 |
| 88 | Kunde #88 | 182.895 | 0 | 104.295 | 78.600 | 0 | 182.895 | 169.795 | 78.600 |
| 89 | Kunde #89 | 196.500 | 0 | 117.900 | 78.600 | 31.240 | 165.260 | 183.400 | 78.600 |
| 90 | Kunde #90 | 235.800 | 0 | 157.200 | 78.600 | 0 | 235.800 | 222.700 | 78.600 |
| 91 | Kunde #91 | 109.992 | 0 | 31.392 | 78.600 | 26.647 | 83.345 | 96.892 | 78.600 |
| 92 | Kunde #92 | 117.900 | 0 | 39.300 | 78.600 | 49.176 | 68.724 | 104.800 | 78.600 |
| 93 | Kunde #93 | 235.800 | 0 | 157.200 | 78.600 | 15.760 | 220.040 | 222.700 | 78.600 |
| 94 | Kunde #94 | 235.800 | 0 | 157.200 | 78.600 | 20.533 | 215.267 | 222.700 | 78.600 |
| 96 | Kunde #96 | 235.800 | 0 | 157.200 | 78.600 | 39.850 | 195.950 | 222.700 | 78.600 |
| 97 | Kunde #97 | 235.800 | 0 | 157.200 | 78.600 | 5.893 | 229.907 | 222.700 | 78.600 |
| 98 | Kunde #98 | 235.800 | 0 | 157.200 | 78.600 | 11.814 | 223.986 | 222.700 | 78.600 |
| 99 | Kunde #99 | 117.900 | 0 | 39.300 | 78.600 | 39.472 | 78.428 | 104.800 | 78.600 |
| 100 | Kunde #100 | 144.100 | 0 | 65.500 | 78.600 | 11.400 | 132.700 | 131.000 | 78.600 |
| 101 | Kunde #101 | 235.800 | 0 | 157.200 | 78.600 | 30.832 | 204.968 | 222.700 | 78.600 |
| 102 | Kunde #102 | 170.300 | 0 | 91.700 | 78.600 | 31.004 | 139.296 | 157.200 | 78.600 |
| 103 | Kunde #103 | 183.400 | 0 | 104.800 | 78.600 | 8.660 | 174.740 | 170.300 | 78.600 |
| 104 | Kunde #104 | 131.000 | 0 | 52.400 | 78.600 | 13.015 | 117.985 | 117.900 | 78.600 |
| 105 | Kunde #105 | 235.800 | 0 | 157.200 | 78.600 | 18.271 | 217.529 | 222.700 | 78.600 |
| 106 | Kunde #106 | 235.800 | 0 | 157.200 | 78.600 | 94.866 | 140.934 | 222.700 | 78.600 |
| 107 | Kunde #107 | 117.900 | 0 | 39.300 | 78.600 | 5.798 | 112.102 | 104.800 | 78.600 |
| 108 | Kunde #108 | 235.800 | 0 | 157.200 | 78.600 | 109.058 | 126.742 | 222.700 | 78.600 |
| 110 | Kunde #110 | 235.800 | 0 | 157.200 | 78.600 | 33.084 | 202.716 | 222.700 | 78.600 |
| 109 | Kunde #109 | 131.000 | 0 | 52.400 | 78.600 | 0 | 131.000 | 117.900 | 78.600 |
| 111 | Kunde #111 | 78.600 | 0 | 0 | 78.600 | 13.038 | 65.562 | 65.500 | 78.600 |
| 161 | Kunde #161 | 379.900 | 13.100 | 314.400 | 52.400 | 13.946 | 365.954 | 392.000 | 52.400 |
| 160 | Kunde #160 | 366.800 | 157.200 | 157.200 | 52.400 | 33.054 | 333.746 | 379.900 | 52.400 |
| 118 | Kunde #118 | 52.400 | 0 | 0 | 52.400 | 24.871 | 27.529 | 65.500 | 52.400 |
| 134 | Kunde #134 | 78.600 | 13.100 | 13.100 | 52.400 | 5.844 | 72.756 | 91.700 | 52.400 |
| 146 | Kunde #146 | 148.705 | 83.205 | 13.100 | 52.400 | 0 | 148.705 | 161.805 | 52.400 |
| 130 | Kunde #130 | 52.400 | 0 | 0 | 52.400 | 12.523 | 39.877 | 65.500 | 52.400 |
| 114 | Kunde #114 | 366.800 | 157.200 | 157.200 | 52.400 | 0 | 366.800 | 379.900 | 52.400 |
| 138 | Kunde #138 | 52.400 | 0 | 0 | 52.400 | 0 | 52.400 | 65.500 | 52.400 |
| 139 | Kunde #134 | 52.400 | 13.100 | 0 | 39.300 | 5.844 | 46.556 | 78.600 | 39.300 |
| 140 | Kunde #140 | 353.700 | 157.200 | 157.200 | 39.300 | 0 | 353.700 | 379.900 | 39.300 |
| 141 | Kunde #141 | 91.700 | 52.400 | 0 | 39.300 | 7.653 | 84.047 | 117.900 | 39.300 |
| 136 | Kunde #136 | 183.400 | 0 | 157.200 | 26.200 | 0 | 183.400 | 222.700 | 26.200 |
| 135 | Kunde #135 | 183.400 | 0 | 157.200 | 26.200 | 0 | 183.400 | 222.700 | 26.200 |
| 137 | Kunde #136 | 183.400 | 0 | 157.200 | 26.200 | 30.240 | 153.160 | 222.700 | 26.200 |
| 153 | Kunde #153 | 209.600 | 104.800 | 91.700 | 13.100 | 11.845 | 197.755 | 261.000 | 13.100 |
| 119 | Kunde #119 | 67.137 | 54.037 | 0 | 13.100 | 42 | 67.095 | 119.537 | 13.100 |
| 158 | Kunde #158 | 26.200 | 13.100 | 0 | 13.100 | 18.150 | 8.050 | 78.600 | 13.100 |
| 155 | Kunde #155 | 340.600 | 170.300 | 157.200 | 13.100 | 11.722 | 328.878 | 392.000 | 13.100 |
| 117 | Kunde #117 | 52.400 | 39.300 | 0 | 13.100 | 12.936 | 39.464 | 104.800 | 13.100 |
| 157 | Kunde #157 | 26.200 | 13.100 | 0 | 13.100 | 10.160 | 16.040 | 78.600 | 13.100 |
| 156 | Kunde #156 | 26.200 | 13.100 | 0 | 13.100 | 0 | 26.200 | 78.600 | 13.100 |
| 95 | Kunde #95 | 5.100 | 0 | 0 | 5.100 | -10.902 | 16.002 | 70.600 | 5.100 |

**Befund:**
- `delta_phantom` ist für ALLE 89 Kunden = `phantom_monthly`. Heißt: Die persistierten `monthly_auto`-Zeilen sind der einzige Drift-Beitrag in `allocated_db`. Wären diese Zeilen wegerklärt (soft-delete), würde `allocated_db = initial + carryover + manual` — exakt das, was das Code-Modell vorsieht.
- Direkter Cross-Check zu **Task #696** („Gesamt zugewiesen 131 € zu hoch"): Kunden mit `phantom_monthly = 13.100` (z.B. 153, 119, 158, 155, 117, 157, 156, 95) zeigen exakt **131 € zuviel** im UI — das ist der Bug-Report wörtlich. Kunden mit `phantom_monthly = 78.600` sehen entsprechend **786 €** zuviel (6 × 131 €).
- `consumed` für Kunde 95 ist **−10.902 Cent** (negativ) — Reversal-Summe übersteigt Konsum-Summe. Das ist ein zweites Symptom der 12 Orphan-Reversals aus §1 und ist nicht durch eine reguläre Buchung erklärbar.
- `rest_db` für Kunden 50, 60, 80, 90, 93, 94, 96, 97, 98, 101, 105, 106, 108, 110, 114, 140 liegt deutlich über dem Soll-Wert per Mai 2026 (Differenz ≈ `phantom_monthly`). Diese Beträge sind operationell „verfügbar", obwohl sie es laut Gesetzeslage/Code nicht sein dürften.

## 5. Top-10 Betroffene Kunden (kombiniert)

Sortiert nach `phantom_storno_cents + phantom_alloc_cents`:

| Rang | customer_id | Name | Phantom-Storno (€) | Storno-Count | Phantom-Allocation §45b (€) | Drift gesamt (€) |
|---:|---:|---|---:|---:|---:|---:|
| 1 | 149 | Kunde #149 | 0,00 | 0 | 1.310,00 | **1.310,00** |
| 2 | 39 | Kunde #39 | 468,99 | 12 | 786,00 | **1.254,99** |
| 3 | 54 | Kunde #54 | 441,95 | 6 | 786,00 | **1.227,95** |
| 4 | 150 | Kunde #150 | 0,00 | 0 | 1.179,00 | **1.179,00** |
| 5 | 151 | Kunde #151 | 0,00 | 0 | 1.179,00 | **1.179,00** |
| 6 | 148 | Kunde #148 | 0,00 | 0 | 1.048,00 | **1.048,00** |
| 7 | 77 | Kunde #77 | 261,31 | 8 | 786,00 | **1.047,31** |
| 8 | 72 | Kunde #72 | 254,25 | 6 | 786,00 | **1.040,25** |
| 9 | 92 | Kunde #92 | 222,94 | 4 | 786,00 | **1.008,94** |
| 10 | 57 | Kunde #57 | 194,20 | 5 | 786,00 | **980,20** |

Zusätzliche Sonder-Erwähnung außerhalb Top-10: **Kunde #95** — kein materialisierter Phantom-€-Wert, aber 6 Termine mit Ledger-Minuten = 2 × Service-Minuten (Doppel-Konsum) und 14 Reversals mit 759,94 €.

## 6. Hypothesen & Code-Pointer

### H1 — §45b `monthly_auto` wurde durch ein Backfill-Skript materialisiert

- **Evidenz:** 89 Kunden in einer Sekunde am 23.02.2026 11:35 UTC mit identischem Muster (Jan–Jun 2026, je 13.100 Cent).
- **Konflikt mit Code:** `server/storage/budget/allocation-storage.ts` und `replit.md` halten explizit fest, dass §45b-Monatsallocations NICHT als Zeilen materialisiert werden, sondern in `calculateAllocated45b` virtuell entstehen.
- **Vermutung:** Beim Import oder einer Setup-Routine (möglicherweise in einem Skript unter `server/startup/` oder einem manuellen `tsx`-Lauf) wurde versehentlich `insertAllocation` mit `source='monthly_auto'` für §45b aufgerufen. Audit-Log enthält für den 23.02.2026 keinen passenden Action-Namen, d.h. der Pfad lief vermutlich an `writeAuditLog` vorbei.
- **Cross-Check zu Task #696:** Genau diese Zeilen werden in `summary-queries.ts` zusätzlich zum virtuellen Renewal aufsummiert → „Gesamt zugewiesen 131 € zu hoch" pro Monat.

### H2 — Import legt Duplikat-Termine an statt zu updaten

- **Evidenz:** 14 Kunden mit 2+ aktiven Terminen pro Tag, davon mehrere Paare mit identischer Dauer und KM aber großer ID-Lücke (z.B. #154/#515 bei Kunde 95, gleicher Tag, gleiche 60 min, gleiche 21,8 km, aber unterschiedlicher Start). Der Konsum wurde dann zweimal gebucht → Ledger-Drift Faktor 2.
- **Code-Pointer:** `server/services/appointment-import.ts` → `findMatchKey` / Dedup-Logik nutzt `(customer_id, date, scheduled_start)`. Sobald die Excel-Datei eine andere Startzeit liefert als der bestehende Termin, sieht der Import keinen Match und legt einen neuen Termin an. Beim anschließenden Konsum-Booking entstehen zwei Konsum-Tx — die alte bleibt liegen.
- **Cross-Check:** Kunden mit Doppel-Konsum (95, 77, 53, 75, 91, 92, 108, 119, 130, 175) sind nahezu identisch mit der Liste in §3 (Minuten-Drift). Das stützt H2.

### H3 — `km-rebook`-Reversal hat by-design keine Termin-Bindung

- **Evidenz:** 84 Phantom-Reversals, davon 51 mit `appointmentId IS NULL` und Note `Storno (Termin-Edit) von Transaktion #N`.
- **Code-Pointer:** `server/storage/budget/km-rebook.ts` setzt `appointmentId: null` auf der Reversal-Zeile, damit die Original-Tx „neutralisiert" wird und eine neue Konsum-Tx mit den korrigierten KM gebucht wird.
- **Befund:** Dieser Anteil ist KEIN Daten-Drift, sondern Soll-Verhalten. Aber: die Diagnose-Query erkennt sie zunächst nicht zuverlässig vom „echten" Phantom. Für ein Cleanup-Tooling sollte über die Note (`Storno (Termin-Edit)`) plus Existenz einer Nachfolger-Konsum-Tx mit selber Termin-ID gefiltert werden.

### H4 — 16 echte Foreign-Key-Orphans

- **Evidenz:** Spalte `orphan_no_original` (Reversal zeigt auf nicht-existente Original-Tx) summiert in Top-25 zu 16 Fällen, hauptsächlich Kunde 95 (12 Stück). Diese fallen NICHT unter H3 — sie stammen aus einem Zeitpunkt, an dem die Original-Konsum-Tx physisch gelöscht wurde (`DELETE FROM budget_transactions ...`) statt soft-storniert.
- **Code-Pointer:** Reguläre Storno-/Rebook-Pfade (`transaction-storage.ts`, `rebook-storage.ts`) löschen NIE — also stammen die Löschungen entweder aus einem manuellen DB-Eingriff oder einem alten Migrations-/Reconcile-Skript (Audit-Log zeigt für 14.04.2026 einen einmaligen `budget_repair_orphaned`-Eintrag).

### H5 — `initial_balance` und `carryover` mit identischem Betrag

- **Evidenz:** Mind. 10 Kunden (50, 52, 53, 54, 55, 56, 57, 58, 60, 64, 65, 66 …) haben in §45b beide Quellen mit exakt gleichem €-Betrag.
- **Vermutung:** Setup- oder Erstanlage-Logik hat den Vorjahres-Übertrag versehentlich zweimal angelegt — einmal als „Startwert laufendes Jahr", einmal als „Carryover Vorjahr". Tritt nur bei §45b auf, das ist die einzige Budget-Art mit beiden Quellen.
- **Code-Pointer:** `upsertInitialBalanceAllocation` (`allocation-storage.ts`) und `upsertCarryoverAllocation` teilen sich Tabelle, aber unterschiedliche Schlüssel. Ein gemeinsamer Aufrufer (z.B. Customer-Setup-Step oder Import-Mapper) hat hier vermutlich dieselbe €-Zahl in beide gefüttert.

### H6 — Ledger-Untererfassung bei Kunden 175 und 53

- **Evidenz:** Bei einzelnen Terminen (z.B. 175/#970: 90 min Ledger vs. 135 min Services) wurde weniger gebucht als die Services ausweisen.
- **Vermutung:** Manuelle Korrektur der `actual_duration_minutes` im UI nach der Konsum-Buchung — Konsum wurde NICHT mitgezogen (kein Rebook getriggert).

## 7. Empfehlungen

> Keine dieser Empfehlungen wurde umgesetzt. Es handelt sich um Diskussionsgrundlage für die nächsten Tasks.

### Sofort (read-only Verifikation, ohne Schreibzugriff)

1. **Audit der `monthly_auto`-Zeilen erweitern:** Quelle des 23.02.2026-Backfills identifizieren — Git-Log / `server/startup/` nach Skripten mit `insertAllocation({...source:'monthly_auto'...})` für §45b durchsuchen, dazu deployment-log.md prüfen.
2. **Doppel-Konsum-Liste an Operations:** Die 14 Kunden mit Verdacht auf Import-Duplikat-Termine zur fachlichen Klärung geben (echter zweiter Termin oder Duplikat?).
3. **`equality`-Test ergänzen:** `tests/equality/budget-45b-allocation.test.ts` (neu) — failt, sobald in der DB §45b-Zeilen mit `source IN ('monthly','monthly_auto')` existieren.

### Mittelfristig (Fix-Tasks, jeweils mit Rollback-Plan und Audit-Log)

4. **§45b-`monthly_auto`-Bereinigung (Hauptfix für #696):** Idempotentes Skript, das alle 470 betroffenen Zeilen soft-löscht (`deleted_at = now()`), pro Zeile einen `budget_allocation_soft_deleted`-Audit-Eintrag schreibt und in einem Dry-Run-Modus zuerst nur logged. KEIN harter Delete (GoBD).
5. **Import-Dedup-Schlüssel erweitern:** `findMatchKey` in `appointment-import.ts` sollte als Fallback zusätzlich auf `(customer_id, date, duration_promised, travel_kilometers)` matchen, wenn `scheduled_start` unterschiedlich ist und innerhalb von ±2h liegt. Sonst weiter neuer Termin.
6. **§45b „doppelte Quelle"-Reconcile:** Für die ~10 Kunden mit identischem `initial_balance` und `carryover` Klärungstask anlegen — welche der beiden Zeilen ist die korrekte?
7. **Phantom-Storno-Cleanup (H4):** Für die 16 Orphan-Reversals: Original-Tx aus Backup wiederherstellen ODER Reversal-Zeilen mit Begründung in Audit-Log soft-löschen.

### Langfristig (Strukturell)

8. **Konstraint hinzufügen:** Partieller CHECK auf `budget_allocations`: `CHECK (budget_type <> 'entlastungsbetrag_45b' OR source NOT IN ('monthly','monthly_auto'))`. Verhindert ein Wiederauftreten von H1.
9. **Foreign-Key auf `reversed_transaction_id`:** Schema prüft aktuell keinen FK auf `budget_transactions.reversed_transaction_id` → das machte H4 möglich. FK mit `ON DELETE RESTRICT` sollte H4 in Zukunft blockieren.
10. **Import-Reconcile-Audit-Log:** Jeder Import-Run sollte mit Anzahl „neu angelegt / geupdated / als Duplikat erkannt" pro Kunde in `audit_log` landen (Action `appointment_import_reconciled`). Aktuell ist dort nur 1 Eintrag mit `appointment_import_reconciled_cancelled` zu sehen.

## 8. Verwendete SQL-Queries (vollständig, reproduzierbar)

Alle Queries wurden gegen das READ-ONLY-Replica der Produktion ausgeführt:
`executeSql({ sqlQuery: <…>, environment: "production" })` (siehe `.local/skills/database/SKILL.md`).

### Q1 — Phantom-Stornos je Kunde (Aggregat aus §1)

```sql
WITH reversals AS (
  SELECT bt.id AS reversal_id, bt.customer_id, bt.amount_cents,
         bt.appointment_id AS reversal_appt_id, bt.transaction_date,
         bt.reversed_transaction_id, bt.notes, bt.created_at
  FROM budget_transactions bt
  WHERE bt.transaction_type = 'reversal'
),
classified AS (
  SELECT r.*, orig.id AS orig_id, orig.transaction_type AS orig_type,
         orig.amount_cents AS orig_amount, orig.appointment_id AS orig_appt_id,
         appt.id AS appt_id, appt.deleted_at AS appt_deleted_at, appt.status AS appt_status,
         (SELECT COUNT(*) FROM budget_transactions rr
          WHERE rr.reversed_transaction_id = r.reversed_transaction_id
            AND rr.transaction_type='reversal') AS dup_reversal_count
  FROM reversals r
  LEFT JOIN budget_transactions orig ON orig.id = r.reversed_transaction_id
  LEFT JOIN appointments appt ON appt.id = COALESCE(orig.appointment_id, r.reversal_appt_id)
)
SELECT customer_id, COUNT(*) AS reversal_count,
       SUM(ABS(amount_cents))::int AS total_cents,
       SUM(CASE WHEN orig_id IS NULL THEN 1 ELSE 0 END) AS orphan_no_original,
       SUM(CASE WHEN dup_reversal_count > 1 THEN 1 ELSE 0 END) AS double_storno,
       SUM(CASE WHEN appt_deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS soft_deleted_appt,
       SUM(CASE WHEN appt_id IS NULL THEN 1 ELSE 0 END) AS no_appt
FROM classified
WHERE orig_id IS NULL
   OR dup_reversal_count > 1
   OR appt_deleted_at IS NOT NULL
   OR appt_id IS NULL
GROUP BY customer_id
ORDER BY total_cents DESC
LIMIT 50;
```

### Q2 — Phantom-Storno Tx-IDs je Kunde (§1, zweite Tabelle)

```sql
WITH classified AS (
  SELECT bt.id AS reversal_id, bt.customer_id, bt.amount_cents,
         bt.reversed_transaction_id, bt.appointment_id,
         orig.id AS orig_id,
         a.id AS appt_id, a.deleted_at AS appt_del,
         (SELECT COUNT(*) FROM budget_transactions rr
          WHERE rr.reversed_transaction_id = bt.reversed_transaction_id
            AND rr.transaction_type='reversal') AS dup_rev
  FROM budget_transactions bt
  LEFT JOIN budget_transactions orig ON orig.id = bt.reversed_transaction_id
  LEFT JOIN appointments a ON a.id = COALESCE(orig.appointment_id, bt.appointment_id)
  WHERE bt.transaction_type='reversal'
)
SELECT customer_id,
       array_agg(reversal_id ORDER BY reversal_id) AS tx_ids,
       SUM(ABS(amount_cents))::int AS total_cents
FROM classified
WHERE orig_id IS NULL OR appt_id IS NULL OR appt_del IS NOT NULL OR dup_rev > 1
GROUP BY customer_id
ORDER BY total_cents DESC;
```

### Q3 — Doppel-Konsum am selben Slot (§2, strikte Variante)

```sql
WITH slot_counts AS (
  SELECT customer_id, date, scheduled_start, COUNT(*) AS appt_count,
         array_agg(id ORDER BY id) AS appt_ids
  FROM appointments
  WHERE deleted_at IS NULL
    AND status <> 'cancelled'
    AND appointment_type = 'Kundentermin'
  GROUP BY customer_id, date, scheduled_start
  HAVING COUNT(*) > 1
)
SELECT customer_id, COUNT(*) AS double_slots,
       SUM(appt_count) AS total_appts_in_slots,
       json_agg(json_build_object('date',date,'start',scheduled_start::text,'ids',appt_ids) ORDER BY date) AS slot_detail
FROM slot_counts
GROUP BY customer_id
ORDER BY double_slots DESC
LIMIT 50;
```

### Q4 — Doppel-Konsum am selben Tag (§2, gelockerte Variante)

```sql
WITH dups AS (
  SELECT customer_id, date, COUNT(*) AS appt_count,
         array_agg(id ORDER BY id) AS appt_ids,
         array_agg(scheduled_start::text ORDER BY id) AS starts,
         array_agg(duration_promised ORDER BY id) AS durations,
         array_agg(travel_kilometers ORDER BY id) AS kms
  FROM appointments
  WHERE deleted_at IS NULL
    AND status <> 'cancelled'
    AND appointment_type = 'Kundentermin'
  GROUP BY customer_id, date
  HAVING COUNT(*) > 1
)
SELECT customer_id, COUNT(*) AS days_with_multi,
       SUM(appt_count) AS total_appts,
       json_agg(json_build_object('date',date,'ids',appt_ids,'starts',starts,'min',durations,'km',kms) ORDER BY date) AS detail
FROM dups
GROUP BY customer_id
ORDER BY days_with_multi DESC
LIMIT 30;
```

### Q5 — Ledger-vs-Termin-Drift (§3, Aggregat)

```sql
WITH appt_net AS (
  SELECT bt.appointment_id,
         SUM(CASE WHEN bt.transaction_type='consumption' THEN ABS(bt.amount_cents)
                  WHEN bt.transaction_type='reversal' THEN -ABS(bt.amount_cents)
                  ELSE 0 END)::int AS net_consumed_cents,
         SUM(CASE WHEN bt.transaction_type='consumption' THEN bt.hauswirtschaft_minutes
                  WHEN bt.transaction_type='reversal' THEN -bt.hauswirtschaft_minutes ELSE 0 END) AS net_hw_min,
         SUM(CASE WHEN bt.transaction_type='consumption' THEN bt.alltagsbegleitung_minutes
                  WHEN bt.transaction_type='reversal' THEN -bt.alltagsbegleitung_minutes ELSE 0 END) AS net_ab_min,
         MAX(bt.customer_id) AS customer_id
  FROM budget_transactions bt
  WHERE bt.appointment_id IS NOT NULL
  GROUP BY bt.appointment_id
),
appt_svc AS (
  SELECT aps.appointment_id,
         SUM(COALESCE(aps.actual_duration_minutes, aps.planned_duration_minutes, 0)) AS svc_min
  FROM appointment_services aps
  GROUP BY aps.appointment_id
)
SELECT an.customer_id,
       COUNT(*) FILTER (WHERE a.deleted_at IS NOT NULL AND an.net_consumed_cents > 0) AS soft_del_with_net,
       COALESCE(SUM(an.net_consumed_cents) FILTER (WHERE a.deleted_at IS NOT NULL AND an.net_consumed_cents > 0),0)::int AS soft_del_net_cents,
       COUNT(*) FILTER (WHERE a.status='cancelled' AND an.net_consumed_cents > 0) AS cancelled_with_net,
       COALESCE(SUM(an.net_consumed_cents) FILTER (WHERE a.status='cancelled' AND an.net_consumed_cents > 0),0)::int AS cancelled_net_cents,
       COUNT(*) FILTER (WHERE a.id IS NULL) AS missing_appt,
       COUNT(*) FILTER (
         WHERE a.deleted_at IS NULL AND a.status <> 'cancelled'
           AND ABS(an.net_hw_min + an.net_ab_min - COALESCE(s.svc_min,0)) > 0
       ) AS minutes_drift_count
FROM appt_net an
LEFT JOIN appointments a ON a.id = an.appointment_id
LEFT JOIN appt_svc s ON s.appointment_id = an.appointment_id
GROUP BY an.customer_id
HAVING (COUNT(*) FILTER (WHERE a.deleted_at IS NOT NULL AND an.net_consumed_cents > 0) > 0
     OR COUNT(*) FILTER (WHERE a.status='cancelled' AND an.net_consumed_cents > 0) > 0
     OR COUNT(*) FILTER (WHERE a.id IS NULL) > 0
     OR COUNT(*) FILTER (WHERE a.deleted_at IS NULL AND a.status <> 'cancelled'
                         AND ABS(an.net_hw_min + an.net_ab_min - COALESCE(s.svc_min,0)) > 0) > 0)
ORDER BY (COALESCE(SUM(an.net_consumed_cents) FILTER (WHERE a.deleted_at IS NOT NULL AND an.net_consumed_cents > 0),0)
        + COALESCE(SUM(an.net_consumed_cents) FILTER (WHERE a.status='cancelled' AND an.net_consumed_cents > 0),0)) DESC
LIMIT 50;
```

### Q6 — Ledger-Drift-Detail je Termin (§3, Beispiele)

```sql
WITH appt_net AS (
  SELECT bt.appointment_id, bt.customer_id,
         SUM(CASE WHEN bt.transaction_type='consumption' THEN bt.hauswirtschaft_minutes
                  WHEN bt.transaction_type='reversal' THEN -bt.hauswirtschaft_minutes ELSE 0 END) AS net_hw,
         SUM(CASE WHEN bt.transaction_type='consumption' THEN bt.alltagsbegleitung_minutes
                  WHEN bt.transaction_type='reversal' THEN -bt.alltagsbegleitung_minutes ELSE 0 END) AS net_ab
  FROM budget_transactions bt
  WHERE bt.appointment_id IS NOT NULL
  GROUP BY bt.appointment_id, bt.customer_id
),
svc AS (
  SELECT appointment_id, SUM(COALESCE(actual_duration_minutes, planned_duration_minutes, 0)) AS svc_min
  FROM appointment_services GROUP BY appointment_id
)
SELECT an.customer_id, an.appointment_id, a.date, a.scheduled_start, a.status, a.deleted_at,
       an.net_hw + an.net_ab AS ledger_min, COALESCE(s.svc_min,0) AS svc_min,
       a.duration_promised
FROM appt_net an
JOIN appointments a ON a.id = an.appointment_id
LEFT JOIN svc s ON s.appointment_id = an.appointment_id
WHERE a.deleted_at IS NULL AND a.status <> 'cancelled'
  AND ABS(an.net_hw + an.net_ab - COALESCE(s.svc_min,0)) > 0
ORDER BY an.customer_id, a.date
LIMIT 25;
```

### Q7 — §45b-Anomalie-Aggregat (§4)

```sql
SELECT customer_id,
       SUM(amount_cents) FILTER (WHERE source='initial_balance')::int AS initial_balance_cents,
       SUM(amount_cents) FILTER (WHERE source='carryover')::int AS carryover_cents,
       SUM(amount_cents) FILTER (WHERE source IN ('monthly','monthly_auto'))::int AS persisted_monthly_cents,
       SUM(amount_cents) FILTER (WHERE source='manual_adjustment')::int AS manual_adjustment_cents,
       COUNT(*) FILTER (WHERE source='initial_balance') AS initial_balance_rows,
       COUNT(*) FILTER (WHERE source='carryover') AS carryover_rows
FROM budget_allocations
WHERE budget_type='entlastungsbetrag_45b'
  AND deleted_at IS NULL
GROUP BY customer_id
HAVING COUNT(*) FILTER (WHERE source='initial_balance') > 1
    OR COUNT(*) FILTER (WHERE source='carryover') > 1
    OR SUM(amount_cents) FILTER (WHERE source IN ('monthly','monthly_auto')) > 0
    OR SUM(amount_cents) FILTER (WHERE source='manual_adjustment') <> 0
ORDER BY COALESCE(SUM(amount_cents) FILTER (WHERE source IN ('monthly','monthly_auto')),0) DESC, customer_id
LIMIT 50;
```

### Q8 — Per-Kunde §45b allocated / reserved / consumed (§4a)

```sql
SELECT a.customer_id,
       c.vorname || ' ' || c.nachname AS name,
       SUM(a.amount_cents) FILTER (WHERE a.deleted_at IS NULL)::int AS allocated_db,
       SUM(a.amount_cents) FILTER (WHERE a.source='initial_balance' AND a.deleted_at IS NULL)::int AS initial,
       SUM(a.amount_cents) FILTER (WHERE a.source='carryover' AND a.deleted_at IS NULL)::int AS carryover,
       SUM(a.amount_cents) FILTER (WHERE a.source IN ('monthly','monthly_auto') AND a.deleted_at IS NULL)::int AS phantom_monthly,
       SUM(a.amount_cents) FILTER (WHERE a.source='manual_adjustment' AND a.deleted_at IS NULL)::int AS manual,
       COALESCE((SELECT SUM(CASE WHEN bt.transaction_type='consumption' THEN ABS(bt.amount_cents)
                                 WHEN bt.transaction_type='reversal' THEN -ABS(bt.amount_cents) ELSE 0 END)
                 FROM budget_transactions bt
                 WHERE bt.customer_id = a.customer_id AND bt.budget_type='entlastungsbetrag_45b'),0)::int AS consumed
FROM budget_allocations a
LEFT JOIN customers c ON c.id = a.customer_id
WHERE a.budget_type='entlastungsbetrag_45b'
GROUP BY a.customer_id, c.vorname, c.nachname
HAVING SUM(a.amount_cents) FILTER (WHERE a.source IN ('monthly','monthly_auto') AND a.deleted_at IS NULL) > 0
ORDER BY SUM(a.amount_cents) FILTER (WHERE a.source IN ('monthly','monthly_auto') AND a.deleted_at IS NULL) DESC
LIMIT 100;
```
> Hinweis: `reserved` ist in §4a separat berechnet als
> `SELECT customer_id, SUM(amount_cents) FROM budget_transactions WHERE transaction_type='reservation' AND budget_type='entlastungsbetrag_45b' GROUP BY customer_id;` —
> liefert in der gesamten Tabelle **0** (es existieren keine `reservation`-Tx-Zeilen).

### Q9 — Monthly_auto-Detail-Listing je Kunde/Monat (§4, Spalten earliest/created)

```sql
SELECT customer_id, source, year, month, COUNT(*) AS rows,
       SUM(amount_cents)::int AS total_cents,
       MIN(valid_from) AS earliest, MAX(valid_from) AS latest,
       MIN(created_at) AS created_min, MAX(created_at) AS created_max
FROM budget_allocations
WHERE budget_type='entlastungsbetrag_45b'
  AND source IN ('monthly','monthly_auto')
  AND deleted_at IS NULL
GROUP BY customer_id, source, year, month
ORDER BY customer_id, year, month
LIMIT 100;
```

### Q10 — Top-10 kombinierte Drift (§5)

```sql
WITH phantom AS (
  SELECT bt.customer_id,
         SUM(ABS(bt.amount_cents))::int AS phantom_cents,
         COUNT(*) AS phantom_count
  FROM budget_transactions bt
  LEFT JOIN budget_transactions orig ON orig.id = bt.reversed_transaction_id
  LEFT JOIN appointments a ON a.id = COALESCE(orig.appointment_id, bt.appointment_id)
  WHERE bt.transaction_type = 'reversal'
    AND (orig.id IS NULL OR a.id IS NULL OR a.deleted_at IS NOT NULL
         OR (SELECT COUNT(*) FROM budget_transactions rr
             WHERE rr.reversed_transaction_id = bt.reversed_transaction_id
               AND rr.transaction_type='reversal') > 1)
  GROUP BY bt.customer_id
),
monthly_drift AS (
  SELECT customer_id, SUM(amount_cents)::int AS phantom_alloc_cents
  FROM budget_allocations
  WHERE budget_type='entlastungsbetrag_45b'
    AND source IN ('monthly','monthly_auto')
    AND deleted_at IS NULL
  GROUP BY customer_id
)
SELECT c.id, c.vorname, c.nachname,
       COALESCE(p.phantom_cents,0) AS phantom_cents,
       COALESCE(p.phantom_count,0) AS phantom_count,
       COALESCE(m.phantom_alloc_cents,0) AS phantom_alloc_cents,
       (COALESCE(p.phantom_cents,0) + COALESCE(m.phantom_alloc_cents,0)) AS total_drift_cents
FROM customers c
LEFT JOIN phantom p ON p.customer_id = c.id
LEFT JOIN monthly_drift m ON m.customer_id = c.id
WHERE COALESCE(p.phantom_cents,0) > 0 OR COALESCE(m.phantom_alloc_cents,0) > 0
ORDER BY total_drift_cents DESC
LIMIT 20;
```

### Q11 — Reversal-Notes-Patterns (§1, Notes-Analyse)

```sql
SELECT notes, COUNT(*) AS n
FROM budget_transactions
WHERE transaction_type='reversal'
GROUP BY notes
ORDER BY n DESC
LIMIT 20;
```

### Q12 — Audit-Log-Quervalidierung (§6 H1/H4)

```sql
SELECT action, COUNT(*) AS n, MIN(created_at), MAX(created_at)
FROM audit_log
WHERE action ILIKE '%reconcil%' OR action ILIKE '%import%'
   OR action ILIKE '%rebook%' OR action ILIKE '%budget%'
GROUP BY action
ORDER BY n DESC
LIMIT 30;
```

## 9. Caveat

- Produktion ist Replica — Zeitpunkt-Snapshot vom 27.05.2026. Bei sehr frischen Writes (letzte Minuten) kann Drift kurzfristig auftauchen oder verschwinden.
- Soft-gelöschte Termine und Transaktionen wurden in `Phantom-Stornos` und `Doppel-Konsum` bewusst je nach Frage berücksichtigt oder ausgeschlossen — siehe Definitionen je Abschnitt.
- Audit-Log (Tabelle ist `audit_log` singular, nicht `audit_logs`) hat zum 23.02.2026 keinen passenden Eintrag — der Backfill von H1 lief am Audit-Layer vorbei.

---

## 10. Nachtrag — Task #987: Phantom-Storno-Korrektur (Verbrauch zu niedrig)

- **Stand:** 05.06.2026
- **Datenquelle:** Produktion (READ-ONLY für Diagnose + Verifikation)
- **Scope:** Append-only-Korrektur der in §1 beschriebenen verwaisten Stornos.

### 10.1 Problem (präzisiert)

Verwaiste Reversal-Zeilen (`reversed_transaction_id IS NULL`, Notiz „Storno von
Transaktion #N") schreiben denselben Verbrauch ein **zweites Mal gut**, wenn die
referenzierte Original-Buchung tatsächlich verbraucht bleibt. Der partielle
Unique-Index `budget_transactions_reversal_unique_idx` greift nur für
Reversals mit **gesetztem** Link und übersieht die NULL-Link-Waisen. Folge:
Netto-Verbrauch zu niedrig, Restguthaben zu hoch (Kunde 39 zeigte 587,02 €
statt 609,84 €).

### 10.2 Authoritative Messung (READ-ONLY, vor Korrektur)

Maß: pro Kunde/Topf `drift = true_used − net_used`, mit
`net_used = Σ|consumption+write_off| − Σ|reversal|` und
`true_used = Σ|consumption, die NICHT per Link storniert ist|`.

Eine Waise wird als **Phantom** klassifiziert (zu korrigieren), wenn die
referenzierte Original-Buchung **(a)** zusätzlich regulär (verknüpft) storniert
ist **ODER (b)** zu einem real geleisteten (lebenden) Termin gehört
(`deleted_at IS NULL AND status <> 'cancelled'`). Ein **Einzel-Storno eines
stornierten/gelöschten Termins** wäre legitim und wird übersprungen — im
Bestand kam dieser Fall nicht vor (alle 28 Waisen sind Phantom).

| Kunde | Topf | Phantom-Waisen | Phantom-Gutschrift |
|---|---|---:|---:|
| 95 | entlastungsbetrag_45b | 10 | 541,44 € |
| 72 | entlastungsbetrag_45b | 4 | 169,50 € |
| 52 | entlastungsbetrag_45b | 1 | 125,90 € |
| 95 | ersatzpflege_39_42a | 2 | 114,00 € |
| 92 | entlastungsbetrag_45b | 2 | 111,47 € |
| 77 | entlastungsbetrag_45b | 3 | 93,70 € |
| 106 | entlastungsbetrag_45b | 1 | 81,60 € |
| 58 | entlastungsbetrag_45b | 2 | 80,98 € |
| 136 | entlastungsbetrag_45b | 1 | 68,64 € |
| 76 | entlastungsbetrag_45b | 1 | 62,95 € |
| 39 | entlastungsbetrag_45b | 1 | 22,82 € |
| **Σ** | | **28** | **1.473,00 €** |

Kunde 39: `net_used` 587,02 € + 22,82 € = **609,84 €** (Soll erreicht).

### 10.3 Korrektur (GoBD, append-only)

Pro Phantom-Waise eine inverse Ausgleichsbuchung (`consumption`) mit
vorzeichen-invertierten Beträgen **und allen Service-Spalten**
(`hauswirtschaft/alltagsbegleitung` Minuten+Cents, `travel/customer`
Kilometer+Cents). Σ(Waise + Korrektur) = 0 je Spalte → der Verbrauch wird wieder
gezählt, die ursprüngliche Waise bleibt revisionssicher stehen. Notiz mit
eindeutiger Idempotenz-Markierung „verwaisten Storno #<id> (ref #<N>)".

- **Skript:** `server/scripts/reconcile-phantom-stornos.ts`
  (Trockenlauf-Default; `--apply` erfordert `--user=<superadmin-id>` +
  `--reason="…"` ≥10 Zeichen; Audit-Log pro Korrektur + Sammel-Batch).
- **Kernlogik (SSoT, rein):** `shared/domain/budget/phantom-storno.ts`
  (genutzt von Skript, Schreib-Guard und Drift-Test).
- **Prävention:** `reverseBudgetTransaction` erkennt jetzt auch Note-basierte
  Waisen-Stornos derselben Original-Buchung und verhindert ein zweites Storno.
- **Drift-Test:** `tests/architecture/phantom-storno-detector.test.ts`
  schlägt an, sobald Waise + verknüpfte Storno-Zeile derselben Buchung auftritt.

### 10.4 Verifikation nach `--apply` (Produktion, READ-ONLY)

> Nach scharfem Lauf auszufüllen — pro Kunde/Topf `net_used == true_used`
> bestätigen, Kunde 39 = 609,84 €, Σ neu gebuchter Korrekturen = 1.473,00 €,
> Audit-Batch-ID notieren.
