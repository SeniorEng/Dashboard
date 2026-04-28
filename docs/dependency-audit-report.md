# Dependency-Audit-Bericht

**Erstellt:** 2026-04-28 · **Methodik:** Statische Volltext-Suche (`ripgrep --fixed-strings`) jeder einzelnen Dependency gegen alle Source-, Config- und Skript-Dateien (außerhalb `node_modules/`, `dist/`, `package-lock.json`, `.local/`, `attached_assets/`, `docs/`, `replit.md`). Ergänzt durch `npm ls`-Cross-Check für transitive Auflösung.

> **Wichtig:** Reiner Bericht. **Kein `npm uninstall`, kein Editieren von `package.json`, keine Code-Änderung.** Empfehlungen am Ende sind als Vorlage für eine spätere Cleanup-Aufgabe gedacht — bewusst entkoppelt vom Audit-Schritt.

## 0. Schnell-Überblick

| Bucket | Anzahl | Beispiele |
|--------|------:|-----------|
| **Genutzt** (direkter Import / CLI-Skript / Config) | **74** | `react`, `express`, `drizzle-orm`, `@playwright/test`, `libphonenumber-js`, … |
| **Implizit genutzt** (Type-Pakete + Build-Toolchain) | **13** | `@types/*`, `tsx`, `typescript`, `tailwindcss`, `esbuild`, `vite` |
| **Verdacht: redundant / nicht aktiv im Pfad** | **2** | `autoprefixer`, `postcss` (siehe §4) |
| **Eindeutig tot** | **0** | – |
| **Gesamt** | **76** (51 prod + 25 dev) | – |

**Kern-Ergebnis:** Der Aufräumeffekt ist gering. Die einzige reale Bereinigungschance liegt im **PostCSS-Pipeline-Setup** (postcss.config.js + autoprefixer + direkter postcss-Eintrag), die mit Tailwind v4 + `@tailwindcss/vite` durch die Vite-Konfiguration faktisch ausgeschaltet ist.

**Korrekturen am vorherigen Bericht (`docs/dead-code-report.md`, Abschnitt 6a):**
- ❌ `@playwright/test` als _„Verdacht: ungenutzt"_ ist **falsch**. Es existieren `playwright.config.ts` + `e2e/health.spec.ts` + `e2e/login.spec.ts` (siehe §3).
- ❌ `libphonenumber-js` als _„nicht direkt importiert"_ ist **falsch**. Drei direkte Importe in `shared/schema/common.ts`, `shared/utils/phone.ts`, `client/src/pages/admin/settings.tsx` (siehe §3).

---

## 1. Klassifizierung der Buckets

| Bucket | Bedeutung |
|--------|-----------|
| `genutzt` | Mindestens ein direkter `import`/`require`/`@import`/CLI-Aufruf in einer aktiven Quelldatei oder Config gefunden. |
| `implizit` | Wird nicht direkt im Code importiert, aber von der Toolchain konsumiert: TypeScript-Type-Pakete (`@types/*`), TS-Compiler/Runner (`typescript`, `tsx`), Build-Tools, die nur per CLI-Skript invoked werden (`vitest`, `esbuild` über `script/build.ts`), oder CSS-Pipeline-Helfer. |
| `redundant` | Liegt installiert, wird aber durch andere Konfiguration im aktiven Pipeline-Pfad umgangen — nicht „defekt", aber funktional toter Ballast. |
| `tot` | Keinerlei Treffer in irgendeinem aktiven Pfad; auch nicht transitive Notwendigkeit. |

---

## 2. Methodik im Detail

Pro Dependency wurde geprüft:

1. **Direkter Import / Require:** `rg --fixed-strings "<package>"` in `*.ts`, `*.tsx`, `*.js`, `*.json`, `*.css`.
2. **Config-Erwähnung:** `vite.config.ts`, `drizzle.config.ts`, `postcss.config.js`, `playwright.config.ts`, `tsconfig.json`, `components.json`, `knip.json`.
3. **CLI-Aufruf in `package.json#scripts`:** für Tools, die per Subprozess statt per Import laufen.
4. **Implizite TS-Type-Resolution:** `@types/<x>`-Paket gilt als genutzt, sobald `<x>` direkt importiert wird (TypeScript löst die `@types/`-Fallback-Deklarationen automatisch über `node_modules/@types`-Lookup, **unabhängig** vom restriktiven `tsconfig.json#types: ["node", "vite/client"]`-Eintrag — letzterer steuert nur _ambient_ Globals).
5. **Transitiver Cross-Check:** `npm ls <package>` zur Klärung, ob ein Paket nur als transitive Dependency überhaupt benötigt würde.

