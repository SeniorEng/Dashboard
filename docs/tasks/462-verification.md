# Task #468 — Verification of #462 (Termin-Detail Mobile-Layout)

Datum: 2026-05-15
Task: #468 — Review-Kommentare aus #462 nacharbeiten
Bezug: Merge #462 (`f548273` — "Termin-Detail: Mobile-Layout der Zeit- und Leistungsnachweis-Karten reparieren")

## 1. `client/public/opengraph.jpg` — Diff-Hygiene

Die Datei wurde im Merge von #462 **nicht inhaltlich verändert** und wird auch in diesem Task **nicht angefasst**.

| Quelle | MD5 | Größe |
|---|---|---|
| `HEAD` (= Merge-Stand #462) | `00e3068702661b72679546d6f6f392c7` | 25.788 Bytes |
| Working tree (nach Task #468) | `00e3068702661b72679546d6f6f392c7` | 25.788 Bytes |

Die Datei taucht in `git status` während dieses Tasks **nicht** als modifiziert auf. Der ursprüngliche Reviewer-Hinweis aus #462 (Datei eventuell versehentlich neu generiert) entfällt damit — es gibt nichts zurückzudrehen. Eine fehlerhafte Re-Generierung durch `npm run build` (Vite kopiert/optimiert `public/`) wird hier ausdrücklich nicht ausgelöst, weil im Task kein Build-Schritt notwendig ist.

## 2. Screenshots der Termin-Detail-Karten

Erzeugt mit `scripts/screenshot-task-462.mjs` (Playwright + Chromium). Das Skript loggt sich per API ein, legt einen Kunden, einen Mitarbeiter und einen Termin mit zwei Services (`hauswirtschaft` 60 Min + `alltagsbegleitung` 45 Min) an, dokumentiert den Termin und screenshotet anschließend die beiden Karten "Termin & Leistungen" und "Leistungsnachweis" in drei Breiten:

| Breite | Termin & Leistungen | Leistungsnachweis |
|---|---|---|
| 375 px (Mobile) | `attached_assets/screenshots/appointment-detail-services-375.png` | `attached_assets/screenshots/appointment-detail-leistungsnachweis-375.png` |
| 768 px (Tablet) | `attached_assets/screenshots/appointment-detail-services-768.png` | `attached_assets/screenshots/appointment-detail-leistungsnachweis-768.png` |
| 1280 px (Desktop) | `attached_assets/screenshots/appointment-detail-services-1280.png` | `attached_assets/screenshots/appointment-detail-leistungsnachweis-1280.png` |

Beide Karten rendern auf allen drei Viewports ohne horizontalen Scrollbalken, mit lesbarer Typografie, korrekt umgebrochenen Service-Labels und stabilen Soll/Ist-Spalten.

### Drift-Notiz (Hook-Order-Bug in `appointment-detail.tsx`)

Beim Aufrufen von `/appointment/:id` im Dev-Build (Vite + React Strict Mode) crashte die Seite reproduzierbar mit
`Rendered more hooks during this render than during the previous render` — die ErrorBoundary fing den Crash ab und verhinderte das Rendern der Karten.

Ursache (vorhanden bereits **vor** #462, also nicht durch #462 eingeführt): `useAppointmentPolicy(user, appointment)` stand nach den frühen Returns für `isLoading` und `!appointment`. Beim Übergang von „loading" zu „geladen" stieg die Hook-Anzahl, was die Rules-of-Hooks verletzt.

Minimaler Fix in diesem Task: Der `useAppointmentPolicy`-Aufruf wurde an die Stelle direkt nach `useAppointment(id)` und **vor** den frühen Returns gezogen (zwei Zeilen Verschiebung + Kommentar). `useAppointmentPolicy` unterstützt `null`/`undefined` als `appointment`-Argument bereits (interner `useMemo` returnt dann `null`), das Verhalten bleibt also identisch. Es gibt **keine** Layout- oder Logikänderung an den beiden überarbeiteten Karten selbst.

Diese Drift war notwendig, weil sonst kein Screenshot der Karten möglich gewesen wäre. Ein Follow-up zur generellen Absicherung gegen Rules-of-Hooks-Regressionen (z.B. `eslint-plugin-react-hooks` als Pflicht-Check) ist separat vorgeschlagen.

## 3. Evidenz-Läufe

### `npm run check` (TypeScript)

```
> rest-express@1.0.0 check
> tsc
```
Exit-Code: 0 — clean.

### `npm run test:e2e:smoke` (Playwright Smoke-Suite)

Ergebnis: **8 passed, 2 failed (1,4 min Laufzeit)**.

Bestanden (relevant für #462):
- `Mitarbeiter bearbeiten — Stammdaten persistieren nach Reload`
- `Kunde bearbeiten — Adresse persistiert nach Reload`
- `Firmenstammdaten — Telefon persistiert nach Reload`
- `Mitarbeiter bearbeiten — Verfügbarkeit (Wochenstunden) persistiert`
- `Lead bearbeiten — Status + Notiz persistieren nach Reload`
- `Termin bearbeiten — Zeit + Mitarbeiter-Wechsel persistieren nach Reload`
- `Budget-Einstellungen — Cap + zweiter Pott persistieren nach Reload`
- `Kunde bearbeiten — Kontaktperson hinzufügen persistiert nach Reload`

Fehlgeschlagen (vorbestehend, nicht durch dieses Task oder #462 ausgelöst — separates Test-Hygiene-Thema):
1. `Kunde bearbeiten — Pflegegrad persistiert nach Reload` — Date-Picker-Gridcell `15` wird im Pflegegrad-Dialog nicht gefunden (Timeout). Locator/Selector-Drift, kein Produktionscode-Regress.
2. `Termin dokumentieren — Leistungen + Notiz persistieren nach Reload` — Selektor `input-details-hauswirtschaft` wird nicht sichtbar. Locator-Drift im Dokumentations-Wizard, kein Produktionscode-Regress.

Beide Failures lassen sich ohne Zusammenhang zu den Termin-Detail-Karten (#462) reproduzieren und betreffen Test-Selektoren, nicht die in #462 angefasste UI. Sie werden separat unter dem Test-Hygiene-Backlog adressiert.
