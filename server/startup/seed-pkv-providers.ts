import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { insuranceProviders } from "@shared/schema";
import { log } from "../lib/log";

interface PkvProviderSeed {
  name: string;
  empfaenger: string;
  strasse?: string;
  hausnummer?: string;
  plz?: string;
  stadt?: string;
  telefon?: string;
  email?: string;
}

const PKV_PROVIDERS: PkvProviderSeed[] = [
  {
    name: "Debeka Krankenversicherung",
    empfaenger: "Debeka Krankenversicherungsverein a.G.",
    strasse: "Ferdinand-Sauerbruch-Straße",
    hausnummer: "18",
    plz: "56058",
    stadt: "Koblenz",
    telefon: "0261 4980",
  },
  {
    name: "Allianz Private Krankenversicherung",
    empfaenger: "Allianz Private Krankenversicherungs-AG",
    plz: "80171",
    stadt: "München",
    telefon: "0800 4100104",
  },
  {
    name: "AXA Krankenversicherung",
    empfaenger: "AXA Krankenversicherung AG",
    plz: "51171",
    stadt: "Köln",
    telefon: "0221 1481000",
  },
  {
    name: "Signal Iduna Krankenversicherung",
    empfaenger: "SIGNAL IDUNA Krankenversicherung a.G.",
    strasse: "Joseph-Scherer-Straße",
    hausnummer: "3",
    plz: "44139",
    stadt: "Dortmund",
    telefon: "0231 1350",
  },
  {
    name: "DKV Deutsche Krankenversicherung",
    empfaenger: "DKV Deutsche Krankenversicherung AG",
    plz: "50594",
    stadt: "Köln",
    telefon: "0221 5780",
  },
  {
    name: "Hallesche Krankenversicherung",
    empfaenger: "Hallesche Krankenversicherung a.G.",
    strasse: "Reinsburgstraße",
    hausnummer: "10",
    plz: "70178",
    stadt: "Stuttgart",
    telefon: "0711 66030",
  },
  {
    name: "Continentale Krankenversicherung",
    empfaenger: "Continentale Krankenversicherung a.G.",
    strasse: "Ruhrallee",
    hausnummer: "92",
    plz: "44139",
    stadt: "Dortmund",
    telefon: "0231 9190",
  },
  {
    name: "HUK-COBURG Krankenversicherung",
    empfaenger: "HUK-COBURG-Krankenversicherung AG",
    plz: "96440",
    stadt: "Coburg",
    telefon: "09561 960",
  },
  {
    name: "HanseMerkur Krankenversicherung",
    empfaenger: "HanseMerkur Krankenversicherung AG",
    strasse: "Siegfried-Wedells-Platz",
    hausnummer: "1",
    plz: "20354",
    stadt: "Hamburg",
    telefon: "040 41190",
  },
  {
    name: "Nürnberger Krankenversicherung",
    empfaenger: "NÜRNBERGER Krankenversicherung AG",
    strasse: "Ostendstraße",
    hausnummer: "100",
    plz: "90334",
    stadt: "Nürnberg",
    telefon: "0911 5310",
  },
  {
    name: "INTER Krankenversicherung",
    empfaenger: "INTER Krankenversicherung AG",
    strasse: "Erzbergerstraße",
    hausnummer: "9-15",
    plz: "68165",
    stadt: "Mannheim",
    telefon: "0621 4270",
  },
  {
    name: "Generali Deutschland Krankenversicherung",
    empfaenger: "Generali Deutschland Krankenversicherung AG",
    plz: "81731",
    stadt: "München",
    telefon: "089 51210",
  },
  {
    name: "Gothaer Krankenversicherung",
    empfaenger: "Gothaer Krankenversicherung AG",
    strasse: "Gothaer Allee",
    hausnummer: "1",
    plz: "50969",
    stadt: "Köln",
    telefon: "0221 3080",
  },
  {
    name: "Barmenia Krankenversicherung",
    empfaenger: "Barmenia Krankenversicherung AG",
    strasse: "Barmenia-Allee",
    hausnummer: "1",
    plz: "42119",
    stadt: "Wuppertal",
    telefon: "0202 4380",
  },
  {
    name: "Münchener Verein Krankenversicherung",
    empfaenger: "Münchener Verein Krankenversicherung a.G.",
    strasse: "Pettenkoferstraße",
    hausnummer: "19",
    plz: "80336",
    stadt: "München",
    telefon: "089 51520",
  },
  {
    name: "Württembergische Krankenversicherung",
    empfaenger: "Württembergische Krankenversicherung AG",
    plz: "70163",
    stadt: "Stuttgart",
    telefon: "0711 6620",
  },
  {
    name: "Universa Krankenversicherung",
    empfaenger: "uniVersa Krankenversicherung a.G.",
    strasse: "Sulzbacher Straße",
    hausnummer: "1-7",
    plz: "90489",
    stadt: "Nürnberg",
    telefon: "0911 53070",
  },
  {
    name: "LVM Krankenversicherung",
    empfaenger: "LVM Krankenversicherungs-AG",
    strasse: "Kolde-Ring",
    hausnummer: "21",
    plz: "48126",
    stadt: "Münster",
    telefon: "0251 7020",
  },
  {
    name: "Mecklenburgische Krankenversicherung",
    empfaenger: "Mecklenburgische Krankenversicherungs-AG",
    strasse: "Platz der Mecklenburgischen",
    hausnummer: "1",
    plz: "30625",
    stadt: "Hannover",
    telefon: "0511 53510",
  },
  {
    name: "Alte Oldenburger Krankenversicherung",
    empfaenger: "Alte Oldenburger Krankenversicherung AG",
    strasse: "Theodor-Heuss-Straße",
    hausnummer: "10",
    plz: "49377",
    stadt: "Vechta",
    telefon: "04441 9050",
  },
  {
    name: "SDK Süddeutsche Krankenversicherung",
    empfaenger: "Süddeutsche Krankenversicherung a.G.",
    strasse: "Raiffeisenplatz",
    hausnummer: "5",
    plz: "70736",
    stadt: "Fellbach",
    telefon: "0711 75721910",
  },
  {
    name: "Bayerische Beamtenkrankenkasse",
    empfaenger: "Bayerische Beamtenkrankenkasse AG",
    plz: "80539",
    stadt: "München",
    telefon: "089 21600",
  },
  {
    name: "ARAG Krankenversicherung",
    empfaenger: "ARAG Krankenversicherungs-AG",
    strasse: "ARAG Platz",
    hausnummer: "1",
    plz: "40472",
    stadt: "Düsseldorf",
    telefon: "0211 9630",
  },
  {
    name: "Concordia Krankenversicherung",
    empfaenger: "Concordia Krankenversicherungs-AG",
    strasse: "Karl-Wiechert-Allee",
    hausnummer: "55",
    plz: "30625",
    stadt: "Hannover",
    telefon: "0511 57010",
  },
  {
    name: "VRK Versicherer im Raum der Kirchen",
    empfaenger: "Versicherer im Raum der Kirchen Krankenversicherung AG",
    strasse: "Doktorweg",
    hausnummer: "2-4",
    plz: "32756",
    stadt: "Detmold",
    telefon: "05231 9750",
  },
  {
    name: "Landeskrankenhilfe (LKH)",
    empfaenger: "Landeskrankenhilfe V.V.a.G.",
    strasse: "Uelzener Straße",
    hausnummer: "120",
    plz: "21335",
    stadt: "Lüneburg",
    telefon: "04131 7250",
  },
  {
    name: "R+V Krankenversicherung",
    empfaenger: "R+V Krankenversicherung AG",
    strasse: "Raiffeisenplatz",
    hausnummer: "1",
    plz: "65189",
    stadt: "Wiesbaden",
    telefon: "0611 5330",
  },
  {
    name: "DEVK Krankenversicherung",
    empfaenger: "DEVK Krankenversicherungs-AG",
    strasse: "Riehler Straße",
    hausnummer: "190",
    plz: "50735",
    stadt: "Köln",
    telefon: "0221 7570",
  },
  {
    name: "Provinzial Krankenversicherung",
    empfaenger: "Provinzial Krankenversicherung Hannover AG",
    strasse: "Schiffgraben",
    hausnummer: "4",
    plz: "30159",
    stadt: "Hannover",
    telefon: "0511 36210",
  },
  {
    name: "uniVita Krankenversicherung",
    empfaenger: "uniVita Krankenversicherungs-AG",
    plz: "90489",
    stadt: "Nürnberg",
  },
];

