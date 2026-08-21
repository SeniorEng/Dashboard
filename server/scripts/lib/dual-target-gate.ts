/**
 * **Ziel-Gate für Skripte, die legitim in Dev UND Prod laufen.**
 *
 * ── Warum es das gibt ───────────────────────────────────────────────────
 * Die drei Zielklassen aus PR #117 gehen davon aus, dass ein Skript weiß,
 * wohin es gehört: Prod-Korrekturen nehmen das Prod-Gate, Test-Werkzeuge die
 * Wegwerf-DB, Dev-Wartung den Dev-Nachweis.
 *
 * `reencrypt-company-secrets.ts` bricht diese Annahme, und zwar zu Recht: eine
 * ENCRYPTION_KEY-Rotation passiert in BEIDEN Umgebungen. Sein bisheriger
 * Ausweg war ein eigenes `--confirm-db=<name>` — und das verglich den Namen
 * aus der `DATABASE_URL`, nicht aus der offenen Verbindung. Genau der Defekt
 * vom 18.08.2026: die URL sagte `neondb`, verbunden war `heliumdb`.
 *
 * ── Warum der Operator die Klasse NENNEN muss ───────────────────────────
 * Die Alternative wäre, sie abzuleiten („`--confirm-target` gesetzt ⇒ Prod").
 * Dann hinge die Sicherheitsstufe an einem vergessenen Flag: wer `--target`
 * vergisst, bekäme still die schwächere Prüfung. Hier ist Vergessen ein
 * Abbruch, keine Herabstufung.
 *
 * ── Beide Wege prüfen auf der OFFENEN Verbindung ────────────────────────
 * Diese Datei prüft selbst nichts — sie wählt aus und delegiert. Beide
 * Delegaten holen den Datenbanknamen über `current_database()`:
 *   `assertProdWriteAllowedOrThrow`  → Host + current_database + Superadmin +
 *                                      Begründung + PROD_DATABASE_URL-Identität
 *   `assertDevWriteTargetOrThrow`    → Host + current_database gegen
 *                                      DEV_WRITE_CONFIRM_TARGET + Prod-Reject
 *
 * Als Vorlage gedacht: jedes weitere Skript, das beide Umgebungen bedient,
 * nimmt diesen Helfer statt einer vierten Formulierung.
 */
import { assertDevWriteTargetOrThrow } from "../../lib/dev-db-guard";
import { assertProdWriteAllowedOrThrow, type ProdWriteArgs } from "./prod-write-gate";

export type Zielklasse = "prod" | "dev";

export interface DualTargetArgs extends ProdWriteArgs {
  /** `--target=prod` oder `--target=dev`. Fehlt sie, bricht das Gate ab. */
  target?: string;
}

export interface DualTargetFreigabe {
  klasse: Zielklasse;
  /** `<host>/<datenbank>`, aus der offenen Verbindung bestätigt. */
  ziel: string;
  /** Nur bei `prod`: der Verantwortliche aus der Audit-Attribution. */
  displayName?: string;
}

const HINWEIS = [
  "ABBRUCH: --apply erfordert --target=prod oder --target=dev.",
  "",
  "  --target=prod   verlangt --confirm-target=<host>/<datenbank>, einen",
  "                  Superadmin (--user), eine Begruendung (--reason) und ein",
  "                  gesetztes PROD_DATABASE_URL.",
  "  --target=dev    verlangt DEV_WRITE_CONFIRM_TARGET=<host>/<datenbank>.",
  "",
  "  Die Klasse wird NICHT abgeleitet. Waere sie es, haenge die Sicherheitsstufe",
  "  an einem vergessenen Flag — wer es vergisst, bekaeme still die schwaechere",
  "  Pruefung. Hier ist Vergessen ein Abbruch.",
].join("\n");

/**
 * Wählt die Zielklasse nach der ausdrücklichen Angabe des Operators und
 * delegiert an das jeweilige Gate. Beide erteilen der Laufzeit-Schreibsperre
 * die Freigabe.
 */
export async function assertDualTargetOrThrow(
  args: DualTargetArgs,
  zweck: string,
): Promise<DualTargetFreigabe> {
  const klasse = (args.target ?? "").trim().toLowerCase();

  if (klasse === "prod") {
    const v = await assertProdWriteAllowedOrThrow(args, zweck);
    // `confirmTarget` ist an dieser Stelle geprueft — das Gate haette sonst
    // geworfen. Es IST damit das bestaetigte Ziel.
    return { klasse: "prod", ziel: (args.confirmTarget ?? "").toLowerCase(), displayName: v.displayName };
  }

  if (klasse === "dev") {
    // Strenger als der Dev-Pfad allein: HIER ist `PROD_DATABASE_URL` Pflicht.
    //
    // Fuer die reinen Dev-Wartungsskripte (#118) ist ihr Fehlen ein bewusst
    // offener Restrand — dort ist "Dev" der Normalfall. Bei einem Skript, das
    // BEIDE Klassen bedient, ist Verwechslung dagegen der wahrscheinlichste
    // Fehler: wer `--target=dev` tippt, waehrend die Shell auf Prod zeigt,
    // haette ohne `PROD_DATABASE_URL` keinen Prod-Reject — und bei
    // `reencrypt-company-secrets` heisst das Prod-Secrets, die die App
    // anschliessend nicht mehr lesen kann.
    if (!(process.env.PROD_DATABASE_URL || "").trim()) {
      throw new Error(
        "ABBRUCH: --target=dev erfordert ein gesetztes PROD_DATABASE_URL.\n" +
          "  Ohne sie laesst sich nicht ausschliessen, dass das 'Dev'-Ziel in " +
          "Wahrheit\n  die Produktionsdatenbank ist — der Prod-Reject haette " +
          "nichts, wogegen er\n  vergleichen koennte.",
      );
    }
    const ziel = await assertDevWriteTargetOrThrow();
    return { klasse: "dev", ziel };
  }

  throw new Error(HINWEIS);
}
