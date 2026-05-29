> **Refresh #822 (2026-05-29):** Deep-Dive-Refresh dieses Chunks. Ersetzt den vorherigen Pattern-Scan (#481 @`3e0d3fb`). Maßgeblich bleibt `../REPORT.md` für die konsolidierten Severity-Counts.

# Chunk 11 — Statistics & Cockpit

**Tiefenstufe:** Deep (Refresh #822 — Gap-Fill Code-Walk)
**Commit:** `178b2574`
**Risiko:** MITTEL
**LOC / Files:** ~6 922 / 25 (`server/lib/statistics/*`, `server/routes/statistics.ts`, `server/routes/v2/index.ts`, Cockpit-Lib)
**Code-Walk:** `common.ts`, `revenue.ts`, `performance.ts`, `cockpit.ts`, `process-health.ts`, `team-workload.ts`, Statistics-Route, v2/index.ts

## Befunde

- ⚠️ **MITTEL — Irreführende YoY/Prev-Deltas für Snapshot-KPIs** (`server/lib/statistics/process-health.ts:133-135`, vgl. `:26-27`, `:147`): Die Kennzahlen `total` und `customersWithoutEmployee` sind **periodenunabhängige Snapshots** (aktueller Bestand), werden aber in dieselbe `prev`/`yoy`-Delta-Mechanik gespeist wie periodengebundene KPIs. Die so berechneten Vorjahres-/Vormonats-Deltas sind fachlich bedeutungslos (Snapshot vs. nicht-vergleichbares Zeitfenster). Die UI suggeriert damit eine Trendaussage, die die Daten nicht hergeben.
  - **Folge:** Snapshot-KPIs aus der Delta-Darstellung herausnehmen ODER explizit als „aktueller Bestand (kein Trend)" labeln.

- ⚠️ **MITTEL — Korrelierte Preis-Lookup-Subquery pro Service-Zeile (Perf-Hotspot)** (durchgängig in den Revenue-/Performance-Aggregationen, `server/lib/statistics/revenue.ts`, `performance.ts`): Jede Statistik-Aggregation führt eine korrelierte `csp`-Preisvereinbarungs-Subquery **pro `appointment_service`-Zeile** aus, ohne deckenden Index auf dem Lookup-Pfad. Skaliert mit wachsendem Termin-Volumen super-linear. Cross-Ref REPORT **M5** (fehlende Indizes).
  - **Folge:** Deckenden Index für den Preis-Lookup ergänzen ODER Preise vorab in eine Map joinen statt korrelierter Subquery.

- ⚠️ **MITTEL — Hohe parallele DB-Last pro Statistik-Request** (`server/routes/statistics.ts`, `revenue.ts`): Ein Revenue-Request löst ~14–17 nebenläufige `db.execute`-Aufrufe aus. Unter dem 300-req/15min-Rate-Limit unkritisch, aber bei mehreren gleichzeitigen Admin-Sessions Pool-Druck (vgl. Neon-Pool-Findings Chunk 16).
  - **Folge:** Verwandte Aggregationen in weniger Roundtrips bündeln (gemeinsame CTE/Materialisierung).

- ⚠️ **MITTEL (Cross-Ref H3) — Rundungsdrift via `monthly_work_hours`** (`server/lib/team-workload.ts`, `computeSollIst`): Konsumiert `monthly_work_hours` als `real`/float (REPORT **H3**: Spalte sollte `numeric` sein). Die Soll/Ist-Berechnung erbt die Float-Ungenauigkeit → Rundungsdrift in Auslastungs-Statistik und Team-Workload-Anzeige.
  - **Folge:** Gemeinsam mit H3 (Schema-Migration `real → numeric`) lösen.

- ⚠️ **NIEDRIG — Performance-Stop-Kriterium nicht automatisiert** (Bestand aus #481): P95 ≤ 800 ms für `/api/admin/statistics/*` wird nicht in CI gemessen; Aggregations-Korrektheit gegen Rohdaten ist weiterhin manuelle Stichprobe.

- ✅ Auth/Scoping: Statistik-Routen sind admin-/teamlead-gegated; keine ungeschützten Aggregat-Leaks im Walk gefunden.
- ✅ Datums-Handling der Aggregate verwendet String-basierte Perioden-Grenzen in den geprüften Query-Buildern (keine `new Date()`-TZ-Falle) — Ausnahme: Snapshot-KPIs siehe oben.

## Empfohlener Folge-Task

`[MITTEL] Statistik-Perf & Snapshot-KPI-Korrektheit: (a) deckender Index/Join statt korrelierter csp-Subquery, (b) Snapshot-KPIs aus YoY/Prev-Delta nehmen/labeln, (c) DB-Roundtrips pro Revenue-Request bündeln.`
