# Konzept: Budget-Startwert & Carryover bei Kundenanlage

**Status:** Entwurf zur Abnahme
**Stand:** April 2026
**Geltungsbereich:** §45b Entlastungsbetrag, §45a Umwandlungsanspruch, §39/§42a Verhinderungs-/Kurzzeitpflege
**Bezogene Tasks:** #115 (dieses Konzept), #101 (Dedup-Regel implementiert), Backlog "Bereinigung historischer Doppel-Startwerte", Backlog "Warnung Startwert-Jahresverlauf"

---

## 1. Executive Summary

Die heutige Erfassung von Startwert (`initial_balance`) und Vorjahres-Übertrag (`carryover`) ist fachlich korrekt, aber im UI doppeldeutig. Anwender können bei einem Kunden, der nach dem 30.06. zustößt, sinnlos Vorjahres-Verbrauch eintragen, der bereits gesetzlich verfallen ist. Außerdem ist die Hierarchie zwischen "Restwert Dezember Vorjahr", "berechneter Übertrag" und "manuellem Override" im Wizard nicht erkennbar.

**Kernentscheidungen dieses Konzepts:**

1. **Juni-Deadline als UI-Schwelle**: Die §45b-Vorjahres-Sektion wird im Wizard nur angezeigt, wenn `Vertragsbeginn <= 30.06.` des aktuellen Jahres liegt. Andernfalls wird sie ausgeblendet (Begründung: gesetzlich verfallen).
2. **Eine Quelle, drei Optionen**: Statt drei paralleler Felder (`vorjahrVerbraucht`, `uebertrag`, `restwert Dez`) entscheidet der Anwender über einen **Auswahl-Schalter** mit drei Modi: *Berechnen*, *Restwert eingeben*, *Übertrag manuell*. Nur ein Modus ist gleichzeitig aktiv.
3. **Klare Topf-Differenzierung**: §45a (monatlich verfallend) und §39/42a (jahresweise) bekommen **kein** "Vorjahr verbraucht"-Feld. Stattdessen optional "Restguthaben zum Stichtag" (Bestandskunden-Migration).
4. **Topf-Karte mit Quell-Aufschlüsselung**: In der Kundenakte zeigt jede Topf-Karte ein aufklappbares Detail "Wie kommt der Stand zustande?" mit aufgeschlüsselten Quellen.
5. **Migration historischer Daten**: Separate Aufräum-Task, hier dokumentiert; nicht Teil dieses Konzepts.

---

## 2. Fachliche Regeln je Topf

### 2.1 §45b Entlastungsbetrag

| Regel | Wert |
|-------|------|
| Anspruch | Pflegegrad ≥ 1 |
| Standard-Höhe | 131 €/Monat (Stand 2025/2026) |
| Vergabe | Monatsweise, kumuliert übers Jahr |
| Vorjahres-Übertrag | Ja — ungenutztes Guthaben aus Vorjahr ist bis **30.06. des Folgejahres** nutzbar |
| Verfall | 01.07. des Folgejahres → automatischer `write_off` durch `processExpiredCarryover` |
| Anteilige Berechnung | Ja — wenn Pflegegrad unterjährig zugeordnet, anteilig ab Pflegegrad-Beginn-Monat |

**Konsequenz für UI**: Die Vorjahres-Sektion ist **nur** für §45b relevant und **nur** sichtbar, wenn `min(today, contractStart) <= 30.06. des aktuellen Jahres`.

### 2.2 §45a Umwandlungsanspruch

| Regel | Wert |
|-------|------|
| Anspruch | Pflegegrad ≥ 2 |
| Standard-Höhe (40% der ungenutzten §36-Sachleistungen) | PG2: 318 €, PG3: 599 €, PG4: 744 €, PG5: 920 € pro Monat |
| Vergabe | Monatsweise |
| Vorjahres-Übertrag | **Nein** — verfällt monatsweise |
| Verfall | Ende jedes Monats |

**Konsequenz für UI**: Kein "Vorjahr"-Feld. Bei Bestandskunden, die migriert werden, optional "Restguthaben zum Stichtag" als einmaliger Startwert (`initial_balance`).

### 2.3 §39/§42a Verhinderungs-/Kurzzeitpflege

