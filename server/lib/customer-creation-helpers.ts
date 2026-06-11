import { customerManagementStorage } from "../storage/customer-management";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { todayISO } from "@shared/utils/datetime";
import type { Customer, InsertCustomer, CustomerInsuranceHistory, InsuranceProvider } from "@shared/schema";
import type { DbOrTx } from "./db";
import type { DbClient } from "../storage/budget/types";
import { maybeFail } from "./test-fault-injector";
import { applyInitialBudget } from "../services/budget-initial-setup";
import { generateAndStorePdf } from "../services/document-pdf";
import { buildPlaceholdersFromCustomer } from "../services/template-engine";
import { documentStorage } from "../storage/documents";
import { getInsuranceProvider } from "../storage/customer-mgmt/insurance";

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
  rechnungAnKunde?: boolean;
  beihilfeBerechtigt?: boolean;
  receivesMonthlyInvoice?: boolean;
  documentDeliveryMethod?: string;
  billingType: string;
  primaryEmployeeId?: number | null;
  backupEmployeeId?: number | null;
  backupEmployeeId2?: number | null;
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
    rechnungAnKunde: data.rechnungAnKunde ?? false,
    beihilfeBerechtigt: data.beihilfeBerechtigt ?? false,
    receivesMonthlyInvoice: data.receivesMonthlyInvoice ?? false,
    billingType: data.billingType,
    createdByUserId,
    primaryEmployeeId: data.primaryEmployeeId ?? null,
    backupEmployeeId: data.backupEmployeeId ?? null,
    backupEmployeeId2: data.backupEmployeeId2 ?? null,
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
  /** §45b-Restguthaben-Override (laufendes Jahr) als initial_balance, Cents. */
  override45bCents?: number;
  /** Stichmonat-Start (`YYYY-MM-01`) für den §45b-Override; null = kein Override. */
  override45bStichmonatStart?: string | null;
}

interface SignatureInput {
  templateSlug: string;
  customerSignatureData: string;
}