Die ursprüngliche Volltext-Suche aus dem Dead-Code-Bericht (§6a) wurde 1:1 reproduziert — Diskrepanzen erklären sich daraus, dass dort `attached_assets/`, `replit.md` und Doku-Dateien mitgezählt wurden, die für eine echte Verwendungs-Aussage irrelevant sind.

---

## 3. Befunde nach Paket

### 3.1 `dependencies` (51)

| Paket | Bucket | Trefferort(e) | Kommentar |
|-------|:------:|---------------|-----------|
| `@google-cloud/storage` | genutzt | `server/replit_integrations/object_storage/**` | Object-Storage-Integration. |
| `@neondatabase/serverless` | genutzt | `server/lib/db.ts:1`, `script/seed.ts:1` | Neon-Postgres-Driver. |
| `@radix-ui/react-alert-dialog` | genutzt | `client/src/components/ui/alert-dialog.tsx`, `vite.config.ts` (manualChunks) | shadcn-Wrapper. |
| `@radix-ui/react-checkbox` | genutzt | `client/src/components/ui/checkbox.tsx` | shadcn-Wrapper. |
| `@radix-ui/react-dialog` | genutzt | `client/src/components/ui/dialog.tsx` (+ command.tsx, sheet.tsx) | shadcn-Wrapper. |
| `@radix-ui/react-dropdown-menu` | genutzt | `client/src/components/ui/dropdown-menu.tsx` | shadcn-Wrapper. |
| `@radix-ui/react-label` | genutzt | `client/src/components/ui/label.tsx` | shadcn-Wrapper. |
| `@radix-ui/react-popover` | genutzt | `client/src/components/ui/popover.tsx` | shadcn-Wrapper. |
| `@radix-ui/react-radio-group` | genutzt | `client/src/components/ui/radio-group.tsx` → `features/appointments/components/travel-documentation.tsx` | shadcn-Wrapper, einziger Konsument ist Reisedoku. |
| `@radix-ui/react-select` | genutzt | `client/src/components/ui/select.tsx` | shadcn-Wrapper, sehr breit konsumiert. |
| `@radix-ui/react-slot` | genutzt | `client/src/components/ui/button.tsx`, `breadcrumb.tsx`, `sidebar.tsx` | shadcn-Helfer (`asChild`-Pattern). |
| `@radix-ui/react-switch` | genutzt | `client/src/components/ui/switch.tsx` | shadcn-Wrapper. |
| `@radix-ui/react-tabs` | genutzt | `client/src/components/ui/tabs.tsx` | shadcn-Wrapper. |
| `@radix-ui/react-toast` | genutzt | `client/src/components/ui/toast.tsx` (→ `use-toast.ts`, ~30 Konsumenten) | Toast-Infrastruktur. |
| `@radix-ui/react-tooltip` | genutzt | `client/src/components/ui/tooltip.tsx` | shadcn-Wrapper. |
| `@radix-ui/react-visually-hidden` | genutzt | `client/src/components/ui/searchable-select.tsx:24` | A11y-Helper im Searchable-Select. |
| `@tanstack/react-query` | genutzt | 96 Dateien | Daten-Fetching-Backbone. |
| `bcrypt` | genutzt | `server/services/auth.ts` | Passwort-Hashing. |
| `class-variance-authority` | genutzt | 7 Dateien (`button.tsx`, `badge.tsx`, …) | Variant-Engine. |
| `clsx` | genutzt | `client/src/lib/utils.ts` (`cn()`) | Klassen-Merge. |
| `cmdk` | genutzt | `client/src/components/ui/command.tsx` → konsumiert in `searchable-select.tsx` | Command-Palette-Primitive. |
| `compression` | genutzt | `server/index.ts:6,38,41` | gzip-Antwortkompression. |
| `cookie-parser` | genutzt | `server/index.ts:5,48` | Cookie-Middleware. |
| `date-fns` | genutzt | 10 Dateien | Datum-Helfer. |
| `dompurify` | genutzt | 4 Dateien | XSS-Sanitizer für Rich-Text/HTML-Mails. |
| `drizzle-orm` | genutzt | 130 Dateien | ORM-Backbone. |
| `drizzle-zod` | genutzt | 7 Dateien (Schema-Insert-Validatoren) | Auto-Zod-Schemas. |
| `exceljs` | genutzt | `server/services/appointment-import.ts:1`, `tests/import-trim-fix.test.ts` | XLSX-Import (Ersatz für `xlsx` nach Sec-Fix Task #181). |
| `express` | genutzt | 82 Dateien | Server-Framework. |
| `express-rate-limit` | genutzt | 3 Dateien (Auth-Routes) | Brute-Force-Schutz. |
| `helmet` | genutzt | `server/index.ts:7,24` | Security-Header. |
| `libphonenumber-js` | genutzt | `shared/schema/common.ts:3`, `shared/utils/phone.ts:7`, `client/src/pages/admin/settings.tsx:18` | Telefonnummer-Validierung (DE-CountryCode). **Korrektur ggü. Dead-Code-Report §6a.** |
| `lucide-react` | genutzt | 137 Dateien | Icon-Library. |
| `multer` | genutzt | 2 Dateien (Upload-Routes) | Multipart-Form-Parser. |
| `nanoid` | genutzt | `server/vite.ts:7,49` | Cache-Buster für `main.tsx` im Dev-Server. |
| `node-zugferd` | genutzt | `server/lib/zugferd.ts:20-29` (dynamic `await import("node-zugferd")`) | E-Rechnung XRechnung/ZUGFeRD-Embed. **Knip kann den dynamischen String-Import nicht auflösen → Eintrag in `knip.json#ignoreDependencies` ist berechtigt.** |
| `nodemailer` | genutzt | 2 Dateien (`server/lib/mailer.ts`, `server/services/email-*.ts`) | SMTP-Versand. |
| `pdf-lib` | genutzt | `server/routes/billing.ts` (3×), `server/services/document-delivery.ts` (alle dynamic `await import("pdf-lib")`) | PDF-Manipulation für ZUGFeRD-Embedding und Mehrseitige Anhänge. |
| `puppeteer-core` | genutzt | `server/services/pdf-generator.ts` | Headless-Chrome-PDF-Render. |
| `react` | genutzt | 188 Dateien | Frontend-Framework. |
| `react-day-picker` | genutzt | `client/src/components/ui/calendar.tsx` → `date-picker.tsx` | Datepicker-Engine. |
| `react-dom` | genutzt | `client/src/main.tsx`, vite-chunks | DOM-Renderer. |
| `react-signature-canvas` | genutzt | `client/src/components/ui/signature-pad.tsx` (konsumiert in 6 Dateien) | Unterschrift-Pad. |
| `tailwind-merge` | genutzt | `client/src/lib/utils.ts` (`cn()` via clsx-Merge) | Tailwind-Klassen-Dedupe. |
| `tw-animate-css` | genutzt | `client/src/index.css:1` (`@import`) | Animations-Plugin für Tailwind v4. **Knip kann CSS-Imports nicht auflösen → Eintrag in `knip.json#ignoreDependencies` ist berechtigt.** |
| `twilio` | genutzt | 11 Dateien (Server + Schema + Settings-UI) | Voice-Bridge + Webhook. |
| `vaul` | genutzt | `client/src/components/ui/drawer.tsx` → `time-entry-dialog.tsx`, `tasks/components.tsx`, `searchable-select.tsx` | Mobile-Drawer-Primitive. |
| `wouter` | genutzt | 60 Dateien | Frontend-Routing. |
| `ws` | genutzt | `server/lib/db.ts:3,5` (`neonConfig.webSocketConstructor = ws`) | WebSocket-Adapter für Neon-Serverless-Driver in Node. |
| `zod` | genutzt | 64 Dateien | Schema-Validierung. |
| `zod-validation-error` | genutzt | 6 Dateien | Lesbare Zod-Fehlerausgabe für API-Responses. |

### 3.2 `devDependencies` (25)

| Paket | Bucket | Trefferort(e) | Kommentar |
|-------|:------:|---------------|-----------|
| `@playwright/test` | genutzt | `playwright.config.ts:1`, `e2e/health.spec.ts`, `e2e/login.spec.ts` | E2E-Test-Framework. **Korrektur ggü. Dead-Code-Report §6a:** Setup ist vorhanden. |
| `@replit/vite-plugin-cartographer` | genutzt | `vite.config.ts:17` (dev-only dynamic import) | Replit-Workspace-Integration. |
| `@replit/vite-plugin-dev-banner` | genutzt | `vite.config.ts:20` (dev-only dynamic import) | Dev-Banner im Replit-Tab. |
| `@replit/vite-plugin-runtime-error-modal` | genutzt | `vite.config.ts:5,11` | Replit Runtime-Error-Overlay. |
| `@tailwindcss/vite` | genutzt | `vite.config.ts:3,12` | Tailwind v4 Vite-Plugin (aktiver CSS-Pipeline-Pfad). |
| `@types/bcrypt` | implizit | TS-Type-Auflösung beim `import bcrypt` | Erforderlich. |
| `@types/compression` | implizit | TS-Type-Auflösung beim `import compression` | Erforderlich. |
| `@types/cookie-parser` | implizit | TS-Type-Auflösung beim `import cookieParser` | Erforderlich. |
| `@types/express` | implizit | TS-Type-Auflösung beim `import express` | Erforderlich. |
| `@types/multer` | implizit | TS-Type-Auflösung beim `import multer` | Erforderlich. |
| `@types/node` | implizit | `tsconfig.json#types: ["node", …]` | Erforderlich. |
| `@types/nodemailer` | implizit | TS-Type-Auflösung beim `import nodemailer` | Erforderlich. |
| `@types/react` | implizit | TS-Type-Auflösung beim `import React` | Erforderlich. |
| `@types/react-dom` | implizit | TS-Type-Auflösung beim `import ReactDOM` | Erforderlich. |
| `@types/ws` | implizit | TS-Type-Auflösung beim `import ws` (`server/lib/db.ts`) | Erforderlich. |
| `@vitejs/plugin-react` | genutzt | `vite.config.ts:2,10` | React-Build-Plugin. |
| `autoprefixer` | **redundant** | nur `postcss.config.js:4` | **Siehe §4** — PostCSS-Pipeline ist durch Vite-Override deaktiviert. |
| `drizzle-kit` | genutzt | `drizzle.config.ts:1`, npm-Skript `db:push` | Schema-Push-CLI. |
| `esbuild` | genutzt | `script/build.ts:1,45` | Server-Bundler. |
| `postcss` | **redundant (nur direkter Eintrag)** | nur `postcss.config.js`; `vite` zieht es ohnehin transitiv mit | **Siehe §4.** |
| `tailwindcss` | genutzt | `client/src/index.css:1` (`@import "tailwindcss"`) + Peer von `@tailwindcss/vite` | Tailwind-Core. |
| `tsx` | implizit | `package.json#scripts` (`dev`, `build`, `cleanup:test-data`) | Erforderlich. |
| `typescript` | implizit | `package.json#scripts.check`, TS-Compiler-Runtime | Erforderlich. |
| `vite` | genutzt | `script/build.ts:2`, `package.json#scripts.dev:client`, `vite.config.ts` | Build-Tool. |
| `vitest` | implizit | Test-Runner für `tests/**/*.test.ts` (npm-Run via Workflow) | Erforderlich. |

---

## 4. Konkrete Empfehlung: PostCSS-Pipeline aufräumen (3 Pakete + 1 Datei)

### Befund

Die Vite-Konfiguration setzt:

```ts
// vite.config.ts
css: {
  postcss: {
    plugins: [],          // ← inline-Konfig leer; lädt postcss.config.js NICHT
  },
},
```

Vite-Verhalten (dokumentiert): Sobald `css.postcss` als Objekt (statt `false`/Pfad) übergeben wird, **überspringt Vite die Auto-Discovery von `postcss.config.js`**. Mit Tailwind v4 läuft die Tailwind-Verarbeitung sowieso über das eigenständige `@tailwindcss/vite`-Plugin (siehe `vite.config.ts:3,12`) — der klassische PostCSS-Plugin-Pfad ist damit obsolet.

Daraus folgt:

| Datei / Paket | Aktueller Zustand | Tatsächlicher Effekt |
|----------------|-------------------|----------------------|
| `postcss.config.js` | Definiert `tailwindcss + autoprefixer` als Plugins | **Wird von Vite nicht eingelesen** |
| `autoprefixer` (devDep) | Nur in `postcss.config.js` referenziert | **Läuft im Build nicht** |
| `postcss` (devDep) | Nur in `postcss.config.js` referenziert | Wird zwar transitiv von `vite` und `autoprefixer` mitgezogen — der **direkte** devDep-Eintrag ist aber überflüssig |

### Was Tailwind v4 stattdessen macht

`@tailwindcss/vite` integriert die Tailwind-Verarbeitung direkt in Vites Asset-Pipeline. Browser-Vendor-Prefixing übernimmt Tailwind v4 automatisch via `lightningcss` (intern) und `targets` aus `browserslist`/`package.json`. **Autoprefixer ist nicht mehr Teil der empfohlenen v4-Toolchain.**

### Risiko

- **Keine CSS-Output-Änderung erwartet**, da der jetzige Pipeline-Pfad bereits ohne PostCSS läuft.
- Restrisiko: Falls jemand künftig `css.postcss.plugins: []` aus `vite.config.ts` entfernt und auf Auto-Discovery zurück will, würde das Setup wieder „aufleben" — dann wären die Pakete nötig. Dieses Szenario ist aktuell nicht geplant (Tailwind v4 macht es überflüssig).

### Vorgeschlagene Cleanup-Aktion (für separate Folge-Aufgabe, nicht hier)

1. `postcss.config.js` löschen.
2. `autoprefixer` aus `devDependencies` entfernen.
3. `postcss` aus `devDependencies` entfernen (bleibt als transitive Dep von `vite` + sonstigen vorhanden).
4. `knip.json#ignoreDependencies` entsprechend kürzen: `autoprefixer` und `postcss` entfernen.
5. CSS-Output-Diff vor/nach Cleanup mit `npm run build` + Sichtkontrolle eines Stylesheets prüfen.

**Geschätzter Aufwand: S (5–15 min)** · **Geschätzter Gewinn:** −2 devDeps (~3 MB `node_modules`), klarere Toolchain-Story.

---

## 5. `knip.json#ignoreDependencies` — Validierung

| Eintrag | Berechtigt? | Begründung |
|---------|:-----------:|------------|
| `tsx` | ✅ | Wird nur per CLI in `package.json#scripts` aufgerufen, nie importiert. |
| `@types/*` | ✅ | TS-Type-Auto-Resolution; knip erkennt das nicht zuverlässig. |
| `tailwindcss` | ✅ | Konsum nur via CSS-`@import` + Peer von `@tailwindcss/vite` — knip scannt CSS nicht. |
| `autoprefixer` | ⚠️ | Nur weil `postcss.config.js` als Entry fehlt — wäre nach Cleanup (§4) entbehrlich. |
| `postcss` | ⚠️ | Dito. Nach Cleanup (§4) entbehrlich. |
| `@tailwindcss/*` | ✅ | Sicherheitsnetz für Tailwind-v4-Plugin-Familie (CSS-Konsum nicht detektierbar). |
| `node-zugferd` | ✅ | Dynamic `await import("node-zugferd")` mit String-Variable — knip kann das nicht auflösen (`server/lib/zugferd.ts:22`). |
| `tw-animate-css` | ✅ | Konsum nur via `@import` in `client/src/index.css:1`. |

---

## 6. Empfehlungs-Tabelle (Zusammenfassung)

| # | Empfehlung | Risiko | Aufwand | Gewinn |
|---|------------|:------:|:-------:|--------|
| 1 | `postcss.config.js`, `autoprefixer`, `postcss` (direkt) entfernen — siehe §4 | niedrig | S | −2 devDeps, klarere Toolchain |
| 2 | `knip.json#ignoreDependencies` nach #1 um `autoprefixer` + `postcss` kürzen | niedrig | XS | bessere Audit-Genauigkeit |
| 3 | Korrektur-Notiz im `dead-code-report.md §6a` ergänzen, dass `@playwright/test` und `libphonenumber-js` produktiv genutzt werden | keins | XS | konsistente Doku |

**Alle übrigen 73 Dependencies sind aktiv im Einsatz und sollten unverändert bleiben.**

---

## 7. Was dieser Bericht NICHT abdeckt

| Bereich | Status | Begründung |
|---------|--------|------------|
| Bundle-Size-Effekt pro Paket | nicht gemessen | Würde `vite build --analyze` + Tree-Map-Vergleich erfordern. Empfehlung: separater Performance-Audit. |
| CI-Pipeline-Cross-Check | nicht möglich | Repo enthält keine GitHub-Actions-/CI-YAML. Replit-Workflows wurden mit-eingerechnet. |
| Sicherheitslücken | nicht Teil dieses Audits | Siehe `replit.md` Abschnitt zu Task #181 (npm audit, 0 HIGH/CRITICAL). |
| Lizenzkonformität | nicht geprüft | Kein Scope dieses Tasks. |
| Versionsaktualität | nicht geprüft | Kein Scope dieses Tasks. |
