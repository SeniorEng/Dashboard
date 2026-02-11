# SeniorenEngel / CareConnect – Performance-Analyse & Optimierungsguide

**Zuletzt aktualisiert:** 2026-02-11
**Zweck:** Dokumentation für den Performance-Agenten – alle Findings, bereits umgesetzte Optimierungen, offene Maßnahmen und Best Practices.

---

## 1. STATUS QUO – Bereits umgesetzte Optimierungen

### 1.1 Datenbank-Ebene (ERLEDIGT)
| Maßnahme | Vorher | Nachher | Datei |
|----------|--------|---------|-------|
| DB-Treiber: neon-http → neon-serverless Pool (WebSocket) | Stateless HTTP pro Query | Persistenter Pool, max 10 Connections, 30s idle | `server/lib/db.ts` |
| Session-Validierung: 3 Queries → 1 JOIN | sessions + users + roles separat | Single JOIN (sessions+users), roles separat | `server/services/auth.ts` |
| N+1 Fix: getAllUsers/getActiveEmployees | Gesamte roles-Tabelle geladen | LEFT JOIN mit Rollen-Aggregation | `server/services/auth.ts` |
| DB-Indexes hinzugefügt | Keine Indexes auf sessions, user_roles | `sessions(user_id)`, `sessions(expires_at)`, `user_roles(user_id)`, `users(is_active)` | `shared/schema/users.ts`, SQL |
| Batch-Cleanup | Per-Record DELETE Loop | Single DELETE Statement | `server/services/auth.ts` |
| Select-Feld-Helpers | ~400 Zeilen Duplikation | Wiederverwendbare `appointmentWithCustomerSelectFields` | `server/storage.ts` |

### 1.2 Backend-Ebene (ERLEDIGT)
| Maßnahme | Vorher | Nachher | Datei |
|----------|--------|---------|-------|
| Error Handler gefixt | `throw err` → Server-Crash | `console.error` + JSON-Response | `server/index.ts` |
| Auth-Middleware Scope | Global auf alle Requests | Nur `/api/*` Routen | `server/routes/index.ts` |
| rawBody entfernt | Auf allen JSON-Requests | Nicht mehr erfasst | `server/index.ts` |
| Compression | Bereits aktiv | ✅ `compression()` Middleware | `server/index.ts` |

### 1.3 Cache-Ebene (ERLEDIGT)
| Maßnahme | Details | Datei |
|----------|---------|-------|
| Cache-GC-Intervall | 60s Garbage Collection für SimpleCache & SessionCacheService | `server/services/cache.ts` |
| Session-Cache | 2min TTL | `server/services/cache.ts` |
| Birthday-Cache | 1h TTL | `server/services/cache.ts` |
| Assigned-Customer-IDs-Cache | TTL-basiert mit Invalidierung | `server/services/cache.ts` |

### 1.4 Frontend-Ebene (BEREITS GUT)
| Maßnahme | Status | Details |
|----------|--------|---------|
| Route-Level Code Splitting | ✅ | Alle Seiten via `React.lazy()` geladen |
| staleTime pro Query-Typ | ✅ | Volatile: 30s, Stabil: 60s, Statisch: 5min, Session: Infinity |
| React.memo auf AppointmentCard | ✅ | Teuerste Listendarstellung memoisiert |
| useMemo/useCallback | ✅ | ~100 Nutzungen in Pages + Components |
| Debounce auf Admin-Kundensuche | ✅ | Verhindert Overload bei Tippen |

---

## 2. OFFENE PERFORMANCE-PROBLEME (Priorisiert)

### 2.1 KRITISCH: Bundle-Größe – 559 kB Haupt-Chunk

**Problem:** Der `index-*.js` Haupt-Chunk ist 559 kB (172 kB gzip). Vite warnt über >500 kB.

**Ursache:** Alle Vendor-Libraries (React, Radix UI, TanStack Query, date-fns, Zod, etc.) werden in einem einzigen Chunk gebündelt.

**Lösung: Manual Chunks in `vite.config.ts`**
```typescript
build: {
  rollupOptions: {
    output: {
      manualChunks: {
        'vendor-react': ['react', 'react-dom'],
        'vendor-radix': [
          '@radix-ui/react-dialog',
          '@radix-ui/react-dropdown-menu',
          '@radix-ui/react-popover',
          '@radix-ui/react-select',
          '@radix-ui/react-tabs',
          '@radix-ui/react-tooltip',
          '@radix-ui/react-alert-dialog',
          '@radix-ui/react-checkbox',
          '@radix-ui/react-label',
          '@radix-ui/react-switch',
        ],
        'vendor-utils': ['date-fns', 'zod', 'clsx', 'tailwind-merge'],
        'vendor-query': ['@tanstack/react-query'],
      }
    }
  }
}
```

