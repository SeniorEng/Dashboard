#!/usr/bin/env python3
"""
Erzeugt das Pseudonymisierungs-SQL für den Prod-Mirror aus der Spaltenliste
`scripts/mirror/spalten.tsv` und den TATSÄCHLICHEN Spalten der Staging-DB.

Fail-closed (Ticket 6hf36pRXqr2FR8JG, „Nicht geprüft ist keine zulässige
Antwort"): Bricht mit Exit-Code 2 ab, wenn
  · die DB eine Text-/JSON-/Binär-Spalte hat, die in der Liste fehlt,
  · die Liste eine Spalte nennt, die es in der DB nicht gibt,
  · eine Spalte mit Regel `null` in der DB NOT NULL ist.
Ausgegeben werden nur Tabellen-/Spaltennamen, nie Werte.

Eingabe (stdin): psql -At-Ausgabe `tabelle|spalte|data_type|udt_name|is_nullable`
Ausgabe (stdout): SQL (eine UPDATE-Anweisung je Tabelle).
"""
import sys
from pathlib import Path

TEXTARTIG = {"text", "character varying", "character", "json", "jsonb", "bytea"}
TEXT_UDT_ARRAYS = {"_text", "_varchar", "_bpchar", "_json", "_jsonb"}


def lade_liste(pfad: Path):
    regeln = {}
    kopf = True
    for zeile in pfad.read_text(encoding="utf-8").splitlines():
        if not zeile.strip() or zeile.startswith("#"):
            continue
        if kopf:
            kopf = False
            continue
        teile = zeile.split("\t")
        if len(teile) != 4 or not teile[3].strip():
            sys.exit(f"spalten.tsv: Zeile ohne 4 Felder/Begründung: {teile[:2]}")
        tabelle, spalte, regel, _ = teile
        if (tabelle, spalte) in regeln:
            sys.exit(f"spalten.tsv: doppelt: {tabelle}.{spalte}")
        regeln[(tabelle, spalte)] = regel
    return regeln


def main() -> None:
    regeln = lade_liste(Path(__file__).with_name("spalten.tsv"))
    db = {}
    for zeile in sys.stdin.read().splitlines():
        if not zeile.strip():
            continue
        tabelle, spalte, data_type, udt, nullable = zeile.split("|")
        db[(tabelle, spalte)] = (data_type, udt, nullable == "YES")

    fehler = []
    for (t, s), (typ, udt, _) in sorted(db.items()):
        textartig = typ in TEXTARTIG or (typ == "ARRAY" and udt in TEXT_UDT_ARRAYS)
        if textartig and (t, s) not in regeln:
            fehler.append(f"NICHT ZUGEORDNET: {t}.{s} ({typ})")
    for (t, s), regel in sorted(regeln.items()):
        if (t, s) not in db:
            fehler.append(f"IN LISTE, ABER NICHT IN DER DB: {t}.{s}")
        elif regel == "null" and not db[(t, s)][2]:
            fehler.append(f"REGEL null AUF NOT-NULL-SPALTE: {t}.{s}")
    if fehler:
        print("\n".join(fehler), file=sys.stderr)
        print(f"ABBRUCH: {len(fehler)} Spalte(n) nicht geklärt — scripts/mirror/spalten.tsv ergänzen.", file=sys.stderr)
        sys.exit(2)

    je_tabelle = {}
    for (t, s), regel in sorted(regeln.items()):
        if regel == "bleibt":
            continue
        if regel == "null":
            ausdruck = "NULL"
        elif regel == "scrub":
            ausdruck = f'mirror_scrub("{s}")'
        elif regel.startswith("="):
            ausdruck = regel[1:]
        else:
            sys.exit(f"spalten.tsv: unbekannte Regel für {t}.{s}: {regel!r}")
        je_tabelle.setdefault(t, []).append(f'"{s}" = {ausdruck}')
    for t, sets in je_tabelle.items():
        print(f'UPDATE "{t}" SET ' + ", ".join(sets) + ";")


if __name__ == "__main__":
    main()
