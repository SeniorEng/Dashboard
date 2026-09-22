# Avis-Testkorpus — 82 anonymisierte Echt-Dateien

Erzeugt am 22.09.2026 aus `09_Pflegekassen` von Cowork.

**Zweck:** Parser-Tests laufen gegen die echte Formatlandschaft statt gegen erdachte Fixtures.
An zwei Tagen sind elf Annahmen über diese Dateien gefallen — sechs davon wären beim ersten
Lauf gegen diesen Korpus aufgefallen statt im dritten Review.

---

## Was erhalten ist — und geprüft wurde

Gegen die Originale Datei für Datei verglichen, **82 von 82 ohne Abweichung**:

| | |
|---|---|
| Beträge | **969 / 969 identisch** |
| Datumswerte und -formate | **985 / 985 identisch** |
| Rechnungsnummern (laufende Nummer) | **274 / 274 erhalten** |
| Feldzahl je Zeile | unverändert |
| Zeilentypen, Trennzeichen | unverändert |
| BOM, CRLF, führende Leerzeichen | unverändert |
| Leerfelder | unverändert |
| DAVASO-Headerzeile | unverändert (ist Struktur, keine Daten) |

## Was ersetzt wurde

Deterministisch und längenerhaltend — derselbe Ausgangswert ergibt überall denselben Ersatz:

- **Namen, Adressen, Freitext** → Pseudonyme gleicher Länge, Trennzeichen an Ort und Stelle
- **IBAN** → `DE00` + Pseudoziffern gleicher Länge
- **Ziffernfolgen ab 10 Stellen** (Beleg-, Vorgangsnummern) → Pseudoziffern gleicher Länge
- **Ziffernfolgen bis 9 Stellen** bleiben (IK-Nummern, Positionszähler — nicht personenbezogen)
- **Rechnungsnummern** behalten ihre laufende Nummer, das Jahr wird auf **2017** gesetzt
  (repoweit als Testjahr frei; verhindert Kollisionen mit echten Rechnungen)

**Gegenprobe auf Restdaten:** keine Umlaute, keine Straßen-/Firmenbezeichner, kein `RE-2026-`,
keine kleingeschriebenen Wortfolgen. Die verbleibenden Treffer auf Namensmuster stammen
ausnahmslos aus DAVASO-Spaltennamen (`KTR_Name,`, `ZEM_RecDatum,`).

---

## Landkarte: welche Datei welchen Fall abdeckt

### DAVASO (29 Dateien, `IKK Classic__Avis_ICL*`)

Einheitlich: 17 Spalten, Header, Komma-Separator, **Punkt als Dezimaltrennzeichen**, UTF-8 ohne BOM, CRLF.

| Datei | Fall |
|---|---|
| `IKK Classic__Avis_ICL01267.csv` | **Der einzige Kürzungsfall im ganzen Bestand.** Kopfzeile fordert 117,19 und zahlt 58,16; die Belegzeile trägt **den gekürzten Betrag** (58,16), nicht die Forderung. Invariante: Σ Belegzeilen = `KTR_BTR_Zahlg` der Kopfzeile. |
| `IKK Classic__Avis_ICL01278.csv` | Der Faktor-100-Fall vom 21.09. Vier Blöcke à 1:1, Gesamtsumme 284,34 €. Der alte Parser machte daraus 7.000,00 €. |
| `IKK Classic__Avis_ICL01290.csv` | Fünf Blöcke, alle 1:1. |
| `IKK Classic__Avis_ICL01201.csv`, `…01229.csv` | Altbestand: `ZEM_RecNr` enthält **kein** `RE-`, sondern ein Datum bzw. `JJJJ-MM-TT/N`. Dieselbe „Nummer" kommt in zwei Blöcken vor — **keine Verdopplung**, sondern zwei Vorgänge im selben Zeitraum. |