interface DocumentInput {
  documentTypeId: number;
  fileName: string;
  objectPath: string;
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
  /** Abrechnungsart des Kunden — für die Budget-Intent-Validierung nötig. */
  billingType?: string | null;
  pflegegrad?: number | null;
  pflegegradSeit?: string;
  insurance?: InsuranceInput;
  contacts?: ContactInput[];
  budgets?: BudgetInput;
  contract?: ContractInput;
  /**
   * Bereits angelegter Kunden-Datensatz (innerhalb derselben Tx erzeugt). Wird
   * für den Aufbau der Unterschrifts-/Dokument-Platzhalter via
   * `buildPlaceholdersFromCustomer` benötigt — ohne erneuten (uncommitted) Read.
   */
  customer?: Customer;
  /** Unterschriften (Template-Slug + Signatur-Bild) — generieren PDFs in der Tx. */
  signatures?: SignatureInput[];
  /** Unterschriftsort (gemeinsam für alle Unterschriften). */
  signingLocation?: string | null;
  /** IP für das Signatur-Audit (optional). */
  signingIp?: string | null;
  /** Bereits ins Object-Storage hochgeladene Dokumente — Metadaten in die Tx. */
  documents?: DocumentInput[];
  /**
   * Optionale äußere Transaktion. Wenn gesetzt, laufen alle Pflicht-Cascade-
   * Schritte (Pflegegrad, Insurance, Budget-Type-Settings, Vertrag/Raten,
   * Startbudgets, Unterschriften, Dokumente) darin und werfen bei Fehler hart,
   * sodass die Transaktion zurückrollt.
   * Soft-Schritte (Kontakte, syncCarryoverAndExpiry) werden weiter mit
   * try/catch eingefangen und tauchen nur als Warnings auf.
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
    {
      const typeSettings: Array<{ budgetType: string; enabled: boolean; priority: number; monthlyLimitCents?: number | null; yearlyLimitCents?: number | null }> = [];
      if (input.budgets.entlastungsbetrag45b > 0) {
        // §45b ist seit Task #425 ein Jahrestopf ohne Monats-Cap. Der vom
        // Wizard gesendete Eurobetrag dient nur noch als Enable-Signal —
        // monthlyLimitCents bleibt explizit null.
        typeSettings.push({ budgetType: "entlastungsbetrag_45b", enabled: true, priority: 1, monthlyLimitCents: null });
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
        await budgetLedgerStorage.upsertBudgetTypeSettings(customerId, typeSettings, tx, userId);
      }

      // Pflicht (Task #1213): Carryover-/Verfalls-Sync ist Teil der atomaren
      // Anlage. Schlägt er fehl, rollt die gesamte Transaktion zurück (kein
      // Soft-Fail/Warning mehr) — der Kunde wird sonst mit inkonsistentem
      // §45b-Carryover persistiert.
      if (typeSettings.length > 0) {
        maybeFail("carryover", testFaults);
        await budgetLedgerStorage.syncCarryoverAndExpiry(customerId, tx);
      }

      // Pflicht: Startbudgets pro Topf — gefaltet aus dem früheren separaten
      // Frontend-Aufruf `POST /budget/:id/initial-budget`. Läuft jetzt INNERHALB
      // der Anlage-Transaktion über die SSoT `applyInitialBudget` (typisierte
      // Fehler → Rollback, kein Orphan-Customer). §45b-Kappung, Selbstzahler-/
      // Pflegegrad-Validierung und der RAW-Anker liegen dort zentral.
      //
      // Reihenfolge §45b → §45a → §39: `applyInitialBudget` schreibt jeweils die
      // Anker-Preferences (last-write-wins). §45b nutzt ggf. den Stichmonat als
      // Anker, §45a/§39 den `budgetStart` — durch die Reihenfolge endet der
      // persistierte Anker beim `budgetStart` (Pflegegrad-Beginn), identisch
      // zum bisherigen Frontend-Verhalten.
      const budgetStart = input.pflegegradSeit || todayISO();
      const customerForBudget = { billingType: input.billingType, pflegegrad: input.pflegegrad };
      const carryover = input.budgets.carryoverAmountCents ?? 0;

      if (input.budgets.entlastungsbetrag45b > 0) {
        maybeFail("initial_budget", testFaults);
        await applyInitialBudget({
          customerId,
          budgetType: "entlastungsbetrag_45b",
          // §45b: nur der aktive Restguthaben-Override bucht ein initial_balance;
          // sonst 0 (rein auto-renewal-getrieben), Carryover + Anker via Preferences.
          currentMonthAmountCents: input.budgets.override45bCents ?? 0,
          carryoverAmountCents: carryover,
          budgetStartDate: input.budgets.override45bStichmonatStart || budgetStart,
          customer: customerForBudget,
          userId,
          tx,
        });
      }

      if (input.budgets.pflegesachleistungen36 > 0) {
        maybeFail("initial_budget", testFaults);
        await applyInitialBudget({
          customerId,
          budgetType: "umwandlung_45a",
          currentMonthAmountCents: input.budgets.pflegesachleistungen36,
          budgetStartDate: budgetStart,
          customer: customerForBudget,
          userId,
          tx,
        });
      }

      if (input.budgets.verhinderungspflege39 > 0) {
        maybeFail("initial_budget", testFaults);
        await applyInitialBudget({
          customerId,
          budgetType: "ersatzpflege_39_42a",
          currentMonthAmountCents: input.budgets.verhinderungspflege39,
          budgetStartDate: budgetStart,
          customer: customerForBudget,
          userId,
          tx,
        });
      }
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

    if (input.contract.rates && input.contract.rates.length > 0) {
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

  // Pflicht: Unterschriften + hochgeladene Dokumente — gefaltet aus den früheren
  // separaten Frontend-Aufrufen (`POST /customers/:id/signatures`,
  // `POST /customers/:id/documents`). Laufen jetzt INNERHALB der Anlage-Tx und
  // werfen bei Fehler hart → Rollback, kein Orphan-Customer. (Die Puppeteer-PDF-
  // Generierung läuft bewusst, während die Tx offen ist — akzeptierter Tradeoff.)
  if ((input.signatures && input.signatures.length > 0) || (input.documents && input.documents.length > 0)) {
    if (!input.customer) {
      throw new Error("Kunden-Datensatz für Unterschriften/Dokumente fehlt");
    }

    if (input.signatures && input.signatures.length > 0) {
      // Platzhalter EINMAL aus dem (noch nicht committeten) Kunden-Datensatz
      // aufbauen — kein erneuter `storage.getCustomer`, der die offene Tx nicht
      // sähe. Versicherung aus dem Anlage-Input auflösen (Provider = Stammdaten).
      let resolvedInsurance:
        | (Pick<CustomerInsuranceHistory, "versichertennummer"> & { provider: InsuranceProvider })
        | null = null;
      if (input.insurance) {
        const provider = await getInsuranceProvider(input.insurance.providerId);
        if (provider) {
          resolvedInsurance = { versichertennummer: input.insurance.versichertennummer, provider };
        }
      }
      const prebuiltPlaceholders = await buildPlaceholdersFromCustomer(input.customer, resolvedInsurance);

      for (const sig of input.signatures) {
        maybeFail("signatures", testFaults);
        const template = await documentStorage.getDocumentTemplateBySlug(sig.templateSlug);
        if (!template) {
          throw new Error(`Vorlage "${sig.templateSlug}" nicht gefunden`);
        }
        await generateAndStorePdf({
          template,
          customerId,
          customerSignatureData: sig.customerSignatureData,
          prebuiltPlaceholders,
          generatedByUserId: userId,
          signingStatus: "complete",
          signingIp: input.signingIp ?? null,
          signingLocation: input.signingLocation ?? null,
          tx,
        });
      }
    }

    if (input.documents && input.documents.length > 0) {
      for (const doc of input.documents) {
        maybeFail("documents", testFaults);
        await documentStorage.uploadCustomerDocument({
          customerId,
          documentTypeId: doc.documentTypeId,
          fileName: doc.fileName,
          objectPath: doc.objectPath,
        }, userId, { tx });
      }
    }
  }

  return warnings;
}
