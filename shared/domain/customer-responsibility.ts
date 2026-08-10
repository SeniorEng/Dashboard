/**
 * Single source of truth für die Frage "welche Rolle hat dieser Mitarbeiter
 * bei diesem Kunden?" — die Verantwortungs-Kette Primär → 1. Vertretung →
 * 2. Vertretung (`primaryEmployeeId` / `backupEmployeeId` / `backupEmployeeId2`).
 *
 * Geschwister-Modul zu `appointment-attribution.ts`: dort geht es um "welchem
 * Mitarbeiter gehört dieser TERMIN?", hier um "welche Rolle hat der Mitarbeiter
 * bei diesem KUNDEN?". Beide lesen dieselbe Kette, deshalb teilen sie den Typ
 * `CustomerCoverage`.
 *
 * ERSETZT die zwei Inline-Ableitungen im Coverage-Check
 * (`server/routes/appointments.ts`, "Kunden ohne Termin"): das handgeschriebene
 * `or(...)` der Kunden-Query und die lokale `getRole()`-Funktion. Beide
 * kodierten die Kette unabhängig voneinander — wer die Vorrang-Reihenfolge
 * ändert oder eine weitere Vertretung ergänzt, musste zwei Stellen treffen und
 * hätte bei nur einer Änderung eine still divergierende Liste bekommen (Query
 * wählt aus, `getRole` beschriftet).
 *
 * ACHTUNG — SERVER-ONLY. `responsibilityCondition` importiert drizzle und die
 * Schema-Tabelle zur LAUFZEIT (nicht `import type`); dieses Modul ist damit das
 * erste unter `shared/domain/**`, für das das gilt. Kein Client-Code darf hier
 * importieren, sonst zieht der Vite-Bundle die komplette Schema-Kette in den
 * Browser. Im Client kommt die Rolle aus der API-Response
 * (`CoverageUncoveredCustomer.role`), nicht aus dieser Datei.
 */
import { eq, or, type SQL } from "drizzle-orm";
import { customers } from "../schema";
import type { CustomerCoverage } from "./appointment-attribution";

export type { CustomerCoverage };

/**
 * Die Rollen der Verantwortungs-Kette in VORRANG-Reihenfolge. Die Reihenfolge
 * ist bedeutungstragend: sie entscheidet, welche Rolle `responsibilityRole`
 * meldet, wenn derselbe Mitarbeiter beim selben Kunden mehrfach eingetragen ist
 * (z.B. gleichzeitig Primär- und Backup-Kraft) — die stärkste gewinnt.
 */
export const RESPONSIBILITY_ROLES = ["primary", "backup1", "backup2"] as const;

export type ResponsibilityRole = (typeof RESPONSIBILITY_ROLES)[number];

/** Rolle → Spalte der Verantwortungs-Kette. Die eine Stelle, die das Mapping kennt. */
const ROLE_COLUMNS = {
  primary: customers.primaryEmployeeId,
  backup1: customers.backupEmployeeId,
  backup2: customers.backupEmployeeId2,
} as const;

/** Rolle → Feld auf einem gelesenen Kunden-Datensatz. Pendant zu `ROLE_COLUMNS`. */
const ROLE_FIELDS = {
  primary: "primaryEmployeeId",
  backup1: "backupEmployeeId",
  backup2: "backupEmployeeId2",
} as const satisfies Record<ResponsibilityRole, keyof CustomerCoverage>;

/**
 * In welcher Rolle ist `employeeId` für diesen Kunden zuständig — oder `null`,
 * wenn gar nicht.
 *
 * Vorrang strikt `primary` > `backup1` > `backup2`: ist derselbe Mitarbeiter
 * mehrfach eingetragen, zählt die stärkste Rolle. `null` ist ein echtes
 * Ergebnis und KEIN Fehlerfall — es heißt "dieser Kunde gehört nicht zu diesem
 * Mitarbeiter". Aufrufer, die nur über `responsibilityCondition`-gefilterte
 * Kunden iterieren, können `null` nicht sehen; sie sollten es trotzdem
 * behandeln, statt eine Rolle zu raten.
 */
export function responsibilityRole(
  customer: CustomerCoverage,
  employeeId: number,
): ResponsibilityRole | null {
  for (const role of RESPONSIBILITY_ROLES) {
    if (customer[ROLE_FIELDS[role]] === employeeId) return role;
  }
  return null;
}

/**
 * Where-Baustein: Kunden, für die `employeeId` zuständig ist.
 *
 * Ohne `roles` deckt die Bedingung alle drei Rollen ab und ist damit
 * deckungsgleich mit `responsibilityRole(...) !== null`. Ein Rollen-Subset
 * verengt sie — damit wird ein künftiges "nur meine Kunden"-Filter ein
 * Parameter statt einer zweiten Query.
 *
 * Ein LEERES `roles`-Array wirft, statt eine Bedingung zu liefern: drizzles
 * `or()` gibt ohne Argumente `undefined` zurück, was in einem umschließenden
 * `and(...)` stillschweigend wegfällt — die Query lieferte dann ALLE Kunden
 * statt keiner. Das ist genau die Art still ausgeweiteter Sichtbarkeit, die
 * hier niemand debuggen will.
 */
export function responsibilityCondition(
  employeeId: number,
  opts?: { roles?: readonly ResponsibilityRole[] },
): SQL {
  const roles = opts?.roles ?? RESPONSIBILITY_ROLES;
  if (roles.length === 0) {
    throw new Error(
      "responsibilityCondition: leeres roles-Array — das würde die Where-Klausel entfernen statt einschränken.",
    );
  }
  const conditions = roles.map((role) => eq(ROLE_COLUMNS[role], employeeId));
  // Bei genau einer Rolle liefert or() die Bedingung unverändert zurück; der
  // Non-Null-Assert deckt nur den von der Guard oben ausgeschlossenen Leerfall.
  return or(...conditions)!;
}
