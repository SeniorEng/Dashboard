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
  insuranceProviders,
  customerInsuranceHistory,
  customerContacts,
  customerCareLevelHistory,
  customerNeedsAssessments,
  customerBudgets,
  customerContracts,
  customerContractRates,
  serviceRates,
  users,
  customerAssignmentHistory,
} from "@shared/schema";
import { eq, and, isNull, isNotNull, desc, count, or, ilike, sql as sqlBuilder } from "drizzle-orm";
import { customerIdsCache } from "../services/cache";
import { customerPricingStorage } from "./customer-pricing";
import { budgetLedgerStorage } from "./budget-ledger";
import { todayISO } from "@shared/utils/datetime";
import { db } from "../lib/db";

export interface CustomerListFilters {
  search?: string;
  pflegegrad?: number;
  primaryEmployeeId?: number;
  hasActiveContract?: boolean;
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
  primaryEmployee: { id: number; displayName: string } | null;
  hasActiveContract: boolean;
  createdAt: Date;
}

export class CustomerManagementStorage {
  // ============================================
  // INSURANCE PROVIDERS
  // ============================================

  async getInsuranceProviders(activeOnly = true): Promise<InsuranceProvider[]> {
    if (activeOnly) {
      return await db.select().from(insuranceProviders).where(eq(insuranceProviders.isActive, true));
    }
    return await db.select().from(insuranceProviders);
  }

  async getInsuranceProvider(id: number): Promise<InsuranceProvider | undefined> {
    const result = await db.select().from(insuranceProviders).where(eq(insuranceProviders.id, id));
    return result[0];
  }

  async getInsuranceProviderByIK(ikNummer: string): Promise<InsuranceProvider | undefined> {
    const result = await db.select().from(insuranceProviders).where(eq(insuranceProviders.ikNummer, ikNummer));
    return result[0];
  }

  async createInsuranceProvider(data: InsertInsuranceProvider): Promise<InsuranceProvider> {
    const result = await db.insert(insuranceProviders).values(data).returning();
    return result[0];
  }

  async updateInsuranceProvider(id: number, data: Partial<InsertInsuranceProvider>): Promise<InsuranceProvider | undefined> {
    const result = await db.update(insuranceProviders).set(data).where(eq(insuranceProviders.id, id)).returning();
    return result[0];
  }

  async getActiveCustomerCountForProvider(providerId: number): Promise<number> {
    const result = await db
      .select({ count: count() })
      .from(customerInsuranceHistory)
      .where(and(
        eq(customerInsuranceHistory.insuranceProviderId, providerId),
        isNull(customerInsuranceHistory.validTo)
      ));
    return Number(result[0]?.count ?? 0);
  }

  // ============================================
  // CUSTOMER INSURANCE HISTORY
  // ============================================

