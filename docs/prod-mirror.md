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

## Einrichtung (einmalig)

**1. Leserolle in Prod anlegen** — Replit-Shell, **Gate 4 (Prod-Schreiboperation, nur nach Freigabe)**. Das Passwort wird verdeckt abgefragt und steht nicht im Befehl:
```
read -rs -p 'Neues Passwort für mirror_reader (mind. 24 Zeichen, nur Buchstaben/Ziffern): ' MRPW; echo; if [[ "$MRPW" =~ ^[A-Za-z0-9]{24,}$ ]]; then printf '%s\n' "\\set pw '$MRPW'" 'BEGIN;' 'CREATE ROLE mirror_reader WITH LOGIN PASSWORD :'\''pw'\'';' 'DO $d$ BEGIN EXECUTE format('\''GRANT CONNECT ON DATABASE %I TO mirror_reader'\'', current_database()); END $d$;' 'GRANT USAGE ON SCHEMA public TO mirror_reader;' 'GRANT SELECT ON ALL TABLES IN SCHEMA public TO mirror_reader;' 'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO mirror_reader;' 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mirror_reader;' 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON SEQUENCES TO mirror_reader;' 'ALTER ROLE mirror_reader SET default_transaction_read_only = on;' 'COMMIT;' | psql "$PROD_DATABASE_URL" -X -v ON_ERROR_STOP=1; else echo 'ABBRUCH: Passwort muss mind. 24 Zeichen haben, nur Buchstaben/Ziffern.'; fi; unset MRPW
```

**2. Leserolle prüfen** — Replit-Shell. Erwartet: eine Zeile mit `mirror_reader` und der Kundenzahl, `on`, dann drei Fehler („read-only transaction“ / „permission denied“ / „read-only transaction“):
```
read -rs -p 'Passwort mirror_reader: ' MRPW; echo; MRURL="${PROD_DATABASE_URL/\/\/*@/\/\/mirror_reader@}"; MRURL="${MRURL/-pooler/}"; PGPASSWORD="$MRPW" psql "$MRURL" -X <<< $'SELECT current_user AS rolle, current_database() AS db, (SELECT count(*) FROM customers) AS kunden;\nSHOW default_transaction_read_only;\nUPDATE customers SET id = id WHERE false;\nBEGIN READ WRITE;\nUPDATE customers SET id = id WHERE false;\nROLLBACK;\nCREATE TABLE mirror_probe (x int);'; unset MRPW MRURL
```

**3. Mirror-Cluster starten** — engeldesk-01, im Repo:
```
read -rs -p 'Neues Passwort Mirror-Admin: ' MIRROR_ADMIN_PW; echo; export MIRROR_ADMIN_PW; sudo --preserve-env=MIRROR_ADMIN_PW docker compose -f docker-compose.mirror.yml up -d; unset MIRROR_ADMIN_PW
```

## Abzug (bei Bedarf)

engeldesk-01, im Repo. Das Skript fragt Neon-Host (direkter Endpunkt, ohne „-pooler“), Datenbank, Passwort `mirror_reader` und Passwort Mirror-Admin:
```
bash scripts/mirror/prod-mirror-abzug.sh
```

**Nach dem ersten Abzug einmalig:** Passwort für CCs Leserolle setzen und CC mitteilen. `psql` fragt zuerst das Admin-Passwort, dann zweimal das neue:
```
( set -e; psql -h 127.0.0.1 -p 5433 -U postgres -d postgres -X -c '\password cc_readonly'; read -rs -p 'Dasselbe Passwort noch einmal (für CC): ' P; echo; printf 'MIRROR_DATABASE_URL=postgres://cc_readonly:%s@127.0.0.1:5433/prod_mirror\n' "$P" > /home/dev/dashboard/.env.mirror.local; chmod 600 /home/dev/dashboard/.env.mirror.local )
```

## Messen (CC)

Nur mit `cc_readonly`, zusätzlich `PGOPTIONS='-c default_transaction_read_only=on'`. Jede Messung nennt `SELECT stichtag FROM mirror_meta`.
