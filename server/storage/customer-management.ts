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
} from "@shared/schema";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { eq, and, isNull, desc, count, or, ilike, sql as sqlBuilder } from "drizzle-orm";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

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
    const today = new Date().toISOString().split('T')[0];
    
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
    const today = new Date().toISOString().split('T')[0];
    
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
    const today = new Date().toISOString().split('T')[0];
    
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
    const today = new Date().toISOString().split('T')[0];
    
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
    const today = new Date().toISOString().split('T')[0];
    
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

    let whereConditions: any[] = [];
    
    if (filters?.search) {
      const searchTerm = `%${filters.search}%`;
      whereConditions.push(
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
      whereConditions.push(eq(customers.pflegegrad, filters.pflegegrad));
    }
    
    if (filters?.primaryEmployeeId) {
      whereConditions.push(eq(customers.primaryEmployeeId, filters.primaryEmployeeId));
    }

    const whereClause = whereConditions.length > 0 ? and(...whereConditions) : undefined;

    const countResult = await db
      .select({ count: count() })
      .from(customers)
      .where(whereClause);
    
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
      })
      .from(customers)
      .leftJoin(users, eq(customers.primaryEmployeeId, users.id))
      .where(whereClause)
      .orderBy(desc(customers.createdAt))
      .limit(limit)
      .offset(offset);

    const data: CustomerListItem[] = await Promise.all(result.map(async (r) => {
      const contract = await db
        .select({ id: customerContracts.id })
        .from(customerContracts)
        .where(and(
          eq(customerContracts.customerId, r.id),
          eq(customerContracts.status, "active")
        ))
        .limit(1);

      return {
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
        hasActiveContract: contract.length > 0,
        createdAt: r.createdAt,
      };
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
        validFrom: new Date().toISOString().split('T')[0],
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
        assessmentDate: new Date().toISOString().split('T')[0],
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
        validFrom: new Date().toISOString().split('T')[0],
      }, userId);

      const contract = await this.createCustomerContract({
        customerId: customer.id,
        contractStart: data.contractStart || new Date().toISOString().split('T')[0],
        hoursPerPeriod: data.contractHours,
        periodType: data.contractPeriod,
        status: "active",
      }, userId);

      if (data.hauswirtschaftRate !== undefined) {
        await this.addContractRate({
          contractId: contract.id,
          serviceCategory: "hauswirtschaft",
          hourlyRateCents: Math.round(data.hauswirtschaftRate * 100),
          validFrom: data.contractStart || new Date().toISOString().split('T')[0],
        }, userId);
      }

      if (data.alltagsbegleitungRate !== undefined) {
        await this.addContractRate({
          contractId: contract.id,
          serviceCategory: "alltagsbegleitung",
          hourlyRateCents: Math.round(data.alltagsbegleitungRate * 100),
          validFrom: data.contractStart || new Date().toISOString().split('T')[0],
        }, userId);
      }

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
  }>): Promise<Customer | undefined> {
    const updateData: any = { ...data, updatedAt: new Date() };
    
    if (data.vorname !== undefined || data.nachname !== undefined) {
      const existing = await db.select().from(customers).where(eq(customers.id, id));
      if (existing.length > 0) {
        const newVorname = data.vorname ?? existing[0].vorname ?? '';
        const newNachname = data.nachname ?? existing[0].nachname ?? '';
        updateData.name = `${newNachname}, ${newVorname}`;
      }
    }
    
    if (data.strasse !== undefined || data.nr !== undefined || data.plz !== undefined || data.stadt !== undefined) {
      const existing = await db.select().from(customers).where(eq(customers.id, id));
      if (existing.length > 0) {
        const newStrasse = data.strasse ?? existing[0].strasse ?? '';
        const newNr = data.nr ?? existing[0].nr ?? '';
        const newPlz = data.plz ?? existing[0].plz ?? '';
        const newStadt = data.stadt ?? existing[0].stadt ?? '';
        updateData.address = `${newStrasse} ${newNr}, ${newPlz} ${newStadt}`;
      }
    }
    
    const result = await db.update(customers).set(updateData).where(eq(customers.id, id)).returning();
    return result[0];
  }
}

export const customerManagementStorage = new CustomerManagementStorage();
