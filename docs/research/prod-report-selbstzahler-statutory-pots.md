# Prod-Lese-Report: Selbstzahler ↔ unzulässige Pflegekassen-Töpfe (systematischer Scan)

> **Status: NUR LESEN — keine Prod-Schreibzugriffe.**
> Systematischer Folge-Scan zu `docs/research/prod-report-kunde-41-45b.md`.
> Erstellt am 2026-06-12 über die read-only Prod-Replica (database-Skill,
> `environment: "production"`). Entscheidungsvorlage für Alrik.

## Auftrag

Selbstzahler haben fachlich keinen Anspruch auf §45b / §45a / §39+§42a. Bei
Kunde 41 wurde eine historisch falsch angelegte, offene §45b-Zeile gefunden und
deaktiviert. Diese Aufgabe prüft systematisch, ob es in Prod **weitere** solche
Altlasten gibt (z.B. vor Einführung der `rejectBudgetIntent`-Validierung in
`server/routes/budget.ts` angelegt).

## Scan-Definition

„Treffer" = Kunde mit `billing_type = 'selbstzahler'`, der in
`customer_budget_type_settings` mindestens **eine OFFENE** (`valid_to IS NULL`),
**aktive** (`enabled = true`) Zeile für einen der drei Pflegekassen-Töpfe
(`entlastungsbetrag_45b`, `umwandlung_45a`, `ersatzpflege_39_42a`) trägt.

## Ergebnis: **0 Treffer** — keine offenen Altlasten

```
SELECT c.id, c.name, s.budget_type, s.enabled, s.valid_from, s.valid_to
FROM customers c
JOIN customer_budget_type_settings s ON s.customer_id = c.id
WHERE c.billing_type = 'selbstzahler'
  AND s.valid_to IS NULL
  AND s.enabled = true
  AND s.budget_type IN ('entlastungsbetrag_45b','umwandlung_45a','ersatzpflege_39_42a');
→ 0 Zeilen
```

Es existiert **kein** Selbstzahler mit einer offenen, aktiven Pflegekassen-Topf-
Zeile. Die einzige je betroffene Selbstzahler-Zeile (Kunde 41) ist bereits sauber
append-only deaktiviert (siehe unten).

## Datengrundlage (Sanity-Check, Prod-Replica 2026-06-12)

| Kennzahl | Wert |
|---|---|
| Kunden gesamt | 172 |
| davon `billing_type='selbstzahler'` | 7 |
| `customer_budget_type_settings` gesamt | 301 |
| `budget_transactions` gesamt | 1053 |

Die 7 Selbstzahler-Kunden: 41 (Testkundin, Erika), 44 (Degenkolb, Alrik),
45 (Test1), 46 (Test2), 177 (Trojahn, Helga), 194 (Theuermeister, Anita),
202 (Bauer, Ullrich).

## Detail-Befunde

### 1. Pflegekassen-Topf-Zeilen aller Selbstzahler (jeder Status)

Nur **ein** Selbstzahler trägt überhaupt jemals eine Pflegekassen-Topf-Zeile:
Kunde 41, §45b. Beide Versionssätze:

| id | budget_type | enabled | valid_from | valid_to | created_at |
|---|---|---|---|---|---|
| 25 | entlastungsbetrag_45b | true | 1970-01-01 | **2026-06-12** (geschlossen) | 2026-02-12 |
| 456 | entlastungsbetrag_45b | **false** | 2026-06-13 | _NULL_ (offen) | 2026-06-12 |

→ Die ursprüngliche offene Zeile (id 25) wurde **append-only** geschlossen, die
neue offene Zeile (id 456) ist `enabled = false`. Damit ist die Remediation aus
`prod-report-kunde-41-45b.md` in Prod **bereits angewandt** und GoBD-konform.

### 2. Verbrauch auf Pflegekassen-Töpfen (alle Selbstzahler)

```
SELECT ... FROM budget_transactions
WHERE customer_id IN (<selbstzahler>)
  AND budget_type IN ('entlastungsbetrag_45b','umwandlung_45a','ersatzpflege_39_42a');
→ 0 Zeilen
```

Kein einziger Selbstzahler hat je auf einem Pflegekassen-Topf gebucht.

### 3. Sonstiger Budget-Verbrauch der Selbstzahler

Zwei Selbstzahler haben Buchungen — ausschließlich auf dem **`private`**-Topf
(fachlich korrekt für Selbstzahler), nicht auf einem Pflegekassen-Topf:

| Kunde | Topf | transaction_type | Zeilen | Σ amount_cents |
|---|---|---|---|---|
| 194 | private | consumption | 4 | −27.716 |
| 202 | private | consumption | 3 | −18.180 |

Die übrigen Selbstzahler (41, 44, 45, 46, 177) haben **0** Budget-Transaktionen.

### 4. Rechnungsbezug

```
SELECT ... FROM invoices i JOIN customers c ON c.id=i.customer_id
WHERE c.billing_type='selbstzahler'
  AND i.budget_type IN ('entlastungsbetrag_45b','umwandlung_45a','ersatzpflege_39_42a');
→ 0 Zeilen
```

Keine Selbstzahler-Rechnung referenziert einen Pflegekassen-Topf.

## Bewertung & Empfehlung

- **Keine weiteren Altlasten.** Außer dem bereits remediierten Kunde 41 gibt es in
  Prod keinen Selbstzahler mit einem (offenen oder geschlossenen) aktiven
  Pflegekassen-Topf, keinerlei Pflegekassen-Verbrauch und keine zugehörigen
  Rechnungen.
- **Keine Aktion nötig.** Es ist **keine** Erweiterung von `PROD_TARGETS` in
  `scripts/deactivate-selbstzahler-45b.ts` erforderlich (kein Treffer, kein
  Freigabebedarf). Kein Delete, kein Roh-UPDATE.
- Die laufzeitseitige `rejectBudgetIntent`-Validierung verhindert künftige
  Neuanlagen dieser Art; dieser einmalige Bestands-Scan bestätigt, dass keine
  historischen Reste übrig sind.