**Erwarteter Effekt:** Haupt-Chunk von 559 kB auf ~150-200 kB reduzierbar. Vendor-Chunks werden separat gecacht und ändern sich selten.

**Aufwand:** Niedrig (Vite-Config anpassen)
**Impact:** Hoch (Initial Load Time, besonders mobil)

### 2.2 HOCH: Ungenutzte UI-Komponenten vergrößern Bundle

**Problem:** Folgende `shadcn/ui`-Komponenten sind installiert, werden aber **nirgends** in der App verwendet:

| Komponente | Dateigröße | Externe Dependency |
|------------|-----------|-------------------|
| `sidebar.tsx` | 727 Zeilen | – (nur intern von button.tsx importiert, prüfen!) |
| `chart.tsx` | 367 Zeilen | `recharts` (sehr groß!) |
| `carousel.tsx` | 260 Zeilen | `embla-carousel-react` |
| `menubar.tsx` | 254 Zeilen | `@radix-ui/react-menubar` |
| `navigation-menu.tsx` | 128 Zeilen | `@radix-ui/react-navigation-menu` |
| `context-menu.tsx` | 198 Zeilen | `@radix-ui/react-context-menu` |
| `hover-card.tsx` | ? | `@radix-ui/react-hover-card` |
| `resizable.tsx` | ? | `react-resizable-panels` |
| `input-otp.tsx` | ? | `input-otp` |
| `avatar.tsx` | ? | `@radix-ui/react-avatar` |
| `aspect-ratio.tsx` | ? | `@radix-ui/react-aspect-ratio` |
| `radio-group.tsx` | ? | `@radix-ui/react-radio-group` |
| `scroll-area.tsx` | ? | `@radix-ui/react-scroll-area` |
| `toggle.tsx` / `toggle-group.tsx` | ? | `@radix-ui/react-toggle` / `toggle-group` |
| `slider` | ? | `@radix-ui/react-slider` (nur in admin/customers.tsx) |

**Wichtig:** `chart.tsx` importiert `recharts` (122 kB+ Minified). Recharts wird sonst nirgends genutzt.

**Lösung:**
1. Ungenutzte Komponenten-Dateien löschen
2. Entsprechende npm-Pakete aus `package.json` entfernen:
   - `recharts`, `embla-carousel-react`, `react-resizable-panels`, `input-otp`
   - Radix-Pakete die nur von ungenutzten Komponenten importiert werden
3. Tree-Shaking kann Radix-Pakete nicht eliminieren wenn die Komponenten-Dateien existieren

**Erwarteter Effekt:** ~100-200 kB weniger im Bundle (besonders durch `recharts`)
**Aufwand:** Niedrig-Mittel (Dateien löschen, Dependencies aufräumen)
**Impact:** Hoch

### 2.3 HOCH: `libphonenumber-js` – 155 kB für Telefonnummern

**Problem:** Zwei Chunks für Phone-Nummern:
- `isValidPhoneNumber-*.js`: 122 kB
- `phone-*.js`: 33 kB
- **Zusammen 155 kB** nur für Telefonnummer-Validierung

**Analyse:** `libphonenumber-js` enthält Metadaten für ALLE Länder weltweit. CareConnect nutzt nur deutsche Nummern.

**Lösungen (von einfach bis komplex):**
1. **Import optimieren:** `libphonenumber-js/min` statt `libphonenumber-js` nutzen (weniger Metadaten, ~60% kleiner)
2. **Nur `de` Metadaten laden:** Custom Metadata-Build nur für Deutschland
3. **Server-seitige Validierung:** Telefonnummer-Validierung nur auf dem Server machen, Frontend nur Format-Check per Regex

**Erwarteter Effekt:** 60-120 kB Ersparnis
**Aufwand:** Niedrig (Option 1) bis Mittel (Option 3)
**Impact:** Mittel-Hoch

### 2.4 MITTEL: Keine HTTP-Cache-Header auf API-Responses

**Problem:** Keine `Cache-Control`, `ETag` oder `Last-Modified` Header auf API-Responses. Der Browser-Cache wird nicht genutzt. Jede Navigation löst neue Requests aus (auch wenn TanStack Query staleTime hat, muss bei neuen Tab-Öffnungen alles neu geladen werden).

