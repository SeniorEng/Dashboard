import {
  type Customer,
  type InsertCustomer,
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
import { eq, and, isNull, isNotNull, desc, asc, count, or, ilike, exists, sql as sqlBuilder } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { customerIdsCache } from "../services/cache";
import { todayISO } from "@shared/utils/datetime";
import { db, type DbOrTx } from "../lib/db";
import { AppError } from "../lib/errors";

/**
 * Invariante (Task #512): Ein Kunde mit `status='erstberatung'` MUSS
 * zwingend über `convertedFromProspectId` an einen Lead/Prospect gebunden
 * sein. Andernfalls entstehen „Waisen-Kunden", die in der Erstberatungs-
 * Übersicht und in den Conversion-Statistiken Lärm erzeugen (siehe
 * `docs/erstberatung-prod-analysis.md`). Wir blocken den Schreibvorgang
 * hart am Storage-Layer, damit alle Aufrufer (Routes, Migrationen, Tests)
 * gegen dieselbe Regel laufen.
 */
export function assertErstberatungHasProspectLink(
  status: string | null | undefined,
  convertedFromProspectId: number | null | undefined,
): void {
  if (status === "erstberatung" && (convertedFromProspectId === null || convertedFromProspectId === undefined)) {
    throw new AppError(
      400,
      "ERSTBERATUNG_REQUIRES_PROSPECT",
      "Kunden im Status 'Erstberatung' müssen mit einem Interessenten verknüpft sein.",
    );
  }
}

import * as insuranceModule from "./customer-mgmt/insurance";
import * as contactsModule from "./customer-mgmt/contacts";
import * as careLevelModule from "./customer-mgmt/care-level";
import * as budgetsModule from "./customer-mgmt/budgets";
import * as contractsModule from "./customer-mgmt/contracts";

export interface CustomerListFilters {
  search?: string;
  pflegegrad?: number;
  responsibleEmployeeId?: number | "unassigned";
  hasActiveContract?: boolean;
  status?: string;
  billingType?: string;
  insuranceProviderId?: number;
  sortBy?: "name" | "contractStart" | "createdAt";
  sortOrder?: "asc" | "desc";
}

interface PaginationOptions {
  limit?: number;
  offset?: number;
}

import type { PaginatedResult } from "@shared/types";
import { customersRepo } from "../repos";

interface CustomerListItem {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  email: string | null;
  telefon: string | null;
  festnetz: string | null;
  geburtsdatum: string | null;
  pflegegrad: number | null;
  address: string;
  stadt: string | null;
  status: string;
  billingType: string;
  primaryEmployee: { id: number; displayName: string } | null;
  backupEmployee: { id: number; displayName: string } | null;
  backupEmployee2: { id: number; displayName: string } | null;
  matchedRole?: "primary" | "backup" | "backup2";
  hasActiveContract: boolean;
  hasBetreuer: boolean;
  createdAt: Date;
}

class CustomerManagementStorage {
  getInsuranceProviders = insuranceModule.getInsuranceProviders;
  getInsuranceProvider = insuranceModule.getInsuranceProvider;
  getInsuranceProviderByIK = insuranceModule.getInsuranceProviderByIK;
  createInsuranceProvider = insuranceModule.createInsuranceProvider;
  updateInsuranceProvider = insuranceModule.updateInsuranceProvider;
  getActiveCustomerCountForProvider = insuranceModule.getActiveCustomerCountForProvider;
  getCustomerCurrentInsurance = insuranceModule.getCustomerCurrentInsurance;
  getCustomerInsuranceHistory = insuranceModule.getCustomerInsuranceHistory;
  addCustomerInsurance = insuranceModule.addCustomerInsurance;

  getCustomerContact = contactsModule.getCustomerContact;
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
  getCustomerLatestContract = contractsModule.getCustomerLatestContract;
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
          ilike(customers.stadt, searchTerm),
          // Versichertennummer (Task #403): nur aktuelle Versicherung
          // (validTo IS NULL) — historische VNRs dürfen die Trefferliste
          // nicht künstlich aufblähen.
          exists(
            db
              .select({ id: customerInsuranceHistory.id })
              .from(customerInsuranceHistory)
              .where(
                and(
                  eq(customerInsuranceHistory.customerId, customers.id),
                  isNull(customerInsuranceHistory.validTo),
                  ilike(customerInsuranceHistory.versichertennummer, searchTerm),
                ),
              ),
          ),
        )
      );
    }
    
    if (filters?.pflegegrad) {
      baseConditions.push(eq(customers.pflegegrad, filters.pflegegrad));
    }
    
    if (filters?.responsibleEmployeeId === "unassigned") {
      baseConditions.push(isNull(customers.primaryEmployeeId));
      baseConditions.push(isNull(customers.backupEmployeeId));
      baseConditions.push(isNull(customers.backupEmployeeId2));
    } else if (filters?.responsibleEmployeeId) {
      baseConditions.push(
        or(
          eq(customers.primaryEmployeeId, filters.responsibleEmployeeId),
          eq(customers.backupEmployeeId, filters.responsibleEmployeeId),
          eq(customers.backupEmployeeId2, filters.responsibleEmployeeId),
        )
      );
    }

    if (filters?.status) {
      baseConditions.push(eq(customers.status, filters.status));
    }

    if (filters?.billingType) {
      baseConditions.push(eq(customers.billingType, filters.billingType));
    }

    const insuranceSubquery = filters?.insuranceProviderId
      ? db
          .select({ customerId: customerInsuranceHistory.customerId })
          .from(customerInsuranceHistory)
          .where(
            and(
              eq(customerInsuranceHistory.insuranceProviderId, filters.insuranceProviderId),
              isNull(customerInsuranceHistory.validTo)
            )
          )
          .groupBy(customerInsuranceHistory.customerId)
          .as('active_insurance')
      : null;

    const activeContractSubquery = db
      .select({ 
        customerId: customerContracts.customerId,
        hasContract: sqlBuilder<boolean>`true`.as('has_contract')
      })
      .from(customerContracts)
      .where(eq(customerContracts.status, "active"))
      .groupBy(customerContracts.customerId)
      .as('active_contracts');

    const betreuerSubquery = db
      .select({
        customerId: customerContacts.customerId,
        hasBetreuer: sqlBuilder<boolean>`true`.as('has_betreuer')
      })
      .from(customerContacts)
      .where(and(
        eq(customerContacts.contactType, "betreuer"),
        eq(customerContacts.isActive, true)
      ))
      .groupBy(customerContacts.customerId)
      .as('betreuer_contacts');

    let fullConditions = [...baseConditions];
    if (filters?.hasActiveContract === true) {
      fullConditions.push(isNotNull(activeContractSubquery.customerId));
    } else if (filters?.hasActiveContract === false) {
      fullConditions.push(isNull(activeContractSubquery.customerId));
    }
    if (insuranceSubquery) {
      fullConditions.push(isNotNull(insuranceSubquery.customerId));
    }
    const fullWhereClause = fullConditions.length > 0 ? and(...fullConditions) : undefined;

    let countQueryBuilder = customersRepo.selectColumnsFrom({ count: count() }, db)
      .leftJoin(activeContractSubquery, eq(customers.id, activeContractSubquery.customerId));
    if (insuranceSubquery) {
      countQueryBuilder = countQueryBuilder.leftJoin(insuranceSubquery, eq(customers.id, insuranceSubquery.customerId)) as any;
    }
    
    const countResult = await countQueryBuilder.where(fullWhereClause);
    const total = Number(countResult[0]?.count ?? 0);

    const backupUser = alias(users, "backup_user");
    const backupUser2 = alias(users, "backup_user2");

    let dataQueryBuilder = customersRepo.selectColumnsFrom({
        id: customers.id,
        name: customers.name,
        vorname: customers.vorname,
        nachname: customers.nachname,
        email: customers.email,
        telefon: customers.telefon,
        festnetz: customers.festnetz,
        geburtsdatum: customers.geburtsdatum,
        pflegegrad: customers.pflegegrad,
        address: customers.address,
        stadt: customers.stadt,
        status: customers.status,
        billingType: customers.billingType,
        rechnungAnKunde: customers.rechnungAnKunde,
        createdAt: customers.createdAt,
        primaryEmployeeId: customers.primaryEmployeeId,
        backupEmployeeId: customers.backupEmployeeId,
        backupEmployeeId2: customers.backupEmployeeId2,
        primaryEmployeeName: users.displayName,
        backupEmployeeName: backupUser.displayName,
        backupEmployee2Name: backupUser2.displayName,
        hasActiveContract: activeContractSubquery.hasContract,
        hasBetreuer: betreuerSubquery.hasBetreuer,
      }, db)
      .leftJoin(users, eq(customers.primaryEmployeeId, users.id))
      .leftJoin(backupUser, eq(customers.backupEmployeeId, backupUser.id))
      .leftJoin(backupUser2, eq(customers.backupEmployeeId2, backupUser2.id))
      .leftJoin(activeContractSubquery, eq(customers.id, activeContractSubquery.customerId))
      .leftJoin(betreuerSubquery, eq(customers.id, betreuerSubquery.customerId));
    if (insuranceSubquery) {
      dataQueryBuilder = dataQueryBuilder.leftJoin(insuranceSubquery, eq(customers.id, insuranceSubquery.customerId)) as any;
    }
    
    const sortBy = filters?.sortBy || "name";
    const sortOrder = filters?.sortOrder || "asc";
    const orderFn = sortOrder === "desc" ? desc : asc;

    let orderByClause;
    if (sortBy === "contractStart") {
      const contractStartSubquery = db
        .select({
          customerId: customerContracts.customerId,
          contractStart: sqlBuilder<string>`MIN(${customerContracts.contractStart})`.as('earliest_contract_start'),
        })
        .from(customerContracts)
        .where(eq(customerContracts.status, "active"))
        .groupBy(customerContracts.customerId)
        .as('contract_start_sq');

      dataQueryBuilder = dataQueryBuilder.leftJoin(
        contractStartSubquery,
        eq(customers.id, contractStartSubquery.customerId)
      ) as any;

      orderByClause = sortOrder === "desc"
        ? desc(contractStartSubquery.contractStart)
        : asc(contractStartSubquery.contractStart);
    } else if (sortBy === "createdAt") {
      orderByClause = orderFn(customers.createdAt);
    } else {
      orderByClause = orderFn(customers.nachname);
    }

    const result = await dataQueryBuilder
      .where(fullWhereClause)
      .orderBy(orderByClause)
      .limit(limit)
      .offset(offset);

    const responsibleId = filters?.responsibleEmployeeId;
    const data: CustomerListItem[] = result.map((r) => {
      let matchedRole: "primary" | "backup" | "backup2" | undefined;
      if (responsibleId && responsibleId !== "unassigned") {
        if (r.primaryEmployeeId === responsibleId) matchedRole = "primary";
        else if (r.backupEmployeeId === responsibleId) matchedRole = "backup";
        else if (r.backupEmployeeId2 === responsibleId) matchedRole = "backup2";
      }
      return {
        id: r.id,
        name: r.name,
        vorname: r.vorname,
        nachname: r.nachname,
        email: r.email,
        telefon: r.telefon,
        festnetz: r.festnetz,
        geburtsdatum: r.geburtsdatum ? String(r.geburtsdatum) : null,
        pflegegrad: r.pflegegrad,
        address: r.address,
        stadt: r.stadt,
        status: r.status,
        billingType: r.billingType,
        rechnungAnKunde: r.rechnungAnKunde,
        primaryEmployee: r.primaryEmployeeId && r.primaryEmployeeName 
          ? { id: r.primaryEmployeeId, displayName: r.primaryEmployeeName }
          : null,
        backupEmployee: r.backupEmployeeId && r.backupEmployeeName
          ? { id: r.backupEmployeeId, displayName: r.backupEmployeeName }
          : null,
        backupEmployee2: r.backupEmployeeId2 && r.backupEmployee2Name
          ? { id: r.backupEmployeeId2, displayName: r.backupEmployee2Name }
          : null,
        matchedRole,
        hasActiveContract: r.hasActiveContract === true,
        hasBetreuer: r.hasBetreuer === true,
        createdAt: r.createdAt,
      };
    });

    return { data, total, limit, offset };
  }

  async getUnassignedActiveCustomerCount(): Promise<number> {
    const result = await customersRepo.selectColumnsFrom({ count: count() }, db)
      .where(
        and(
          isNull(customers.deletedAt),
          eq(customers.status, "aktiv"),
          isNull(customers.primaryEmployeeId),
          isNull(customers.backupEmployeeId),
          isNull(customers.backupEmployeeId2),
        )
      );
    return Number(result[0]?.count ?? 0);
  }

  async getCustomerWithDetails(customerId: number): Promise<CustomerWithDetails | undefined> {
    const customerResult = await customersRepo.selectFrom(db).where(eq(customers.id, customerId));
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
      backupEmployee2,
    ] = await Promise.all([
      this.getCustomerCurrentInsurance(customerId),
      this.getCustomerContacts(customerId),
      this.getCustomerCareLevelHistory(customerId),
      this.getCustomerNeedsAssessment(customerId),
      this.getCustomerCurrentBudget(customerId),
      this.getCustomerLatestContract(customerId),
      customer.primaryEmployeeId 
        ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, customer.primaryEmployeeId)).then(r => r[0])
        : Promise.resolve(undefined),
      customer.backupEmployeeId
        ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, customer.backupEmployeeId)).then(r => r[0])
        : Promise.resolve(undefined),
      customer.backupEmployeeId2
        ? db.select({ id: users.id, displayName: users.displayName }).from(users).where(eq(users.id, customer.backupEmployeeId2)).then(r => r[0])
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
      backupEmployee2,
    };
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
    backupEmployeeId2: number | null;
    vorerkrankungen: string | null;
    haustierVorhanden: boolean;
    haustierDetails: string | null;
    acceptsPrivatePayment: boolean;
    rechnungAnKunde: boolean;
    personenbefoerderungGewuenscht: boolean;
    documentDeliveryMethod: string;
    inaktivAb: string | null;
    deactivationReason: string | null;
    deactivationNote: string | null;
  }>): Promise<Customer | undefined> {
    return await db.transaction(async (tx) => {
    const updateData: any = { ...data, updatedAt: new Date() };
    
    const existing = await customersRepo.selectFrom(tx).where(eq(customers.id, id)).for("update");
    if (existing.length === 0) return undefined;
    
    const oldCustomer = existing[0];

    // Task #512: Verhindere, dass ein Kunde per Update in den Status
    // 'erstberatung' gesetzt wird, ohne dass eine Prospect-Verknüpfung
    // existiert (würde sonst denselben Waisen-Effekt erzeugen wie bei der
    // Anlage).
    if (data.status === "erstberatung") {
      assertErstberatungHasProspectLink(data.status, oldCustomer.convertedFromProspectId);
    }

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
    
    if (data.primaryEmployeeId !== undefined || data.backupEmployeeId !== undefined || data.backupEmployeeId2 !== undefined) {
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

      if (data.backupEmployeeId2 !== undefined && oldCustomer.backupEmployeeId2 !== data.backupEmployeeId2) {
        if (oldCustomer.backupEmployeeId2) {
          await tx.update(customerAssignmentHistory)
            .set({ validTo: today })
            .where(and(
              eq(customerAssignmentHistory.customerId, id),
              eq(customerAssignmentHistory.employeeId, oldCustomer.backupEmployeeId2),
              eq(customerAssignmentHistory.role, "backup2"),
              isNull(customerAssignmentHistory.validTo)
            ));
        }
        if (data.backupEmployeeId2) {
          await tx.insert(customerAssignmentHistory).values({
            customerId: id,
            employeeId: data.backupEmployeeId2,
            role: "backup2",
            validFrom: today,
          });
        }
      }

      customerIdsCache.invalidateForCustomer(oldCustomer.primaryEmployeeId, oldCustomer.backupEmployeeId, oldCustomer.backupEmployeeId2);
      customerIdsCache.invalidateForCustomer(updated.primaryEmployeeId, updated.backupEmployeeId, updated.backupEmployeeId2);
    }
    
    return updated;
    });
  }

  async updateCustomerAssignment(
    customerId: number,
    primaryEmployeeId: number | null,
    backupEmployeeId: number | null,
    changedByUserId?: number,
    backupEmployeeId2: number | null | undefined = undefined,
    changedByRole: "admin" | "teamLead" | "employee" | null = null,
  ) {
    const today = todayISO();
    const backup2 = backupEmployeeId2 === undefined ? undefined : backupEmployeeId2;

    const updated = await db.transaction(async (tx) => {
      const [existing] = await customersRepo.selectFrom(tx).where(eq(customers.id, customerId));

      if (existing) {
        if (existing.primaryEmployeeId !== primaryEmployeeId) {
          if (existing.primaryEmployeeId) {
            await tx.update(customerAssignmentHistory)
              .set({ validTo: today })
              .where(and(
                eq(customerAssignmentHistory.customerId, customerId),
                eq(customerAssignmentHistory.employeeId, existing.primaryEmployeeId),
                eq(customerAssignmentHistory.role, "primary"),
                isNull(customerAssignmentHistory.validTo)
              ));
          }
          if (primaryEmployeeId) {
            await tx.insert(customerAssignmentHistory).values({
              customerId,
              employeeId: primaryEmployeeId,
              role: "primary",
              validFrom: today,
              changedByUserId: changedByUserId ?? null,
              changedByRole,
            });
          }
        }

        if (existing.backupEmployeeId !== backupEmployeeId) {
          if (existing.backupEmployeeId) {
            await tx.update(customerAssignmentHistory)
              .set({ validTo: today })
              .where(and(
                eq(customerAssignmentHistory.customerId, customerId),
                eq(customerAssignmentHistory.employeeId, existing.backupEmployeeId),
                eq(customerAssignmentHistory.role, "backup"),
                isNull(customerAssignmentHistory.validTo)
              ));
          }
          if (backupEmployeeId) {
            await tx.insert(customerAssignmentHistory).values({
              customerId,
              employeeId: backupEmployeeId,
              role: "backup",
              validFrom: today,
              changedByUserId: changedByUserId ?? null,
              changedByRole,
            });
          }
        }

        if (backup2 !== undefined && existing.backupEmployeeId2 !== backup2) {
          if (existing.backupEmployeeId2) {
            await tx.update(customerAssignmentHistory)
              .set({ validTo: today })
              .where(and(
                eq(customerAssignmentHistory.customerId, customerId),
                eq(customerAssignmentHistory.employeeId, existing.backupEmployeeId2),
                eq(customerAssignmentHistory.role, "backup2"),
                isNull(customerAssignmentHistory.validTo)
              ));
          }
          if (backup2) {
            await tx.insert(customerAssignmentHistory).values({
              customerId,
              employeeId: backup2,
              role: "backup2",
              validFrom: today,
              changedByUserId: changedByUserId ?? null,
              changedByRole,
            });
          }
        }
      }

      const setData: any = { primaryEmployeeId, backupEmployeeId };
      if (backup2 !== undefined) {
        setData.backupEmployeeId2 = backup2;
      }

      const [result] = await tx
        .update(customers)
        .set(setData)
        .where(eq(customers.id, customerId))
        .returning();

      return { result, existing };
    });

    customerIdsCache.invalidateForCustomer(updated.existing?.primaryEmployeeId ?? null, updated.existing?.backupEmployeeId ?? null, updated.existing?.backupEmployeeId2 ?? null);
    customerIdsCache.invalidateForCustomer(primaryEmployeeId, backupEmployeeId, backup2 ?? null);

    return updated.result;
  }

  async createCustomerDirect(customerData: InsertCustomer, tx?: DbOrTx) {
    assertErstberatungHasProspectLink(customerData.status, customerData.convertedFromProspectId);
    const executor = tx ?? db;
    const [customer] = await executor.insert(customers).values(customerData).returning();
    return customer;
  }
}

export const customerManagementStorage = new CustomerManagementStorage();
