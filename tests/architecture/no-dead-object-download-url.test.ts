/**
 * Task #1720 / #1722 — Architektur-Test: Jede Client-Download-URL für ein
 * gespeichertes Objekt/Dokument MUSS auf eine tatsächlich registrierte
 * Server-Route zeigen.
 *
 * Hintergrund: Zwei Screens (proof-review, Qonto advices-tab) hatten
 * Download-Buttons, die auf eine Proxy-URL
 *   `/api/object-storage/download?path=...`
 * zeigten. Diese Route existierte serverseitig NIE — der Download schlug
 * still fehl (Task #1719 fixte beide Call-Sites, indem sie den gespeicherten
 * `/objects/...`-Pfad direkt öffnen).
 *
 * Task #1720 zog eine erste Schranke über eine Denylist bekannter toter
 * Pfade. Das fängt aber KEINE brandneue tote Download-URL, die in Zukunft
 * erfunden wird. Task #1722 ersetzt die Denylist durch eine POSITIVE Prüfung:
 *
 * Dieser Test
 *   1. löst den Express-Mount-Graphen des Servers statisch auf und baut die
 *      Menge ALLER real registrierten Routen (`GET /objects/:objectPath(*)`,
 *      `GET /api/(admin|customers)/generated-documents/:id/download`, …),
 *   2. sammelt im Client-Quellcode alle String-Literale, die wie eine
 *      Objekt-/Datei-Download-URL aussehen, und
 *   3. schlägt fehl, sobald eine solche Client-URL auf KEINE registrierte
 *      Server-Route passt — mit Datei:Zeile und der gefundenen URL.
 *
 * Damit fällt jede unbelegte Download-URL durch, nicht nur die bereits
 * bekannten.
 *
 * Fix bei Fehlschlag: Öffne den gespeicherten `/objects/...`-Pfad direkt
 * (dieser wird durch die authentifizierte `GET /objects/:objectPath(*)`-Route
 * bedient), oder — für generierte Dokumente — die vorhandene
 * `/api/.../generated-documents/:id/download`-Route.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync, existsSync } from "fs";
import { join, relative, sep, dirname, resolve } from "path";

const ROOT = process.cwd();
const SERVER_ROOT = join(ROOT, "server");
const CLIENT_ROOT = join(ROOT, "client/src");

const SELF = "tests/architecture/no-dead-object-download-url.test.ts";

// Die Datei, in der der App-Router-Baum an `app` gehängt wird.
const ENTRY_FILE = join(SERVER_ROOT, "routes.ts");

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "all"] as const;

// ────────────────────────────────────────────────────────────────────────────
// Datei-Utilities
// ────────────────────────────────────────────────────────────────────────────

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith(".") || entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      yield* walk(full);
    } else if ((entry.endsWith(".ts") || entry.endsWith(".tsx")) && !entry.endsWith(".d.ts")) {
      yield full;
    }
  }
}

/** Strippt Zeilen- und Block-Kommentare, damit Beispiele/URLs in Kommentaren
 * weder als Server-Route noch als Client-Download-URL zählen. */
function stripComments(source: string): string[] {
  const rawLines = source.split("\n");
  const out: string[] = [];
  let inBlock = false;
  for (let line of rawLines) {
    if (inBlock) {
      const end = line.indexOf("*/");
      if (end === -1) {
        out.push("");
        continue;
      }
      line = line.slice(end + 2);
      inBlock = false;
    }
    // Alle vollständigen /* ... */ auf der Zeile entfernen.
    for (;;) {
      const start = line.indexOf("/*");
      if (start === -1) break;
      const end = line.indexOf("*/", start + 2);
      if (end === -1) {
        line = line.slice(0, start);
        inBlock = true;
        break;
      }
      line = line.slice(0, start) + line.slice(end + 2);
    }
    const lc = line.indexOf("//");
    if (lc !== -1) line = line.slice(0, lc);
    out.push(line);
  }
  return out;
}

/** Löst einen relativen Import-Spezifizierer auf eine existierende .ts-Datei
 * (inkl. `/index.ts`) auf. */
function resolveImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base + ".ts",
    base + ".tsx",
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────────
// Server-Route-Extraktion pro Datei
// ────────────────────────────────────────────────────────────────────────────

interface FileInfo {
  /** localName → absoluter Modulpfad (nur relative Imports). */
  imports: Map<string, string>;
  /** Route-Definitionen (`x.get("/path", …)`) in dieser Datei. */
  routes: Array<{ method: string; path: string }>;
  /** Mounts (`x.use("/prefix", childVar)`). */
  mounts: Array<{ prefix: string; child: string }>;
  /** `registerXxx(app)`-Aufrufe. */
  registerCalls: string[];
}

