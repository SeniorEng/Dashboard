# Pseudonymisierter Prod-Mirror (engeldesk-01)

Ticket `6hf36pRXqr2FR8JG`. **Zweck:** CC misst und rechnet an einem pseudonymisierten Abzug von Prod selbst. Es gibt keine Prod-Befehle mehr über Alrik. Jede Messung nennt den Stichtag aus `mirror_meta`.

## Aufbau

| Teil | Wo | Wer |
|---|---|---|
| Leserolle `mirror_reader` | Prod (Neon), nur `SELECT`, voreingestellt read-only | legt Alrik einmal an (Gate 4) |
| Mirror-Cluster | `docker-compose.mirror.yml`, Postgres 18, `127.0.0.1:5433`, eigenes Volume | startet Alrik einmal (sudo) |
| Abzug | `scripts/mirror/prod-mirror-abzug.sh` | startet Alrik von Hand, wenn ein neuer Stand gebraucht wird |
| Spaltenliste | `scripts/mirror/spalten.tsv`: jede Text-/JSON-Spalte und jede Datums-/Zahlenspalte mit Personenbezug, mit Regel und Begründung | CC pflegt, Cowork prüft |
| Leserolle für CC | `cc_readonly` im Mirror-Cluster, nur `SELECT`, voreingestellt read-only | legt der Abzug an, Passwort setzt Alrik |

**Ablauf des Abzugs:**
1. Prod wird nur im Snapshot gelesen (`REPEATABLE READ, READ ONLY`, Rolle `mirror_reader`).
2. `pg_dump` streamt direkt in eine Staging-DB im Mirror-Cluster. Es entsteht kein Dump auf der Platte.
3. Die Daten werden pseudonymisiert und geprüft.
4. Erst dann wird die Staging-DB zu `prod_mirror` umbenannt. Der alte Abzug wird gelöscht, es bleibt immer nur der letzte.
5. **Scheitert ein Schritt, wird die Staging-DB gelöscht, und `prod_mirror` bleibt unverändert.**

**Das Skript bricht ab**, wenn
- die DB eine Text-/JSON-Spalte hat, die nicht in `spalten.tsv` steht, oder die Liste eine Spalte nennt, die es nicht gibt (Ausgabe: nur Spaltennamen),
- die Zeilenzahlen einer Tabelle von Prod im Snapshot abweichen (Abnahme 1),
- die Stichprobe Kunde 89 (Zuweisungen, Buchungen, Rechnungen, Termine) andere Zeilenzahlen hat (Abnahme 2),
- nach der Pseudonymisierung irgendein Klarname, eine E-Mail-Adresse oder eine IBAN in einer Text-/JSON-Spalte steht (Abnahme 3). Die Namen stammen aus Kunden, Mitarbeitern, Kontakten, Interessenten und Leads, Token ab 4 Buchstaben. Ausgabe: nur Spalte und Anzahl.

**Was bleibt:** IDs, Beträge, Daten, Pflegegrade, Buchungen, Rechnungsnummern, Status, Hashes, Kassen-Stammdaten (Institutionen), Konfiguration.

**Was ersetzt wird:**
- Namen, Anschriften, Kontakte, Versichertennummern, IBANs
- Freitexte, Unterschriften, IP-Adressen
- Zugangsdaten und Tokens der Firma
- Geo-Koordinaten der Wohnungen
- Geburtsdatum: auf den 01.01. gesetzt, das Jahr bleibt
- In Budget-Notizen bleibt nur der Storno-Verweis `Storno … Transaktion #N` stehen, weil ihn die Fachlogik liest.
- JSON (Audit, Rechnungs-Snapshot): Die Struktur bleibt, Texte werden `[x]` außer unter fachlichen Schlüsseln und bei reinen Zahlen oder Daten.

## Grenzen (offen benannt)

- Auf engeldesk-01 gibt es nur den Unix-Benutzer `dev`, und unter dem läuft auch CC. Das Skript hält die Passwörter nur im Speicher und in der Umgebung der gestarteten `psql`/`pg_dump`-Prozesse, solange sie laufen. Es gibt keine Datei, keine History und keine Kommandozeile. Eine harte Trennung ist das nicht; die gäbe erst ein eigener Unix-Benutzer für den Abzug. **Während des Abzugs keine CC-Sitzung laufen lassen.**
- Die Suche nach Klarnamen findet nur Namen, die in den Stammdaten stehen. Namen Dritter in Freitexten sind durch die Regel „Freitext → ersetzt“ abgedeckt, nicht durch die Suche.

## Reihenfolge (nach dem Merge von #198)

**Entscheidung Alrik (26.09.2026):**
- Vorerst nur manuelle Abzüge.
- **Während eines Abzugs läuft keine CC-Sitzung.**
- Ein nächtlicher Timer kommt erst mit einem eigenen Unix-Benutzer für den Abzug (FINDING P2).

