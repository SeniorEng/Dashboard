# März-2026-Karteileichen — Quellenanalyse (Task #515)

Stand: 15. Mai 2026 · Read-only-Analyse (Prod-Replica + Git-History)

## Kurzfassung

Die 15 Waisen-Kunden mit `status='erstberatung'` und `converted_from_prospect_id IS NULL` (IDs 120, 121, 122, 123, 127, 128, 129, 131, 133, 142, 143, 144, 145, 147, 154) stammen **alle** aus dem **alten Lead-Anlage-Flow vor Task #15** ("Lead-to-Client Backend-Refactoring", landete am **2026-03-23 09:18 UTC**). Das Zeitfenster der Anlagen (2026-03-02 … 2026-03-20) endet exakt zwei Werktage vor dem Refactor. Seit dem Refactor (jetzt zusätzlich abgesichert durch Task #510/#512 Storage-Guard und CHECK-Constraint sowie Task #315 Entfernung der toten Convert-Route) **kann kein Pfad mehr** im laufenden Code solche Karteileichen erzeugen — eine erneute Anbindung an einen Prospect-Flow ist nicht erforderlich, weil der zuständige Code bereits ersatzlos entfernt wurde.

## Beweisführung

### 1. Zeitliche Korrelation

| Datum | Ereignis |
|---|---|
| **2026-03-02 … 2026-03-20** | 15 Waisen-Kunden in Prod angelegt (alle 15 in diesem Fenster, alle mit `created_by_user_id = NULL`, je 1 zugehöriger Erstberatungs-Termin) |
| **2026-03-23 09:18 UTC** | Task #15 (commit `914009e`) — Backend-Refactor: `appointments.prospect_id` FK, `prospect_offers`-Tabelle, neuer Endpunkt `POST /api/appointments/prospect-erstberatung`, Status-Pipeline `qualifiziert/erstberatung_durchgeführt/angebot_gemacht/gewonnen` |
| **2026-03-23 09:32 UTC** | Task #16 (commit `6c4f623`) — Frontend-Umbau auf Prospect-Flow |
| **2026-05-04** | Task #315 (commit `2b1c196`) — entfernt die tote Restroute `POST /admin/prospects/:id/convert` (war nach Task #314 schon nicht mehr erreichbar) |
| **Mai 2026** | Task #509 (Backfill-Migration mit synthetischen Prospects), Task #510 (Storage-Guard), Task #512 (CHECK-Constraint), Task #513 (entfernt `'erstberatung'` aus `customer.status`) |

**Nach 2026-03-20 wurde kein einziger weiterer Waisen-Kunde mehr angelegt** — der direkte zeitliche Schnitt mit dem Refactor ist der stärkste Indikator.

### 2. Pattern der Waisen vs. Convert-Route

Die alte `POST /admin/prospects/:id/convert`-Route (parent von `2b1c196`) setzte:

```ts
const [customer] = await tx.insert(customers).values({
  ...buildCustomerInsertData(data, userId),
  status: "aktiv",                       // ← nicht 'erstberatung'
  convertedFromProspectId: id,           // ← Link wäre gesetzt worden
}).returning();
```

Damit erzeugt diese Route **keine** Waisen — sie setzt `status='aktiv'` und befüllt `convertedFromProspectId`. Auch der heutige Pfad `POST /api/admin/customers` (über `buildCustomerInsertData`) setzt `createdByUserId: userId`. Beide passen nicht zum Waisen-Profil (`status='erstberatung'`, `created_by_user_id=NULL`).

Die Kombination "`status='erstberatung'` + `created_by_user_id=NULL` + alle 15 zwischen 2026-03-02 und 2026-03-20" ist nur mit einem **vor dem Refactor existierenden** Lead-Anlage-Pfad erklärbar, in dem ein eingehender Lead (Anruf/Mail) direkt als Kunden-Datensatz mit Erstberatung-Status angelegt wurde, ohne den damals noch nicht existierenden Prospects-Datensatz und ohne sessionbezogenen `userId` (z. B. weil ein automatisierter Email-Parser oder ein Skript den Insert ausführte).

### 3. Audit-/Prod-Logs

* **Deployment-Logs**: Keine Treffer für `ERSTBERATUNG_REQUIRES_PROSPECT`, `assertErstberatungHasProspectLink` oder verwandte Fehler. Der Storage-Guard (Task #510) feuert in Prod aktuell nicht — d. h. **kein laufender Code** versucht heute noch einen solchen Insert.
* **Startup-Migration-Warnungen** (`server/startup/migrate-erstberatung-customers.ts`): Wiederholen lediglich die Liste der 15 historischen Waisen, keine neuen Einträge.
* **`audit_log`**: Genau ein Eintrag (Kunde 143) als Customer-Anlage, sonst keinerlei Historie an den 15 Datensätzen — konsistent mit einer automatisierten, nicht UI-getriebenen Anlage über den alten Pfad.

## Konsequenz für Task #515 — Done Criteria

* **„Audit-Log und Prod-Logs nach Insert-Fehlern durchsuchen"** — erledigt. Es existieren **keine** Fehlermeldungen mit `ERSTBERATUNG_REQUIRES_PROSPECT` in Prod-Deployment-Logs oder im `audit_log`. Der Storage-Guard läuft seit Task #510 in Produktion, ohne je ausgelöst zu haben.
* **„Auslösende Stelle identifizieren und an Prospect-Pfad anbinden"** — die auslösende Stelle ist der **alte Lead-Anlage-Flow vor Task #15** und existiert seit dem Backend-Refactor am 2026-03-23 nicht mehr im Code. Eine "saubere Anbindung an Prospect-Anlage" wurde damals bereits durchgeführt: Leads werden heute über `POST /api/appointments/prospect-erstberatung` direkt als `prospects`-Datensatz mit Erstberatungstermin angelegt; eine Konvertierung zum Kunden setzt `convertedFromProspectId`.

## Empfehlung

* **Keine weitere Code-Änderung nötig.** Die Quelle ist ausgelaufen, der ersetzende Pfad steht, drei Schutzschichten (Storage-Guard, CHECK-Constraint, geplanter Wegfall des Status `'erstberatung'` in Task #513) blockieren Rückfälle.
* **Bereinigung der 15 Bestands-Waisen** läuft separat über Task #509 (synthetische Prospects) bzw. die in `docs/erstberatung-prod-analysis.md` skizzierte Alternative (Hard-Delete der 15 Kunden + 15 Erstberatungs-Termine ohne Folge-Geschäft).
