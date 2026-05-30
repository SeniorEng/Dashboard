/**
 * Task #826 — Bank-Verbindungsdaten (IBAN/BIC) bleiben verschlüsselt.
 *
 * Task #825 hat die Spalten `company_settings.iban` und `.bic` auf den
 * Encrypted-at-Rest-Mechanismus (`encryptedText`) umgestellt. Der allgemeine
 * Architektur-Test (`tests/architecture/sensitive-columns.test.ts`) greift
 * hier NICHT, weil er nur Spaltennamen flaggt, die auf
 * /secret|token|password|key/i matchen — "iban"/"bic" tun das nicht.
 *
 * Dieser gezielte Test sichert die Verschlüsselung daher direkt ab:
 *  1. IBAN/BIC sind als sensitive Spalten registriert.
 *  2. Round-Trip: Beim Schreiben werden sie zu Ciphertext (`enc:`-Prefix),
 *     beim Lesen wieder zum ursprünglichen Klartext — eine nicht-sensitive
 *     Spalte (`companyName`) bleibt unangetastet.
 *  3. Ohne `ENCRYPTION_KEY` ist der Pfad ein Graceful No-Op (kein Crash).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { companySettings } from "@shared/schema";
import { isSensitiveDbColumn } from "@shared/schema";
import {
  encryptRow,
  decryptRow,
  getSensitivePropsForTable,
} from "../../server/lib/encrypted-row";

const TEST_KEY = "a".repeat(64);

describe("CompanySettings IBAN/BIC bleiben verschlüsselt (Task #826)", () => {
  let originalKey: string | undefined;

  beforeAll(() => {
    originalKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalKey;
    }
  });

  it("registriert iban und bic als sensitive DB-Spalten", () => {
    expect(isSensitiveDbColumn("iban")).toBe(true);
    expect(isSensitiveDbColumn("bic")).toBe(true);

    const props = getSensitivePropsForTable(companySettings);
    expect(props).toContain("iban");
    expect(props).toContain("bic");
    // Gegenprobe: eine harmlose Spalte ist NICHT als sensitiv markiert.
    expect(props).not.toContain("companyName");
    expect(isSensitiveDbColumn("company_name")).toBe(false);
  });

  it("verschlüsselt IBAN/BIC beim Schreiben und entschlüsselt sie wieder beim Lesen", () => {
    const plaintext = {
      companyName: "Muster Pflege GmbH",
      iban: "DE89370400440532013000",
      bic: "COBADEFFXXX",
    };

    const stored = encryptRow(companySettings, plaintext);

    // Ciphertext: IBAN/BIC sind verändert und tragen den enc:-Prefix.
    expect(stored.iban).not.toBe(plaintext.iban);
    expect(stored.bic).not.toBe(plaintext.bic);
    expect(stored.iban.startsWith("enc:")).toBe(true);
    expect(stored.bic.startsWith("enc:")).toBe(true);
    // Der Klartext darf nirgends mehr im gespeicherten Wert auftauchen.
    expect(stored.iban).not.toContain("DE89370400440532013000");
    expect(stored.bic).not.toContain("COBADEFFXXX");
    // Nicht-sensitive Spalte bleibt unangetastet.
    expect(stored.companyName).toBe(plaintext.companyName);

    // Round-Trip: Lesen stellt den Original-Klartext wieder her.
    const roundTripped = decryptRow(companySettings, stored);
    expect(roundTripped.iban).toBe(plaintext.iban);
    expect(roundTripped.bic).toBe(plaintext.bic);
    expect(roundTripped.companyName).toBe(plaintext.companyName);
  });

  it("ist ein Graceful No-Op, wenn kein ENCRYPTION_KEY gesetzt ist", () => {
    const saved = process.env.ENCRYPTION_KEY;
    delete process.env.ENCRYPTION_KEY;
    try {
      const plaintext = {
        companyName: "Muster Pflege GmbH",
        iban: "DE89370400440532013000",
        bic: "COBADEFFXXX",
      };
      const stored = encryptRow(companySettings, plaintext);
      // Ohne Key: keine Verschlüsselung, aber auch kein Crash.
      expect(stored.iban).toBe(plaintext.iban);
      expect(stored.bic).toBe(plaintext.bic);
      expect(decryptRow(companySettings, stored)).toEqual(plaintext);
    } finally {
      process.env.ENCRYPTION_KEY = saved;
    }
  });
});
