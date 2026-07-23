# SSoT-Redundanz: Systematische Erkennung & Behebung

Stand: 2026-07-22. Quelle: Online-Recherche (5 Themenfelder) + verifizierter
Repo-Audit (41 Agenten; jeder Duplikats-Befund von einem unabhängigen,
skeptischen Verifikations-Agenten am echten Code geprüft).
Evidenz: [`docs/audits/ssot-2026-07-22/verified-findings.md`](audits/ssot-2026-07-22/verified-findings.md)
(26 bestätigte Verletzungen) · Guard-Inventur & Lücken:
[`docs/audits/ssot-2026-07-22/raw/audit-guards-inventory.md`](audits/ssot-2026-07-22/raw/audit-guards-inventory.md)
· jscpd-Rohanalyse: [`docs/audits/ssot-2026-07-22/raw/jscpd-analysis.md`](audits/ssot-2026-07-22/raw/jscpd-analysis.md)
· Selbstkritik des Audits: [`docs/audits/ssot-2026-07-22/completeness-critic.md`](audits/ssot-2026-07-22/completeness-critic.md).

---

## 0. Kernbefund

**Die SSoT-Schicht selbst ist sauber — die Verletzungen entstehen an den
Call-Sites.** jscpd über 722 Dateien / 184k Zeilen: 2,39 % duplizierte Zeilen
gesamt, aber `shared/` liegt bei ~0,6 % (nahezu klonfrei), während sich
Duplikate in `server/scripts/`, `server/startup/` und zwei Riesen-Routen
konzentrieren. Die 26 bestätigten SSoT-Verletzungen sind überwiegend
**Typ-3-Klone** (kopiert und dann abgewandelt) oder **Typ-4**
(anders geschrieben, gleiche fachliche Frage) — genau die Klasse, die
token-basierte Tools NICHT finden und die heute niemand systematisch sucht.

Warum entstehen trotz „Eine SSoT pro fachlicher Frage" + „Ersetzen statt
hinzufügen" immer wieder Duplikate? Vier strukturelle Ursachen:

1. **Erkennungs-Latenz.** Alle 44 Architektur-Guards feuern in CI, NACHDEM das
   Duplikat geschrieben wurde — und nur für Muster, die ein früherer Vorfall
   hinterlassen hat (incident-getrieben, nicht systematisch). Es gibt heute
   **keinerlei** generische Clone-/Ähnlichkeits-Erkennung.
