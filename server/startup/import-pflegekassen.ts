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
  kimAdresse: string | null;
  email: string | null;
  telefon: string | null;
  fax: string | null;
  ansprechpartner: string | null;
  datenannahmeIk: string | null;
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
    let currentKim: string | null = null;
    let currentEmail: string | null = null;
    let currentTelefon: string | null = null;
    let currentFax: string | null = null;
    let currentAnsprechpartner: string | null = null;
    let currentDatenannahmeIk: string | null = null;

    for (const seg of segments) {
      if (seg.startsWith("IDK+")) {
        if (currentIK && currentIK.startsWith("18") && !allKassen.has(currentIK)) {
          allKassen.set(currentIK, {
            ik: currentIK, name: currentName, nam: currentNAM,
            ans1: currentANS1, ans2: currentANS2,
            kimAdresse: currentKim, email: currentEmail,
            telefon: currentTelefon, fax: currentFax,
            ansprechpartner: currentAnsprechpartner,
            datenannahmeIk: currentDatenannahmeIk,
          });
        }
        const parts = seg.split("+");
        currentIK = parts[1];
        currentName = parts[3] || "";
        currentNAM = null;
        currentANS1 = null;
        currentANS2 = null;
        currentKim = null;
        currentEmail = null;
        currentTelefon = null;
        currentFax = null;
        currentAnsprechpartner = null;
        currentDatenannahmeIk = null;
      } else if (seg.startsWith("NAM+")) {
        const parts = seg.split("+");
        currentNAM = [parts[2], parts[3], parts[4]].filter(Boolean).join(" / ");
      } else if (seg.startsWith("ANS+")) {
        const parts = seg.split("+");
        const type = parts[1];
        const addr = { plz: parts[2] || "", city: parts[3] || "", street: parts[4] || "" };
        if (type === "1") currentANS1 = addr;
        else if (type === "2") currentANS2 = addr;
      } else if (seg.startsWith("DFU+")) {
        const parts = seg.split("+");
        const medium = parts[2];
        const adresse = parts[parts.length - 1] || "";
        if (medium === "080" && adresse.includes(".kim.telematik")) {
          currentKim = adresse;
        } else if (medium === "070" && adresse.includes("@")) {
          currentEmail = adresse;
        }
      } else if (seg.startsWith("ASP+")) {
        const parts = seg.split("+");
        if (!currentTelefon && parts[2]) currentTelefon = parts[2];
        if (!currentFax && parts[3]) currentFax = parts[3];
        const aspName = parts[4] || "";
        const aspAbteilung = parts[5] || "";
        if (!currentAnsprechpartner && (aspName || aspAbteilung)) {
          currentAnsprechpartner = [aspName, aspAbteilung].filter(Boolean).join(", ");
        }
      } else if (seg.startsWith("VKG+")) {
        const parts = seg.split("+");
        if (!currentDatenannahmeIk && parts[2]) {
          currentDatenannahmeIk = parts[2];
        }
      }
    }
    if (currentIK && currentIK.startsWith("18") && !allKassen.has(currentIK)) {
      allKassen.set(currentIK, {
        ik: currentIK, name: currentName, nam: currentNAM,
        ans1: currentANS1, ans2: currentANS2,
        kimAdresse: currentKim, email: currentEmail,
        telefon: currentTelefon, fax: currentFax,
        ansprechpartner: currentAnsprechpartner,
        datenannahmeIk: currentDatenannahmeIk,
      });
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
      const displayName = buildDisplayName(kasse);
      const empfaenger = buildEmpfaenger(kasse);

      if (existingIKs.has(kasse.ik)) {
        const result = await db.execute(sql`
          UPDATE insurance_providers
          SET name = ${displayName},
              empfaenger = ${empfaenger},
              strasse = COALESCE(NULLIF(strasse, ''), ${strasse || null}),
              hausnummer = COALESCE(NULLIF(hausnummer, ''), ${hausnummer || null}),
              plz = COALESCE(NULLIF(plz, ''), ${plz || null}),
              stadt = COALESCE(NULLIF(stadt, ''), ${stadt || null}),
              telefon = COALESCE(NULLIF(telefon, ''), ${kasse.telefon || null}),
              fax = COALESCE(NULLIF(fax, ''), ${kasse.fax || null}),
              email = COALESCE(NULLIF(email, ''), ${kasse.email || null}),
              kim_adresse = COALESCE(NULLIF(kim_adresse, ''), ${kasse.kimAdresse || null}),
              ansprechpartner = COALESCE(NULLIF(ansprechpartner, ''), ${kasse.ansprechpartner || null}),
              datenannahme_ik = COALESCE(NULLIF(datenannahme_ik, ''), ${kasse.datenannahmeIk || null})
          WHERE ik_nummer = ${kasse.ik}
        `);
        if ((result.rowCount ?? 0) > 0) updated++;
      } else {
        try {
          await db.insert(insuranceProviders).values({
            name: displayName,
            empfaenger: empfaenger,
            ikNummer: kasse.ik,
            strasse: strasse || null,
            hausnummer: hausnummer || null,
            plz: plz || null,
            stadt: stadt || null,
            telefon: kasse.telefon || null,
            fax: kasse.fax || null,
            email: kasse.email || null,
            kimAdresse: kasse.kimAdresse || null,
            ansprechpartner: kasse.ansprechpartner || null,
            datenannahmeIk: kasse.datenannahmeIk || null,
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
      console.log(`[startup] Pflegekassen-Import: ${created} neu erstellt, ${updated} aktualisiert (von ${kassen.length} in EDIFACT)`);
    }
  } catch (error) {
    console.error("[startup] Pflegekassen-Import fehlgeschlagen:", error);
  }
}