| Regel | Wert |
|-------|------|
| Anspruch | Pflegegrad ≥ 2 |
| Standard-Höhe | 3.539 €/Jahr (kombiniert ab 01.07.2025) |
| Vergabe | Jahresweise |
| Vorjahres-Übertrag | **Nein** — Topf wird Jahresanfang neu vergeben |
| Verfall | 31.12. des laufenden Jahres |

**Konsequenz für UI**: Kein "Vorjahr"-Feld. Bei Bestandskunden optional "Restguthaben zum Stichtag" als `initial_balance` mit `expiresAt = ${year}-12-31` (bereits implementiert in `routes/budget.ts:319`).

---

## 3. Aktueller Stand: Code-Inventur

### 3.1 Datenmodell (`budget_allocations`)

```
budget_allocations:
  customerId       int
  budgetType       'entlastungsbetrag_45b' | 'umwandlung_45a' | 'ersatzpflege_39_42a'
  year             int
  month            int | null           -- null bei jährlichen Töpfen / carryover
  amountCents      int
  source           'initial_balance' | 'carryover' | 'monthly_auto' | 'monthly'
                   | 'manual_adjustment'
  validFrom        date                 -- Ab wann der Eintrag wirkt
  expiresAt        date | null          -- Verfalldatum
  notes            text
  deletedAt        timestamp | null
```