Alle Befehle auf engeldesk-01 laufen in einem **eigenen Clone `~/mirror`** auf `main`, nicht in CCs Arbeitsordner. Der Abzug braucht nur `bash`, `psql`, `pg_dump`, `python3` und `git`, kein `npm`.

1. **Replit-Shell — Leserolle in Prod anlegen** (einmalig, **Gate 4**; das Passwort wird verdeckt abgefragt):
   ```
   read -rs -p 'Neues Passwort für mirror_reader (mind. 24 Zeichen, nur Buchstaben/Ziffern): ' MRPW; echo; if [[ "$MRPW" =~ ^[A-Za-z0-9]{24,}$ ]]; then printf '%s\n' "\\set pw '$MRPW'" 'BEGIN;' 'CREATE ROLE mirror_reader WITH LOGIN PASSWORD :'\''pw'\'';' 'DO $d$ BEGIN EXECUTE format('\''GRANT CONNECT ON DATABASE %I TO mirror_reader'\'', current_database()); END $d$;' 'GRANT USAGE ON SCHEMA public TO mirror_reader;' 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO mirror_reader;' 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO mirror_reader;' 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mirror_reader;' 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO mirror_reader;' 'ALTER ROLE mirror_reader SET default_transaction_read_only = on;' 'COMMIT;' | psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1; else echo 'ABBRUCH: Passwort muss mind. 24 Zeichen haben, nur Buchstaben/Ziffern.'; fi; unset MRPW
   ```
2. **Replit-Shell — Leserolle prüfen** (einmalig). Erwartet: eine Zeile mit `mirror_reader` und der Kundenzahl, dann `on`, dann drei Fehler („read-only transaction“ / „permission denied“ / „read-only transaction“):
   ```
   read -rs -p 'Passwort mirror_reader: ' MRPW; echo; MRURL="${PROD_DATABASE_URL/\/\/*@/\/\/mirror_reader@}"; MRURL="${MRURL/-pooler/}"; PGPASSWORD="$MRPW" psql "$MRURL" -X <<< $'SELECT current_user AS rolle, current_database() AS db, (SELECT count(*) FROM customers) AS kunden;\nSHOW default_transaction_read_only;\nUPDATE customers SET id = id WHERE false;\nBEGIN READ WRITE;\nUPDATE customers SET id = id WHERE false;\nROLLBACK;\nCREATE TABLE mirror_probe (x int);'; unset MRPW MRURL
   ```
3. **engeldesk-01 — eigenen Clone anlegen** (einmalig):
   ```
   gh repo clone SeniorEng/Dashboard ~/mirror -- --branch main --single-branch
   ```
4. **engeldesk-01 — Mirror-Cluster starten** (einmalig, sudo; Admin-Passwort verdeckt):
   ```
   read -rs -p 'Neues Passwort Mirror-Admin: ' MIRROR_ADMIN_PW; echo; export MIRROR_ADMIN_PW; sudo --preserve-env=MIRROR_ADMIN_PW docker compose -f ~/mirror/docker-compose.mirror.yml up -d; unset MIRROR_ADMIN_PW
   ```
5. **engeldesk-01 — Abzug** (bei jedem Bedarf; vorher alle CC-Sitzungen beenden). Holt zuerst den aktuellen `main`, dann fragt das Skript Neon-Host (direkter Endpunkt, ohne „-pooler“), Datenbank, Passwort `mirror_reader` und Passwort Mirror-Admin:
   ```
   ( set -e; git -C ~/mirror checkout -q main; git -C ~/mirror pull -q --ff-only; bash ~/mirror/scripts/mirror/prod-mirror-abzug.sh )
   ```
   Am Ende steht `FERTIG: prod_mirror ersetzt · Stichtag … · Skript <commit> · Spaltenliste <hash>`. Bei `ABBRUCH` bleibt der vorige Mirror unverändert; die Meldung nennt nur Spalten und Anzahlen und kann CC so weitergegeben werden.
6. **engeldesk-01 — Passwort für CCs Leserolle** (einmalig, nach dem ERSTEN Abzug, der die Rolle anlegt). `psql` fragt erst das Admin-Passwort, dann zweimal das neue; danach wird es für CC abgelegt:
   ```
   ( set -e; psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -X -c '\password cc_readonly'; read -rs -p 'Dasselbe Passwort noch einmal (für CC): ' P; echo; printf 'MIRROR_DATABASE_URL=postgres://cc_readonly:%s@127.0.0.1:5433/prod_mirror\n' "$P" > /home/dev/dashboard/.env.mirror.local; chmod 600 /home/dev/dashboard/.env.mirror.local )
   ```
7. **CC Bescheid geben.** CC nennt bei jeder Messung den Stichtag aus `mirror_meta`.

## Messen (CC)

Nur mit `cc_readonly`, zusätzlich `PGOPTIONS='-c default_transaction_read_only=on'`. Jede Messung nennt `SELECT stichtag FROM mirror_meta`.
