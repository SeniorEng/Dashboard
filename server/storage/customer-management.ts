import {
  type Customer,
  type InsuranceProvider,
  type InsertInsuranceProvider,
  type CustomerInsuranceHistory,
  type InsertCustomerInsurance,
  type CustomerContact,
  type InsertCustomerContact,
  type CustomerCareLevelHistory,
  type InsertCareLevelHistory,
  type CustomerNeedsAssessment,
  type InsertNeedsAssessment,
  type CustomerBudget,
  type InsertCustomerBudget,
  type CustomerContract,
  type InsertCustomerContract,
  type CustomerContractRate,
  type InsertContractRate,
  type ServiceRate,
  type InsertServiceRate,
  type CustomerWithDetails,
  type CreateFullCustomer,
  customers,
  customerInsuranceHistory,
  customerContracts,
  customerContractRates,
  customerContacts,
  customerBudgets,
  customerNeedsAssessments,
  customerCareLevelHistory,
  users,
  customerAssignmentHistory,
} from "@shared/schema";
import { eq, and, isNull, isNotNull, desc, count, or, ilike, sql as sqlBuilder } from "drizzle-orm";
import { customerIdsCache } from "../services/cache";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../lib/db";

import * as insuranceModule from "./customer-mgmt/insurance";
import * as contactsModule from "./customer-mgmt/contacts";
import * as careLevelModule from "./customer-mgmt/care-level";
import * as budgetsModule from "./customer-mgmt/budgets";
import * as contractsModule from "./customer-mgmt/contracts";

export interface CustomerListFilters {
  search?: string;
  pflegegrad?: number;
  primaryEmployeeId?: number;
  hasActiveContract?: boolean;
  status?: string;
  billingType?: string;
}

export interface PaginationOptions {
  limit?: number;
  offset?: number;
}

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CustomerListItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  email: string | null;
  telefon: string | null;
  pflegegrad: number | null;
  address: string;
  stadt: string | null;
  status: string;
  billingType: string;
  primaryEmployee: { id: number; displayName: string } | null;
  hasActiveContract: boolean;
  createdAt: Date;
}

export class CustomerManagementStorage {
  getInsuranceProviders = insuranceModule.getInsuranceProviders;
  getInsuranceProvider = insuranceModule.getInsuranceProvider;
  getInsuranceProviderByIK = insuranceModule.getInsuranceProviderByIK;
  createInsuranceProvider = insuranceModule.createInsuranceProvider;
  updateInsuranceProvider = insuranceModule.updateInsuranceProvider;
  getActiveCustomerCountForProvider = insuranceModule.getActiveCustomerCountForProvider;
  getCustomerCurrentInsurance = insuranceModule.getCustomerCurrentInsurance;
  getCustomerInsuranceHistory = insuranceModule.getCustomerInsuranceHistory;
  addCustomerInsurance = insuranceModule.addCustomerInsurance;

  getCustomerContacts = contactsModule.getCustomerContacts;
  addCustomerContact = contactsModule.addCustomerContact;
  updateCustomerContact = contactsModule.updateCustomerContact;
  deleteCustomerContact = contactsModule.deleteCustomerContact;

  getCustomerCareLevelHistory = careLevelModule.getCustomerCareLevelHistory;
  getCustomerCurrentCareLevel = careLevelModule.getCustomerCurrentCareLevel;
  addCareLevelHistory = careLevelModule.addCareLevelHistory;
  getCustomerNeedsAssessment = careLevelModule.getCustomerNeedsAssessment;
  updateNeedsAssessment = careLevelModule.updateNeedsAssessment;
  createNeedsAssessment = careLevelModule.createNeedsAssessment;

  updateCustomerContract = contractsModule.updateCustomerContract;

  getCustomerCurrentBudget = budgetsModule.getCustomerCurrentBudget;
  getCustomerBudgetHistory = budgetsModule.getCustomerBudgetHistory;
  addCustomerBudget = budgetsModule.addCustomerBudget;

