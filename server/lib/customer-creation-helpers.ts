import { customerManagementStorage } from "../storage/customer-management";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";
import type { InsertCustomer } from "@shared/schema";
import type { DbOrTx } from "./db";
import type { DbClient } from "../storage/budget/types";
import { maybeFail } from "./test-fault-injector";

interface CustomerBaseFields {
  vorname: string;
  nachname: string;
  email?: string | null;
  telefon?: string | null;
  festnetz?: string | null;
  strasse: string;
  nr: string;
  plz: string;
  stadt: string;
  pflegegrad?: number | null;
  geburtsdatum?: string | null;
  vorerkrankungen?: string | null;
  haustierVorhanden?: boolean;
  haustierDetails?: string | null;
  personenbefoerderungGewuenscht?: boolean;
  acceptsPrivatePayment?: boolean;
  beihilfeBerechtigt?: boolean;
  receivesMonthlyInvoice?: boolean;
  documentDeliveryMethod?: string;
  billingType: string;
}

export function buildCustomerInsertData(data: CustomerBaseFields, createdByUserId: number): InsertCustomer {
  return {
    name: `${data.nachname}, ${data.vorname}`,
    vorname: data.vorname,
    nachname: data.nachname,
    email: data.email || null,
    telefon: data.telefon || null,
    festnetz: data.festnetz || null,
    address: `${data.strasse} ${data.nr}, ${data.plz} ${data.stadt}`,
    strasse: data.strasse,
    nr: data.nr,
    plz: data.plz,
    stadt: data.stadt,
    pflegegrad: data.pflegegrad || null,
    geburtsdatum: data.geburtsdatum || null,
    vorerkrankungen: data.vorerkrankungen || null,
    haustierVorhanden: data.haustierVorhanden || false,
    haustierDetails: data.haustierVorhanden ? (data.haustierDetails || null) : null,
    personenbefoerderungGewuenscht: data.personenbefoerderungGewuenscht || false,
    documentDeliveryMethod: (data.documentDeliveryMethod as "email" | "post") || "email",
    acceptsPrivatePayment: data.acceptsPrivatePayment ?? false,
    beihilfeBerechtigt: data.beihilfeBerechtigt ?? false,
    receivesMonthlyInvoice: data.receivesMonthlyInvoice ?? false,
    billingType: data.billingType,
    createdByUserId,
  };
}

interface InsuranceInput {
  providerId: number;
  versichertennummer: string;
  validFrom: string;
}

interface ContactInput {
  contactType: string;
  isPrimary: boolean;
  vorname: string;
  nachname: string;
  festnetz?: string | null;
  mobilnummer?: string | null;
  email?: string | null;
  notes?: string | null;
}

interface BudgetInput {
  entlastungsbetrag45b: number;
  verhinderungspflege39: number;
  pflegesachleistungen36: number;
  validFrom: string;
  carryoverAmountCents?: number;
}

interface ContractInput {
  contractStart: string;
  contractDate?: string | null;
  vereinbarteLeistungen?: string | null;
  hoursPerPeriod: number;
  periodType: string;
  rates?: Array<{ serviceCategory: string; hourlyRateCents: number }>;
}

interface CreateRelatedDataInput {
  customerId: number;
  userId: number;
  logPrefix: string;
  pflegegrad?: number | null;
  pflegegradSeit?: string;
  insurance?: InsuranceInput;
  contacts?: ContactInput[];
  budgets?: BudgetInput;
  contract?: ContractInput;
  useLedgerBudgets?: boolean;
  /**
   * Optionale äußere Transaktion. Wenn gesetzt, laufen alle Pflicht-Cascade-
   * Schritte (Pflegegrad, Insurance, Budget-Type-Settings, Vertrag/Raten)
   * darin und werfen bei Fehler hart, sodass die Transaktion zurückrollt.
   * Soft-Schritte (Kontakte, Carryover, syncCarryoverAndExpiry) werden weiter
   * mit try/catch eingefangen und tauchen nur als Warnings auf.
   */
  tx?: DbOrTx & DbClient;
  /**
   * Test-Fault-Set (siehe `server/lib/test-fault-injector.ts`). Routes lesen
   * den `x-test-inject-fault`-Header und reichen das Set hier durch. In
   * Produktion bleibt dieses Feld undefined und ohne Wirkung.
   */
  testFaults?: Set<string>;
}

