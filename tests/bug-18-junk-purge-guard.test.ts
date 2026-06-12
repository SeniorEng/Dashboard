import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../server/lib/db";
import { services, documentTypes } from "@shared/schema";
import {
  collectJunkPurgeReport,
  JUNK_PURGE_MIGRATION_NAME,
} from "../server/startup/purge-junk-master-data";
import {
  isDocumentTypeTestJunk,
  DOCUMENT_TYPE_WHITELIST,
} from "../server/services/test-data-cleanup";

// BUG-18 (Task #1230) — Wirksamkeits-Beweis durch ABSICHTLICHEN Verstoß.
//
// Schleust je einen frischen Müll-Service (`tlsicht_…`) und einen
// Nicht-Whitelist-`DOC*`-Dokumenttyp ein und beweist, dass derselbe Filter, den
// Guard (`scripts/check-no-test-junk.ts`) und Prod-Migration nutzen, beide
// erkennt — und dass ein echter Whitelist-Typ NICHT erfasst wird. Räumt am Ende
// restlos auf, sodass zwei volle Testläufe 0 neue Müll-Einträge hinterlassen.

const SUFFIX = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const JUNK_SERVICE_NAME = `tlsicht_violation_${SUFFIX}`;
const JUNK_DOC_TYPE_NAME = `DOCviolation_${SUFFIX}`;

let junkServiceId: number | undefined;
let junkDocTypeId: number | undefined;

afterAll(async () => {
  if (junkServiceId !== undefined) {
    await db.delete(services).where(inArray(services.id, [junkServiceId]));
  }
  if (junkDocTypeId !== undefined) {
    await db.delete(documentTypes).where(inArray(documentTypes.id, [junkDocTypeId]));
  }
});

describe("BUG-18 — Junk-Stammdaten-Guard (absichtlicher Verstoß)", () => {
  it("erkennt einen frisch eingeschleusten Müll-Service + Müll-Dokumenttyp", async () => {
    const [svc] = await db
      .insert(services)
      .values({ name: JUNK_SERVICE_NAME, unitType: "hour" })
      .returning({ id: services.id });
    junkServiceId = svc.id;

    const [dt] = await db
      .insert(documentTypes)
      .values({ name: JUNK_DOC_TYPE_NAME })
      .returning({ id: documentTypes.id });
    junkDocTypeId = dt.id;

    const report = await collectJunkPurgeReport();

    const flaggedServiceIds = new Set([
      ...report.services.deletable.map((r) => r.id),
      ...report.services.deactivatable.map((r) => r.id),
    ]);
    const flaggedDocTypeIds = new Set([
      ...report.documentTypes.deletable.map((r) => r.id),
      ...report.documentTypes.deactivatable.map((r) => r.id),
    ]);

    expect(flaggedServiceIds.has(junkServiceId)).toBe(true);
    expect(flaggedDocTypeIds.has(junkDocTypeId)).toBe(true);

    // Referenzlos eingeschleust ⇒ HART-löschbar (nicht nur deaktivieren).
    expect(report.services.deletable.some((r) => r.id === junkServiceId)).toBe(true);
    expect(report.documentTypes.deletable.some((r) => r.id === junkDocTypeId)).toBe(true);

    // Echte Stammdaten bleiben unangetastet.
    expect(report.realServiceIds).not.toContain(junkServiceId);
    expect(report.realDocumentTypeIds).not.toContain(junkDocTypeId);
  });

  it("klassifiziert die reine Funktion deckungsgleich (DOC-Müll vs. Whitelist)", () => {
    expect(isDocumentTypeTestJunk(JUNK_DOC_TYPE_NAME)).toBe(true);
    for (const name of DOCUMENT_TYPE_WHITELIST) {
      expect(isDocumentTypeTestJunk(name)).toBe(false);
    }
  });

  it("exportiert einen stabilen Migrations-Namen fürs exactly-once Ledger", () => {
    expect(JUNK_PURGE_MIGRATION_NAME).toBe("bug-18-purge-junk-master-data");
  });
});
