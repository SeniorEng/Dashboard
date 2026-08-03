# Archiv — die alte, kaputte Migrations-Historie

Dieser Ordner ist **inaktiv**. Er wurde beim Schema-Deploy-Baselining (A2) aus
`migrations/` hierher verschoben und wird von keinem Werkzeug mehr gelesen.

## Warum er nicht als Baseline taugte

`meta/_journal.json` beschrieb weder den Ordner noch den DB-Stand:

- es verwies auf `0011_melodic_blizzard`, dessen `.sql` in Commit `eb7c56eb`
  gelöscht wurde — `drizzle-kit migrate` wäre schon beim Lesen gescheitert;
- es kannte `0020`–`0022` nicht, die hätte also nie jemand angewendet;
- der neueste Snapshot war `0014`, ein `generate` hätte gegen diesen Stand
  gediffed und alles seither in EINE riesige Migration gepackt — inklusive
  dessen, was `drizzle-kit push` längst angelegt hatte.

Dazu wurde nie ein Runner eingesetzt: `migrations/README.md` (jetzt hier) sagt
es selbst — die Dateien liefen manuell per `psql`, es gibt keine
`__drizzle_migrations`-Tabelle.

## Wozu er trotzdem aufgehoben wird

Das mitarchivierte `README.md` dokumentiert die Prod-Ausführungsreihenfolge des
Mai-2026-Cleanups (`0014`/`0015`/`0016`) samt Backup-Verweis. Das ist Beleg, kein
ausführbarer Bestand — die git-Historie hätte es zwar auch, aber als Nachweis
gegenüber der Buchhaltung ist ein auffindbarer Pfad mehr wert als ein
Commit-Hash.

**Nichts hier neu ausführen.** Der gültige Bauplan ist die Baseline in
`migrations/` plus die handgeführte `migrations/manual/0001_gobd_triggers.sql`.