export async function createCustomerRelatedData(input: CreateRelatedDataInput): Promise<string[]> {
  const { customerId, userId, logPrefix, tx, testFaults } = input;
  const warnings: string[] = [];

  // Pflicht: Pflegegrad-Historie. Hard-Fail, damit kein Customer ohne
  // konsistente Pflegegrad-Historie persistiert wird (downstream-kritisch
  // für §45b-Buchungen).
  if (input.pflegegrad && input.pflegegradSeit) {
    maybeFail("care_level", testFaults);
    await customerManagementStorage.addCareLevelHistory({
      customerId,
      pflegegrad: input.pflegegrad,
      validFrom: input.pflegegradSeit,
    }, userId, tx);
  }

  // Pflicht: Versicherung. Hard-Fail bei FK-Verletzung der providerId oder
  // anderen Schreibfehlern, damit kein pflegekasse_*-Customer ohne
  // gültige Versicherungs-Historie entsteht.
  if (input.insurance) {
    maybeFail("insurance", testFaults);
    await customerManagementStorage.addCustomerInsurance({
      customerId,
      insuranceProviderId: input.insurance.providerId,
      versichertennummer: input.insurance.versichertennummer,
      validFrom: input.insurance.validFrom,
    }, userId, tx);
  }

  // Soft: Kontakte. Eine sequentielle Schleife mit try/catch um den
  // gesamten Block stellt sicher, dass bei einem Fehler im 2. Kontakt der
  // 1. Kontakt nicht teilweise persistiert ist (innerhalb derselben Tx
  // wird ohnehin alles zurückgerollt; ohne Tx beendet die Schleife
  // einfach nach dem ersten Fehler — kein „Half-Persist").
  if (input.contacts && input.contacts.length > 0) {
    try {
      maybeFail("contacts", testFaults);
      for (let i = 0; i < input.contacts.length; i++) {
        const c = input.contacts[i];
        await customerManagementStorage.addCustomerContact({
          customerId,
          contactType: c.contactType as "familie" | "angehoerige" | "nachbar" | "hausarzt" | "betreuer" | "sonstige",
          isPrimary: c.isPrimary,
          vorname: c.vorname,
          nachname: c.nachname,
          festnetz: c.festnetz || null,
          mobilnummer: c.mobilnummer || null,
          email: c.email || null,
          notes: c.notes || null,
          sortOrder: i,
        }, tx);
      }
    } catch (err) {
      console.error(`[${logPrefix}] Kontakte fehlgeschlagen für Kunde ${customerId}:`, err);
      warnings.push("Kontakte konnten nicht gespeichert werden");
    }
  }

  if (input.budgets) {
    if (input.useLedgerBudgets) {
      const typeSettings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null }> = [];
      if (input.budgets.entlastungsbetrag45b > 0) {
        typeSettings.push({ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: input.budgets.entlastungsbetrag45b });
      }
      if (input.budgets.pflegesachleistungen36 > 0) {
        typeSettings.push({ budgetType: "umwandlung_45a", enabled: true, priority: 2, monthlyLimitCents: input.budgets.pflegesachleistungen36 });
      }
      if (input.budgets.verhinderungspflege39 > 0) {
        typeSettings.push({ budgetType: "ersatzpflege_39_42a", enabled: true, priority: 3, yearlyLimitCents: input.budgets.verhinderungspflege39 });
      }

      // Pflicht: Budget-Type-Settings. Ohne diese kann der §45b-Pfad weder
      // monatliche Auto-Allokation noch Carryover korrekt berechnen.
      if (typeSettings.length > 0) {
        maybeFail("budget_settings", testFaults);
        await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, typeSettings, tx);
      }

      // Soft: Carryover-Sync. Best-Effort — bei Fehler weiter, aber als
      // Warning hochgereicht.
      if (typeSettings.length > 0) {
        try {
          await budgetLedgerStorage.syncCarryoverAndExpiry(customerId, tx);
        } catch (err) {
          console.error(`[${logPrefix}] Budget-Sync fehlgeschlagen für Kunde ${customerId}:`, err);
        }
      }

      // Soft: Carryover-Allocation aus Vorjahr. Bleibt als Warning
      // tolerierbar, weil der Customer ohne Carryover funktional weiter
      // nutzbar ist (manueller Nachtrag später möglich).
      if (input.budgets.carryoverAmountCents && input.budgets.carryoverAmountCents > 0) {
        try {
          maybeFail("carryover", testFaults);
          const validFrom = input.budgets.validFrom || todayISO();
          const validFromDate = parseLocalDate(validFrom);
          const currentYear = validFromDate.getFullYear();
          // validFrom des Carryover wird auf Jahresanfang gesetzt, damit
          // rückwirkende Buchungen/Importe im Stichjahr den Übertrag sehen
          // (Task #116). Andernfalls wäre der Übertrag für Monate VOR dem
          // Anlagedatum unsichtbar und würde Monatscap-Kürzungen erzeugen.
          await budgetLedgerStorage.createBudgetAllocation({
            customerId,
            budgetType: "entlastungsbetrag_45b",
            year: currentYear - 1,
            month: null,
            amountCents: input.budgets.carryoverAmountCents,
            source: "carryover",
            validFrom: `${currentYear}-01-01`,
            expiresAt: `${currentYear}-06-30`,
            notes: `Übertrag aus ${currentYear - 1}`,
          }, userId, tx);
        } catch (err) {
          console.error(`[${logPrefix}] Carryover-Allocation fehlgeschlagen für Kunde ${customerId}:`, err);
          warnings.push("Übertrag aus Vorjahr konnte nicht gespeichert werden");
        }
      }
    } else {
      // Pflicht (Legacy-Pfad in prospects.ts): Budget-Eintrag in
      // customer_budgets. Hard-Fail aus demselben Grund wie oben.
      maybeFail("budget_settings", testFaults);
      await customerManagementStorage.addCustomerBudget({
        customerId,
        entlastungsbetrag45b: input.budgets.entlastungsbetrag45b,
        verhinderungspflege39: input.budgets.verhinderungspflege39,
        pflegesachleistungen36: input.budgets.pflegesachleistungen36,
        validFrom: input.budgets.validFrom,
      }, userId, tx);
    }
  }

  // Pflicht: Vertrag + Raten. Ohne Vertrag und Raten schlagen
  // Termin-Anlage und Rechnungslauf später unerwartet fehl.
  if (input.contract) {
    maybeFail("contract", testFaults);
    const contract = await customerManagementStorage.createCustomerContract({
      customerId,
      contractStart: input.contract.contractStart,
      contractDate: input.contract.contractDate || null,
      vereinbarteLeistungen: input.contract.vereinbarteLeistungen || null,
      hoursPerPeriod: input.contract.hoursPerPeriod,
      periodType: input.contract.periodType as "week" | "month" | "year",
      status: "active",
    }, userId, tx);

    if (input.contract.rates && input.contract.rates.length > 0 && input.useLedgerBudgets) {
      for (const rate of input.contract.rates) {
        await customerManagementStorage.addContractRate({
          contractId: contract.id,
          serviceCategory: rate.serviceCategory as "hauswirtschaft" | "alltagsbegleitung" | "erstberatung",
          hourlyRateCents: rate.hourlyRateCents,
          validFrom: input.contract!.contractStart,
        }, userId, tx);
      }
    }
  }

  return warnings;
}
