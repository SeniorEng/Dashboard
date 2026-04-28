import { customerManagementStorage } from "../storage/customer-management";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { parseLocalDate, todayISO } from "@shared/utils/datetime";
import type { InsertCustomer } from "@shared/schema";

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
}

export async function createCustomerRelatedData(input: CreateRelatedDataInput): Promise<string[]> {
  const { customerId, userId, logPrefix } = input;
  const warnings: string[] = [];

  if (input.pflegegrad && input.pflegegradSeit) {
    try {
      await customerManagementStorage.addCareLevelHistory({
        customerId,
        pflegegrad: input.pflegegrad,
        validFrom: input.pflegegradSeit,
      }, userId);
    } catch (err) {
      console.error(`[${logPrefix}] Pflegegrad-Historie fehlgeschlagen für Kunde ${customerId}:`, err);
      warnings.push("Pflegegrad-Historie konnte nicht gespeichert werden");
    }
  }

  if (input.insurance) {
    try {
      await customerManagementStorage.addCustomerInsurance({
        customerId,
        insuranceProviderId: input.insurance.providerId,
        versichertennummer: input.insurance.versichertennummer,
        validFrom: input.insurance.validFrom,
      }, userId);
    } catch (err) {
      console.error(`[${logPrefix}] Versicherung fehlgeschlagen für Kunde ${customerId}:`, err);
      warnings.push("Versicherung konnte nicht gespeichert werden");
    }
  }

  if (input.contacts && input.contacts.length > 0) {
    try {
      await Promise.all(input.contacts.map((c, i) =>
        customerManagementStorage.addCustomerContact({
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
        })
      ));
    } catch (err) {
      console.error(`[${logPrefix}] Kontakte fehlgeschlagen für Kunde ${customerId}:`, err);
      warnings.push("Kontakte konnten nicht gespeichert werden");
    }
  }

  if (input.budgets) {
    try {
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
        if (typeSettings.length > 0) {
          try {
            await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, typeSettings);
          } catch (err) {
            console.error(`[${logPrefix}] Budget-Type-Settings fehlgeschlagen für Kunde ${customerId}:`, err);
            warnings.push("Budget-Einstellungen konnten nicht gespeichert werden");
          }
        }

        if (typeSettings.length > 0) {
          try {
            await budgetLedgerStorage.syncCarryoverAndExpiry(customerId);
          } catch (err) {
            console.error(`[${logPrefix}] Budget-Sync fehlgeschlagen für Kunde ${customerId}:`, err);
          }
        }

        if (input.budgets.carryoverAmountCents && input.budgets.carryoverAmountCents > 0) {
          try {
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
            }, userId);
          } catch (err) {
            console.error(`[${logPrefix}] Carryover-Allocation fehlgeschlagen für Kunde ${customerId}:`, err);
            warnings.push("Übertrag aus Vorjahr konnte nicht gespeichert werden");
          }
        }
      } else {
        await customerManagementStorage.addCustomerBudget({
          customerId,
          entlastungsbetrag45b: input.budgets.entlastungsbetrag45b,
          verhinderungspflege39: input.budgets.verhinderungspflege39,
          pflegesachleistungen36: input.budgets.pflegesachleistungen36,
          validFrom: input.budgets.validFrom,
        }, userId);
      }
    } catch (err) {
      console.error(`[${logPrefix}] Budgets fehlgeschlagen für Kunde ${customerId}:`, err);
      warnings.push("Budgets konnten nicht gespeichert werden");
    }
  }

  if (input.contract) {
    try {
      const contract = await customerManagementStorage.createCustomerContract({
        customerId,
        contractStart: input.contract.contractStart,
        contractDate: input.contract.contractDate || null,
        vereinbarteLeistungen: input.contract.vereinbarteLeistungen || null,
        hoursPerPeriod: input.contract.hoursPerPeriod,
        periodType: input.contract.periodType as "week" | "month" | "year",
        status: "active",
      }, userId);

      if (input.contract.rates && input.contract.rates.length > 0 && input.useLedgerBudgets) {
        await Promise.all(input.contract.rates.map(rate =>
          customerManagementStorage.addContractRate({
            contractId: contract.id,
            serviceCategory: rate.serviceCategory as "hauswirtschaft" | "alltagsbegleitung" | "erstberatung",
            hourlyRateCents: rate.hourlyRateCents,
            validFrom: input.contract!.contractStart,
          }, userId)
        ));
      }
    } catch (err) {
      console.error(`[${logPrefix}] Vertrag fehlgeschlagen für Kunde ${customerId}:`, err);
      warnings.push("Vertrag konnte nicht erstellt werden");
    }
  }

  return warnings;
}
