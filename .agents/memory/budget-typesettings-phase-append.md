---
name: Budget-Type-Settings Phasen-Append-Pfad
description: customer_budget_type_settings hat zwei Schreib-Modi (Same-Day-Edit vs. Phasen-Append); ein zukünftiges validFrom darf NIE den In-Place-Pfad treffen.
---

`customer_budget_type_settings` ist append-only historisiert. Der Upsert-Pfad hat zwei klar getrennte Modi, die NIE vermischt werden dürfen:

1. **Same-Day-Edit** — kein/heutiges `validFrom` im Payload. Alte offene Zeile wird geschlossen (`validTo = heute`), neue mit `validFrom = heute+1` angelegt. Solange die alte Zeile noch nie aktiv war (`validFrom >= heute` ODER NULL + heute angelegt), darf sie in-place überschrieben werden.
2. **Phasen-Append** — explizit zukünftiges `validFrom` (`> heute`). Vorgänger und Nachfolger über ALLE Zeilen suchen (offen + geschlossen), Vorgänger auf `validTo = neuesValidFrom - 1` schließen, neue Zeile zwischen Vorgänger und ggf. Nachfolger einklemmen.

**Why:** Ein In-Place-Pfad, der jede Folgeschreibung auf der vorhandenen offenen Zeile umsetzt, erzeugt Phantom-Historie: vier Anfragen für vier zukünftige Phasen lassen nur die letzte übrig, und Bestandsbuchungen sehen retroaktiv die jüngste Konfiguration — GoBD-Bruch.

**How to apply.** Jede neue Mutation oder Route an dieser Tabelle muss sich explizit für einen Modus entscheiden:

- Phasen-Append nur greifen lassen, wenn `validFrom > today` UND `validFrom !== current.validFrom`; sonst bewusst in den Same-Day-Pfad fallen.
- Im Phasen-Append-Zweig MUSS vor jedem Insert geprüft werden, ob bereits eine Zeile mit exakt demselben `validFrom` existiert — auch wenn sie inzwischen durch einen Nachfolger geschlossen wurde. Trifft sie zu: in-place Update auf dieser Zeile, `validTo` NICHT überschreiben (bleibt vom Nachfolger geklemmt). Sonst entsteht ein überlappendes Duplikat.
- Vorgänger-Suche MUSS `validFrom = NULL` als gültigen Kandidaten (−∞, rückwirkende Baseline) behandeln. Sonst wird die offene NULL-Baseline nicht geschlossen → zwei offene Zeilen → Verletzung des partiellen UNIQUE-Index `(customer_id, budget_type) WHERE valid_to IS NULL`.

Boundary-Konvention: `validTo` ist letzter gültiger Tag **inklusive** (`gte(validTo, asOfDate)` im Read), Phasen überlappen nicht (`validTo = nextValidFrom - 1`). Ein idempotenter Read-Only-Audit beim Startup loggt Drift (Multi-Open / Overlap / Gap), korrigiert aber nie automatisch — Korrekturen brauchen Audit-Begründung.
