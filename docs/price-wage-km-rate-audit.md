# Preis-/Lohn-/km-Satz-Audit (SSoT-Vollständigkeit)

App-weiter, read-only durchgeführter Audit: **Jede** angezeigte, berechnete oder
gebuchte Rate (Preis, Lohn/Stundensatz, km-Satz) MUSS ausschließlich aus den
SSoT-Resolvern (`priceFor` / `wageFor`) bzw. der Katalog-/Preis-/Lohn-Tabelle
stammen — NIE aus einer hartcodierten Zahl oder einem Dummy-Fallback.

Auslöser: Screenshot „Wirtschaftlicher Überblick" mit Raten 38,00 € / 16,00 € /
0,35 € (= 3800 / 1600 / 35 Cent). Frage: Sind diese Werte hartcodiert oder
kommen sie aus der Tabelle?

## Klassifikation pro Fund

Jeder Fund ist klassifiziert als:
- **kosmetisch** — hartcodierter Wert == Tabellenwert; gefahrloser Refactor auf
  den Resolver möglich.
- **wertändernd** — hartcodierter Wert ≠ Tabellenwert; echter Geld-Bug → nur
  melden, NICHT stillschweigend ändern (GoBD: keine rückwirkende Änderung
  versiegelter/abgeschlossener Perioden).

## SSoT-Referenzwerte (Katalog)

`shared/config/services.ts` ist die Katalog-SSoT und die legitime Heimat der
Rate-Literale:

| Leistung | Preis (Kunde) | Lohn (Mitarbeiter) |
|---|---|---|
| Hauswirtschaft (HW) | 3800 ct/h | 1600 ct/h |
| Alltagsbegleitung (AB) | 4200 ct/h | 1800 ct/h |
| Kilometer (km) | 35 ct/km | 30 ct/km |

Label-Semantik der Anzeige: ein angezeigter Preis ist entweder der
**kundenaufgelöste** Wert (Kunden-Sonderpreis → firmenweiter Standardpreis) oder
der **Katalog-Standard** als unterster Fallback — beide kommen über `priceFor`
aus derselben Quelle, nie aus einer parallelen Rechnung.

## Befunde

### Live-Produktivpfade — SAUBER (keine Funde)

| Pfad | Ergebnis |
|---|---|
| `server/storage/statistics/economics.ts` | Raten per SQL aus `services`-Tabelle — keine Literale |
| `server/storage/billing/economics-reader.ts` | Raten per SQL aus `services`-Tabelle — keine Literale |
| `server/services/invoice-data.ts` | Auflösung über `priceFor`; wirft bei fehlendem Preis (alter `?? 35`-km-Fallback bereits entfernt) |
| `shared/domain/invoice-line-items.ts` | km-Quantisierung, keine Rate-Literale |
| `server/storage/budget/appointment-cost-calculator.ts` | Auflösung über Resolver |
| `server/routes/standard-prices.ts` | Liest/schreibt nur die `prices`-SSoT (zeitversioniert) |
| `server/routes/role-wage-rates.ts` | Liest/schreibt nur die `role_wage_rates`-SSoT |
| `server/routes/services.ts` | Katalog-Identität read-only (403 auf POST/PUT) |
| `client/src/features/billing/components/economics-overview-card.tsx` | nur `formatEuroDE` + Reader-Output |
| `client/src/features/billing/utils.ts` | `>= 35` / `>= 50` sind Margin-Farbschwellen, keine Raten (außerhalb des Scopes) |

**Wertändernde Funde: 0. Kosmetische Funde in Live-Pfaden: 0.** Die im
Screenshot gezeigten Raten kommen über den Economics-Reader aus der
`services`-Tabelle — korrekt, nicht hartcodiert.

### Legitime Literale (keine Änderung)

| Ort | Werte | Einordnung |
|---|---|---|
| `shared/config/services.ts` | 3800/1600/4200/1800/35/30 | Die Katalog-SSoT selbst — korrekte Heimat |
| `server/startup/recover-prices-from-backup.ts` | 3800/4200 | Einmaliges Recovery-Skript (Soll-Wert-Assertions) |
| `tests/**` | diverse | Test-Fixtures |
| Urlaubs-/Fälligkeitstage (`?? 30`) | 30 | Kein Preis/Lohn/km-Satz — außerhalb des Scopes |

## Fazit & getroffene Maßnahme

Die Architektur ist durch frühere Konsolidierungen bereits diszipliniert
(ein Preis-Resolver, ein Lohn-Resolver, tabellengetriebene Economics-Reader,
Entfernung des km-Fallbacks). Es gab **keine** wertändernden Bugs und **keine**
hartcodierten Raten in Live-Pfaden, daher waren keine kosmetischen Code-Fixes in
Produktivpfaden nötig.

Diese Inventur wurde dem Nutzer vor jeder potenziell wertändernden Änderung zur
Freigabe vorgelegt; Entscheidung: ausschließlich die Architektur-Schranke
ergänzen. Versiegelte/abgeschlossene Perioden bleiben unberührt.

Als Regressionsschutz wurde der Architektur-Guard erweitert: siehe
`tests/architecture/calculations-in-shared.test.ts` (verbietet hartcodierte
Preis-/Lohn-/km-Satz-Magic-Numbers außerhalb der Katalog-SSoT; Inline-Escape
`// rate-literal-allowed: <Grund>` für begründete Ausnahmen).