  async getCustomerCurrentInsurance(customerId: number): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider }) | undefined> {
    const result = await db
      .select({
        id: customerInsuranceHistory.id,
        customerId: customerInsuranceHistory.customerId,
        insuranceProviderId: customerInsuranceHistory.insuranceProviderId,
        versichertennummer: customerInsuranceHistory.versichertennummer,
        validFrom: customerInsuranceHistory.validFrom,
        validTo: customerInsuranceHistory.validTo,
        notes: customerInsuranceHistory.notes,
        createdAt: customerInsuranceHistory.createdAt,
        createdByUserId: customerInsuranceHistory.createdByUserId,
        provider: {
          id: insuranceProviders.id,
          name: insuranceProviders.name,
          ikNummer: insuranceProviders.ikNummer,
          strasse: insuranceProviders.strasse,
          hausnummer: insuranceProviders.hausnummer,
          plz: insuranceProviders.plz,
          stadt: insuranceProviders.stadt,
          telefon: insuranceProviders.telefon,
          email: insuranceProviders.email,
          empfaenger: insuranceProviders.empfaenger,
          empfaengerZeile2: insuranceProviders.empfaengerZeile2,
          emailInvoiceEnabled: insuranceProviders.emailInvoiceEnabled,
          zahlungsbedingungen: insuranceProviders.zahlungsbedingungen,
          zahlungsart: insuranceProviders.zahlungsart,
          isActive: insuranceProviders.isActive,
          createdAt: insuranceProviders.createdAt,
        },
      })
      .from(customerInsuranceHistory)
      .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
      .where(and(
        eq(customerInsuranceHistory.customerId, customerId),
        isNull(customerInsuranceHistory.validTo)
      ))
      .limit(1);
    
    if (result.length === 0) return undefined;
    return { ...result[0], provider: result[0].provider };
  }

  async getCustomerInsuranceHistory(customerId: number): Promise<(CustomerInsuranceHistory & { provider: InsuranceProvider })[]> {
    const result = await db
      .select({
        id: customerInsuranceHistory.id,
        customerId: customerInsuranceHistory.customerId,
        insuranceProviderId: customerInsuranceHistory.insuranceProviderId,
        versichertennummer: customerInsuranceHistory.versichertennummer,
        validFrom: customerInsuranceHistory.validFrom,
        validTo: customerInsuranceHistory.validTo,
        notes: customerInsuranceHistory.notes,
        createdAt: customerInsuranceHistory.createdAt,
        createdByUserId: customerInsuranceHistory.createdByUserId,
        provider: {
          id: insuranceProviders.id,
          name: insuranceProviders.name,
          ikNummer: insuranceProviders.ikNummer,
          strasse: insuranceProviders.strasse,
          hausnummer: insuranceProviders.hausnummer,
          plz: insuranceProviders.plz,
          stadt: insuranceProviders.stadt,
          telefon: insuranceProviders.telefon,
          email: insuranceProviders.email,
          empfaenger: insuranceProviders.empfaenger,
          empfaengerZeile2: insuranceProviders.empfaengerZeile2,
          emailInvoiceEnabled: insuranceProviders.emailInvoiceEnabled,
          zahlungsbedingungen: insuranceProviders.zahlungsbedingungen,
          zahlungsart: insuranceProviders.zahlungsart,
          isActive: insuranceProviders.isActive,
          createdAt: insuranceProviders.createdAt,
        },
      })
      .from(customerInsuranceHistory)
      .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
      .where(eq(customerInsuranceHistory.customerId, customerId))
      .orderBy(desc(customerInsuranceHistory.validFrom));
    
    return result.map(r => ({ ...r, provider: r.provider }));
  }

  async addCustomerInsurance(data: InsertCustomerInsurance, userId?: number): Promise<CustomerInsuranceHistory> {
    const today = todayISO();
    
    await db
      .update(customerInsuranceHistory)
      .set({ validTo: today })
      .where(and(
        eq(customerInsuranceHistory.customerId, data.customerId),
        isNull(customerInsuranceHistory.validTo)
      ));
    
    const result = await db.insert(customerInsuranceHistory).values({
      ...data,
      createdByUserId: userId,
    }).returning();
    
    return result[0];
  }

  // ============================================
  // CUSTOMER CONTACTS (Emergency Contacts)
  // ============================================

  async getCustomerContacts(customerId: number, activeOnly = true): Promise<CustomerContact[]> {
    const conditions = [eq(customerContacts.customerId, customerId)];
    if (activeOnly) {
      conditions.push(eq(customerContacts.isActive, true));
    }
    
    return await db
      .select()
      .from(customerContacts)
      .where(and(...conditions))
      .orderBy(desc(customerContacts.isPrimary), customerContacts.sortOrder);
  }

  async addCustomerContact(data: InsertCustomerContact): Promise<CustomerContact> {
    if (data.isPrimary) {
      await db
        .update(customerContacts)
        .set({ isPrimary: false })
        .where(eq(customerContacts.customerId, data.customerId));
    }
    
    const result = await db.insert(customerContacts).values(data).returning();
    return result[0];
  }

  async updateCustomerContact(id: number, data: Partial<InsertCustomerContact>): Promise<CustomerContact | undefined> {
    if (data.isPrimary) {
      const existing = await db.select().from(customerContacts).where(eq(customerContacts.id, id));
      if (existing.length > 0) {
        await db
          .update(customerContacts)
          .set({ isPrimary: false })
          .where(eq(customerContacts.customerId, existing[0].customerId));
      }
    }
    
    const result = await db
      .update(customerContacts)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(customerContacts.id, id))
      .returning();
    return result[0];
  }

  async deleteCustomerContact(id: number): Promise<boolean> {
    const result = await db
      .update(customerContacts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(customerContacts.id, id))
      .returning();
    return result.length > 0;
  }

  // ============================================
  // CARE LEVEL HISTORY
  // ============================================

  async getCustomerCareLevelHistory(customerId: number): Promise<CustomerCareLevelHistory[]> {
    return await db
      .select()
      .from(customerCareLevelHistory)
      .where(eq(customerCareLevelHistory.customerId, customerId))
      .orderBy(desc(customerCareLevelHistory.validFrom));
  }

  async getCustomerCurrentCareLevel(customerId: number): Promise<CustomerCareLevelHistory | undefined> {
    const result = await db
      .select()
      .from(customerCareLevelHistory)
      .where(and(
        eq(customerCareLevelHistory.customerId, customerId),
        isNull(customerCareLevelHistory.validTo)
      ))
      .limit(1);
    return result[0];
  }

  async addCareLevelHistory(data: InsertCareLevelHistory, userId?: number): Promise<CustomerCareLevelHistory> {
    const today = todayISO();
    
    await db
      .update(customerCareLevelHistory)
      .set({ validTo: today })
      .where(and(
        eq(customerCareLevelHistory.customerId, data.customerId),
        isNull(customerCareLevelHistory.validTo)
      ));
    
    const result = await db.insert(customerCareLevelHistory).values({
      ...data,
      createdByUserId: userId,
    }).returning();
    
    await db
      .update(customers)
      .set({ pflegegrad: data.pflegegrad, updatedAt: new Date() })
      .where(eq(customers.id, data.customerId));
    
    return result[0];
  }

  // ============================================
  // NEEDS ASSESSMENTS
  // ============================================

  async getCustomerNeedsAssessment(customerId: number): Promise<CustomerNeedsAssessment | undefined> {
    const result = await db
      .select()
      .from(customerNeedsAssessments)
      .where(eq(customerNeedsAssessments.customerId, customerId))
      .orderBy(desc(customerNeedsAssessments.assessmentDate))
      .limit(1);
    return result[0];
  }

  async createNeedsAssessment(data: InsertNeedsAssessment, userId?: number): Promise<CustomerNeedsAssessment> {
    const result = await db.insert(customerNeedsAssessments).values({
      ...data,
      createdByUserId: userId,
    }).returning();
    return result[0];
  }

  // ============================================
  // BUDGETS
  // ============================================

  async getCustomerCurrentBudget(customerId: number): Promise<CustomerBudget | undefined> {
    const result = await db
      .select()
      .from(customerBudgets)
      .where(and(
        eq(customerBudgets.customerId, customerId),
        isNull(customerBudgets.validTo)
      ))
      .limit(1);
    return result[0];
  }

  async getCustomerBudgetHistory(customerId: number): Promise<CustomerBudget[]> {
    return await db
      .select()
      .from(customerBudgets)
      .where(eq(customerBudgets.customerId, customerId))
      .orderBy(desc(customerBudgets.validFrom));
  }

  async addCustomerBudget(data: InsertCustomerBudget, userId?: number): Promise<CustomerBudget> {
    const today = todayISO();
    
    await db
      .update(customerBudgets)
      .set({ validTo: today })
      .where(and(
        eq(customerBudgets.customerId, data.customerId),
        isNull(customerBudgets.validTo)
      ));
    
    const result = await db.insert(customerBudgets).values({
      ...data,
      createdByUserId: userId,
    }).returning();
    
    return result[0];
  }

  // ============================================
  // CONTRACTS
  // ============================================

  async getCustomerCurrentContract(customerId: number): Promise<(CustomerContract & { rates: CustomerContractRate[] }) | undefined> {
    const contractResult = await db
      .select()
      .from(customerContracts)
      .where(and(
        eq(customerContracts.customerId, customerId),
        eq(customerContracts.status, "active")
      ))
      .limit(1);
    
    if (contractResult.length === 0) return undefined;
    
    const contract = contractResult[0];
    const rates = await db
      .select()
      .from(customerContractRates)
      .where(and(
        eq(customerContractRates.contractId, contract.id),
        isNull(customerContractRates.validTo)
      ));
    
    return { ...contract, rates };
  }

  async createCustomerContract(data: InsertCustomerContract, userId?: number): Promise<CustomerContract> {
    const result = await db.insert(customerContracts).values({
      ...data,
      createdByUserId: userId,
    }).returning();
    return result[0];
  }

  async addContractRate(data: InsertContractRate, userId?: number): Promise<CustomerContractRate> {
    const today = todayISO();
    
    await db
      .update(customerContractRates)
      .set({ validTo: today })
      .where(and(
        eq(customerContractRates.contractId, data.contractId),
        eq(customerContractRates.serviceCategory, data.serviceCategory),
        isNull(customerContractRates.validTo)
      ));
    
    const result = await db.insert(customerContractRates).values({
      ...data,
      createdByUserId: userId,
    }).returning();
    
    return result[0];
  }

  // ============================================
  // SERVICE RATES (Company-wide defaults)
  // ============================================

  async getCurrentServiceRates(): Promise<ServiceRate[]> {
    return await db
      .select()
      .from(serviceRates)
      .where(isNull(serviceRates.validTo));
  }

  async addServiceRate(data: InsertServiceRate, userId?: number): Promise<ServiceRate> {
    const today = todayISO();
    
    await db
      .update(serviceRates)
      .set({ validTo: today })
      .where(and(
        eq(serviceRates.serviceCategory, data.serviceCategory),
        isNull(serviceRates.validTo)
      ));
    
    const result = await db.insert(serviceRates).values({
      ...data,
      createdByUserId: userId,
    }).returning();
    
    return result[0];
  }

  // ============================================
  // CUSTOMER LIST WITH FILTERS
  // ============================================

  async getCustomersPaginated(
    filters?: CustomerListFilters,
    options?: PaginationOptions
  ): Promise<PaginatedResult<CustomerListItem>> {
    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;

    // Base where conditions (without hasActiveContract filter)
    let baseConditions: any[] = [];
    
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

    // Subquery to check for active contracts - avoids N+1 queries
    const activeContractSubquery = db
      .select({ 
        customerId: customerContracts.customerId,
        hasContract: sqlBuilder<boolean>`true`.as('has_contract')
      })
      .from(customerContracts)
      .where(eq(customerContracts.status, "active"))
      .groupBy(customerContracts.customerId)
      .as('active_contracts');

    // Build full where clause including hasActiveContract filter (applied after join)
    let fullConditions = [...baseConditions];
    if (filters?.hasActiveContract === true) {
      fullConditions.push(isNotNull(activeContractSubquery.customerId));
    } else if (filters?.hasActiveContract === false) {
      fullConditions.push(isNull(activeContractSubquery.customerId));
    }
    const fullWhereClause = fullConditions.length > 0 ? and(...fullConditions) : undefined;

    // Count query needs to join with subquery for accurate hasActiveContract filtering
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
      primaryEmployee: r.primaryEmployeeId && r.primaryEmployeeName 
        ? { id: r.primaryEmployeeId, displayName: r.primaryEmployeeName }
        : null,
      hasActiveContract: r.hasActiveContract === true,
      createdAt: r.createdAt,
    }));

    return { data, total, limit, offset };
  }

  // ============================================
  // CUSTOMER DETAILS (Full View)
  // ============================================

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
      pricingHistory,
      currentPricing,
      budgetSummary,
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
      customerPricingStorage.getPricingHistory(customerId),
      customerPricingStorage.getCurrentPricing(customerId),
      budgetLedgerStorage.getBudgetSummary(customerId),
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
      pricingHistory,
      currentPricing: currentPricing ?? undefined,
      budgetSummary,
    };
  }

  // ============================================
  // FULL CUSTOMER CREATION (Admin Form)
  // ============================================

  async createFullCustomer(data: CreateFullCustomer, userId: number): Promise<Customer> {
    let customerId: number | null = null;
    
    try {
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
      
      const customerResult = await db.insert(customers).values(customerData).returning();
      const customer = customerResult[0];
      customerId = customer.id;

      await this.addCustomerInsurance({
        customerId: customer.id,
        insuranceProviderId: data.insuranceProviderId,
        versichertennummer: data.versichertennummer,
        validFrom: todayISO(),
      }, userId);

      await this.addCustomerContact({
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
        await this.addCustomerContact({
          customerId: customer.id,
          contactType: contact.contactType,
          isPrimary: false,
          vorname: contact.vorname,
          nachname: contact.nachname,
          telefon: contact.telefon,
          sortOrder: sortOrder++,
        });
      }

      await db.insert(customerCareLevelHistory).values({
        customerId: customer.id,
        pflegegrad: data.pflegegrad,
        pflegegradBeantragt: data.pflegegradBeantragt,
        validFrom: data.pflegegradSeit,
        createdByUserId: userId,
      });

      const services = data.services || {};
      await this.createNeedsAssessment({
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
      }, userId);

      await this.addCustomerBudget({
        customerId: customer.id,
        entlastungsbetrag45b: Math.round(data.entlastungsbetrag45b * 100),
        verhinderungspflege39: Math.round(data.verhinderungspflege39 * 100),
        pflegesachleistungen36: Math.round(data.pflegesachleistungen36 * 100),
        validFrom: todayISO(),
      }, userId);

      await this.createCustomerContract({
        customerId: customer.id,
        contractStart: data.contractStart || todayISO(),
        hoursPerPeriod: data.contractHours,
        periodType: data.contractPeriod,
        hauswirtschaftRateCents: Math.round((data.hauswirtschaftRate ?? 0) * 100),
        alltagsbegleitungRateCents: Math.round((data.alltagsbegleitungRate ?? 0) * 100),
        kilometerRateCents: Math.round((data.kilometerRate ?? 0) * 100),
        status: "active",
      }, userId);

      return customer;
    } catch (error) {
      if (customerId) {
        await db.delete(customers).where(eq(customers.id, customerId)).catch(console.error);
      }
      throw error;
    }
  }

  // ============================================
  // CUSTOMER UPDATE (Basic fields)
  // ============================================

  async updateCustomer(id: number, data: Partial<{
    vorname: string;
    nachname: string;
    email: string | null;
    festnetz: string | null;
    telefon: string | null;
    strasse: string;
    nr: string;
    plz: string;
    stadt: string;
    primaryEmployeeId: number | null;
    backupEmployeeId: number | null;
    vorerkrankungen: string | null;
    haustierVorhanden: boolean;
    haustierDetails: string | null;
  }>): Promise<Customer | undefined> {
    const updateData: any = { ...data, updatedAt: new Date() };
    
    const existing = await db.select().from(customers).where(eq(customers.id, id));
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
    
    const result = await db.update(customers).set(updateData).where(eq(customers.id, id)).returning();
    const updated = result[0];
    
    if (data.primaryEmployeeId !== undefined || data.backupEmployeeId !== undefined) {
      const today = todayISO();

      if (data.primaryEmployeeId !== undefined && oldCustomer.primaryEmployeeId !== data.primaryEmployeeId) {
        if (oldCustomer.primaryEmployeeId) {
          await db.update(customerAssignmentHistory)
            .set({ validTo: today })
            .where(and(
              eq(customerAssignmentHistory.customerId, id),
              eq(customerAssignmentHistory.employeeId, oldCustomer.primaryEmployeeId),
              eq(customerAssignmentHistory.role, "primary"),
              isNull(customerAssignmentHistory.validTo)
            ));
        }
        if (data.primaryEmployeeId) {
          await db.insert(customerAssignmentHistory).values({
            customerId: id,
            employeeId: data.primaryEmployeeId,
            role: "primary",
            validFrom: today,
          });
        }
      }

      if (data.backupEmployeeId !== undefined && oldCustomer.backupEmployeeId !== data.backupEmployeeId) {
        if (oldCustomer.backupEmployeeId) {
          await db.update(customerAssignmentHistory)
            .set({ validTo: today })
            .where(and(
              eq(customerAssignmentHistory.customerId, id),
              eq(customerAssignmentHistory.employeeId, oldCustomer.backupEmployeeId),
              eq(customerAssignmentHistory.role, "backup"),
              isNull(customerAssignmentHistory.validTo)
            ));
        }
        if (data.backupEmployeeId) {
          await db.insert(customerAssignmentHistory).values({
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
  }
}

export const customerManagementStorage = new CustomerManagementStorage();
