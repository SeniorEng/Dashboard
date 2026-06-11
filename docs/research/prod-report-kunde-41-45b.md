# Prod-Lese-Report: Kunde 41 — §45b-Selbstzahler-Altlast

> **Status: NUR LESEN — keine Prod-Schreibzugriffe.**
> Entscheidungsvorlage für Alrik. Remediation (Transition/Deaktivieren der
> offenen §45b-Zeile) erst **nach Freigabe** — **kein Delete**, sondern
> append-only Versionierung (#1169). Erstellt am 2026-06-11 über die
> read-only Prod-Replica (database-Skill, `environment: "production"`).

## Kontext

`PUT /api/budget/:customerId/type-settings` lieferte in Prod einen 500, wenn ein
reiner Deaktivier-Payload auf eine **nicht existierende** Kunden-ID zielte
(FK-Verletzung statt sauberem 404). Die ursprünglich gemeldeten IDs
138911/145919/203042 sind **Dev-Kunden** (in Prod laufen die IDs nur 39–213 und
diese drei existieren dort nicht). Die echte Selbstzahler-Altlast in Prod ist
**Kunde 41**: ein Selbstzahler mit einer offenen, aktiven §45b-Zeile, die
fachlich nicht zu einem Selbstzahler passt.

Die Route-Robustheit (404 statt 500) und die Dev-Bereinigung sind in dieser
Aufgabe erledigt. Dieser Report dokumentiert ausschließlich den Prod-Befund zu
Kunde 41 als Grundlage für die spätere Freigabe.

## Stammdaten

| Feld | Wert |
|---|---|
| ID | 41 |
| Name | Testkundin, Erika |
| Abrechnungsart (`billing_type`) | `selbstzahler` |
| Pflegegrad | 2 |
| Status | `aktiv` |

## §45b-Settings-Historie (`customer_budget_type_settings`)

| id | budget_type | enabled | priority | monthly_limit_cents | valid_from | valid_to | created_at |
|---|---|---|---|---|---|---|---|
| 25 | entlastungsbetrag_45b | **true** | 1 | _NULL_ | 1970-01-01 | _NULL_ (offen) | 2026-02-12 |

- Genau **eine** §45b-Zeile, **offen** (`valid_to = NULL`) und **aktiv**
  (`enabled = true`).
- Kein Monatslimit gesetzt (`monthly_limit_cents = NULL` → statutorischer
  Default-Cap würde greifen).
- Keine weiteren Töpfe (§45a / §39+§42a) für Kunde 41 vorhanden.

## §45b-`budget_transactions`

| Kennzahl | Wert |
|---|---|
| Anzahl Zeilen (alle `transaction_type`) | **0** |
| Σ `amount_cents` | **0** |
| Σ `amount_cents` (nur `consumption`) | **0** |

**→ Verbrauch = 0.** Es existiert über **alle Töpfe** hinweg keine einzige
`budget_transactions`-Zeile für Kunde 41.

## Rechnungen / Positionen mit Bezug auf den §45b-Topf

- Rechnungen für Kunde 41 gesamt: **keine**.
- Rechnungen mit `budget_type = 'entlastungsbetrag_45b'`: **keine**.
- Damit auch keine `invoice_line_items` mit §45b-Bezug.

## Bewertung & Empfehlung (zur Freigabe)

- Die offene §45b-Zeile ist **folgenlos**: kein Verbrauch, keine Allokationen,
  keine Rechnungen referenzieren sie. Eine Deaktivierung hat keine
  fachlichen/finanziellen Seiteneffekte.
- **Empfohlene Remediation nach Freigabe:** die §45b-Zeile über die reguläre
  Route (`PUT …/type-settings`, Deaktivier-Payload) auf `enabled = false`
  **transitionieren** — Vorgängerzeile sauber schließen, neue Zeile anhängen
  (append-only, GoBD-konform). **Kein** rohes UPDATE/DELETE der Zeile 25 (#1169).
- Bis zur Freigabe: **keine Prod-Änderung**.
