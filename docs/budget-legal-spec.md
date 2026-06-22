# Budget — Rechts-Spezifikation (Stand 2026)

Maßgebliche Spezifikation der gesetzlichen Beträge und Anspruchsregeln für die
vier Budget-Regeln von CareConnect. Dieses Dokument ist die **Quelle der
Wahrheit** für die Beträge; die Code-Konstanten in
[`shared/domain/budgets.ts`](../shared/domain/budgets.ts) tragen Rückverweise
(`// R-45B`, `// R-45A`, `// R-39`, `// R-SZ`) und werden über den
Spec-Conformance-Test
[`tests/architecture/budget-legal-spec-conformance.test.ts`](../tests/architecture/budget-legal-spec-conformance.test.ts)
gegen die hier dokumentierten Beträge geprüft (bricht CI bei Drift).

> **Read-only Artefakt.** Dieses Dokument ändert kein Verhalten. Beträge ändern
> heißt: hier ändern, Konstante ändern, Conformance-Test grün halten — in einem
> Schritt.

Alle Beträge sind ausnahmslos **Integer-Cents** (keine Floats/Euro-Strings).

---

## R-45B — §45b SGB XI Entlastungsbetrag

- **Betrag:** 131,00 €/Monat = **13.100 Cents**.
- **Code-Konstante:** `BUDGET_45B_MAX_MONTHLY_CENTS = 13100`.
- **Anspruch:** alle Pflegegrade 1–5 (auch PG1).
- **Charakter:** monatlicher Anspruch; nicht verbrauchte Beträge sind innerhalb
  des Kalenderjahres übertragbar (Carryover), Rest des Vorjahres verfällt zum
  30.06. des Folgejahres (§45b-Verfallslogik, siehe
  [`docs/architecture/budget.md`](architecture/budget.md)).
- **Kein Chaining (Task #1392):** Ein Restguthaben aus Quelljahr Y verfällt zu
  **seiner eigenen** Frist 30.06.(Y+1) und rollt **niemals** weiter in einen
  Y+2-Übertrag. Nur das im jeweiligen Jahr selbst entstandene Guthaben ist
  übertragbar; ein bereits hereingerollter Übertrag wird nicht erneut
  weitergerollt. Übertrag und Startwert desselben Quelljahrs zählen genau einmal.
- **Onboarding-Baseline:** Für einen nie eingerichteten Kunden wird der zur
  Laufzeit aus der Pflegegrad-Historie abgeleitete Anker auf den 1.1. des
  laufenden Jahres gebodet (`floorAutoAnchor45bToCurrentYear`) — es wird kein
  Vorjahres-Übertrag automatisch materialisiert. Ein echtes Restguthaben trägt
  der Operator explizit (audit-pflichtig) ein.

## R-45A — §45a SGB XI Umwandlungsanspruch

- **Betrag:** bis zu **40 % der nicht genutzten Pflegesachleistung nach §36 SGB XI**,
  je Pflegegrad (monatlicher Cap):

  | Pflegegrad | §36-Sachleistung/Monat | §45a-Cap (40 %) | Cents |
  |---|---|---|---|
  | PG1 | — (kein Anspruch) | 0,00 € | `0` |
  | PG2 | 796,00 € | 318,40 € | `31840` |
  | PG3 | 1.497,00 € | 598,80 € | `59880` |
  | PG4 | 1.859,00 € | 743,60 € | `74360` |
  | PG5 | 2.299,00 € | 919,60 € | `91960` |

- **Code-Konstante:** `BUDGET_45A_MAX_BY_PFLEGEGRAD` (Reader:
  `get45aMaxForPflegegrad(pflegegrad)`).
- **Anspruch:** erst **ab Pflegegrad 2** (PG1 = 0).
- **Charakter:** monatlicher Cap; Opt-in pro Kunde (default-deaktiviert, siehe
  R-Aktivierung im SSoT-Audit).

## R-39 — §39/§42a SGB XI Gemeinsamer Jahresbetrag (Verhinderungs-/Kurzzeitpflege)

- **Betrag:** 3.539,00 €/Jahr = **353.900 Cents** (gemeinsamer Jahresbetrag seit
  01.07.2025 durch das Pflegeunterstützungs- und -entlastungsgesetz, PUEG).
- **Code-Konstante:** `BUDGET_39_42A_MAX_YEARLY_CENTS = 353900`.
- **Anspruch:** ab Pflegegrad 2.
- **Charakter:** Jahres-Cap; Opt-in pro Kunde (default-deaktiviert).

## R-SZ — Selbstzahler / privater Anteil

- **Betrag:** keiner — Selbstzahler haben **keinen Anspruch** auf die
  gesetzlichen Pflegekassen-Töpfe (§45b/§45a/§39+§42a sind SGB-XI-Leistungen).
- **Code-SSoT:** `isPrivatePaymentAllowed(...)` und `validateSelbstzahlerBudget(...)`
  in [`shared/domain/budget-selbstzahler-validator.ts`](../shared/domain/budget-selbstzahler-validator.ts).
- **Regel:** Ein privater (19 %-USt-)Anteil ist nur erlaubt, wenn der Kunde
  grundsätzlich privat zahlt — `billingType === "selbstzahler"` ODER
  `acceptsPrivatePayment === true`. Ein „Rest", der bei einem reinen
  Pflegekassen-Kunden ohne `acceptsPrivatePayment` nicht in die gesetzlichen
  Töpfe passt, MUSS blockieren (keine stille Privatrechnung).
- **USt:** Die USt hängt am Budget-Topf (Kasse = steuerbefreit §4 Nr. 16,
  privat = 19 %), nicht am `billingType` — Detail:
  [`docs/architecture/budget.md`](architecture/budget.md).

---

## Querverweise

- Budget-Architektur (Pot-Regeln, Historisierung, Cascade, Selbstzahler, SSoT):
  [`docs/architecture/budget.md`](architecture/budget.md)
- SSoT-Vollständigkeits-Audit (welcher Code beantwortet welche Frage):
  [`docs/budget-ssot-audit.md`](budget-ssot-audit.md)
- SSoT-Inventur/Beschlüsse: [`docs/budget-ssot-inventory.md`](budget-ssot-inventory.md)
