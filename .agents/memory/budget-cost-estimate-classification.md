---
name: Cost-Estimate Klassifikation
description: Klassifikation Selbstzahler / OK / Soft-Private / Hard-Block für die Kostenschätzung lebt als pure Funktion in shared/domain/budget/ — Server-Route ist nur noch Komposition-Wrapper.
---

# Cost-Estimate-Klassifikation: pure Funktion in shared/domain/

Die vier Branches der Kostenschätzung — `selbstzahler`, `ok`, `soft_private`
(Privat-Anteil bei Engpass + acceptsPrivatePayment), `hard_block` (Engpass
ohne PrivatPayment) — werden NICHT inline in der `/cost-estimate`-Route
berechnet, sondern über `classifyCostEstimate()` aus
`shared/domain/budget/cost-estimate-outcome.ts`.

## Warum
- Inline-Logik mit Warning-Strings ist nicht unit-testbar und nicht von
  Equality-Tests aufrufbar (DB-Roundtrip nötig).
- Wenn die Klassifikation jemals an einer zweiten Stelle gebraucht wird
  (clientseitige Live-Preview, Bulk-Termin-Validator), duplizierte sich sonst
  das deutsche Warning-Wording inkl. `formatEuroDE`-Format.
- Querschnitts-Auflage für die Budget-Domäne: pure / no-state in
  `shared/domain/`, alle Inputs explizit übergeben.

## Wann anwenden
- Wer einen neuen Pfad baut, der "passt dieser Termin ins Budget oder muss er
  privat berechnet werden?" beantwortet, MUSS `classifyCostEstimate({
  totalCostCents, availableCents, weightedVatRate, acceptsPrivatePayment,
  isSelbstzahler })` rufen — NIEMALS die Strings oder die `> available`-
  Schwelle nachbauen.
- Wire-Shape-Spezialfall: `bruttoCents` wird im Route-Response NUR im
  Selbstzahler-Pfad weitergereicht (Bestands-Wire-Compat — Client-Type
  `CostEstimate.bruttoCents?` ist optional und wird nur im Selbstzahler-Zweig
  gelesen). Die pure Funktion liefert für non-Selbstzahler immer
  `bruttoCents: 0`; der Wrapper entscheidet, was ans Wire geht.
- MwSt-Mathematik: Selbstzahler → VAT auf `totalCostCents`, Soft-Private →
  VAT auf `shortfall` (nicht auf Total). Beides via `Math.round(× /100)`.

## Drift-Schutz
`tests/budget/cost-estimate-outcome.test.ts` deckt alle vier `kind`-Branches
inkl. Wording-Regex und VAT-Rundung ab. Bei einer Regression im Wording
(z.B. Bindestrich-Variante, abweichendes Euro-Format) failed der Test.