2. **Nur negative, keine positive Durchsetzung.** Guards verbieten bekannte
   Anti-Muster („kein direkter `customer_budgets`-Read"), aber nichts erzwingt
   die positive Richtung („wer Frage Q beantwortet, MUSS die SSoT
   importieren"). Eine zweite, anders benannte Implementierung passiert alle
   Gates.
3. **Löchriges Substrat.** `npm run lint` prüft nur `client/src` +
   `server/routes` — die ESLint-Blöcke für `server/storage`/`server/services`
   sind tote Config, `shared/` (die SSoT-Schicht!) wird nie gelintet. knip ist
   `continue-on-error`. km-Drift-Equality-Suiten sind bei `CI=true`
   quarantänisiert. Bei fehlenden `TEST_USER_*`-Secrets (Forks) skippen die
   Gates 4/5/8 inklusive fast aller Architektur-Guards **stumm**.
4. **Der SSoT-Katalog ist Prosa.** `docs/budget-ssot-audit.md` &
   `budget-ssot-inventory.md` sind manuell gepflegte Einmal-Dokumente; kein
   Werkzeug liest sie. Die Allowlists leben verstreut in einzelnen Guard-Tests.

Der Plan folgt daraus in drei Strängen: (A) Substrat dichtmachen,
(B) Erkennung in 4 Schichten systematisieren, (C) die 26 Befunde in Wellen
nach festem Playbook konsolidieren — jede Konsolidierung endet mit einem
neuen Guard, sonst wächst das Duplikat nach.

---

## 1. Was bereits existiert (und bleibt)

Die Basis ist ungewöhnlich stark und wird **erweitert, nicht ersetzt**:
44 Architektur-Fitness-Functions (`tests/architecture/`, ast-grep +
Negativ-Test-Muster), ~54 „Anzeige == Buchung"-Drift-Detektoren
(`tests/equality/`), knip, Stryker-Mutation auf Rechenkernen,
Per-File-Coverage-Gates, OpenAPI-Drift-Gate, `deep-analysis`-Audit-Skill.
Das Budget-Domäne ist vorbildlich abgesichert (4 Fragen × SSoT × Guard).
Genau dieses Niveau wird auf die übrigen Domänen skaliert.

---

## 2. Audit-Ergebnis (Evidenz, verifiziert)

**26 bestätigte Verletzungen** (10 Re-Implementierungen von
`shared/utils`-Helfern, 10 parallele Business-Logiken, 7 Client/Server-Drifts;
minus 1 Überschneidung), dazu 3 als INTENTIONAL eingestufte und 1
False-Positive — Details mit `file:line`-Referenzen, Verifikations-Begründung
und Fix-Skizze pro Finding in
[`verified-findings.md`](audits/ssot-2026-07-22/verified-findings.md).

Die P0-Klasse (können divergierende Geld-/Statuswerte produzieren):

| ID | Befund | Erstfundstelle |
|---|---|---|
| util-reimpl-1 | Rohes `service.vatRate`-Brutto-Rechnen im Kunden-Wizard (Task-#1659-Bypass, Guard via `\|\| 0` umgangen) | `client/src/features/customers/components/wizard/budgets-contract-step.tsx:466` |
| util-reimpl-2 | Euro-Eingabe-Parsing per `parseFloat`/`Number` in Buchungsformularen — deutsches Komma wird still abgeschnitten | `client/src/components/budget/BudgetLedgerSection.tsx:1111` |
| util-reimpl-3 | **Zwei divergierende `parseGermanDecimal` innerhalb von `shared/utils` selbst** (Doku-UI vs. Excel-Import parsen denselben String unterschiedlich) | `shared/utils/format.ts:51` |
| util-reimpl-4 | Dritter + vierter Euro-String→Cents-Parser in Payment-Ingestion (Avis/Qonto) — 100×-Fehlerklasse bei Punkt-Dezimalen | `server/services/avis-parser.ts:51` |
| util-reimpl-5 | Fachdaten per UTC-`toISOString().slice(0,10)` statt lokalem `formatDateISO` — TZ-abhängiger Off-by-one | `server/routes/admin/qonto.ts:473` |
| parallel-logic-1 | Phantom-Status `'documented'`: ~50 hand-gerollte SQL-Status-Prädikate parallel zur Status-SSoT | `server/storage/statistics/cockpit.ts:34` |
| parallel-logic-2 | Kundenpreis-Auflösung als SQL-Subquery an 13 Stellen kopiert, semantisch divergierend von der `priceFor`-SSoT | `server/storage/statistics/revenue.ts:21` |
| parallel-logic-3 | Zwei parallele Wirtschaftlicher-Überblick-Reader mit byte-identischen Helfern und divergierenden Gates | `server/storage/statistics/economics.ts:18` |
| parallel-logic-4 | Revenue-Funnel (Geplant/Dokumentiert/Nachgewiesen/Berechnet) 3× implementiert mit divergierenden Stufen-Definitionen | `server/storage/statistics/revenue.ts:60` |
| drift-1 | Minuten-Attribution pro Termin im Day-Detail-Panel als 4. Kopie | `client/src/features/time-tracking/components/day-detail-panel.tsx:44` |
| drift-4 | EU-Rentner-Arbeitszeitgrenzen existieren NUR client-seitig, zweimal, mit inkonsistenten Formeln | `client/src/features/time-tracking/components/day-detail-panel.tsx:113` |
| drift-5 | Termin-`STATUS_LABELS` verdreifacht: shared-SSoT + 2 divergierende Client-Maps | `shared/domain/appointments.ts:68` |

jscpd-Systemfunde außerhalb der 26: `stornoInvoiceDocumentOnly()` komplett
dupliziert in zwei Reconcile-Skripten (73 Zeilen, ~30 Feld-Kopien),
re-implementierter Budget-Ledger-Reader in Skripten (Kommentar gibt es selbst
zu), `routes/billing.ts` mit 14 Selbst-Klonen über die zwei
Rechnungsversand-Pfade, Preis-Gültigkeits-Timeline-Stitching 2×
(service-prices vs. standard-prices), `eur()`-Formatter 6× in Skripten.

Die Guard-Lücken-Inventur (44 Guards gelesen) listet zusätzlich: ganze Domänen
ohne statischen SSoT-Guard (Statistik/Ökonomie, Time-Entries, Urlaub,
Dokumente, Storno-Policy, Importe, Qonto, Lohn-Lesepfad, Rechnungsnummer/
-aggregation), „Ersetzen statt hinzufügen" nur für DB-Tabellen mechanisiert,
Equality-Szenarien hand-enumeriert ohne Registrierungszwang.

---

## 3. Ziel-Architektur: Erkennung in 4 Schichten (+ Substrat)

### Phase 0 — Substrat dichtmachen (zuerst; ~1–2 Tage)

Ohne das erbt jedes neue Gate dieselben Umgehungspfade:

| Maßnahme | Ersetzt (Ersetzungs-Regel) |
|---|---|
| Lint-Scope auf `client/src server shared tests` erweitern; erst `--max-warnings 0` über Suppressions-Baseline halten (s. §5) | Die tote ESLint-Config für `server/storage`/`services` und die ungelintete SSoT-Schicht |
| knip von `continue-on-error` auf blockierend | Den Warn-only-Modus |
| `CI=true`-Quarantäne der km-Equality-Suiten auflösen oder Findings fixen | Den stummen Skip in `tests/helpers/known-failing.ts` |
| Meta-Check: Pflicht-Gates müssen nachweislich >0 Tests ausgeführt haben (Fork/Secret-Skip wird sichtbar statt still grün) | Das stille Skippen der Gates 4/5/8 |

### Schicht 1 — Textuelle Klone (Typ 1): jscpd v5 als CI-Gate #12

Token-basiert, Sekunden-Laufzeit (v5-Rust-Engine). Gate-Mechanik nach dem
Muster der bestehenden Per-File-Coverage-Gates: **committete Per-Klon-Baseline**
(Schlüssel `fileA+fileB+tokenHash`, shrink-only — neue Klon-Paare failen,
Legacy blockiert nie) + globaler %-Threshold als Backstop, quartalsweise
nachgezogen. Ignorieren: `client/src/components/ui/**` (vendored shadcn),
`tests/**`, `e2e/**`, `migrations/**`. Start-Config:

```jsonc
// .jscpd.json
{ "format": ["typescript", "tsx"], "mode": "mild",
  "minTokens": 70, "minLines": 5, "threshold": 5, "gitignore": true,
  "ignore": ["client/src/components/ui/**", "tests/**", "e2e/**",
             "migrations/**", "**/*.test.ts*", "server/replit_integrations/**"],
  "reporters": ["console", "json", "sarif"], "output": ".jscpd-report" }
```

**Ersetzt:** die manuellen grep-Scans der Refactor-Masterplan-Methodik als
Duplikat-Zählung. **Grenze (ehrlich):** findet die 26 Befunde oben größtenteils
NICHT — dafür Schicht 2–4.

### Schicht 2 — Strukturelle/semantische Nähe (Typ 2–4)

1. **similarity-ts** (mizchi/similarity, Rust, AST + Tree-Edit-Distance):
   das einzige fertige Tool für unseren tatsächlichen Fehlermodus
   („kopiert und leicht abgewandelt", auch umbenannt). Wöchentlicher
   Report-only-Sweep `similarity-ts shared server client/src --cross-file
   --threshold 0.88 --min-tokens 30 --print` → Triage-Issue; optional später
   PR-scoped als Gate (geänderte Dateien gegen Gesamt-Repo, Baseline-diffed).
2. **ts-morph-Signatur-Clustering** (~200-Zeilen-Skript, wöchentlich):
   exportierte Funktionen nach normalisierter Signatur clustern. Weil die
   Codebase domänen-typisiert ist, sind zwei Exporte
   `(BudgetTransaction[], Date) => Cents` SSoT-Rivalen — auch bei null
   struktureller Ähnlichkeit. Höchste Präzision, gibt es nirgends zu kaufen.
3. **eslint-plugin-sonarjs** `no-identical-functions` (+
   `no-duplicate-string` auf `shared/` + `server/`): schließt das triviale
   Ende schon beim Autor im Editor. <1 h Aufwand.

**Ersetzt:** das Zufalls-Entdecken („uns fällt später auf, dass es die
Funktion schon gab") durch einen planbaren Kandidaten-Strom.

### Schicht 3 — Graph- & Import-Disziplin (Prävention)

1. **dependency-cruiser** als Graph-Gate: kann, was ast-grep-Dateiscans nicht
   sehen — Regeln über den gesamten Import-Graphen. Drei Regelklassen:
   *forbidden* (client→server, shared→app-seitig, Umgehung kanonischer
   Einstiegspunkte), **required** („Module, die Frage Q berühren, MÜSSEN die
   SSoT importieren" — die fehlende **positive** Hälfte der SSoT-Durchsetzung)
   und *orphan/`reachable:false`* (tote Duplikat-Teilbäume, die knips
   Export-Analyse entgehen). Mit `--ignore-known`-Baseline sofort auf `error`
   schaltbar. **Ersetzt:** die ~10 reinen Import-Boundary-ast-grep-Tests
   (werden zu 6-Zeilen-Regeln; die Tests bleiben nur, wo sie Symbol-Ebene
   prüfen).
2. **ESLint-Spiegel der Top-SSoT-Verbote** (`no-restricted-imports` mit
   `importNames` + sprechender Message „Cap-SSoT: `readUnifiedBudgetAvailability`
   verwenden (A1)", `no-restricted-syntax` für Geld-Arithmetik): verlegt das
   Feedback vom CI-Fail in den Editor-Moment des Tippens — der direkte Hebel
   gegen Ursache 1 (Latenz). Die Vitest-Guards bleiben die
   negativ-getestete Autorität; ESLint ist nur Vorwarnung.
   **Ersetzt:** nichts (Spiegel, keine zweite Autorität — bewusst).

### Schicht 4 — Semantik, die nur Menschen/LLMs sehen

1. **Wöchentlicher Triage-Cron:** Kandidaten aus Schicht 1–3 + Naming-Cluster
   (`calculate*/compute*/derive*/get*X` über Verzeichnisse) zusammenführen →
   LLM-Triage (`claude -p`) gegen die SSoT-Registry (§4) → ein gepinntes
   Issue mit Verdikten CONFIRMED/INTENTIONAL/FALSE_POSITIVE. Forschungsstand:
   LLMs sind stark im Triagieren von Kandidaten, unzuverlässig als alleinige
   Äquivalenz-Beweiser — Beweis bleibt bei Tests (Equality-Suite) vor jeder
   Löschung.
2. **Quartalsweiser Domänen-Audit** nach der Methodik von
   `docs/budget-ssot-audit.md` („Welche fachlichen Fragen hat Domäne X? Wer
   beantwortet sie? Wo ist der Guard?"), eine Domäne pro Quartal, eingebettet
   in den bestehenden `deep-analysis`-Skill. Reihenfolge nach Guard-Lücken:
   **Statistik/Ökonomie → Time-Entries/Lohn-Lesepfad → Rechnungswesen jenseits
   VAT/km → Dokumente → Importe/Qonto**. **Ersetzt:** den Einmal-Charakter des
   Budget-Audits durch eine Kadenz.

### Spätere Modalitäten (aus der Audit-Selbstkritik, Phase 3+)

- **SQL-Schicht:** die zwei schlimmsten Befunde (13× Preis-Subquery, ~50
  Status-Prädikate) sind eingebettete SQL-Klone, die alle TS-Tools strukturell
  verfehlen. Maßnahme: `` sql`…` ``-Templates + Trigger-/PL-pgSQL-Bodies
  extrahieren, normalisieren, fingerprinten; die bestehenden
  Tabellen-Zugriffs-Bans (Budget, Lohn) auf jede SSoT-eigene Tabelle
  generalisieren.
- **Abgeleitete Spalten:** die ~15 `sync-*/reconcile-*/backfill-*`-Skripte in
  `server/startup/` sind stehender Beweis für Denormalisierungs-Drift →
  Inventur der abgeleiteten Spalten, Reconcile-Einmalskripte zu
  **geplanten Invarianten-Assertions** umbauen, die laut failen.
- **Query-Key-Factory:** 243 inline `queryKey`-Literale in 95 Client-Dateien;
  Factory-Modul + ast-grep-Ban auf Inline-Keys.
- **Env-SSoT:** 118 rohe `process.env.*`-Reads in 48 Server-Dateien mit
  divergierenden Defaults → ein zod-validiertes Env-Modul + Ban außerhalb.
- **Contract-Kette schließen:** `openapi-typescript`-generierte Client-Typen
  mit Regen-Diff-Gate (gleicher Mechanismus wie das bestehende OpenAPI-Gate)
  + `oasdiff breaking` als semantisches Gate; später Zod-4-/drizzle-zod-0.8-
  Upgrade (dessen Registry macht doppelte Schema-IDs zum Build-Fehler).
- **knip verschärfen:** zweiter Lauf `knip --production --strict`
  (`!`-Einträge), damit Exporte, die nur noch ihr eigener Test am Leben hält
  — der klassische Zombie-Duplikat-Fall — endlich auffallen;
  `ignoreExportsUsedInFile` überdenken; Blanket-Ignore von
  `client/src/components/ui/**` auf Datei-Ebene verfeinern.

---

## 4. Herzstück: maschinenlesbare SSoT-Registry

**Eine committete Datei `shared/ssot-registry.ts`** — pro fachlicher Frage:
ID, kanonische Funktion + Modul, Import-Allowlist, „owned literals"
(Enum-Strings, Sätze, Cent-Konstanten), Pfad(e) der Guard-Tests, zugehörige
ESLint-Regel-ID. Dazu ein Meta-Guard-Test, der prüft: jeder Eintrag existiert,
ist exportiert, hat mindestens einen Guard; jede Guard-Allowlist stammt aus
der Registry (nicht mehr hart im Test).

Konsumenten: der generische Lockdown-Test, die ESLint-Spiegelregeln, die
dependency-cruiser-required-Regeln, die PR-Review-Instruktion („neue Funktion
mit Fach-Semantik? → Registry-Abgleich") und der LLM-Triage-Prompt.
Das AIP/api-linter-Muster: jede Regel hat eine ID und einen automatischen
Check, der den kanonischen Fix benennt.

**Ersetzt:** die in ~45 Guard-Tests verstreuten Allowlists
(`CAP_SLOT_IMPORT_ALLOWLIST` etc.) und die Prosa-Kataloge
(`budget-ssot-inventory`-Beschlüsse) als Ort der Wahrheit — Prosa-Dokus
bleiben als Erklärung, verlieren aber die Katalog-Rolle. Damit wird auch die
Frage „ist das eine NEUE fachliche Frage ohne SSoT?" beim Autor beantwortbar.

## 5. EIN Ratchet-Prinzip, nicht fünf Baselines

Die Recherche empfahl je Tool eigene Baselines (jscpd-Baseline,
dep-cruiser `known-violations`, ESLint-Suppressions, Betterer, similarity-
Baseline) — der Selbstkritik-Agent hat zu Recht angemerkt: fünf unabhängige
Ledger divergieren genauso wie der Code. Entscheidung:

- **Tool-native, tool-erzwungene Baselines sind erlaubt** (ESLint
  `--suppress-all` → `eslint-suppressions.json`; dep-cruiser
  `known-violations`; jscpd-Baseline-Skript) — weil nur dort die
  Shrink-only-Semantik vom Tool selbst erzwungen wird. Regel: **kein Gate ohne
  Baseline-Mechanik, keine Baseline ohne Gate.** Jede neue strenge Regel
  startet sofort auf `error` + Baseline, nie als „Warning bis irgendwann".
- **Ein einziger Aggregat-Report** `npm run ratchet:status` liest alle
  Baselines und rendert eine Trend-Tabelle (Größe je Baseline über Zeit) —
  das ist die eine Stelle, an der „werden wir besser?" ablesbar ist.
- **Betterer wird NICHT adoptiert.** Zwei Recherche-Agenten widersprachen
  sich hier; Auflösung: das Projekt ist praktisch unmaintained, und seine
  Kernidee (Snapshot, worse=fail/better=update) haben wir mit den nativen
  Baselines + Aggregat-Report ohne neue Dependency.

## 6. Remediation-Playbook (Strangler-Fig — Guard ist Pflicht-Deliverable)

Für jede Konsolidierung, verbindlich (→ `docs/ssot-consolidation-playbook.md`
als eigenes Dokument in Phase 1, PR-Template-Checkbox):

1. **Fachliche Frage deklarieren** + Registry-Eintrag (§4) anlegen.
2. **SSoT bauen oder segnen** (bestehende beste Implementierung wird
   kanonisch; Ort: `shared/domain/` bzw. `shared/utils/`).
3. **Shadow-Compare**: Equality-Test alt vs. neu (`tests/equality/`-Muster,
   raise-on-mismatch) über echte Szenarien — der Beweis VOR dem Umbau.
4. **Cutover**: Call-Sites migrieren (bei Risiko hinter Flag).
5. **Legacy löschen** — knip beweist, dass nichts mehr daran hängt.
6. **Guard installieren + Baseline schrumpfen im selben PR**: ast-grep-Guard/
   ESLint-Regel/dep-cruiser-Regel, die die Wiederkehr des Musters bannt.

Schritt 6 ist der, der heute als „optionales Cleanup" behandelt wird — er ist
das eigentliche Ratchet. Detektoren finden; nur Guards verhindern Rückfall.

**Gegengewicht — Über-Konsolidierung ist der symmetrische Fehler:**
Rule of Three (beim 3. Vorkommen abstrahieren, nicht zwangsweise beim 2.);
Sandi Metz: „duplication is far cheaper than the wrong abstraction". Die
SSoT-Achse ist **die gleiche fachliche Frage**, nie die gleiche Code-Form.
Ein jscpd-/similarity-Hit ist eine **Frage, kein Auftrag** — zulässige Antwort
ist „INTENTIONAL" mit Annotation (`jscpd:ignore` + Begründungs-Kommentar),
siehe die 3 so eingestuften Audit-Findings (z. B. Qonto-Match bewusst ohne
Toleranz). Guards bleiben frage-scoped, nie form-scoped.

## 7. Behebungs-Backlog (Wellen)

Reihenfolge nach Schadensklasse; jede Position läuft durchs Playbook §6.
IDs → [`verified-findings.md`](audits/ssot-2026-07-22/verified-findings.md).

- **Welle 1 — Geld & Status (P0, die 12er-Tabelle in §2).** Cluster:
  (a) *Euro-Parsing/Format*: util-reimpl-2/-3/-4/-9/-10 konsolidieren auf
  `parseEuroDE`/`formatEuroDE` + eine `parseGermanDecimal`; (b) *Datums-SSoT*:
  util-reimpl-5/-7/-8; (c) *Status-SSoT*: parallel-logic-1 + drift-5 (ein
  Prädikat-Set, eine Label-Map); (d) *Preis-Lesepfad*: parallel-logic-2
  (SQL-Subquery → `priceFor`-basierte View/Funktion); (e) *Statistik-Reader*:
  parallel-logic-3/-4; (f) *Time-Tracking-Drift*: drift-1/-4 (EU-Rentner-Regel
  gehört nach `shared/domain/` + Server-Enforcement!); util-reimpl-1.
- **Welle 2 — Wartungsrisiken (P1 medium):** parallel-logic-5…-10,
  drift-6/-8/-9/-10, inkl. Entry-Type-Listen (7+ Stellen → eine Quelle in
  `shared/domain/time-entries.ts`) und PLZ-/Contract-/Prospect-Schemata.
- **Welle 3 — jscpd-Hotspots:** Storno-Skript-Duplikat, Budget-Ledger-Reader
  in Skripten, `routes/billing.ts`-Selbstklone, Preis-Timeline-Stitching,
  Skript-Harness (`eur()`, `assertSuperadminOrThrow`) → `server/scripts/lib/`.

Grobaufwand: Welle 1 ≈ 6–8 Konsolidierungs-PRs à 0,5–1,5 Tage (Playbook macht
sie gleichförmig); Wellen 2–3 inkrementell dahinter.

## 8. Rollout

| Phase | Inhalt | Aufwand | Ersetzt |
|---|---|---|---|
| **0** (sofort) | Substrat: Lint-Scope, knip blocking, Quarantäne-/Skip-Löcher, Gate-Meta-Check | 1–2 Tage | stumme Skips & tote Config |
| **1** | Registry-Seed aus bestehenden Guard-Allowlists + Meta-Guard; jscpd-Gate + Baseline; sonarjs-Quick-Wins; Playbook-Doku + PR-Checkbox | ~1 Woche | verstreute Allowlists; manuelle Dup-Scans |
| **2** | dependency-cruiser (forbidden/required/orphans, Baseline); ESLint-SSoT-Spiegel Top 10; knip `--production --strict`; similarity-ts-Weekly + Triage-Issue | ~1 Woche | ~10 Import-Boundary-Tests; Zufalls-Entdeckung |
| **3** | ts-morph-Signatur-Clustering; LLM-Triage-Cron; Quartals-Audit-Kadenz (Start: Statistik/Ökonomie); openapi-typescript/oasdiff | inkrementell | Einmal-Audit-Charakter |
| **4** | SQL-Fingerprinting; Invarianten-Assertions statt Reconcile-Einmalskripte; Query-Key-Factory; Env-SSoT; Zod-4-Kette | inkrementell | Reconcile-Feuerwehr |
| parallel | Welle-1-Fixes (§7) je mit Guard | s. §7 | die 26 Duplikate |

## 9. Erfolgsmessung

Trend-KPIs im `ratchet:status`-Report: jscpd-%, Baseline-Größen (alle Kurven
müssen monoton fallen), Anzahl Registry-Einträge mit Guard vs. ohne,
Erkennungs→Fix-Latenz pro Finding, Anzahl INTENTIONAL-Annotationen (bewusste
Entscheidungen statt stiller Duplikate). Quartalsweise 30-Minuten-Review.

## 10. Bewusst NICHT adoptiert

**PMD CPD** (JVM-Dependency; sein einziger Vorteil — Identifier-Anonymisierung
— ist für TS nicht unterstützt) · **SonarQube/SonarCloud** (PR-Gating nur
bezahlt; das „Clean as You Code"-Prinzip übernehmen wir baseline-basiert zum
Nulltarif) · **CodeQL-Similar-Code** (Queries 2022 entfernt) · **Betterer**
(unmaintained, §5) · **Semgrep** (redundant zu vorhandenem ast-grep) ·
**eslint-plugin-boundaries / ts-arch / ArchUnitTS / Sheriff / Nx-Boundaries**
(überlappen dependency-cruiser ohne dessen required-Regeln/Baseline) ·
**jsinspect** (tot) · **pgvector-Embedding-Index** (Watchlist: nur falls
similarity-ts + Signatur-Clustering nachweislich Lücken lassen) ·
**qlty CLI** (solide, aber drittes überlappendes Tool — Watchlist, ebenso
**basta** vom jscpd-Autor).

## Quellen (Auswahl)

jscpd: github.com/kucherenko/jscpd · similarity-ts: github.com/mizchi/similarity
· dependency-cruiser Rules-Referenz: github.com/sverweij/dependency-cruiser ·
knip Production-Mode: knip.dev · ESLint Bulk Suppressions (v9.24+):
eslint.org · SonarQube „Clean as You Code": docs.sonarsource.com ·
oasdiff: github.com/oasdiff/oasdiff · openapi-typescript: openapi-ts.dev ·
Clone-Taxonomie Typ 1–4: Roy/Cordy · Fitness Functions: Ford/Parsons/Kua,
*Building Evolutionary Architectures* · Sandi Metz, „The Wrong Abstraction".
Vollständige Quellenlisten in den Recherche-Rohberichten des Audit-Laufs
(Branch-Verlauf `claude/ssot-redundancy-detection-grrpph`).
