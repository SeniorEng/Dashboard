# Gate-2 Diagnose — Schatten-Diff der KONSOLIDIERTEN `priceFor` (Phase 3.3, READ-ONLY)

**Status:** ✅ GRÜN — Gate 2 ist 0-Cent-wertgleich zum heutigen Verhalten. Keine Abweichungen, keine verschatteten Vertragssätze. Kein `--apply`, keine Konsolidierung, keine Löschung, kein Code geändert. Reine Entscheidungsvorlage für Alriks Freigabe.
**Skript:** `server/scripts/shadow-diff-price-for-consolidated.ts` (`runGate2Diff`), Lader `buildConsolidationReport` aus `report-price-consolidation-conflicts.ts`.
**Parameter:** `--months=12` · Stichtag (asOf) = **2026-06-15** · Termin-Fenster ab **2025-06-15**.
**Quelle:** Production read replica (read-only, `executeSql environment:"production"`). Das TS-Skript erreicht über seine `db`-Instanz nur die (synthetisch reseedete) Dev-DB; daher wurde die Skript-Logik 1:1 gegen die echten Prod-Daten repliziert — identisches Vorgehen wie beim #1295-Re-Run.
**Erzeugt:** 2026-06-15.

> **Datenschutz (DSGVO):** Versioniert und daher **pseudonymisiert**. Kunden-IDs sind durch Aliasse ersetzt (Kunde A / Kunde B); Services per Katalog-Code benannt. Keine personenbezogenen Daten.

## Ergebnis (Kernkennzahlen)

| Kennzahl | Wert |
|---|---|
| **Abweichungen konsolidiert vs heute (0-Cent-Gate)** | **0** |
| **Verschattete Vertragssätze (csp & ccr beide aktiv + abweichend)** | **0** |
| **Abdeckungspunkte gesamt** | **1215** |

**Fazit:** GATE 2 GRÜN. Die fertig konsolidierte Auflösung (`csp → ccr → service_rates(Standard) → Katalog-Default`) reproduziert das heutige Live-Verhalten **wertneutral**. Ein Cutover wäre — nach Freigabe — 0-Cent-neutral.

### (1) Abweichungen konsolidiert vs heute: **0**

Keine bisher dormante Quelle würde durch die Konsolidierung eine Preisänderung aktivieren. Es gibt daher **keine** je-Zeile-Entscheidung für Alrik (keine Tabelle Kunde/Service/heute→konsolidiert/Quelle/triggeredRowId/Gültigkeit, weil 0 Zeilen).

**Warum 0 (deterministisch):** Die einzige am Stichtag potenziell aktivierbare dormante Quelle sind zwei `customer_contract_rates`-Zeilen von **Kunde A**. Beide treffen exakt den Katalog-Default des jeweiligen Service:

| Kunde | Service | csp @asOf | ccr @asOf | Katalog-Default | konsolidiert | heute | Δ |
|---|---|---|---|---|---|---|---|
| Kunde A | hauswirtschaft | — (keine) | 3800 ct/h | 3800 ct/h | 3800 | 3800 | **0** |
| Kunde A | alltagsbegleitung | — (keine) | 4200 ct/h | 4200 ct/h | 4200 | 4200 | **0** |

Da `ccr == Katalog-Default`, ist `baseline == consolidated` an jedem Abdeckungspunkt → keine Abweichung. `service_rates` (Standard-Scope) ist **leer** (0 Zeilen) → von dort kann ohnehin keine Abweichung kommen.

### (2) Verschattete Vertragssätze: **0**

Es existiert am Stichtag kein `(Kunde, Service)`-Paar, bei dem `customer_service_prices` UND `customer_contract_rates` gleichzeitig aktiv sind und abweichen. (Der einzige csp-Eintrag von Kunde A für hauswirtschaft war auf `validTo = 2026-05-26` befristet und ist am Stichtag 2026-06-15 nicht mehr aktiv; sein ccr-Pendant deckt sich zudem mit dem Katalog-Default.) Es gibt also keine ccr-Zeile, die unter der `csp-gewinnt`-Präzedenz verworfen würde.

### (3) Abdeckungspunkte: **1215**

Deduplizierte Tripel `customerId × serviceId × date` aus:
- 1321 reale Termin-Service-Tupel der letzten 12 Monate (≥ 2025-06-15, Kunde nicht null), dedupliziert,
- 2 `(Kunde, Service)`-Paare aus `customer_contract_rates` am Stichtag,
- 0 Services aus `service_rates` (Standard) am Stichtag.

