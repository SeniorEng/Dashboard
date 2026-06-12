export function parseObjectPath(path: string): { bucketName: string; objectName: string } {
  if (!path.startsWith("/")) path = `/${path}`;
  const parts = path.split("/");
  if (parts.length < 3) throw new Error("Invalid path");
  return { bucketName: parts[1], objectName: parts.slice(2).join("/") };
}

export function getPrivateDir(): string {
  const dir = process.env.PRIVATE_OBJECT_DIR || "";
  if (!dir) throw new Error("PRIVATE_OBJECT_DIR not set");
  return dir;
}

// Task #1042: Object-Storage-Isolation pro Umgebung für Rechnungs-/
// Leistungsnachweis-PDFs.
//
// Dev, Test und Produktion teilen sich denselben Object-Storage-Bucket (die
// Pfade kommen aus den globalen Secrets `PRIVATE_OBJECT_DIR`/
// `PUBLIC_OBJECT_SEARCH_PATHS`). Da Rechnungsnummern (`RE-2026-00xx`) über die
// Dev- und Prod-Datenbanken hinweg kollidieren, würde ein Dev-/Test-Lauf, der
// `RE-2026-0034` erzeugt, das Produktions-PDF unter demselben Object-Key
// überschreiben. Der GoBD-Guard „niemals einen vorhandenen `pdf_path`
// überschreiben" schützt nur eine einzelne DB-Zeile, nicht den geteilten
// Object-Key über Umgebungen hinweg.
//
// Lösung: Produktion behält den nackten Key-Space `invoices/<nummer>.pdf`
// (Bestands-`pdf_path`/`pdf_hash`/ZUGFeRD bleiben byte-genau gültig); alle
// Nicht-Produktions-Umgebungen schreiben unter einen klar getrennten Prefix
// `_nonprod/<NODE_ENV>/invoices/…`. Lesen erfolgt weiterhin verbatim über den
// gespeicherten `pdf_path`, sodass Bestandszeilen ohne Migration funktionieren.

const NONPROD_PDF_PREFIX = "_nonprod";

// Task #1051: Pro-Lauf-Isolation für Rechnungs-/LN-PDF-Objektschlüssel.
//
// Die Ephemeral-Test-DBs sind pro Lauf/Worker isoliert, der Object-Storage-
// Bucket ist es NICHT — alle Nicht-Prod-Läufe teilen den Prefix
// `_nonprod/<NODE_ENV>/` (NODE_ENV=test für jeden Testlauf). Starten zwei
// Testläufe gleichzeitig (z.B. der `test`-Workflow plus ein manueller Lauf),
// erzeugen beide aus ihren frischen DBs dieselben Rechnungsnummern → identische
// Objektschlüssel → sie überschreiben sich gegenseitig die Bucket-Objekte.
//
// Lösung: Der Orchestrator (`scripts/with-ephemeral-db.ts`) exportiert eine
// lauf-eindeutige Run-ID via `EPHEMERAL_RUN_ID` an BEIDE Seiten (Worker-App-
// Server UND den Vitest-Prozess). Ist sie gesetzt, wird der Nicht-Prod-Prefix
// um ein `run-<id>`-Segment erweitert, sodass parallele Läufe denselben Bucket
// ohne gegenseitiges Überschreiben teilen. Produktion ist davon unberührt.
const RUN_ID_ENV = "EPHEMERAL_RUN_ID";

// Task #1263: Pro-WORKER-Isolation zusätzlich zur Pro-Lauf-Isolation.
//
// Ein einzelner Testlauf provisioniert mehrere Worker (Default 2), jeder mit
// EIGENER, frisch geklonter Wegwerf-DB. Aus diesen frischen DBs vergeben die
// Worker jeweils DIESELBEN Rechnungsnummern (`RE-2026-0001` …). Da sie sich die
// EINE Lauf-ID (`EPHEMERAL_RUN_ID`) teilen, würden ihre PDF-Objektschlüssel
// kollidieren → parallele Worker überschreiben sich gegenseitig die Bucket-
// Objekte (PDF-Hash-/Re-Render-Tests werden flaky).
//
// Lösung: Der Orchestrator vergibt jedem Worker eine 0-basierte Worker-ID und
// exportiert sie via `EPHEMERAL_WORKER_ID` an BEIDE Seiten desselben Workers —
// den Worker-App-Server UND den gepaarten Vitest-Fork (tests/setup.ts mappt die
// `VITEST_POOL_ID` auf denselben Index). Ist sie gesetzt, wird der Nicht-Prod-
// Prefix um ein `w-<id>`-Segment erweitert, sodass Worker innerhalb desselben
// Laufs disjunkte Key-Räume schreiben. Produktion ist davon unberührt.
const WORKER_ID_ENV = "EPHEMERAL_WORKER_ID";