  getCustomerCurrentContract = contractsModule.getCustomerCurrentContract;
  createCustomerContract = contractsModule.createCustomerContract;
  addContractRate = contractsModule.addContractRate;
  getCurrentServiceRates = contractsModule.getCurrentServiceRates;
  addServiceRate = contractsModule.addServiceRate;

  async getCustomersPaginated(
    filters?: CustomerListFilters,
    options?: PaginationOptions
  ): Promise<PaginatedResult<CustomerListItem>> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    let baseConditions: any[] = [isNull(customers.deletedAt)];
    
    if (filters?.search) {
      const searchTerm = `%${filters.search}%`;
      baseConditions.push(
        or(
          ilike(customers.name, searchTerm),
          ilike(customers.vorname, searchTerm),
          ilike(customers.nachname, searchTerm),
          ilike(customers.email, searchTerm),
          ilike(customers.telefon, searchTerm),
          ilike(customers.strasse, searchTerm),
          ilike(customers.stadt, searchTerm)
        )
      );
    }
    
    if (filters?.pflegegrad) {
      baseConditions.push(eq(customers.pflegegrad, filters.pflegegrad));
    }
    
    if (filters?.primaryEmployeeId) {
      baseConditions.push(eq(customers.primaryEmployeeId, filters.primaryEmployeeId));
    }

    if (filters?.status) {
      baseConditions.push(eq(customers.status, filters.status));
    }

    if (filters?.billingType) {
      baseConditions.push(eq(customers.billingType, filters.billingType));
    }

    const activeContractSubquery = db
      .select({ 
        customerId: customerContracts.customerId,
        hasContract: sqlBuilder<boolean>`true`.as('has_contract')
      })
      .from(customerContracts)
      .where(eq(customerContracts.status, "active"))
      .groupBy(customerContracts.customerId)
      .as('active_contracts');

    let fullConditions = [...baseConditions];
    if (filters?.hasActiveContract === true) {
      fullConditions.push(isNotNull(activeContractSubquery.customerId));
    } else if (filters?.hasActiveContract === false) {
      fullConditions.push(isNull(activeContractSubquery.customerId));
    }
    const fullWhereClause = fullConditions.length > 0 ? and(...fullConditions) : undefined;

    const countQuery = db
      .select({ count: count() })
      .from(customers)
      .leftJoin(activeContractSubquery, eq(customers.id, activeContractSubquery.customerId))
      .where(fullWhereClause);
    
    const countResult = await countQuery;
    const total = Number(countResult[0]?.count ?? 0);

    const result = await db
      .select({
        id: customers.id,
        name: customers.name,
        vorname: customers.vorname,
        nachname: customers.nachname,
        email: customers.email,
        telefon: customers.telefon,
        pflegegrad: customers.pflegegrad,
        address: customers.address,
        stadt: customers.stadt,
        status: customers.status,
        billingType: customers.billingType,
        createdAt: customers.createdAt,
        primaryEmployeeId: customers.primaryEmployeeId,
        primaryEmployeeName: users.displayName,
        hasActiveContract: activeContractSubquery.hasContract,
      })
      .from(customers)
      .leftJoin(users, eq(customers.primaryEmployeeId, users.id))
      .leftJoin(activeContractSubquery, eq(customers.id, activeContractSubquery.customerId))
      .where(fullWhereClause)
      .orderBy(desc(customers.createdAt))
      .limit(limit)
      .offset(offset);

    const data: CustomerListItem[] = result.map((r) => ({
      id: r.id,
      name: r.name,
      vorname: r.vorname,
      nachname: r.nachname,
      email: r.email,
      telefon: r.telefon,
      pflegegrad: r.pflegegrad,
      address: r.address,
      stadt: r.stadt,
      status: r.status,
      billingType: r.billingType,
      primaryEmployee: r.primaryEmployeeId && r.primaryEmployeeName 
        ? { id: r.primaryEmployeeId, displayName: r.primaryEmployeeName }
        : null,
      hasActiveContract: r.hasActiveContract === true,
      createdAt: r.createdAt,
    }));