**Lösung:**
```typescript
// Für stabile Daten (Services, Insurance Providers)
res.set('Cache-Control', 'private, max-age=300'); // 5 min

// Für volatile Daten (Appointments)  
res.set('Cache-Control', 'private, max-age=0, must-revalidate');

// Für statische Listen (Employees)
res.set('Cache-Control', 'private, max-age=60');
```

**Erwarteter Effekt:** Schnellere Navigation bei Tab-Wechsel, weniger Server-Load
**Aufwand:** Niedrig
**Impact:** Mittel

### 2.5 MITTEL: Keine Prefetching-Strategie

**Problem:** Kein Prefetching von Daten oder Routes. Wenn User auf Dashboard ist, könnten wahrscheinliche nächste Seiten (Kunden, Aufgaben) bereits im Hintergrund geladen werden.

**Lösung:**
```typescript
// Route-Prefetch bei Hover über Navigation
const prefetchCustomers = () => {
  queryClient.prefetchQuery({
    queryKey: ['/api/customers/assigned'],
    queryFn: ...,
    staleTime: 30000
  });
};

// In der Navigation:
<Link href="/customers" onMouseEnter={prefetchCustomers}>
```

**Erwarteter Effekt:** Gefühlte Navigation ~200-500ms schneller
**Aufwand:** Mittel
**Impact:** Mittel (User Experience)

### 2.6 MITTEL: SELECT * Pattern in Storage Layer

**Problem:** Viele Queries nutzen `db.select().from(table)` ohne explizite Feldauswahl. Das überträgt alle Spalten, auch wenn der Client nur wenige braucht.

**Betroffene Queries (Auswahl):**
- `getAllCustomers()` – alle Felder obwohl Listen nur name/address brauchen
- `getAppointmentsByDate()` – alle Appointment-Felder
- `getAllAppointments()` – nur intern, aber trotzdem alles

**Lösung:** Explizite `select({ id, name, address })` für Listen-Endpoints.

**Erwarteter Effekt:** 20-40% weniger Daten pro Query für Listen
**Aufwand:** Mittel (pro Query anpassen)
**Impact:** Mittel

### 2.7 NIEDRIG: Keine List-Virtualisierung

**Problem:** Wenn ein Mitarbeiter viele Termine hat (z.B. 20+ pro Tag), werden alle DOM-Nodes gleichzeitig gerendert. Aktuell unkritisch bei den typischen Datenmengen (<20 pro Seite), aber sollte bei Wachstum beobachtet werden.

**Lösung:** `@tanstack/react-virtual` für Listen >50 Items einsetzen.

**Erwarteter Effekt:** Wichtig erst bei >50 Items pro Liste
**Aufwand:** Mittel
**Impact:** Niedrig (aktuell)

### 2.8 NIEDRIG: CSS-Animationen

**Problem:** 28 CSS-Animationen (`animate-in`, `slide-in`, `transition`) in Pages. Einzeln harmlos, aber `animate-pulse` auf in-progress-Icons läuft dauerhaft und kann bei vielen sichtbaren Cards CPU verbrauchen.

**Lösung:**
- `animate-pulse` durch statisches Icon ersetzen oder nur bei Hover aktivieren
- `will-change: transform` sparsam einsetzen

**Erwarteter Effekt:** Minimal, aber bessere Akku-Laufzeit auf Mobilgeräten
**Aufwand:** Niedrig
**Impact:** Niedrig

### 2.9 NIEDRIG: Direkte DB-Zugriffe in Routes

**Problem:** 9 Route-Handler greifen direkt auf die Datenbank zu statt über den Storage Layer. Das umgeht die Abstraktion und macht Caching/Optimierung schwieriger.

**Betroffene Dateien:**
- `server/routes/settings.ts` (2 Queries)
- `server/routes/admin/customers.ts` (6 Queries)  
- `server/routes/appointments.ts` (5 Queries)
- `server/routes/time-entries.ts` (1 Query)

**Lösung:** Queries in den Storage Layer verschieben.
**Aufwand:** Mittel
**Impact:** Niedrig (Architektur-Sauberkeit, erleichtert späteres Caching)

---

## 3. NICHT UMGESETZTE BEST PRACTICES (Kontext: Mobile-First Care App)

### 3.1 Frontend Best Practices