### Quell-Inventar (Prod, am Stichtag gelesen)

| Quelle | Zeilen |
|---|---|
| `customer_service_prices` (nicht soft-deleted) | 2 |
| `customer_contract_rates` (über `customer_contracts` gejoint) | 2 |
| `service_rates` (firmenweiter Standard) | **0** |
| Termin-Service-Tupel (≥ 2025-06-15) | 1321 |
| Nicht abbildbare Kategorien (ccr/sr ohne Katalog-Service) | 0 |

## ✅ Einheiten-Konsistenz: ja, apples-to-apples (pro Service)

**Bestätigt:** Für ein und denselben Service tragen alle Quellen **dieselbe Einheit** — den Pro-Einheit-Satz gemäß `services.unit_type`. Der Diff vergleicht damit Gleiches mit Gleichem.

**Beleg aus dem Konsumpfad** (`server/storage/budget/appointment-cost-calculator.ts`, `calculateAppointmentCost`): der aufgelöste Preis wird **immer** als Pro-Einheit-Satz verrechnet —
`Stunden-Cent = round((Minuten/60) × satz)` und `km-Cent = computeKmLineTotalCents(km, satz)` — **unabhängig davon, aus welcher Quelle** der Satz stammt. Es gibt keinen Pfad, der `customer_service_prices.priceCents` oder `services.defaultPriceCents` als Pauschale (pro Termin) statt als Pro-Einheit-Satz behandelt.

**Beleg aus dem Katalog (Prod):**

| Service | unit_type | default_price_cents | billable | tritt in ccr/sr auf? |
|---|---|---|---|---|
| hauswirtschaft | hours | 3800 (= ct/Std) | ja | ja (Kategorie) |
| alltagsbegleitung | hours | 4200 (= ct/Std) | ja | ja (Kategorie) |
| erstberatung | hours | 0 | **nein** | Kategorie vorhanden, aktuell 0 Zeilen |
| travel_km | kilometers | 35 (= ct/km) | ja | nein |
| customer_km | kilometers | 35 (= ct/km) | ja | nein |

Daraus folgt:
- `customer_contract_rates.hourly_rate_cents` und `service_rates.hourly_rate_cents` sind **€/Stunde**. Sie mappen ausschließlich auf die drei Kategorien `hauswirtschaft`/`alltagsbegleitung`/`erstberatung` — alle `unit_type = hours`. Dort sind `customer_service_prices.priceCents` und `services.defaultPriceCents` **ebenfalls €/Stunde** ⇒ Vergleich €/Std gegen €/Std.
- Die km-Services (`travel_km`/`customer_km`, `unit_type = kilometers`, €/km) haben **keine** ccr/sr-Kategorie. Sie lösen nur über `csp → Katalog` auf; eine Stunden-vs-km-Vermischung ist strukturell ausgeschlossen.
- **Nuance `erstberatung`:** `unit_type = hours`, aber `is_billable = false` ⇒ heute löst es auf 0 auf. Ein künftiger `service_rates`-Stundensatz hierfür wäre einheiten­konsistent (€/Std), würde aber einen von 0 abweichenden Preis **aktivieren** (eine *Verhaltens*-Abweichung, keine Einheiten-Inkonsistenz). Aktuell existieren **keine** `service_rates`-Zeilen, daher ist der Punkt heute gegenstandslos — wäre aber bei künftiger Befüllung erneut über Gate 2 zu prüfen.

## Abgrenzung / GoBD

- Rein lesend. Keine fakturierten Snapshots werden neu berechnet; keine Buchung/kein Beleg verändert.
- Gate 2 simuliert nur die prospektive Auflösung; die finale Präzedenz und jede etwaige Aktivierung bleiben Alriks Entscheidung.

## Empfehlung

Gate 2 ist **sauber (0 Cent, 0 verschattet)** und ergänzt damit Gate 1. Beide Gates des Zwei-Gate-Freigabekriteriums (`docs/pricing-ssot.md`) sind erfüllt. Eine spätere Konsolidierung der drei Tabellen wäre wertneutral — bleibt aber **menschlich freizugeben** und ist **nicht Teil dieses Laufs**. Kein `--apply`, keine Konsolidierung, keine Löschung.