**Virtuelle Quellen**: `monthly_auto` (45a/45b) und `yearly_auto` (39/42a) werden **nicht persistiert**, sondern in `summary-queries.ts` aus den `budgetTypeSettings` berechnet (siehe Task #111-Drift). Persistiert sind nur die manuellen/abweichenden Quellen `initial_balance`, `carryover`, `manual_adjustment` sowie alt-persistierte `monthly`-Zeilen.

### 3.2 Backend-Endpoints

| Endpoint | Zweck | Aufrufer |
|----------|-------|----------|
| `POST /budget/:customerId/initial-budget` | Sammel-Endpoint für Wizard, schreibt `initial_balance` + ggf. `carryover` | `use-customer-wizard.ts:464` |
| `POST /budget/:customerId/initial-balance/:budgetType` | Einzelner Startwert pro Topf, Admin-Pflege | Bestandskunden-Edit-Dialog (heute spärlich genutzt) |
| `GET /budget/:customerId/initial-balances/:budgetType` | Historie aller Startwerte | Admin-Anzeige |
| `DELETE /budget/:customerId/initial-balance/:allocationId` | Startwert löschen | Admin-Korrektur |

### 3.3 Bestehende Dedup-Logik (Task #101 — funktioniert)

In `server/storage/budget/allocation-storage.ts`:

- **Zeile 374–386 (`calculateAllocated45b`)**: Beim Summieren wird ein `carryover` für Jahr Y *ignoriert*, wenn für Quelljahr `Y-1` ein `initial_balance` existiert.
- **Zeile 669–682 (`ensureYearlyCarryover45b`)**: Beim automatischen Anlegen wird kein `carryover` für (Y+1) erzeugt, wenn für Y ein `initial_balance` existiert.
- **Zeile 769+ (`processExpiredCarryover`)**: Verfallene Carryovers werden per `write_off` auf 0 gebucht.

**Diese Logik bleibt unverändert.** Das Konzept ändert nur das UI/Wizard-Verhalten und das API-Vertrags-Wording, nicht die zugrundeliegende Allokations-Mathematik.

### 3.4 Wizard-UI (heute)

`client/src/pages/admin/components/budgets-contract-step.tsx`, Zeilen 193–235:

- Pro §45b: Feld "Wie viel wurde im Vorjahr vom Entlastungsbetrag verbraucht?" + Feld "Übertrag (€)" (Auto-Ergebnis, manuell überschreibbar).
- `eligibleMonthsLastYear` wird aus `pflegegradSeit` berechnet — wenn Pflegegrad erst dieses Jahr begann, ist die Vorjahr-Sektion gegraut.
- **Kein Feld** für "Restwert Dezember Vorjahr als manueller Startwert" — Wizard sendet immer `initial_balance` mit dem Standard-Monatsbetrag des aktuellen Monats.
- **Keine Berücksichtigung des heutigen Datums** für die Juni-Deadline — auch am 15.07.2026 würde die Vorjahres-Sektion erscheinen, wenn `pflegegradSeit` in 2025 liegt.

### 3.5 Lücken (zu schließen)

1. **Juni-Deadline-Schwelle fehlt** im Wizard (Use-Case UC2).
2. **Drei parallele Konzepte** (Vorjahr-Verbrauch / Übertrag-Override / Startwert Dez) sind im Wizard nicht voneinander abgegrenzt (UC3).
3. **Bestandskunden-Edit-Dialog** ist primitiv: einfache Liste + Add/Delete-Knöpfe, keine Vorschau "Wie wirkt sich die Änderung aus" (UC4).
4. **Topf-Karte in der Akte** zeigt nur Endsumme, keine Aufschlüsselung Quell-Beträge (Sachbearbeiter-Verständlichkeit).
5. **§45a/§39 mit "Vorjahr"-Feld** verwirrt — diese Töpfe haben keinen Übertrag (UC6).

---

## 4. Entscheidungs-Matrix: Welche Eingaben erscheinen wann?

Eingangs-Variablen:
- `today` = heutiges Datum
- `contractStart` = Vertragsbeginn
- `pflegegradSeit` = Datum Pflegegrad-Zuordnung
- `juniDeadline(year)` = `${year}-06-30`

| Bedingung | §45b laufendes Jahr | §45b Vorjahr-Sektion | §45a | §39/42a |
|-----------|---------------------|----------------------|------|---------|
| `contractStart <= today` und `today <= juniDeadline(today.year)` und `pflegegradSeit < today.year` | Sichtbar | **Sichtbar** mit drei Modi (s. §5) | Sichtbar (kein Vorjahr) | Sichtbar (kein Vorjahr) |
| `today > juniDeadline(today.year)` ODER `pflegegradSeit >= today.year` | Sichtbar | **Ausgeblendet** + Hinweis-Toast "Vorjahresanspruch nicht relevant" | Sichtbar | Sichtbar |
| Wizard: Pflegegrad noch nicht ausgewählt | Sichtbar (gegraut) | Ausgeblendet | Gegraut | Gegraut |
| Bestandskunde, der **nachträglich** im Februar des Folgejahres erfasst wird (rückwirkende Erfassung) | Sichtbar | Sichtbar (heute liegt vor Juni-Deadline des Folgejahres) | Sichtbar | Sichtbar |

**Hinweis**: Die Schwelle nutzt `today` (nicht `contractStart`), weil entscheidend ist, ob der Anspruch zum Erfassungszeitpunkt noch existiert. Wenn ein Anwender am 15.07.2026 einen Kunden mit `contractStart = 01.03.2026` erfasst, ist der §45b-2025-Übertrag bereits verfallen — auch wenn der Vertrag früher begann. Korrektur dieser historischen Daten erfolgt über den Bestandskunden-Edit-Dialog, nicht über den Neuanlage-Wizard.

---

## 5. Eingabe-Hierarchie & Modi für §45b Vorjahres-Sektion

Statt drei paralleler Felder bekommt der Anwender **einen Auswahl-Schalter** mit drei Modi:

```
[●] Berechnen            (Default: Anwender kennt Verbrauch im Vorjahr)
[ ] Restwert eingeben    (Anwender kennt Restwert direkt)
[ ] Übertrag manuell     (Korrekturen / Sonderfälle)
```

### Modus A — "Berechnen" (Default)

Anwender gibt ein: **"Wie viel wurde im Vorjahr verbraucht?"** (€)
System berechnet: `uebertrag = (eligibleMonthsLastYear × 131) - verbraucht`
Speicherung: `carryover` mit `year = previousYear`, `expiresAt = ${currentYear}-06-30`
Kein `initial_balance` für Vorjahr.

### Modus B — "Restwert eingeben"

Anwender gibt ein: **"Restwert §45b zum Stichtag"** (€) + Stichtag (Default: letzter Monat Vorjahr)
Speicherung: `initial_balance` mit `year = previousYear`, `month = stichtag.month`, `amountCents = restwert`
Folge: Automatik unterdrückt `carryover` für `currentYear` (siehe `allocation-storage.ts:382-386`).
Visualisierung: Feld "Übertrag berechnet" zeigt `min(restwert, eligibleMonthsLastYear × 131)` und einen Hinweis "Wirkt sich automatisch auf das laufende Jahr aus".

### Modus C — "Übertrag manuell"

Anwender gibt ein: **"Übertrag (€)"** direkt
Speicherung: `carryover` mit `year = previousYear`, `expiresAt = ${currentYear}-06-30`
Audit-Eintrag: `manual_carryover_override` mit Anwender + Zeitstempel.
UI-Hinweis: "Manueller Übertrag — bitte Notiz hinterlegen."

**Wichtig**: Die drei Modi sind exklusiv. Wechsel zwischen ihnen verwirft die Eingaben des vorherigen Modus mit einem Bestätigungs-Dialog.

---

## 6. Use-Case-Walk-throughs

### UC1 — Neukunde 15.01.2026 mit Pflegegrad seit 01.07.2025

- `today = 15.01.2026`, `juniDeadline(2026) = 30.06.2026` → Vorjahres-Sektion **sichtbar**
- `eligibleMonthsLastYear = 6` (Juli–Dez 2025)
- `maxCarryover = 6 × 131 = 786 €`
- Default-Modus A: Anwender trägt z. B. "im Vorjahr 200 € verbraucht" → System berechnet 586 € Übertrag → `carryover` mit `expiresAt = 30.06.2026`

### UC2 — Neukunde 15.07.2026 (nach Juni-Deadline)

- `today = 15.07.2026 > juniDeadline(2026)` → Vorjahres-Sektion **ausgeblendet**
- Stattdessen Hinweis-Banner: *"§45b-Anspruch aus 2025 ist am 30.06.2026 verfallen — keine Erfassung erforderlich."*
- Nur laufendes Jahr (Juli–Dez 2026) wird erfasst.

### UC3 — Neukunde 15.03.2026, beim Vorgänger-Pflegedienst Geld verbraucht

- Anwender weiß: Vom 2025-Topf sind noch 320 € übrig, Stichtag 28.02.2026
- Wechsel auf **Modus B "Restwert eingeben"**
- Eingabe: 320 €, Stichtag = 02/2026
- Speicherung: `initial_balance` für `year=2025, month=12` (oder Stichtag-Monat, je nach finaler Entscheidung) mit 320 €
- Auto-Carryover für 2026 wird unterdrückt → keine Doppelzählung
- UI zeigt im laufenden Jahr 2026: "Stand 01.03.2026 = 320 € + März–Dez × 131 €"

### UC4 — Bestandskunde, Startwert vor 6 Monaten falsch eingetragen

- Sachbearbeiter öffnet Kundenakte → Topf-Karte §45b → "Startwerte verwalten" (Edit-Dialog)
- Dialog zeigt: alle vorhandenen `initial_balance` + `carryover` + `manual_adjustment` Einträge mit Stichtag, Betrag, Quelle, Anleger
- Aktion: **Startwert bearbeiten** → Vorschau-Box "vorher / nachher":
  - *vorher*: Topf-Stand heute = 412 €
  - *nachher*: Topf-Stand heute = 312 € (-100 €, da neuer Startwert 100 € niedriger)
- Warnung: *"Diese Änderung wirkt rückwirkend auf alle bereits gebuchten Termine. 7 Buchungen sind betroffen — bitte prüfen, ob Folge-Korrekturen nötig sind."*
- Bestätigung mit Pflicht-Notiz "Grund der Korrektur"

### UC5 — Bestandskunde, Pflegegrad rückwirkend geändert

- Außerhalb des Konzepts dieser Task — wird in einem separaten Konzept behandelt.
- **Schnittstelle**: Edit-Dialog soll einen Hinweis "Pflegegrad-Änderung kann Auswirkungen auf alle Töpfe haben — bitte separat prüfen" anzeigen.

### UC6 — §45a / §39: keine Vorjahres-Felder

- Wizard zeigt für §45a nur das monatliche Limit-Feld + "Pflegegrad-abhängiges Maximum"
- Wizard zeigt für §39/42a nur das Jahres-Limit-Feld
- Im Edit-Dialog (Bestandskunden) gibt es für beide Töpfe das **optionale** Feld "Restguthaben zum Stichtag" mit `expiresAt = ${year}-12-31` (39/42a) bzw. `expiresAt = ${year}-${month}-monthEnd` (45a).

---

## 7. Mockup-Skizzen (ASCII)

### 7.1 Wizard-Schritt "Budget" — Neukunde, vor Juni-Deadline

```
┌─ Pflegegrad ────────────────────────────────────────────────────────────┐
│  Pflegegrad: [PG3 ▼]            Pflegegrad seit: [01.07.2025 📅]       │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §45b Entlastungsbetrag ───────────────────────────────  [✓] aktiv ─────┐
│  Betrag: [131,00] €/Monat       (Standard: 131 €/Monat)                │
│                                                                         │
│  ┌─ Vorjahres-Anspruch (§45b 2025) ──────────────────────────────────┐ │
│  │  Anspruch 2025: 6 Monate × 131 € = 786 €  (gültig bis 30.06.2026) │ │
│  │                                                                    │ │
│  │  Wie möchten Sie den Übertrag erfassen?                            │ │
│  │   (●) Vorjahres-Verbrauch eintragen — wir berechnen den Rest      │ │
│  │   ( ) Restwert direkt eingeben                                    │ │
│  │   ( ) Übertrag manuell eintragen                                  │ │
│  │                                                                    │ │
│  │  Vorjahr verbraucht (€): [200,00]                                  │ │
│  │  → Übertrag berechnet:    586,00 € (verfällt 30.06.2026)           │ │
│  └────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §45a Umwandlung ──────────────────────────────────────  [✓] aktiv ─────┐
│  Betrag: [599,00] €/Monat       Maximum für PG3: 599 €                 │
│  ℹ️ §45a verfällt monatsweise — kein Vorjahres-Übertrag.                │
└─────────────────────────────────────────────────────────────────────────┘

┌─ §39/§42a Verhinderungspflege ─────────────────────────  [✓] aktiv ─────┐
│  Betrag: [3539,00] €/Jahr       Standard: 3.539 €/Jahr                 │
│  ℹ️ §39/§42a verfällt jährlich — kein Vorjahres-Übertrag.               │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Wizard-Schritt "Budget" — Neukunde, nach Juni-Deadline

```
┌─ §45b Entlastungsbetrag ───────────────────────────────  [✓] aktiv ─────┐
│  Betrag: [131,00] €/Monat                                              │
│                                                                         │
│  ┌─ ℹ️ Hinweis ──────────────────────────────────────────────────────┐  │
│  │  Der §45b-Anspruch aus 2025 ist am 30.06.2026 verfallen.          │  │
│  │  Eine Erfassung des Vorjahres-Übertrags ist nicht mehr nötig.     │  │
│  │  Falls der Kunde rückwirkend für das 1. Halbjahr 2026 abgerechnet │  │
│  │  werden soll, bitte den Vertragsbeginn entsprechend setzen und    │  │
│  │  Korrekturen über die Kundenakte vornehmen.                       │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.3 Bestandskunden-Edit-Dialog "Startwerte §45b verwalten"

```
┌─ Startwerte §45b — Max Mustermann ────────────────────────────────[X]──┐
│                                                                         │
│  Aktueller Topf-Stand (heute, 18.04.2026):                             │
│    Anspruch laufend:    4 × 131 €      =   524 €                       │
│    Übertrag aus 2025:                  =   320 € (verfällt 30.06.2026) │
│    Bereits verbraucht:                 =  -180 €                       │
│    ───────────────────────────────────────────────                     │
│    Verfügbar:                              664 €                       │
│                                                                         │
│  ┌─ Vorhandene Einträge ────────────────────────────────────────────┐  │
│  │ Stichtag    Quelle             Betrag    Notiz       [Aktionen] │  │
│  │ 12/2025     initial_balance    320,00 €  "Restguth." [Bearb.] [🗑]│ │
│  │ 01/2026     carryover (auto)   ── unterdrückt (Startwert vorh.) │  │
│  │ 03/2026     manual_adjustment   50,00 €  "Korrektur" [Bearb.] [🗑]│  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  [+ Neuen Startwert hinzufügen]                                        │
│                                                                         │
│  ┌─ Vorschau bei Änderung (320 € → 250 €) ─────────────────────────┐  │
│  │  vorher: 664 € verfügbar                                        │  │
│  │  nachher: 594 € verfügbar  (-70 €)                              │  │
│  │  ⚠️ 7 Buchungen ab Stichtag betroffen — bitte prüfen.           │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│  Pflicht-Notiz: [_____________________________________________]        │
│                                                                         │
│                                  [Abbrechen]  [Änderungen speichern]   │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.4 Topf-Karte in der Kundenakte (mit aufklappbarer Quell-Aufschlüsselung)

```
┌─ §45b Entlastungsbetrag ─────────────────────────── 2026 ──────────────┐
│                                                                         │
│   Verfügbar: 664,00 €    von 1.572,00 € (Anspruch laufend + Übertrag)  │
│   ▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░ 42% verbraucht                        │
│                                                                         │
│   [▼ Wie kommt dieser Stand zustande?]                                 │
│   ┌─ Quell-Aufschlüsselung ─────────────────────────────────────────┐  │
│   │  Anspruch lfd. Jahr (Apr–Dez):    9 × 131 € =  1.179 €          │  │
│   │  ➕ Startwert 12/2025:                          320 € (manuell)  │  │
│   │     ⓘ Auto-Übertrag aus 2025 wurde unterdrückt (Startwert vorh.)│  │
│   │  ➕ Manuelle Anpassung 03/2026:                  50 € (Korrektur)│  │
│   │  ➖ Bisher verbraucht (12 Termine):            -885 €            │  │
│   │  ─────────────────────────────────────────────────────────────  │  │
│   │  = Verfügbar:                                   664 €            │  │
│   │                                                                 │  │
│   │  ⏰ Übertrag aus 2025 (320 €) verfällt am 30.06.2026.           │  │
│   └────────────────────────────────────────────────────────────────┘  │
│                                                                         │
│   [Startwerte verwalten]  [Termine anzeigen]  [Manuelle Korrektur]     │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 8. API-Spec: heute → vorgeschlagen

### 8.1 `POST /budget/:customerId/initial-budget` (Wizard, Sammel-Endpoint)

**Heute:**
```json
{
  "budgetType": "entlastungsbetrag_45b",
  "currentYearAmountCents": 13100,
  "carryoverAmountCents": 58600,
  "budgetStartDate": "2026-01-15"
}
```

**Vorgeschlagen** — Backend bleibt rückwärtskompatibel, Wizard sendet zusätzlich einen Modus-Flag:

```json
{
  "budgetType": "entlastungsbetrag_45b",
  "currentYearAmountCents": 13100,
  "budgetStartDate": "2026-01-15",
  "vorjahrMode": "calculated" | "remainder" | "manual_override" | "none",
  "vorjahrPayload": {
    // bei "calculated":     { "verbraucht45bCents": 20000 }
    // bei "remainder":      { "restwertCents": 32000, "stichtag": "2025-12" }
    // bei "manual_override":{ "uebertragCents": 50000, "notiz": "..." }
    // bei "none":           {}
  }
}
```

**Backend-Verhalten:**
- `mode = "none"` (Default, wenn `today > juniDeadline`): keine Carryover-Zeile.
- `mode = "calculated"`: Berechnet `uebertrag = max(0, eligibleMonthsLastYear × 131 - verbraucht)`, schreibt `carryover` Row.
- `mode = "remainder"`: Schreibt `initial_balance` Row für Vorjahr (Stichtag-Monat). Auto-Carryover wird unterdrückt (vorhandene Logik).
- `mode = "manual_override"`: Schreibt `carryover` Row direkt mit übergebenem Betrag, audit-loggt `manual_carryover_override`.

**Atomarität (wichtig)**: Beim Anwenden eines neuen Modus löscht der Endpoint **vorab** alle bisherigen `carryover`- und Vorjahr-`initial_balance`-Rows für denselben (Kunde, Topf, Quelljahr). Andernfalls könnten bei Modus-Wechseln im Wizard ("Mode-Mixing") Doppel-Einträge entstehen, die zwar von der Dedup-Logik abgefangen werden, aber als Phantom-Daten in der DB verbleiben.

**Backend-Anpassung in `ensureYearlyCarryover45b`** (Folge-Task): Aktuell unterdrückt die Funktion den Auto-Carryover für (Y+1) nur, wenn ein `initial_balance` für **Quelljahr Y** existiert. Wird im Modus B ein Restwert mit `Stichtag im Folgejahr` (z. B. 02/2026) eingegeben, hat dieser `year=2026` — die bestehende Suppression greift nicht. Erweiterung nötig: zusätzlich unterdrücken, wenn das **Zieljahr** bereits einen `initial_balance` enthält. Diese Anpassung wird im Folge-Task "Wizard §45b Vorjahres-Sektion" mit umgesetzt.

### 8.2 `POST /budget/:customerId/initial-balance/:budgetType` (Edit-Dialog)

**Heute:** unverändert. Bleibt als Low-Level-Endpoint für Admin-Korrekturen. Wird vom neuen Edit-Dialog genutzt.

**Erweiterung — neuer Endpoint für Vorschau:**

```
POST /budget/:customerId/preview-startwert-change
{
  "budgetType": "entlastungsbetrag_45b",
  "allocationId": 1234,
  "newAmountCents": 25000
}

Response:
{
  "before": { "available": 66400, "consumedCount": 12 },
  "after": { "available": 59400, "consumedCount": 12 },
  "affectedBookings": 7,
  "warnings": ["Buchungen ab 12/2025 müssen ggf. korrigiert werden."]
}
```

Dieser Endpoint berechnet die Änderung **read-only** (kein Schreibvorgang) für die Vorschau im Dialog (UC4).

### 8.3 Audit-Events (neu)

| Event | Trigger | Payload |
|-------|---------|---------|
| `manual_carryover_override` | Modus C im Wizard | `{ customerId, year, amountCents, notes }` |
| `startwert_corrected` | Edit-Dialog mit Notiz | `{ customerId, allocationId, oldAmount, newAmount, notes }` |

---

## 9. Migration historischer Daten (separater Task)

**Problem (heute beobachtet)**: In Produktion existiert mindestens 1 Kunde mit gleichzeitig `initial_balance Dez 2025 = 250 €` und `carryover 2026 = 250 €` — Doppelzählung. Die Dedup-Logik in `calculateAllocated45b` filtert das beim Lesen heraus, aber die Daten bleiben als Phantom-Zeilen in der DB und tauchen z. B. in Reports auf.

**Strategie** (separater Backlog-Task "Bereinigung historischer Doppel-Startwerte"):

1. Read-only Audit-Skript: Alle Kunden mit `initial_balance(year=Y) AND carryover(year=Y+1)` listen.
2. Pro Fall manuelle Entscheidung: welche Quelle "wahr" ist (initial_balance bevorzugen, da expliziter).
3. **Vor dem Soft-Delete: alle `budget_transactions.allocationId` umhängen.** Bestehende Verbrauchs-Buchungen (`consumption`, `write_off`, `reversal`) referenzieren `allocationId` (siehe `allocation-storage.ts:699–720`). Würde die Allokation einfach soft-gelöscht, blieben Phantom-Referenzen zurück und die linked-consumption-Berechnung würde diese Buchungen verlieren oder falsch zuordnen.
   - Migration: `UPDATE budget_transactions SET allocation_id = <retainedId> WHERE allocation_id = <deletedId>`.
   - Audit-Log pro umgehängter Buchung: `transaction_relinked` mit alter/neuer `allocationId`.
4. Soft-Delete der überzähligen Zeile (`deletedAt = now()`), Audit-Log `historical_dedup_cleanup`.
5. Rollback-Pfad: `deletedAt = null` UND Re-Mapping der `allocationId`s rückgängig machen (Audit-Log nutzen).

**Wichtig**: Migration berührt **nicht** den Algorithmus — der Algorithmus arbeitet bereits korrekt. Migration entfernt nur Phantom-Daten für saubere Reports/Exporte. Die Re-Mapping-Pflicht (Schritt 3) ist die einzige technisch heikle Stelle und muss in einer Transaktion atomar mit Schritt 4 erfolgen.

---

## 10. Folge-Tasks (Implementierungs-Roadmap)

Nach Abnahme dieses Konzepts werden folgende Tasks angelegt:

1. **Wizard §45b Vorjahres-Sektion: 3-Modus-Auswahl + Juni-Deadline-Schwelle**
   - `client/src/pages/admin/components/budgets-contract-step.tsx`
   - `client/src/pages/admin/hooks/use-customer-wizard.ts` (Payload-Erweiterung)
   - `server/routes/budget.ts` (initial-budget Endpoint: `vorjahrMode` Handling)
   - Akzeptanz: UC1, UC2, UC3 manuell verifizierbar

2. **Bestandskunden-Edit-Dialog "Startwerte verwalten" mit Vorschau**
   - Neue Komponente `client/src/components/budget/StartwertManagementDialog.tsx`
   - Neuer Endpoint `POST /budget/:customerId/preview-startwert-change`
   - Audit-Logs `startwert_corrected`
   - Akzeptanz: UC4 manuell verifizierbar

3. **Topf-Karte in Kundenakte: aufklappbare Quell-Aufschlüsselung**
   - Bestehende Komponente `client/src/components/budget/BudgetLedgerSection.tsx` erweitern
   - Neuer Endpoint oder Erweiterung von `/budget/:customerId/overview`: pro Topf eine `breakdown[]` mit Quellen
   - Akzeptanz: Akten-Topf-Karte zeigt Anspruch laufend / Startwert / Anpassung / Verbraucht / Verfügbar getrennt

4. **§45a/§39 Edit-Dialog: optionales "Restguthaben zum Stichtag"** (UC6, niedrigste Prio)
   - Reuse des Dialogs aus Task 2.

Bereits im Backlog (kein Doppel-Task):
- "Bereinigung historischer Doppel-Startwerte für Bestandskunden"
- "Warnung anzeigen, wenn Startwert nach laufendem Jahresverlauf gesetzt wird"

---

## 11. Risiken & offene Fragen

- **Fachliche Validierung 30.06.-Frist**: Bitte vom Pflege-Fachbereich bestätigen, dass es keine Sonder-Verlängerungen für Härtefälle gibt, die wir berücksichtigen müssten (z. B. pandemiebedingt 2020/2021).
- **Stichtag bei "Restwert"-Modus**: Datentechnisch wird `initial_balance` mit (`year`, `month`) abgelegt. Wenn der Anwender den Stichtag auf "12/2025" setzt, lautet der Eintrag `year=2025, month=12, validFrom=2025-12-01`. Die Dedup-Logik unterdrückt dann den Auto-Carryover für 2026. Frage: Soll der Anwender den Monat frei wählen können, oder nur "12 Vorjahr" als Default? **Vorschlag**: 12 Vorjahr als Default, frei wählbar für Sonderfälle (z. B. Pflegegrad-Wechsel mitten im Vorjahr).
- **Modus-Wechsel mid-form**: UX-Frage — sollen Eingaben beim Wechsel verworfen oder behalten werden? **Vorschlag**: Bestätigungs-Dialog vor dem Verwerfen.
- **Backwards Compatibility Wizard**: Bestehende Wizard-Flows (Tests, evtl. externe Integrationen) senden den alten Payload ohne `vorjahrMode`. Backend sollte beide Formate unterstützen (alt = `mode: calculated` mit `verbraucht=0, uebertrag=carryoverAmountCents`).

---

## 12. Akzeptanzkriterien für dieses Konzept

- [x] Alle 6 Use-Cases (UC1–UC6) sind dokumentiert und mit erwartetem Verhalten beschrieben.
- [x] Fachliche Regeln je Topf (§45b/§45a/§39/42a) sind tabellarisch dokumentiert inkl. Verfallsregeln.
- [x] Eingabe-Hierarchie/Modi sind exklusiv und nachvollziehbar.
- [x] Mockups für Wizard (vor/nach Juni), Edit-Dialog, Akten-Topf-Karte sind enthalten (ASCII).
- [x] API-Spec heute → vorgeschlagen ist dokumentiert; Backend bleibt rückwärtskompatibel.
- [x] Migrations-Strategie für historische Doppel-Startwerte ist skizziert (Implementierung in eigenem Task).
- [x] Folge-Tasks sind benannt; keine Code-Änderungen am Wizard/Backend in dieser Task.