| Technik | Status | Relevanz | Anmerkung |
|---------|--------|----------|-----------|
| Route-Level Code Splitting | ✅ Umgesetzt | Kritisch | Alle Pages lazy-loaded |
| Manual Vendor Chunks | ❌ Offen | Hoch | Haupt-Chunk 559 kB |
| React.memo auf Listen-Items | ✅ AppointmentCard | Hoch | Andere Karten prüfen |
| useMemo/useCallback | ✅ Vorhanden | Hoch | ~100 Nutzungen |
| List Virtualization | ❌ Nicht nötig (noch) | Niedrig | Datenmengen <50/Seite |
| Image Lazy Loading | N/A | – | Kaum Bilder in der App |
| Service Worker / Offline | ❌ Nicht umgesetzt | Mittel | Für Pfleger im Feld nützlich |
| Optimistic Updates | ✅ Teilweise | Hoch | TanStack Query Mutations |
| Skeleton Loaders | ❌ Nur Spinner | Mittel | Bessere UX möglich |
| Prefetching | ❌ Nicht umgesetzt | Mittel | Navigation-Prefetch |
| Bundle Analysis (visualizer) | ❌ Nicht eingerichtet | Hoch | Einmalig für Analyse |
| CSS-in-JS eliminieren | ✅ Tailwind | – | Kein Runtime-CSS-in-JS |
| Tree Shaking | ✅ Via Vite/Rollup | – | Aber durch ungenutzte Dateien limitiert |

### 3.2 Backend Best Practices

| Technik | Status | Relevanz | Anmerkung |
|---------|--------|----------|-----------|
| NODE_ENV=production | ✅ Bei Deploy | Kritisch | 3x Performance-Boost |
| Gzip/Brotli Compression | ✅ compression() | Hoch | Bereits aktiv |
| Connection Pooling | ✅ Umgesetzt | Kritisch | Max 10, 30s idle |
| DB Indexing | ✅ Umgesetzt | Hoch | sessions, user_roles, users |
| Pagination | ✅ Vorhanden | Hoch | Admin-Kundenliste etc. |
| HTTP Cache Headers | ❌ Fehlen | Mittel | Für stabile API-Responses |
| Rate Limiting | ❌ Nicht umgesetzt | Mittel | Schutz vor Abuse |
| Graceful Shutdown | ❌ Nicht umgesetzt | Niedrig | Für Zero-Downtime Deploys |
| Structured Logging (Pino) | ❌ console.log | Niedrig | Für Prod-Monitoring |
| DB Query Logging | ❌ Nicht aktiv | Niedrig | Für Slow-Query-Analyse |
| ETag Support | ❌ Nicht umgesetzt | Niedrig | Für conditional Requests |

### 3.3 Datenbank Best Practices

| Technik | Status | Relevanz | Anmerkung |
|---------|--------|----------|-----------|
| Indexes auf häufige Queries | ✅ Teilweise | Hoch | sessions, user_roles, users |
| Connection Pool | ✅ Umgesetzt | Kritisch | WebSocket Pool |
| Batch Operations | ✅ Cleanup | Mittel | Session/Token Cleanup |
| Explicit Column Selection | ❌ Viele SELECT * | Mittel | Listen-Queries optimieren |
| Query Plan Analysis (EXPLAIN) | ❌ Nicht gemacht | Mittel | Schwerste Queries prüfen |
| Prepared Statements | ✅ Via Drizzle | – | Automatisch |
| Missing Indexes prüfen | ❌ | Mittel | appointments(date), appointments(customer_id, date) |

---

## 4. EMPFOHLENE REIHENFOLGE DER UMSETZUNG

### Phase 1: Quick Wins (Niedrig-Aufwand, Hoher Impact)
1. **Manual Chunks in vite.config.ts** → Bundle-Split, 559 kB → ~200 kB
2. **Ungenutzte UI-Komponenten löschen** → recharts etc. entfernen
3. **libphonenumber-js/min verwenden** → 60-120 kB Ersparnis

### Phase 2: Mittlerer Aufwand, Guter Impact
4. **HTTP Cache-Control Headers** auf API-Responses
5. **Navigation-Prefetching** für häufige Seitenwechsel
6. **Ungenutzte npm-Pakete entfernen** (recharts, embla-carousel-react, etc.)
7. **Fehlende DB-Indexes** prüfen: `appointments(date)`, `appointments(customer_id, date)`