export async function seedPkvProviders(): Promise<void> {
  try {
    let created = 0;
    let updated = 0;

    for (const seed of PKV_PROVIDERS) {
      const existing = await db.execute(sql`
        SELECT id, is_private
        FROM insurance_providers
        WHERE LOWER(name) = LOWER(${seed.name})
        LIMIT 1
      `);
      const row = (existing.rows as Array<{ id: number; is_private: boolean }>)[0];

      if (row) {
        if (!row.is_private) {
          await db.execute(sql`
            UPDATE insurance_providers
            SET is_private = true
            WHERE id = ${row.id}
          `);
          updated++;
        }
      } else {
        try {
          await db.insert(insuranceProviders).values({
            name: seed.name,
            empfaenger: seed.empfaenger,
            isPrivate: true,
            strasse: seed.strasse ?? null,
            hausnummer: seed.hausnummer ?? null,
            plz: seed.plz ?? null,
            stadt: seed.stadt ?? null,
            telefon: seed.telefon ?? null,
            email: seed.email ?? null,
            isActive: true,
          });
          created++;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          log(`PKV-Provider ${seed.name} Seed fehlgeschlagen: ${msg}`, "startup");
        }
      }
    }

    if (created > 0 || updated > 0) {
      log(`PKV-Provider-Seed: ${created} neu erstellt, ${updated} als privat markiert (von ${PKV_PROVIDERS.length} bekannten PKV-Anbietern)`, "startup");
    }
  } catch (error) {
    log(`PKV-Provider-Seed fehlgeschlagen: ${error}`, "startup");
  }
}
