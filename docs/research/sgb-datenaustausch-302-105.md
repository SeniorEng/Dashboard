# Sondierung: Elektronischer Datenaustausch §105 SGB XI / §302 SGB V

> **Status:** Entscheidungsvorlage (Sondierung) — **keine Implementierung**.
> **Stand:** Juni 2026.
> **Zweck:** Klären, ob und wie CareConnect den gesetzlich vorgeschriebenen
> elektronischen Abrechnungsdaten-Austausch mit den Kassen umsetzen muss, was
> dafür im Datenmodell fehlt, und welcher Umsetzungsweg empfohlen wird.

## 0. Worum es geht (Management Summary)

Es gibt **zwei völlig getrennte „E-Rechnungen"**, die oft verwechselt werden:

1. **ZUGFeRD / Factur-X (EN 16931)** — das, was CareConnect **bereits kann**.
   Das ist die **umsatzsteuerliche, menschenlesbare Rechnung** (PDF/A-3 mit
   eingebettetem XML). Sie genügt der E-Rechnungspflicht im B2B-Sinne und der
   GoBD. Details: [`docs/erechnung-validation.md`](../erechnung-validation.md),
   [`docs/architecture/budget.md`](../architecture/budget.md).

2. **Sozialdaten-Austausch nach §105 SGB XI / §302 SGB V** — das, **was hier
   sondiert wird**. Das ist ein **gesetzlich vorgeschriebener, technisch streng
   genormter Datensatz-Austausch direkt mit der Kranken-/Pflegekasse** (eigene
   XML-Schemata, eigene Schlüssel, eigene Übertragungswege, zertifizierte
   Software, Verschlüsselung). Er ersetzt nicht die ZUGFeRD-Rechnung und wird
   nicht von ihr ersetzt — beide existieren parallel.