### Phase 3: Architektur-Verbesserungen
8. **SELECT * durch explizite Felder ersetzen** in Listen-Queries
9. **Direkte DB-Zugriffe in Routes** in Storage Layer verschieben
10. **Skeleton Loaders** statt Spinner für bessere UX
11. **Service Worker** für Offline-Unterstützung (Pfleger im Feld)

### Phase 4: Monitoring & Langfrist
12. **Bundle Visualizer** einrichten für regelmäßige Analyse
13. **Rate Limiting** für API-Schutz
14. **Structured Logging** (Pino) für Prod
15. **List Virtualization** wenn Datenmengen wachsen

---

## 5. METRIKEN & ZIELWERTE

### Bundle-Größe (aktuell → Ziel)
| Chunk | Aktuell | Ziel |
|-------|---------|------|
| Haupt-Chunk (index) | 559 kB (173 kB gzip) | <200 kB (<60 kB gzip) |
| Phone-Chunks | 155 kB | <60 kB |
| Date-Picker | 72 kB | 72 kB (akzeptabel, lazy-loaded) |
| Page-Chunks | 5-51 kB | OK (bereits lazy-loaded) |

### API-Response-Zeiten (Zielwerte)
| Endpoint-Typ | Ziel |
|-------------|------|
| Auth/Session Check | <10ms |
| Einzelne Entität laden | <50ms |
| Listen-Endpoint (paginiert) | <100ms |
| Komplexe Aggregation (Budget) | <200ms |
| Such-Endpoint | <150ms |

### Core Web Vitals (Mobile-Zielwerte)
| Metrik | Ziel |
|--------|------|
| LCP (Largest Contentful Paint) | <2.5s |
| INP (Interaction to Next Paint) | <100ms |
| CLS (Cumulative Layout Shift) | <0.1 |

---

## 6. TOOLING & MONITORING

### Empfohlene Tools für Performance-Analyse
- **Bundle:** `rollup-plugin-visualizer` in vite.config.ts
- **React:** React DevTools Profiler (Chrome Extension)
- **Queries:** `EXPLAIN ANALYZE` auf PostgreSQL für langsame Queries
- **Netzwerk:** Chrome DevTools → Network → Slow 3G Throttling
- **Lighthouse:** Chrome DevTools → Lighthouse → Mobile Performance Audit

### Kommandos für Quick-Checks
```bash
# Bundle-Größe analysieren
npx vite build --mode production 2>&1 | grep -E "kB|MB"

# Ungenutzte Exports finden
npx knip --include exports

# DB-Query-Performance
psql -c "EXPLAIN ANALYZE SELECT ... FROM appointments WHERE date = '2026-02-11';"
```

---

## 7. ARCHITEKTUR-HINWEISE FÜR DEN PERFORMANCE-AGENTEN

### Was NICHT geändert werden darf
- **TanStack Query staleTime-Werte** sind bewusst gewählt pro Query-Typ
- **React.lazy() Pattern** in App.tsx ist korrekt implementiert
- **WebSocket DB Pool** Konfiguration (max 10, 30s idle) ist für Neon optimiert
- **Auth-Middleware Scope** auf /api ist bewusst so konfiguriert

### Was beachtet werden muss
- **Keine Avatare/Profilbilder** (User-Preference) → keine Image-Optimierung nötig
- **Keine Blur-Effekte** (User-Preference) → CSS-Komplexität bereits reduziert
- **Keine CSS-Transforms in Overlays** (User-Preference) → GPU-Compositing reduziert
- **Mobile-First** → Performance-Budget primär für mobile Geräte
- **Deutsche Lokalisierung** → date-fns/locale/de wird immer geladen

### Caching-Hierarchie
```
Browser HTTP-Cache (Cache-Control) ← FEHLT NOCH
  ↓
TanStack Query Cache (staleTime) ← ✅ Konfiguriert
  ↓
Server In-Memory Cache (TTL) ← ✅ Konfiguriert
  ↓
PostgreSQL (Connection Pool) ← ✅ Konfiguriert
```

### Datenfluß pro Page-Load
```
1. Browser: Route lazy-loaded? Ja → Chunk laden (einmalig)
2. React: useQuery fires → staleTime abgelaufen?
   Nein → Cached Data sofort anzeigen
   Ja → HTTP Request
3. Express: Auth-Middleware → Route-Handler → Storage Layer → DB Query
4. DB: Pool Connection → Query → Result
5. Express: JSON Response (compressed)
6. React: TanStack Cache updaten → Re-Render
```