**Paar-Struktur, gemessen über alle 29:** je Rechnung zwei Zeilen mit derselben `AvisPos` und
`ZEM_RecNr`. Kopfzeile trägt `KTR_BTR_Zahlg`, Skonto, Kürzung, Zahldatum; Postenzeile nur
`ZEM_BTR_Forderg` und `ZEM_BelegNr`.
`ZEM_BelegNr` läuft **je Block** 1..N — 66 Blöcke, alle beginnen bei 1, keine blockweite Dublette,
**17 von 29 Dateien haben dateiweite Dubletten** (ein dateiweiter Riegel lehnt sie zu Unrecht ab).
`ZEM_VorgangsNr` ist blockweit konstant und dateiweit eindeutig — der taugliche Block-Schlüssel.

### Kassen-CSV (53 Dateien, `BARMER__*`, `AOK*__*`, `IKK Classic__461438852_*`)

Semikolon, **Komma als Dezimaltrennzeichen**, Zeilentypen `1;` Kopf, `2;` Posten, `3;` Summe.

**Drei Belegungen der `3;`-Zeile — die Feldzahl allein identifiziert das Layout nicht:**

| Breite | Belegung | Vorkommen |
|---|---|---|
| **6** | `[1]` Belegnr · `[2]` **Datum** · `[3]` Betrag · `[4]` IBAN | 19 Zeilen (BARMER) |
| **7 AOK** | `[1]` **IK** · `[2]` `82051000` · `[3]` Betrag · `[4]` EUR · `[5]` Belegnr · `[6]` **Datum** | 22 Zeilen |
| **7 BARMER** | `[1]` Text · `[2]` **Datum** · `[3]` Betrag · `[5]`/`[6]` leer | 3 Zeilen |

**Keine einzige `3;`-Zeile trägt zwei Datums-Felder** — strukturelle Datumserkennung ist eindeutig.

| Datei | Fall |
|---|---|
| `AOK Plus__461438852_20260814_710008557698.csv` | 7-Feld-AOK, 50 Posten, **`[2]` = `82051000`**. Der Prod-Fall für das Kopffeld-Mapping. Gesamt 5.798,66 €. |
| `AOK Plus__461438852_20260817_740008474134.csv` | Dieselbe Belegung, 21 Posten, 3.145,43 €. Beide tragen in `[1]`/`[2]` **identische Werte** — ein Riegel darauf kollidiert dateiübergreifend. |
| `AOK Plus__461438852_20260428_710008308148.csv` | **Wird abgelehnt** (`AVIS_PARSE_UNCERTAIN`, HTTP 422). 19 Postenzeilen, Summenzeile passt nicht zur Postensumme. |
| `BARMER__02_ERLEDIGT__…6CF0….csv` | 7-Feld-BARMER, Betrag mit **einer** Nachkommastelle (`252,3`). |
| `BARMER__02_ERLEDIGT__…FB43….csv`, `…260105_Zahlungsavis_Barmer.csv` | 7-Feld-BARMER, Datum bei `[2]`, `[6]` leer. |
| `BARMER__01_OFFEN__*` (19 Dateien) | **BOM + führendes Leerzeichen** vor der Zeilenkennung. Eine Erkennung auf „Zeile beginnt mit `1;`" greift hier nur nach Normalisierung. |
| `AOK Plus__01_ERLEDIGT__461438852_20260624_*.csv`, `…20260727_*.csv` | **Dritte Kopfvariante:** erste Zeile ist `AOK PLUS – Die Gesundheitskasse`, kein `1;`. |

### Nicht im Korpus

- **4 Dateien** waren als OneDrive-Platzhalter nicht lesbar (`Avis_ICL01125`, `Avis_ICL01157`,
  `IKK_Classic_Avis_ICL01159`, eine TEMPLATE-Datei).
- **1 Fremddatei** im Quellordner ist gar kein Avis (Qonto-Export, Header
  `Status;Abrechnungsdatum (UTC);…`) — sie sollte vom Import erkannt und abgelehnt werden.

---

## Herkunft

`_herkunft.json` ordnet jeden Dateinamen im Korpus seinem Originalpfad zu.
Der Dateiname enthält den Pfad mit `__` als Trenner (`BARMER__01_OFFEN__SAP-….csv`).

## Neu erzeugen

Das Skript liegt bei Cowork (`/tmp/anon/anonymisiere.py`). Es ist deterministisch —
derselbe Lauf über dieselben Quelldateien ergibt byte-identische Ausgaben.
