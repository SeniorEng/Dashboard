/**
 * Task #1177 (Phase 3) — Intake-Checkliste (GOV.UK Task-List-Muster).
 *
 * SSoT für den Anlage-Fortschritt eines Kunden. Nach der Minimal-Anlage
 * (Name + Typ + Kontakt) werden die übrigen Onboarding-Schritte NICHT mehr
 * in einem erzwungenen Wizard durchlaufen, sondern als Checkliste auf der
 * Kunden-Detailseite angeboten. Der Status jedes Schritts wird rein aus den
 * bereits vorhandenen Daten abgeleitet — es gibt KEINEN neuen Status-Store.
 *
 * Diese Funktion ist absichtlich frei von UI-Belangen (Labels/Links liegen
 * im Frontend) und von HTTP-/DB-Zugriffen, damit sie deterministisch
 * unit-getestet werden kann (Read- und Anzeige-Pfad teilen denselben Code).
 */
import { isPflegekasseCustomer, type BillingType } from "../customers";

export type IntakeStepKey =
  | "personal"
  | "insurance"
  | "contract"
  | "budgets"
  | "matching"
  | "documents";

export type IntakeStepStatus = "done" | "open" | "not_applicable";

export const INTAKE_STEP_ORDER: readonly IntakeStepKey[] = [
  "personal",
  "insurance",
  "contract",
  "budgets",
  "matching",
  "documents",
] as const;

export interface IntakeChecklistInput {
  billingType: BillingType | "" | null | undefined;
  pflegegrad?: number | null;
  /** Stammdaten (Name + Adresse) vollständig erfasst. */
  hasPersonalData?: boolean;
  /** Aktive Krankenkassen-/Versicherungszuordnung vorhanden. */
  hasInsurance?: boolean;
  /** Aktiver Vertrag (Vertragsbeginn) vorhanden. */
  hasContract?: boolean;
  /**
   * Server-abgeleitetes Flag (PG ≥ 2 + pflegekasse + keine aktiven
   * Topf-Settings). `true` ⇒ Budget-Schritt offen.
   */
  budgetSetupMissing?: boolean;
  /** Mind. eine Betreuungskraft zugeordnet (Matching erledigt). */
  hasPrimaryEmployee?: boolean;
  /** Mind. ein unterschriebenes/hochgeladenes Kundendokument vorhanden. */
  hasDocuments?: boolean;
}

export interface IntakeStepState {
  key: IntakeStepKey;
  status: IntakeStepStatus;
}

export interface IntakeChecklist {
  steps: IntakeStepState[];
  /** Anzahl erledigter (applicable + done) Schritte. */
  doneCount: number;
  /** Anzahl relevanter (nicht not_applicable) Schritte. */
  applicableCount: number;
  /** Kein relevanter Schritt mehr offen. */
  complete: boolean;
  /** Anlage läuft noch (mind. ein relevanter Schritt offen). */
  inIntake: boolean;
}

function statusFor(applicable: boolean, done: boolean): IntakeStepStatus {
  if (!applicable) return "not_applicable";
  return done ? "done" : "open";
}

export function computeIntakeChecklist(input: IntakeChecklistInput): IntakeChecklist {
  const isPflegekasse = isPflegekasseCustomer(input.billingType ?? "");
  const pflegegrad = input.pflegegrad ?? 0;

  const steps: IntakeStepState[] = [
    {
      key: "personal",
      status: statusFor(true, input.hasPersonalData ?? false),
    },
    {
      // Versicherung nur für Pflegekassen-Kunden relevant.
      key: "insurance",
      status: statusFor(isPflegekasse, input.hasInsurance ?? false),
    },
    {
      key: "contract",
      status: statusFor(true, input.hasContract ?? false),
    },
    {
      // Budgets nur für pflegekassen-berechtigte Kunden mit PG ≥ 2 relevant.
      // `budgetSetupMissing` (Server-Flag) kodiert dieselbe Bedingung; ist es
      // nicht gesetzt, gilt der Schritt als erledigt.
      key: "budgets",
      status: statusFor(isPflegekasse && pflegegrad >= 2, !(input.budgetSetupMissing ?? false)),
    },
    {
      key: "matching",
      status: statusFor(true, input.hasPrimaryEmployee ?? false),
    },
    {
      key: "documents",
      status: statusFor(true, input.hasDocuments ?? false),
    },
  ];

  const applicableSteps = steps.filter((s) => s.status !== "not_applicable");
  const doneCount = applicableSteps.filter((s) => s.status === "done").length;
  const applicableCount = applicableSteps.length;
  const complete = applicableSteps.every((s) => s.status === "done");

  return {
    steps,
    doneCount,
    applicableCount,
    complete,
    inIntake: !complete,
  };
}
