---
name: Budget-Architektur-Doku ausgelagert
description: Budget-spezifische Architektur und Gotchas liegen nicht (mehr) in replit.md, sondern in docs/architecture/budget.md.
---

Budget-spezifische Architektur-Entscheidungen und Gotchas wurden aus `replit.md` herausgezogen.

**Wo Budget-Details jetzt leben:**
- `docs/architecture/budget.md` — Pot-Regeln, GoBD-Historisierung (resurrect-Regel, Append-Only-Settings), Selbstzahler-Routing, §45b-Spezifika (Startwert/Carryover/„Unser Anteil"), Query-Invalidation-Spezifika, laufende SSoT-Konsolidierung
- `docs/budget-ssot-inventory.md` — Konflikt-Matrix, Drei-View-Vorschlag, Beschlüsse zu 10 Review-Fragen, Phasen-Reihenfolge

**Why:** `replit.md` war auf >100 dichte Zeilen Architecture-Decisions angewachsen, davon ~60% Budget. Index-Charakter ging verloren. Auslagerung in eigene Architecture-Doku, `replit.md` behält nur Pointer.

**How to apply:**
- Neue Budget-Architektur-Regeln gehören in `docs/architecture/budget.md`, nicht in `replit.md`.
- `replit.md` darf nur einzeilige Verweise auf Budget-Detail-Doku haben, keine ausgewachsenen Paragraphen.
- Wenn du in `replit.md` einen Budget-bezogenen Abschnitt hinzufügen willst: lieber in `docs/architecture/budget.md` schreiben und in `replit.md` referenzieren.