**Kernaussage:** Sobald CareConnect Leistungen **direkt mit der Kasse abrechnet**
(Abtretung / „Rechnung an Kasse"), greift die Pflicht zum elektronischen
Datenaustausch nach §105/§302. Die ZUGFeRD-Datei allein erfüllt diese Pflicht
**nicht**. Empfehlung siehe Abschnitt 5: **Anbindung über ein Abrechnungszentrum
(Variante A)**.

---

## 1. Welche Rechtsgrundlage gilt für CareConnect?

| Norm | Geltungsbereich | Trifft CareConnect? |
|---|---|---|
| **§105 SGB XI** | Abrechnung **pflegerischer** Leistungen mit der **Pflegekasse** (§36 Pflegesachleistung, §37 Abs. 3, §39 Verhinderungspflege, §42a, §43b, **§45a/§45b Entlastungs-/Umwandlungsbetrag**) | **JA — Kernfall.** Genau die Töpfe, die CareConnect heute führt (§45b, §45a, §39/§42a). |
| **§302 SGB V** | Abrechnung **häuslicher Krankenpflege** und sonstiger nichtärztlicher Leistungen mit der **Krankenkasse** (SGB V) | **Nur falls** der Betrieb auch HKP nach SGB V erbringt. Im aktuellen Datenmodell nicht abgebildet → vorerst **nachrangig**, aber technisch nahezu identisch. |

**Fazit Rechtsgrundlage:** Maßgeblich ist **§105 SGB XI** (Pflege). §302 SGB V
ist die strukturell gleiche Pflicht für den SGB-V-Zweig und kann mit demselben
Umsetzungsweg später mitabgedeckt werden, falls HKP dazukommt.

### Wann genau greift die Pflicht?

- Die Pflicht greift bei **Direktabrechnung mit der Kasse** (Leistungen werden
  per Abtretung gegenüber der Pflegekasse abgerechnet). Im Datenmodell:
  `customers.billingType = 'pflegekasse_gesetzlich'` bzw. Töpfe, die an eine
  Kasse als Empfänger gehen.
- **Nicht** betroffen ist der **Selbstzahler-/Privatanteil**
  (`billingType = 'selbstzahler'`, privater Topf) — hier rechnet der Kunde
  privat, da genügt die normale (ZUGFeRD-)Rechnung.
- Rechtlich verbindlich: Der elektronische Austausch ist seit **01.03.2021**
  vorgeschrieben (papierlos). Der Übergang auf **vollelektronische Übertragung
  über die Telematikinfrastruktur (TI) / KIM** ist gesetzlich terminiert (Pflege
  TA5 / TI-Anbindung ab **2027**). D.h. die Anforderung verschärft sich, sie
  verschwindet nicht.

---

## 2. Was der Austausch technisch verlangt (Soll)

Quellen: GKV-Spitzenverband / `gkv-datenaustausch.de` (Pflege + sonstige
Leistungserbringer), ITSG Trust Center, Technische Anlagen (TA) zur §105-Richtlinie.

1. **Institutionskennzeichen (IK)** des Leistungserbringers (9-stellig).
2. **DTA-Vertrag / Anmeldung pro Kasse** mit **Abrechnungscode (AC)** und
   **Tarifkennzeichen (TK)** — zusammen das **7-stellige Kennzeichen**, das den
   Leistungserbringer-Typ und Tarif gegenüber der Kasse identifiziert.
3. **Leistungskomplexe / Positionsnummern** nach dem **Schlüsselverzeichnis der
   Technischen Anlage (TA3)** — die Leistung muss in den **bundeslandspezifischen
   Vergütungs-Positionsnummern** der Kasse codiert sein, nicht als Freitext.
4. **Versichertendaten**: Versichertennummer, Pflegegrad, Kasse (IK der
   Datenannahmestelle).
5. **Zertifikat/Schlüssel vom ITSG Trust Center** für die Verschlüsselung/
   Signatur der Datenpakete (Sozialgeheimnis, §35 SGB I).
6. **Zertifizierte Software** gemäß der Technischen Anlagen (XSD-konforme
   XML-Pakete: ein Paket = **eine Leistungsart + eine Kasse**; Einzelnachweise
   signiert, Base64, gebündelt).
7. **Übertragungsweg**: heute Datenannahmestelle der Kasse; ab 2027
   zunehmend **KIM/TI** (`insurance_providers.kimAdresse`, `datenannahmeIk` sind
   dafür bereits vorgesehen).

---

## 3. Daten-Gap-Analyse (Ist-Schema vs. Soll)

Geprüfte Quellen im Repo: `shared/schema/insurance.ts`, `company.ts`,
`customers.ts`, `billing.ts`, `services.ts`, `service-records.ts`,
`appointments.ts`.

### ✅ Bereits vorhanden

| Soll-Feld | Im Schema | Spalte |
|---|---|---|
| IK Leistungserbringer | `company_settings` | `ikNummer` |
| IK Kasse / Datenannahme | `insurance_providers` | `ikNummer`, `datenannahmeIk` |
| KIM-Adresse der Kasse | `insurance_providers` | `kimAdresse` |
| Versichertennummer | `customer_insurance_history`, `invoices` | `versichertennummer` |
| Pflegegrad | `customers`, `invoices` | `pflegegrad` |
| Leistungsart (grob) | `services` | `lohnartKategorie`, Budget-Töpfe (§45b/§45a/§39_42a) |
| Leistungsdatum/-zeit/-dauer | `appointments` | `date`, `scheduledStart/End`, `actualStart/End`, `durationMinutes` |
| Leistungsnachweis + Signaturen | `monthly_service_records` | Mitarbeiter-/Kunden-Signatur, Hash, Zeitpunkt |
| Empfänger pro Topf (Kasse) | `customer_budget_recipients` | `ikNummer`, `versichertennummer`, `recipientName/Address` |

→ **Stammdaten-seitig ist die Basis überraschend gut.** IK, Versichertennummer,
Pflegegrad, Kasse, Leistungsdaten und unterschriebene Nachweise liegen vor.

### ❌ Fehlt für §105/§302

| Soll-Feld / Baustein | Status | Bemerkung |
|---|---|---|
| **Abrechnungscode (AC)** pro Kasse/Vertrag | **fehlt** | Kein Feld; `services.code` ist nur ein interner Freitext-Code. |
| **Tarifkennzeichen (TK)** (7-stellig mit AC) | **fehlt** | Pro Leistungserbringer-Kassen-Vertrag, nicht modelliert. |
| **Leistungskomplex-/Positionsnummern (TA3)** | **fehlt** | Leistungen sind nicht in den offiziellen bundeslandspezifischen Vergütungs-Positionsnummern codiert. |
| **ITSG-Zertifikat / Schlüsselverwaltung** | **fehlt** | Keine Schlüssel-/Zertifikatsablage; betrifft Infrastruktur, nicht nur Schema. |
| **§105-konforme XML-Erzeugung (TA-Schemata)** | **fehlt** | Komplett eigene Schemata, unabhängig vom vorhandenen ZUGFeRD-Generator. |
| **Übertragung an Datenannahmestelle / KIM/TI** | **fehlt** | Kein Versandkanal für Sozialdaten (nur SMTP/LetterXpress/Twilio vorhanden). |
| **Quittungs-/Fehler-Rückläufer-Verarbeitung** | **fehlt** | Kassen senden Annahme-/Abweisungsprotokolle zurück. |

**Bewertung des Gaps:** Die **Stammdaten** sind zu ~70 % da. Was fehlt, ist der
**regulatorisch-prozessuale Kern**: AC/TK, Positionsnummern-Mapping, Zertifikate,
zertifizierte XML-Erzeugung und ein sicherer Übertragungsweg. Genau dieser Kern
ist der teure, zertifizierungspflichtige Teil.

---

## 4. Vergleich der drei Umsetzungswege

### Variante A — Anbindung an ein Abrechnungszentrum (z. B. DMRZ, azh, opta data)

Das Zentrum übernimmt §105/§302-Konformität, Zertifikate, XML-Erzeugung,
Übertragung an die Kassen und Rückläufer. CareConnect liefert die Abrechnungs-
daten (idealerweise per CSV/API-Export oder, niedrigschwellig, per Erfassung im
Portal des Zentrums).

- **Aufwand CareConnect:** gering–mittel. Im Minimum: AC/TK + Positionsnummern
  als Stammdaten ergänzen und einen Export der monatlichen Leistungsdaten bauen.
- **Zertifizierung:** entfällt für CareConnect (liegt beim Zentrum).
- **Kosten:** laufende Gebühr pro Abrechnung/Monat (typisch prozentual oder
  pauschal je Vorgang).
- **Risiko:** gering. Bewährter Standardweg für kleine/mittlere Pflegedienste.
- **Time-to-Compliance:** Wochen.

### Variante B — Dienstleister-/Kassen-Portal (manuelle Erfassung)

Leistungen werden direkt im Webportal des Abrechnungsdienstleisters oder der
Kasse manuell eingegeben.

- **Aufwand CareConnect:** sehr gering technisch — aber **hoher manueller
  Doppel-Erfassungsaufwand** Monat für Monat.
- **Zertifizierung:** entfällt.
- **Kosten:** niedrig/keine Software-Kosten, dafür Personalzeit.
- **Risiko:** Übertragungsfehler durch Doppelerfassung; skaliert schlecht.
- **Time-to-Compliance:** sofort, aber dauerhaft ineffizient.

### Variante C — Eigene zertifizierte Software (in-house)

CareConnect erzeugt selbst §105/§302-konforme XML-Pakete, verwaltet ITSG-
Zertifikate und überträgt direkt an Datenannahmestellen/KIM.

- **Aufwand CareConnect:** **sehr hoch.** Eigene XML-Schemata (TA1/TA3/TA5),
  Positionsnummern-Pflege je Bundesland/Kasse, Schlüssel-/Zertifikatsverwaltung,
  Rückläufer-Verarbeitung, **Software-Zertifizierung/Zulassung**, laufende
  Pflege bei jeder TA-Versionsänderung (z. B. TA-Versionssprünge mehrfach/Jahr).
- **Zertifizierung:** erforderlich und wiederkehrend.
- **Kosten:** hohe Einmal- und Dauer-Wartungskosten.
- **Risiko:** hoch (Compliance-Haftung, Wartungslast, TI-Migration 2027).
- **Time-to-Compliance:** Monate bis Jahr.

### Übersicht

| Kriterium | A: Abrechnungszentrum | B: Portal manuell | C: In-house |
|---|---|---|---|
| Dev-Aufwand | gering–mittel | minimal | sehr hoch |
| Laufender Betrieb | gering (autom. Export) | hoch (Handarbeit) | mittel–hoch (Wartung) |
| Zertifizierung nötig | nein | nein | ja (wiederkehrend) |
| Compliance-Risiko | gering | mittel | hoch |
| Skaliert mit Wachstum | ja | nein | ja, aber teuer |
| TI/KIM-Migration 2027 | Zentrum trägt sie | Zentrum/Kasse trägt sie | CareConnect trägt sie |

---

## 5. Empfehlung

**Variante A — Anbindung an ein Abrechnungszentrum (z. B. DMRZ).**

Begründung:
- Der teure, zertifizierungspflichtige Kern (Schemata, Zertifikate, Übertragung,
  TI-Migration 2027) wird ausgelagert; CareConnect trägt kein Compliance- und
  kein Wartungsrisiko für die TA-Versionssprünge.
- Die vorhandene Datenbasis (IK, Versichertennummer, Pflegegrad, Kasse,
  signierte Leistungsnachweise) macht einen **Datenexport** realistisch klein.
- Schnellste, risikoärmste Time-to-Compliance bei einem typischen kleinen/
  mittleren Pflegedienst.

**Variante C wird ausdrücklich nicht empfohlen** — der Eigenbau einer
zertifizierten Sozialdaten-Abrechnung steht in keinem Verhältnis zum Nutzen für
einen einzelnen Betrieb und bindet dauerhaft Entwicklungskapazität an
regulatorische Pflege.

Variante B nur als **kurzfristige Übergangslösung**, falls vor der A-Anbindung
bereits Kassenabrechnungen anfallen.

### Voraussichtlicher Umsetzungsaufwand für Variante A (grobe Schätzung)

| Baustein | Aufwand | Risiko |
|---|---|---|
| Auswahl Abrechnungszentrum + Vertrag/AC/TK-Klärung (fachlich, kein Dev) | extern/organisatorisch | gering |
| Schema: `Abrechnungscode`, `Tarifkennzeichen` (pro Kasse/Vertrag) ergänzen | S (klein) | gering |
| Schema/Mapping: Leistungskomplex-/Positionsnummern an `services` koppeln | M (mittel) | mittel (bundesland-/kassenspezifisch) |
| Monatlicher Abrechnungsdaten-Export im Format des Zentrums (CSV/API) | M (mittel) | mittel (Format-Abhängigkeit) |
| Rückläufer/Quittungen einlesen (optional, Phase 2) | M (mittel) | mittel |

**Gesamteinschätzung:** mittlerer einmaliger Implementierungsaufwand,
**niedriges Dauerrisiko**. Der kritische Pfad ist **organisatorisch** (AC/TK pro
Kasse, Vertrag mit dem Zentrum), nicht primär technisch.

### Nächste Schritte (außerhalb dieser Sondierung)

1. Fachliche Entscheidung Betreiber: rechnet CareConnect direkt mit Kassen ab
   (Abtretung) oder bleibt es vorerst Selbstzahler/Privat? → bestimmt Dringlichkeit.
2. Abrechnungszentrum auswählen, Konditionen + benötigtes Eingabeformat klären.
3. AC/TK pro Kasse beschaffen (DTA-Anmeldung).
4. Erst danach: Schema-Ergänzungen + Export als eigene Tasks schneiden.

---

## Abgrenzung / Querverweise

- **ZUGFeRD/EN-16931 (vorhanden):** [`docs/erechnung-validation.md`](../erechnung-validation.md),
  [`docs/architecture/budget.md`](../architecture/budget.md)
  → „E-Rechnung … Abgrenzung & Validierung".
- Diese Sondierung betrifft den **§105/§302-Sozialdaten-Austausch**, der dort
  bereits als außerhalb des ZUGFeRD-Scopes liegend markiert ist.

**Out of scope dieser Sondierung:** jegliche XML-/TI-/KIM-Implementierung,
Schema-/DB-Änderungen, Zertifizierung, Vertragsabschlüsse, Änderungen an der
bestehenden ZUGFeRD-Rechnung.