const IMPORT_RE = /import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g;
const ROUTE_RE = new RegExp(
  `\\.(${HTTP_METHODS.join("|")})\\(\\s*["'\`]([^"'\`]+)["'\`]`,
  "g",
);
const MOUNT_RE = /\.use\(\s*["'`]([^"'`]+)["'`]\s*,\s*([A-Za-z0-9_$]+)\s*\)/g;
const REGISTER_RE = /\b(register[A-Za-z0-9_$]*)\s*\(\s*app\s*\)/g;

function analyzeFile(file: string): FileInfo {
  const src = stripComments(readFileSync(file, "utf-8")).join("\n");
  const imports = new Map<string, string>();
  let m: RegExpExecArray | null;

  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src))) {
    const [, defaultName, named, spec] = m;
    const resolved = resolveImport(file, spec);
    if (!resolved) continue;
    if (defaultName) imports.set(defaultName, resolved);
    if (named) {
      for (const part of named.split(",")) {
        const name = part.split(" as ").pop()!.trim();
        if (name) imports.set(name, resolved);
      }
    }
  }

  const routes: FileInfo["routes"] = [];
  ROUTE_RE.lastIndex = 0;
  while ((m = ROUTE_RE.exec(src))) {
    routes.push({ method: m[1], path: m[2] });
  }

  const mounts: FileInfo["mounts"] = [];
  MOUNT_RE.lastIndex = 0;
  while ((m = MOUNT_RE.exec(src))) {
    mounts.push({ prefix: m[1], child: m[2] });
  }

  const registerCalls: string[] = [];
  REGISTER_RE.lastIndex = 0;
  while ((m = REGISTER_RE.exec(src))) {
    registerCalls.push(m[1]);
  }

  return { imports, routes, mounts, registerCalls };
}

// ────────────────────────────────────────────────────────────────────────────
// Pfad-Normalisierung & Matching
// ────────────────────────────────────────────────────────────────────────────

function joinPath(prefix: string, path: string): string {
  const a = prefix.replace(/\/+$/g, "");
  const b = path.startsWith("/") ? path : "/" + path;
  const joined = (a + b).replace(/\/{2,}/g, "/");
  return joined === "" ? "/" : joined;
}

type Seg = { kind: "literal"; value: string } | { kind: "param" } | { kind: "wildcard" };

/** Zerlegt eine Server-Route-Pattern-URL in Segmente. Express-Parameter
 * (`:id`, `:objectPath(*)`) werden zu `param`/`wildcard`. */
function parseRoutePattern(pattern: string): Seg[] {
  const clean = pattern.split("?")[0];
  const parts = clean.split("/").filter((p) => p.length > 0);
  return parts.map((p): Seg => {
    if (p === "*" || p.includes("(*)") || p.includes("(.*)")) {
      // Catch-all — matcht ein oder mehrere Segmente.
      if (p.startsWith(":")) return { kind: "wildcard" };
      if (p === "*") return { kind: "wildcard" };
      return { kind: "wildcard" };
    }
    if (p.startsWith(":")) return { kind: "param" };
    return { kind: "literal", value: p };
  });
}

/** Zerlegt eine Client-URL. `${…}`-Interpolationen werden zu `param`. */
function parseClientUrl(url: string): Seg[] {
  const noQuery = url.split(/[?#]/)[0];
  const parts = noQuery.split("/").filter((p) => p.length > 0);
  return parts.map((p): Seg => {
    if (/^\$\{[^}]*\}$/.test(p)) return { kind: "param" };
    // Segment mit eingebetteter Interpolation (z.B. `x-${id}`) als Param behandeln.
    if (p.includes("${")) return { kind: "param" };
    return { kind: "literal", value: p };
  });
}

/** Prüft, ob eine Client-URL (Segmente) auf ein Server-Route-Pattern passt. */
function matchesRoute(clientSegs: Seg[], routeSegs: Seg[]): boolean {
  let ci = 0;
  let ri = 0;
  while (ri < routeSegs.length) {
    const r = routeSegs[ri];
    if (r.kind === "wildcard") {
      // Catch-all schluckt den Rest — muss mind. 1 Segment geben.
      return clientSegs.length - ci >= 1 || ri === routeSegs.length - 1;
    }
    if (ci >= clientSegs.length) return false;
    const c = clientSegs[ci];
    if (r.kind === "param") {
      // Param matcht genau ein Segment (egal ob Literal oder ${…}).
      ci++;
      ri++;
      continue;
    }
    // Literal muss exakt passen. Ein ${…} könnte theoretisch alles sein —
    // aber ein Literal-Segment im Server erwartet einen festen Wert.
    if (c.kind === "literal" && c.value === r.value) {
      ci++;
      ri++;
      continue;
    }
    return false;
  }
  return ci === clientSegs.length;
}

// ────────────────────────────────────────────────────────────────────────────
// Mount-Graph auflösen → Menge aller registrierten Routen
// ────────────────────────────────────────────────────────────────────────────

function buildServerRoutes(): Seg[][] {
  const analyzed = new Map<string, FileInfo>();
  const analyze = (file: string): FileInfo => {
    let info = analyzed.get(file);
    if (!info) {
      info = analyzeFile(file);
      analyzed.set(file, info);
    }
    return info;
  };

  // register*-Funktionsdefinitionen global lokalisieren (z.B.
  // registerObjectStorageRoutes lebt in object_storage/routes.ts).
  const registerDefFile = new Map<string, string>();
  for (const file of walk(SERVER_ROOT)) {
    const src = readFileSync(file, "utf-8");
    const re = /export\s+function\s+(register[A-Za-z0-9_$]*)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      registerDefFile.set(m[1], file);
    }
  }

  const routePatterns: Seg[][] = [];
  const seen = new Set<string>();

  // BFS über (Datei, kumulierter Prefix).
  const queue: Array<{ file: string; prefix: string }> = [];
  const enqueue = (file: string, prefix: string) => {
    const key = file + "\u0000" + prefix;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ file, prefix });
  };

  enqueue(ENTRY_FILE, "");

  while (queue.length > 0) {
    const { file, prefix } = queue.shift()!;
    const info = analyze(file);

    for (const r of info.routes) {
      routePatterns.push(parseRoutePattern(joinPath(prefix, r.path)));
    }

    for (const mount of info.mounts) {
      const childFile = info.imports.get(mount.child);
      if (!childFile) continue;
      enqueue(childFile, joinPath(prefix, mount.prefix));
    }

    // register*(app)-Aufrufe: Routen der Zieldatei hängen ohne Prefix am App-Root.
    for (const reg of info.registerCalls) {
      const defFile = registerDefFile.get(reg);
      if (defFile) enqueue(defFile, "");
    }
  }

  return routePatterns;
}

// ────────────────────────────────────────────────────────────────────────────
// Client-Download-URL-Erkennung
// ────────────────────────────────────────────────────────────────────────────

/** Findet in einer (kommentarfreien) Zeile alle String-/Template-Literale, die
 * wie eine Objekt-/Datei-Download-URL aussehen. */
function extractDownloadUrls(line: string): string[] {
  const urls: string[] = [];
  const literalRe = /["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = literalRe.exec(line))) {
    const value = m[1];
    if (!value.startsWith("/")) continue;
    const lower = value.toLowerCase();
    const looksLikeDownload =
      value.startsWith("/objects/") ||
      value === "/objects" ||
      (value.startsWith("/api/") &&
        (lower.includes("download") || lower.includes("object")));
    if (looksLikeDownload) urls.push(value);
  }
  return urls;
}

// ────────────────────────────────────────────────────────────────────────────
// Test
// ────────────────────────────────────────────────────────────────────────────

describe("Architektur — jede Client-Download-URL hat eine echte Server-Route", () => {
  it("baut die Server-Route-Menge und findet dort die bekannten Download-Routen", () => {
    const routes = buildServerRoutes();
    expect(routes.length).toBeGreaterThan(50);

    const has = (url: string) => {
      const segs = parseClientUrl(url);
      return routes.some((r) => matchesRoute(segs, r));
    };

    // Ankerrouten müssen aufgelöst worden sein — sonst ist der Resolver kaputt
    // und der Test würde falsch-positiv „grün" sein.
    expect(has("/objects/uploads/abc123")).toBe(true);
    expect(has("/api/customers/generated-documents/42/download")).toBe(true);
    expect(has("/api/admin/generated-documents/42/download")).toBe(true);
    // Gegenprobe: die tote Proxy-URL darf NICHT auflösen.
    expect(has("/api/object-storage/download")).toBe(false);
  });

  it("Client öffnet keine Download-URL ohne registrierte Server-Route", () => {
    try {
      statSync(CLIENT_ROOT);
    } catch {
      return;
    }

    const routes = buildServerRoutes();
    const hits: Array<{ file: string; line: number; url: string }> = [];

    for (const file of walk(CLIENT_ROOT)) {
      const rel = relative(ROOT, file).split(sep).join("/");
      if (rel === SELF) continue;
      const lines = stripComments(readFileSync(file, "utf-8"));
      for (let i = 0; i < lines.length; i++) {
        for (const url of extractDownloadUrls(lines[i])) {
          const segs = parseClientUrl(url);
          const matched = routes.some((r) => matchesRoute(segs, r));
          if (!matched) hits.push({ file: rel, line: i + 1, url });
        }
      }
    }

    if (hits.length > 0) {
      const msg = hits.map((h) => `  ${h.file}:${h.line} — '${h.url}'`).join("\n");
      expect.fail(
        `Folgende Client-Download-URLs zeigen auf KEINE registrierte ` +
          `Server-Route:\n${msg}\n\n` +
          `Solche Proxy-/Download-Endpunkte schlagen still fehl. Die EINZIGE ` +
          `gültige Streaming-Route für gespeicherte Objekt-Pfade ist die ` +
          `authentifizierte 'GET /objects/:objectPath(*)'. Fix: Öffne den ` +
          `gespeicherten '/objects/...'-Pfad direkt (z.B. ` +
          `window.open(entity.objectPath)) oder nutze für generierte Dokumente ` +
          `die vorhandene '/api/.../generated-documents/:id/download'-Route.`,
      );
    }
  });
});