/**
 * True, wenn die laufende Umgebung die Produktion ist. Nur in der Produktion
 * werden PDFs unter den nackten Produktions-Key-Space geschrieben.
 */
export function isProductionPdfEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * SSoT für den Object-Key-Prefix der Rechnungs-/LN-PDF-Schreibvorgänge.
 * Produktion: "" (nackter `invoices/…`-Key-Space). Nicht-Produktion:
 * `_nonprod/<NODE_ENV>` (z.B. `_nonprod/development`, `_nonprod/test`), und —
 * falls eine Ephemeral-Lauf-ID gesetzt ist (`EPHEMERAL_RUN_ID`) — zusätzlich
 * pro Lauf gescoped: `_nonprod/<NODE_ENV>/run-<id>` (Task #1051), damit
 * parallele Testläufe sich nicht gegenseitig die Bucket-Objekte überschreiben.
 */
export function getInvoicePdfKeyPrefix(): string {
  if (isProductionPdfEnv()) return "";
  const env = process.env.NODE_ENV || "unknown";
  let prefix = `${NONPROD_PDF_PREFIX}/${env}`;
  const rawRunId = process.env[RUN_ID_ENV];
  if (rawRunId) {
    const safeRunId = rawRunId.replace(/[^a-z0-9_-]/gi, "_");
    if (safeRunId) prefix = `${prefix}/run-${safeRunId}`;
  }
  // Task #1263: Innerhalb eines Laufs zusätzlich pro Worker scopen, damit
  // parallele Worker (eigene DBs, gleiche Rechnungsnummern) disjunkte Key-Räume
  // schreiben und sich nicht gegenseitig die Bucket-Objekte überschreiben.
  const rawWorkerId = process.env[WORKER_ID_ENV];
  if (rawWorkerId) {
    const safeWorkerId = rawWorkerId.replace(/[^a-z0-9_-]/gi, "_");
    if (safeWorkerId) prefix = `${prefix}/w-${safeWorkerId}`;
  }
  return prefix;
}

/**
 * Baut den umgebungs-gescopten Object-Key (relativ zum Private-Dir) für ein
 * Rechnungs- oder Leistungsnachweis-PDF. `safeNumber` ist die bereits
 * sanitisierte Rechnungsnummer.
 */
export function buildInvoicePdfObjectKey(
  safeNumber: string,
  opts?: { leistungsnachweis?: boolean },
): string {
  const base = opts?.leistungsnachweis
    ? `invoices/${safeNumber}-leistungsnachweis.pdf`
    : `invoices/${safeNumber}.pdf`;
  const prefix = getInvoicePdfKeyPrefix();
  return prefix ? `${prefix}/${base}` : base;
}

/**
 * Defense-in-Depth: verhindert, dass eine Nicht-Produktions-Umgebung jemals
 * unter den nackten Produktions-Key-Space (`invoices/…`) schreibt. Schlägt
 * hart fehl, falls ein zukünftiger Fehler den Prefix umgeht und damit ein
 * Produktions-PDF überschreiben könnte. In der Produktion ist es ein No-op.
 */
export function assertInvoicePdfWriteKeyAllowed(objectKey: string): void {
  if (isProductionPdfEnv()) return;
  const prefix = getInvoicePdfKeyPrefix();
  if (!objectKey.startsWith(`${prefix}/`)) {
    throw new Error(
      `Object-Storage-Isolation verletzt: Nicht-Produktions-Umgebung ` +
        `(NODE_ENV=${process.env.NODE_ENV ?? "unset"}) wollte das PDF-Objekt ` +
        `"${objectKey}" außerhalb des Nicht-Produktions-Prefix "${prefix}/" ` +
        `schreiben. Schreiben abgebrochen, um Produktions-PDFs nicht zu ` +
        `überschreiben (Task #1042).`,
    );
  }
}
