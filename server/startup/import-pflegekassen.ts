import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { insuranceProviders } from "@shared/schema";
import * as fs from "fs";
import * as path from "path";

interface EdifactKasse {
  ik: string;
  name: string;
  nam: string | null;
  ans1: { plz: string; city: string; street: string } | null;
  ans2: { plz: string; city: string; street: string } | null;
}

function parseEdifactFiles(): EdifactKasse[] {
  const assetsDir = path.join(process.cwd(), "attached_assets");
  if (!fs.existsSync(assetsDir)) return [];

  const files = fs.readdirSync(assetsDir).filter(f => f.endsWith(".ke0") || f.endsWith(".ke1"));
  if (files.length === 0) return [];

  const allKassen = new Map<string, EdifactKasse>();

  for (const file of files) {
    const raw = fs.readFileSync(path.join(assetsDir, file));
    const content = raw.toString("latin1");

    const segments = content.split("'").map(s => s.replace(/[\r\n]+/g, "").trim()).filter(Boolean);

    let currentIK: string | null = null;
    let currentName = "";
    let currentNAM: string | null = null;
    let currentANS1: { plz: string; city: string; street: string } | null = null;
    let currentANS2: { plz: string; city: string; street: string } | null = null;

    for (const seg of segments) {
      if (seg.startsWith("IDK+")) {
        if (currentIK && currentIK.startsWith("18") && !allKassen.has(currentIK)) {
          allKassen.set(currentIK, { ik: currentIK, name: currentName, nam: currentNAM, ans1: currentANS1, ans2: currentANS2 });
        }
        const parts = seg.split("+");
        currentIK = parts[1];
        currentName = parts[3] || "";
        currentNAM = null;
        currentANS1 = null;
        currentANS2 = null;
      } else if (seg.startsWith("NAM+")) {
        const parts = seg.split("+");
        currentNAM = [parts[2], parts[3], parts[4]].filter(Boolean).join(" / ");
      } else if (seg.startsWith("ANS+")) {
        const parts = seg.split("+");
        const type = parts[1];
        const addr = { plz: parts[2] || "", city: parts[3] || "", street: parts[4] || "" };
        if (type === "1") currentANS1 = addr;
        else if (type === "2") currentANS2 = addr;
      }
    }
    if (currentIK && currentIK.startsWith("18") && !allKassen.has(currentIK)) {
      allKassen.set(currentIK, { ik: currentIK, name: currentName, nam: currentNAM, ans1: currentANS1, ans2: currentANS2 });
    }
  }

  return Array.from(allKassen.values());
}

function splitStreetAndNumber(street: string): { strasse: string; hausnummer: string } {
  if (!street) return { strasse: "", hausnummer: "" };
  const match = street.match(/^(.+?)\s+(\d+\s*[-–]?\s*\d*\s*[a-zA-Z]?)$/);
  if (match) {
    return { strasse: match[1].trim(), hausnummer: match[2].trim() };
  }
  return { strasse: street, hausnummer: "" };
}

function buildDisplayName(kasse: EdifactKasse): string {
  if (kasse.nam) {
    const parts = kasse.nam.split(" / ");
    if (parts.length >= 2) return parts.slice(1).join(" / ");
    return kasse.nam;
  }
  let name = kasse.name;
  if (name.startsWith("Pflegek.")) name = name.replace("Pflegek.", "Pflegekasse");
  if (name.startsWith("Pflegek ")) name = name.replace("Pflegek ", "Pflegekasse ");
  return name;
}

function buildEmpfaenger(kasse: EdifactKasse): string {
  if (kasse.nam) return kasse.nam;
  return buildDisplayName(kasse);
}

export async function importPflegekassen(): Promise<void> {
  try {
    const kassen = parseEdifactFiles();
    if (kassen.length === 0) return;

    const existing = await db.select({ ikNummer: insuranceProviders.ikNummer })
      .from(insuranceProviders);
    const existingIKs = new Set(existing.map(e => e.ikNummer));

    let created = 0;
    let updated = 0;

    for (const kasse of kassen) {
      const addr = kasse.ans1 || kasse.ans2;
      const { strasse, hausnummer } = addr ? splitStreetAndNumber(addr.street) : { strasse: "", hausnummer: "" };
      const plz = addr?.plz || "";
      const stadt = addr?.city || "";

      if (existingIKs.has(kasse.ik)) {
        if (plz && stadt) {
          const result = await db.execute(sql`
            UPDATE insurance_providers
            SET strasse = COALESCE(NULLIF(strasse, ''), ${strasse || null}),
                hausnummer = COALESCE(NULLIF(hausnummer, ''), ${hausnummer || null}),
                plz = COALESCE(NULLIF(plz, ''), ${plz || null}),
                stadt = COALESCE(NULLIF(stadt, ''), ${stadt || null})
            WHERE ik_nummer = ${kasse.ik}
              AND (strasse IS NULL OR strasse = '' OR plz IS NULL OR plz = '' OR stadt IS NULL OR stadt = '')
          `);
          if ((result.rowCount ?? 0) > 0) updated++;
        }
      } else {
        try {
          await db.insert(insuranceProviders).values({
            name: buildDisplayName(kasse),
            empfaenger: buildEmpfaenger(kasse),
            ikNummer: kasse.ik,
            strasse: strasse || null,
            hausnummer: hausnummer || null,
            plz: plz || null,
            stadt: stadt || null,
            isActive: true,
          });
          created++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!msg.includes("duplicate") && !msg.includes("unique")) {
            console.error(`[startup] Pflegekasse ${kasse.ik} Import fehlgeschlagen:`, msg);
          }
        }
      }
    }

    if (created > 0 || updated > 0) {
      console.log(`[startup] Pflegekassen-Import: ${created} neu erstellt, ${updated} Adressen aktualisiert (von ${kassen.length} in EDIFACT)`);
    }
  } catch (error) {
    console.error("[startup] Pflegekassen-Import fehlgeschlagen:", error);
  }
}