    return { data, total, limit, offset };
  }

  async getCustomerWithDetails(customerId: number): Promise<CustomerWithDetails | undefined> {
    const customerResult = await db.select().from(customers).where(eq(customers.id, customerId));
    if (customerResult.length === 0) return undefined;
    
    const customer = customerResult[0];

    const [
      insurance,
      contacts,
      careLevelHistory,
      needsAssessment,
      budget,
      contract,
      primaryEmployee,
      backupEmployee,
    ] = await Promise.all([
      this.getCustomerCurrentInsurance(customerId),
      this.getCustomerContacts(customerId),
      this.getCustomerCareLevelHistory(customerId),
      this.getCustomerNeedsAssessment(customerId),
      this.getCustomerCurrentBudget(customerId),
      this.getCustomerCurrentContract(customerId),
      customer.primaryEmployeeId 
        ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, customer.primaryEmployeeId)).then(r => r[0])
        : Promise.resolve(undefined),
      customer.backupEmployeeId
        ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, customer.backupEmployeeId)).then(r => r[0])
        : Promise.resolve(undefined),
    ]);

    return {
      ...customer,
      insurance,
      contacts,
      careLevelHistory,
      needsAssessment: needsAssessment ?? undefined,
      budget: budget ?? undefined,
      contract: contract ?? undefined,
      primaryEmployee,
      backupEmployee,
    };
  }

  async createFullCustomer(data: CreateFullCustomer, userId: number): Promise<Customer> {
    return await db.transaction(async (tx) => {
      const customerData = {
        name: `${data.nachname}, ${data.vorname}`,
        vorname: data.vorname,
        nachname: data.nachname,
        email: data.email,
        festnetz: data.festnetz,
        telefon: data.mobiltelefon,
        geburtsdatum: data.geburtsdatum,
        address: `${data.strasse} ${data.hausnummer}, ${data.plz} ${data.stadt}`,
        strasse: data.strasse,
        nr: data.hausnummer,
        plz: data.plz,
        stadt: data.stadt,
        pflegegrad: data.pflegegrad,
        createdByUserId: userId,
      };
      
      const customerResult = await tx.insert(customers).values(customerData).returning();
      const customer = customerResult[0];

      await tx.insert(customerInsuranceHistory).values({
        customerId: customer.id,
        insuranceProviderId: data.insuranceProviderId,
        versichertennummer: data.versichertennummer,
        validFrom: todayISO(),
        createdByUserId: userId,
      } as typeof customerInsuranceHistory.$inferInsert);

      await tx.insert(customerContacts).values({
        customerId: customer.id,
        contactType: data.primaryContact.contactType,
        isPrimary: true,
        vorname: data.primaryContact.vorname,
        nachname: data.primaryContact.nachname,
        telefon: data.primaryContact.telefon,
        sortOrder: 0,
      });

      let sortOrder = 1;
      for (const contact of data.additionalContacts || []) {
        await tx.insert(customerContacts).values({
          customerId: customer.id,
          contactType: contact.contactType,
          isPrimary: false,
          vorname: contact.vorname,
          nachname: contact.nachname,
          telefon: contact.telefon,
          sortOrder: sortOrder++,
        });
      }

      await tx.insert(customerCareLevelHistory).values({
        customerId: customer.id,
        pflegegrad: data.pflegegrad,
        pflegegradBeantragt: data.pflegegradBeantragt,
        validFrom: data.pflegegradSeit,
        createdByUserId: userId,
      } as typeof customerCareLevelHistory.$inferInsert);

      const services = data.services || {};
      await tx.insert(customerNeedsAssessments).values({
        customerId: customer.id,
        assessmentDate: todayISO(),
        householdSize: data.householdSize,
        pflegedienstBeauftragt: data.pflegedienstBeauftragt,
        anamnese: data.anamnese,
        serviceHaushaltHilfe: services.haushaltHilfe,
        serviceMahlzeiten: services.mahlzeiten,
        serviceReinigung: services.reinigung,
        serviceWaeschePflege: services.waeschePflege,
        serviceEinkauf: services.einkauf,
        serviceTagesablauf: services.tagesablauf,
        serviceAlltagsverrichtungen: services.alltagsverrichtungen,
        serviceTerminbegleitung: services.terminbegleitung,
        serviceBotengaenge: services.botengaenge,
        serviceGrundpflege: services.grundpflege,
        serviceFreizeitbegleitung: services.freizeitbegleitung,
        serviceDemenzbetreuung: services.demenzbetreuung,
        serviceGesellschaft: services.gesellschaft,
        serviceSozialeKontakte: services.sozialeKontakte,
        serviceFreizeitgestaltung: services.freizeitgestaltung,
        serviceKreativ: services.kreativ,
        sonstigeLeistungen: data.sonstigeLeistungen,
        createdByUserId: userId,
      });

      await tx.insert(customerBudgets).values({
        customerId: customer.id,
        entlastungsbetrag45b: Math.round(data.entlastungsbetrag45b * 100),
        verhinderungspflege39: Math.round(data.verhinderungspflege39 * 100),
        pflegesachleistungen36: Math.round(data.pflegesachleistungen36 * 100),
        validFrom: todayISO(),
        createdByUserId: userId,
      });

      await tx.insert(customerContracts).values({
        customerId: customer.id,
        contractStart: data.contractStart || todayISO(),
        hoursPerPeriod: data.contractHours,
        periodType: data.contractPeriod,
        hauswirtschaftRateCents: Math.round((data.hauswirtschaftRate ?? 0) * 100),
        alltagsbegleitungRateCents: Math.round((data.alltagsbegleitungRate ?? 0) * 100),
        kilometerRateCents: Math.round((data.kilometerRate ?? 0) * 100),
        status: "active",
        createdByUserId: userId,
      });

      return customer;
    });
  }

  async updateCustomer(id: number, data: Partial<{
    vorname: string;
    nachname: string;
    geburtsdatum: string | null;
    email: string | null;
    festnetz: string | null;
    telefon: string | null;
    strasse: string;
    nr: string;
    plz: string;
    stadt: string;
    status: string;
    billingType: string;
    primaryEmployeeId: number | null;
    backupEmployeeId: number | null;
    vorerkrankungen: string | null;
    haustierVorhanden: boolean;
    haustierDetails: string | null;
    acceptsPrivatePayment: boolean;
    personenbefoerderungGewuenscht: boolean;
    documentDeliveryMethod: string;
    inaktivAb: string | null;
    deactivationReason: string | null;
    deactivationNote: string | null;
  }>): Promise<Customer | undefined> {
    return await db.transaction(async (tx) => {
    const updateData: any = { ...data, updatedAt: new Date() };
    
    const existing = await tx.select().from(customers).where(eq(customers.id, id)).for("update");
    if (existing.length === 0) return undefined;
    
    const oldCustomer = existing[0];
    
    if (data.vorname !== undefined || data.nachname !== undefined) {
      const newVorname = data.vorname ?? oldCustomer.vorname ?? '';
      const newNachname = data.nachname ?? oldCustomer.nachname ?? '';
      updateData.name = `${newNachname}, ${newVorname}`;
    }
    
    if (data.strasse !== undefined || data.nr !== undefined || data.plz !== undefined || data.stadt !== undefined) {
      const newStrasse = data.strasse ?? oldCustomer.strasse ?? '';
      const newNr = data.nr ?? oldCustomer.nr ?? '';
      const newPlz = data.plz ?? oldCustomer.plz ?? '';
      const newStadt = data.stadt ?? oldCustomer.stadt ?? '';
      updateData.address = `${newStrasse} ${newNr}, ${newPlz} ${newStadt}`;
    }
    
    const result = await tx.update(customers).set(updateData).where(eq(customers.id, id)).returning();
    const updated = result[0];
    
    if (data.primaryEmployeeId !== undefined || data.backupEmployeeId !== undefined) {
      const today = todayISO();

      if (data.primaryEmployeeId !== undefined && oldCustomer.primaryEmployeeId !== data.primaryEmployeeId) {
        if (oldCustomer.primaryEmployeeId) {
          await tx.update(customerAssignmentHistory)
            .set({ validTo: today })
            .where(and(
              eq(customerAssignmentHistory.customerId, id),
              eq(customerAssignmentHistory.employeeId, oldCustomer.primaryEmployeeId),
              eq(customerAssignmentHistory.role, "primary"),
              isNull(customerAssignmentHistory.validTo)
            ));
        }
        if (data.primaryEmployeeId) {
          await tx.insert(customerAssignmentHistory).values({
            customerId: id,
            employeeId: data.primaryEmployeeId,
            role: "primary",
            validFrom: today,
          });
        }
      }

      if (data.backupEmployeeId !== undefined && oldCustomer.backupEmployeeId !== data.backupEmployeeId) {
        if (oldCustomer.backupEmployeeId) {
          await tx.update(customerAssignmentHistory)
            .set({ validTo: today })
            .where(and(
              eq(customerAssignmentHistory.customerId, id),
              eq(customerAssignmentHistory.employeeId, oldCustomer.backupEmployeeId),
              eq(customerAssignmentHistory.role, "backup"),
              isNull(customerAssignmentHistory.validTo)
            ));
        }
        if (data.backupEmployeeId) {
          await tx.insert(customerAssignmentHistory).values({
            customerId: id,
            employeeId: data.backupEmployeeId,
            role: "backup",
            validFrom: today,
          });
        }
      }

      customerIdsCache.invalidateForCustomer(oldCustomer.primaryEmployeeId, oldCustomer.backupEmployeeId);
      customerIdsCache.invalidateForCustomer(updated.primaryEmployeeId, updated.backupEmployeeId);
    }
    
    return updated;
    });
  }

  async updateCustomerAssignment(
    customerId: number,
    primaryEmployeeId: number | null,
    backupEmployeeId: number | null,
    changedByUserId?: number
  ) {
    const { customerIdsCache } = await import("../services/cache");
    const today = todayISO();
    
    const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
    
    if (existing) {
      if (existing.primaryEmployeeId !== primaryEmployeeId) {
        if (existing.primaryEmployeeId) {
          await db.update(customerAssignmentHistory)
            .set({ validTo: today })
            .where(and(
              eq(customerAssignmentHistory.customerId, customerId),
              eq(customerAssignmentHistory.employeeId, existing.primaryEmployeeId),
              eq(customerAssignmentHistory.role, "primary"),
              isNull(customerAssignmentHistory.validTo)
            ));
        }
        if (primaryEmployeeId) {
          await db.insert(customerAssignmentHistory).values({
            customerId,
            employeeId: primaryEmployeeId,
            role: "primary",
            validFrom: today,
            changedByUserId: changedByUserId ?? null,
          });
        }
      }

      if (existing.backupEmployeeId !== backupEmployeeId) {
        if (existing.backupEmployeeId) {
          await db.update(customerAssignmentHistory)
            .set({ validTo: today })
            .where(and(
              eq(customerAssignmentHistory.customerId, customerId),
              eq(customerAssignmentHistory.employeeId, existing.backupEmployeeId),
              eq(customerAssignmentHistory.role, "backup"),
              isNull(customerAssignmentHistory.validTo)
            ));
        }
        if (backupEmployeeId) {
          await db.insert(customerAssignmentHistory).values({
            customerId,
            employeeId: backupEmployeeId,
            role: "backup",
            validFrom: today,
            changedByUserId: changedByUserId ?? null,
          });
        }
      }
    }

    const [updated] = await db
      .update(customers)
      .set({ primaryEmployeeId, backupEmployeeId })
      .where(eq(customers.id, customerId))
      .returning();

    if (existing) {
      customerIdsCache.invalidateForCustomer(existing.primaryEmployeeId, existing.backupEmployeeId);
    }
    customerIdsCache.invalidateForCustomer(primaryEmployeeId, backupEmployeeId);

    return updated;
  }

  async createCustomerDirect(customerData: any) {
    const [customer] = await db.insert(customers).values(customerData).returning();
    return customer;
  }
}

export const customerManagementStorage = new CustomerManagementStorage();
