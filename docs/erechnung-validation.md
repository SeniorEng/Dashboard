# E-Rechnungs-Validierung (ZUGFeRD/Factur-X EN 16931)

Runbook für das offizielle E-Rechnungs-Validierungs-Gate (Task #1073).

## Was wird geprüft?

`npm run validate:erechnung` (`scripts/validate-erechnung.ts`) erzeugt eine
**Beispiel**-Rechnung als hybrides **PDF/A-3** mit eingebetteter
**EN-16931-(Factur-X/ZUGFeRD)-XML** — komplett über den Library-Pfad
(`server/lib/zugferd.ts` → node-zugferd `embedInPdf`), **ohne Chromium**
(das Trägerdokument ist ein leeres pdf-lib-A4-PDF). Anschließend validiert es
das Ergebnis mit den **offiziellen** Prüfwerkzeugen:

- **Mustang/KoSIT** — EN-16931-Schematron + ZUGFeRD/Factur-X-Konformität
  (`java -jar Mustang-CLI-*.jar --action validate`).
- **veraPDF** — PDF/A-3b-Konformität (`verapdf --flavour 3b`).

Beide sind Java-Tools. Das Gate testet damit exakt die Pipeline, die auch der
Produktivpfad nutzt — nicht eine Nachbildung.

Seit Task #1106 besteht die Beispielrechnung **beide** Validatoren ohne Fehler
(Mustang: `XML:valid`, 0 Schematron-Errors; veraPDF: `isCompliant="true"`,
PDF/A-3b). Davor war das Gate zwar verdrahtet, sprang aber ohne lokales Java
still über — produktive Rechnungen scheiterten an EN-16931-Schematron-Regeln
(fehlende IBAN/BG-16, fehlende USt-Aufschlüsselung/BG-23) und an PDF/A wegen
eines kaputten XMP-Namespaces (`xmlns:about` statt `rdf:about`).

## Abgrenzung (wichtig)

Die ZUGFeRD/Factur-X-XML ist die maschinenlesbare **umsatzsteuerliche**
Rechnung nach EN 16931. Sie ist **NICHT** der sozialrechtliche
Leistungs-/Abrechnungs-Datenaustausch nach **§ 105 SGB XI** / **§ 302 SGB V**
(separates EDIFACT/TA-Verfahren über ein Abrechnungszentrum). Details:
[`docs/architecture/budget.md`](architecture/budget.md) →
„E-Rechnung (ZUGFeRD/Factur-X EN 16931) — Abgrenzung & Validierung".

## Lokaler Lauf

```bash
npm run validate:erechnung
```

Ohne Java-Runtime (Standard-Dev-Container) **überspringt** sich das Skript
sauber mit Exit 0 — die Beispiel-PDF/A-3 + XML werden trotzdem erzeugt, sodass
ein Pipeline-Defekt (keine XML eingebettet) auch lokal auffällt (Exit 2).

Mit lokal installierten Validatoren:

```bash
MUSTANG_CLI_JAR=/pfad/Mustang-CLI-x.y.z.jar \
VERAPDF_CLI=/pfad/verapdf \
npm run validate:erechnung
```

## Env-Schalter

| Variable | Zweck |
|---|---|
| `MUSTANG_CLI_JAR` | Pfad zur Mustang-CLI-JAR. Fehlt → Mustang-Check übersprungen. |
| `VERAPDF_CLI` | Pfad zur veraPDF-Executable. Fehlt → veraPDF-Check übersprungen. |
| `ERECHNUNG_REQUIRE_VALIDATORS` | `1` erzwingt Java **und** beide Validatoren (sonst Exit 1). Im CI gesetzt; lokal ungesetzt = graceful skip. |

## Exit-Codes

| Code | Bedeutung |
|---|---|
| 0 | OK — alle konfigurierten Validatoren bestanden, **oder** sauber übersprungen (kein Java/Validator, `REQUIRE` nicht gesetzt). |
| 1 | Ein konfigurierter Validator meldete Nicht-Konformität — **oder** ein erzwungener Validator/Java fehlt (`REQUIRE=1`). |
| 2 | Die Beispiel-PDF/A-3 konnte nicht erzeugt werden bzw. es wurde keine XML eingebettet (Pipeline-Defekt — immer ein echter Fehler). |

## CI-Gate

Eigener Job `erechnung-validation` in `.github/workflows/ci.yml`:

1. `actions/setup-java` (Temurin 17).
2. Mustang-CLI-JAR von Maven Central laden (Version dynamisch aus den
   Maven-Metadaten).
3. veraPDF headless installieren (IzPack-Auto-Install).
4. `ERECHNUNG_REQUIRE_VALIDATORS=1 npm run validate:erechnung`.

Das Gate ist **nicht** branch-protected (Required-Checks bleiben
`static-analysis`/`tests`/`e2e-smoke`), läuft aber bei jedem Push/PR und macht
einen Konformitätsbruch sofort sichtbar.

## Java-freies Strict-Gate (Task #1109)

Der oben beschriebene Mustang/veraPDF-Job hängt an einer Java-Runtime + zwei
externen Downloads (Maven Central, verapdf.org). Damit der seit Task #1105
genutzte **Java-freie** Strict-Pfad (`validateZugferdXsd`, xmllint-wasm) nicht
unbemerkt für neue Rechnungen regressiert — und der
`invoice_zugferd_nonstrict_seal`-Audit nicht still zurückkehrt — gibt es ein
zweites, von Java unabhängiges Gate:

```bash
npm run validate:erechnung:strict
```

`scripts/validate-erechnung-strict.ts` baut für die wichtigsten **Pot-/USt-
Szenarien** je eine vollständige Rechnung (mit `strictSettlement: true` wie neue
Rechnungen) über den Produktivpfad (`buildZugferdInvoice` → node-zugferd),
validiert das emittierte XML per `validateInvoiceXsd` (`server/lib/zugferd.ts`,
xmllint-wasm gegen die gebündelten EN-16931-Profil-XSDs) und verlangt, dass
**jedes** Szenario XSD-konform ist **und** als strict markiert würde
(`usedStrictMode === true`). Abgedeckte Szenarien:

- § 45b Entlastungsbetrag (Pflegekasse, USt-befreit § 4 Nr. 16 UStG)
- § 45a Umwandlungsanspruch (Pflegekasse, USt-befreit)
- §§ 39 / 42a Verhinderungspflege (Pflegekasse, USt-befreit)
- Selbstzahler (19 % USt)
- Stornorechnung (§ 45b, USt-befreit, typeCode 384)

Exit-Codes: `0` = alle konform + strict, `1` = mindestens ein Szenario
nicht-konform bzw. nur Non-Strict-versiegelbar (Regression), `2` =
Pipeline-Defekt. Das Gate braucht **kein** Java, **keine** DB und **keinen**
Server und läuft im CI-Job `erechnung-validation` als eigener Schritt **vor**
dem Java-Setup — so wird eine Strict-Pfad-Regression auch dann rot, wenn der
Mustang/veraPDF-Download mal hakt.

## GoBD-Byte-Determinismus

Das Standard-Profil ist seit Task #1073 `en16931` (vorher `basic`). Der
Wechsel **darf die Re-Render-Hash-Stabilität bereits versiegelter Rechnungen
nicht brechen**: `InvoiceRenderSnapshot.profile` friert das Profil beim
Erst-Persist ein; Bestand-Rechnungen ohne `profile` im Snapshot werden bewusst
weiter als `basic` re-gerendert. Analog friert `InvoiceRenderSnapshot.lineAggregation`
den Positions-Aggregationsmodus und (seit Task #1098) `InvoiceRenderSnapshot.includeLineTotalAmount`
den Pro-Zeilen-Betrag (BT-131, `LineTotalAmount`) ein: vor #1098 versiegelte
Rechnungen tragen das Flag nicht und re-rendern bewusst **ohne** BT-131
(node-zugferd verwarf den damals falschen `totalAmount`-Schlüssel still), neue
Rechnungen werden mit `includeLineTotalAmount: true` versiegelt. Analog friert
(seit Task #1105) `InvoiceRenderSnapshot.strictSettlement` die **Header-Settlement-
Struktur** ein: vor #1105 versiegelte Rechnungen tragen das Flag nicht und
re-rendern bewusst über den Legacy-Pfad (die damals an node-zugferd übergebenen
Schlüssel `tradeTax`/`paymentMeans` waren falsch und wurden still verworfen →
kein Header-`ApplicableTradeTax`/keine `PaymentMeans` im XML). Neue Rechnungen
werden mit `strictSettlement: true` versiegelt und verwenden die **korrekten**
node-zugferd-Schlüssel `vatBreakdown` (BG-23, Header-USt-Aufschlüsselung) +
`paymentInstruction` (BG-16) — erst damit besteht das XML die XSD. **Beide
Untergruppen sind Arrays** (`transfers`/`vatBreakdown`) — als Einzelobjekt
übergeben droppt node-zugferd den Inhalt (z. B. fehlende `IBANID` ⇒ Mustang
`BR-CO-27`).

Task #1106 ergänzt die zweite, dazu **orthogonale** Versionierung über
`InvoiceRenderSnapshot.includeConformantSettlement` — diese friert die
**XMP-Namespace-Reparatur** (PDF/A-3b) ein, unabhängig von der XML-Header-
Struktur (`strictSettlement`). Erst beide Flags zusammen ergeben eine vollständig
EN-16931- UND PDF/A-3b-konforme Rechnung:

- **XMP-Reparatur:** node-zugferd schreibt in den PDF/A-Metadatenstream
  `xmlns:about=""` statt `rdf:about=""`; `repairZugferdXmpNamespace` ersetzt das
  **längenerhaltend** (beide Tokens 14 Bytes), damit die Byte-Offsets der
  PDF-XRef-Tabelle gültig bleiben und veraPDF PDF/A-3b grün meldet. Vor #1106
  versiegelte Rechnungen tragen das Flag nicht und re-rendern mit dem
  unreparierten Original-XMP ⇒ versiegeltes PDF bleibt byte-identisch
  (GoBD-`pdf_hash`-Stabilität).
- **USt-befreite Pflegekassen-Rechnungen (Kategorie E):** EN-16931 `BR-E-2`
  verlangt eine USt-IdNr. (BT-31) **oder** Steuernummer (BT-32). Pflegedienste
  rechnen i. d. R. ohne USt-IdNr. ab ⇒ die Firmen-`steuernummer` MUSS gepflegt
  sein, sonst failt Mustang.

Neue Rechnungen werden mit `strictSettlement: true` **und**
`includeConformantSettlement: true` versiegelt. Detektoren:
`tests/equality/zugferd-roundtrip.test.ts`,
`tests/equality/zugferd-xml-rerender.test.ts`,
`tests/equality/invoice-cumulative-pdf-xml-parity.test.ts`,
`server/services/invoice-integrity-verifier.ts`.

Kann die XML nicht im Strict-Modus erzeugt werden, fällt der Renderer auf
Non-Strict zurück und schreibt beim Versiegeln einen Audit-Log-Eintrag
`invoice_zugferd_nonstrict_seal` (statt still zu degradieren). Seit Task #1105
wird die Strict-Versiegelung **ohne Java** verifiziert: `validateZugferdXsd()`
(`server/lib/zugferd.ts`) prüft das emittierte XML mit `xmllint-wasm` (reines
WebAssembly) gegen die von node-zugferd gebündelten Profil-XSDs
(`profile.xsdPath()` + per `schemaLocation` nachgeladene Sub-Schemas). Besteht
eine **neue** Rechnung (`strictSettlement: true`) diese WASM-XSD-Prüfung, gilt
die Versiegelung als strict und der `invoice_zugferd_nonstrict_seal`-Audit
unterbleibt; schlägt sie fehl, bleibt es beim Non-Strict-Audit (graceful, kein
Abbruch). Bestand (ohne `strictSettlement`) durchläuft diese Brücke nicht und
bleibt byte-identisch.

## Bestandsrechnungen-Backfill (kein erzwungenes Re-Seal)

Vor Task #1073 versiegelte Rechnungen tragen ein BASIC-Profil. Sie werden
**bewusst NICHT** nachträglich auf `en16931` gehoben — BASIC ist bereits ein
konformer EN-16931-Subset, und ein In-Place-Re-Seal würde die versiegelten
GoBD-Felder (`pdf_hash`/`zugferd_xml`) mutieren. Vollständige Entscheidung +
Kontingenz-Pfad (Storno + Neuausstellung): [`docs/architecture/budget.md`](architecture/budget.md)
→ „Bestandsrechnungen-Backfill auf EN 16931 — Entscheidung".
