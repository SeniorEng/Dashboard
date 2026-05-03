import {
  apiDelete,
  apiGet,
  apiPatch,
  apiPost,
  apiPut,
  cleanupCustomer,
  createTestCustomer,
  createTestEmployee,
  deactivateTestEmployee,
} from "../test-utils";
import {
  BUDGET_39_42A_MAX_YEARLY_CENTS,
  BUDGET_45A_MAX_BY_PFLEGEGRAD,
  type BudgetType,
} from "@shared/domain/budgets";
import type { BillingType } from "@shared/domain/customers";
import { addMinutesToTimeHHMMSS } from "@shared/utils/datetime";

export type Pflegegrad = 1 | 2 | 3 | 4 | 5;

export interface BudgetTypeSettingSpec {
  type: BudgetType;
  enabled: boolean;
  priority: number;
  monthlyLimitCents?: number | null;
  yearlyLimitCents?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
}

export interface BudgetScenarioPreferencesSpec {
  budgetStartDate?: string;
  monthlyLimitCents?: number | null;
  notes?: string | null;
}

export interface BudgetScenarioInitialBalanceSpec {
  type: BudgetType;
  amountCents: number;
  validFrom: string;
}

export interface BudgetScenarioCarryoverSpec {
  type: BudgetType;
  amountCents: number;
  year: number;
}

export interface BudgetScenarioServiceSpec {
  code: string;
  durationMinutes: number;
}

export interface BudgetScenarioAppointmentSpec {
  date: string;
  scheduledStart: string;
  /** Optional. If omitted, computed as scheduledStart + sum(services.durationMinutes). */
  scheduledEnd?: string;
  services: BudgetScenarioServiceSpec[];
  document?: boolean;
  actualStart?: string;
  notes?: string;
  travelKilometers?: number;
  customerKilometers?: number;
}

export interface BudgetScenarioManualAdjustmentSpec {
  type: BudgetType;
  amountCents: number;
  notes?: string;
}

export interface BudgetScenarioSpec {
  customerNamePrefix?: string;
  pflegegrad?: Pflegegrad;
  billingType?: BillingType;
  acceptsPrivatePayment?: boolean;
  preferences?: BudgetScenarioPreferencesSpec;
  types: BudgetTypeSettingSpec[];
  initialBalance?: BudgetScenarioInitialBalanceSpec;
  carryover?: BudgetScenarioCarryoverSpec;
  manualAdjustments?: BudgetScenarioManualAdjustmentSpec[];
  appointments?: BudgetScenarioAppointmentSpec[];
}

export interface BudgetScenarioTransaction {
  readonly id: number;
  readonly appointmentId: number;
  readonly allocationId: number | null;
  readonly amountCents: number;
}

export interface BudgetScenarioHandle {
  readonly customerId: number;
  readonly employeeId: number;
  readonly appointmentIds: readonly number[];
  readonly transactions: readonly BudgetScenarioTransaction[];
  readonly manualAdjustmentTxIds: readonly number[];
  cleanup(): Promise<void>;
}

interface ServiceCatalogEntry {
  id: number;
  code: string | null;
  name: string;
}

interface ApiAllocation {
  id: number;
  source: string;
  budgetType?: BudgetType;
}

interface ApiAppointment {
  id: number;
}

interface ApiBudgetTransaction {
  id: number;
  allocationId: number | null;
  amountCents: number;
  appointmentId: number | null;
}

interface ApiDocumentationResponse {
  budgetTransaction: ApiBudgetTransaction | null;
}

interface ApiManualAdjustmentResponse {
  type: string;
  data?: { id: number };
}

interface InitialBudgetResponse {
  allocations: ApiAllocation[];
}

interface ServerTypeSetting {
  budgetType: BudgetType;
  enabled: boolean;
  priority: number;
  monthlyLimitCents: number | null;
  yearlyLimitCents: number | null;
  validFrom: string | null;
  validTo: string | null;
}

let cachedServiceCatalog: ServiceCatalogEntry[] | null = null;

async function createScenarioEmployee(prefix: string): Promise<number> {
  // Each scenario gets its own employee so that hard-coded appointment
  // dates/times in different INT-blocks cannot collide on the employee's
  // calendar. Cleanup deactivates the employee in cleanup().
  const employee = await createTestEmployee({ nachnamePrefix: `BS_${prefix}` });
  return employee.id;
}

async function getServiceCatalog(): Promise<ServiceCatalogEntry[]> {
  if (cachedServiceCatalog !== null) return cachedServiceCatalog;
  const res = await apiGet<ServiceCatalogEntry[]>("/api/services");
  if (res.status !== 200 || !Array.isArray(res.data)) {
    throw new Error(
      `Service-Katalog konnte nicht geladen werden: status=${res.status}`,
    );
  }
  cachedServiceCatalog = res.data;
  return cachedServiceCatalog;
}

function findServiceByCode(
  catalog: ServiceCatalogEntry[],
  code: string,
): ServiceCatalogEntry {
  const svc = catalog.find((s) => s.code === code);
  if (!svc) {
    throw new Error(`Service mit Code '${code}' nicht gefunden`);
  }
  return svc;
}

function normalizeValidFromToDate(validFrom: string): string {
  if (/^\d{4}-\d{2}$/.test(validFrom)) return `${validFrom}-01`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(validFrom)) return validFrom;
  throw new Error(
    `Ungültiges validFrom Format '${validFrom}': erwartet 'YYYY-MM' oder 'YYYY-MM-DD'`,
  );
}

function resolveDefaultMonthlyLimit(
  type: BudgetType,
  pflegegrad: Pflegegrad,
): number | null {
  if (type === "umwandlung_45a") {
    return BUDGET_45A_MAX_BY_PFLEGEGRAD[pflegegrad] ?? null;
  }
  return null;
}

function resolveDefaultYearlyLimit(type: BudgetType): number | null {
  if (type === "ersatzpflege_39_42a") {
    return BUDGET_39_42A_MAX_YEARLY_CENTS;
  }
  return null;
}

function toServerTypeSetting(
  t: BudgetTypeSettingSpec,
  pflegegrad: Pflegegrad,
): ServerTypeSetting {
  // Auto-fill default limits from Pflegegrad when caller omits them
  // (undefined = "use system default"; null = "no limit set").
  const monthlyLimitCents =
    t.monthlyLimitCents === undefined
      ? resolveDefaultMonthlyLimit(t.type, pflegegrad)
      : t.monthlyLimitCents;
  const yearlyLimitCents =
    t.yearlyLimitCents === undefined
      ? resolveDefaultYearlyLimit(t.type)
      : t.yearlyLimitCents;

  return {
    budgetType: t.type,
    enabled: t.enabled,
    priority: t.priority,
    monthlyLimitCents,
    yearlyLimitCents,
    validFrom: t.validFrom ?? null,
    validTo: t.validTo ?? null,
  };
}

export async function setupBudgetScenario(
  spec: BudgetScenarioSpec,
): Promise<BudgetScenarioHandle> {
  const namePrefix = spec.customerNamePrefix ?? "TEST-DSL";
  const pflegegrad: Pflegegrad = spec.pflegegrad ?? 3;
  const billingType: BillingType = spec.billingType ?? "pflegekasse_gesetzlich";
  const acceptsPrivatePayment = spec.acceptsPrivatePayment ?? true;

  const customer = await createTestCustomer({
    vorname: namePrefix,
    nachname: `Scenario-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    pflegegrad,
    pflegegradSeit: "2024-01-01",
    billingType,
    acceptsPrivatePayment,
  });
  const customerId = customer.id;

  const employeeId = await createScenarioEmployee(namePrefix);

  const assignRes = await apiPatch<unknown>(
    `/api/admin/customers/${customerId}/assign`,
    {
      primaryEmployeeId: employeeId,
      backupEmployeeId: null,
      backupEmployeeId2: null,
    },
  );
  if (assignRes.status !== 200) {
    throw new Error(
      `setupBudgetScenario: assign fehlgeschlagen (status=${assignRes.status}, customerId=${customerId})`,
    );
  }

  if (spec.preferences) {
    const prefRes = await apiPut<unknown>(
      `/api/budget/${customerId}/preferences`,
      {
        customerId,
        budgetStartDate: spec.preferences.budgetStartDate ?? null,
        monthlyLimitCents: spec.preferences.monthlyLimitCents ?? null,
        notes: spec.preferences.notes ?? null,
      },
    );
    if (prefRes.status !== 200) {
      throw new Error(
        `setupBudgetScenario: preferences fehlgeschlagen (status=${prefRes.status})`,
      );
    }
  }

  if (spec.carryover && spec.carryover.type !== "entlastungsbetrag_45b") {
    throw new Error(
      "setupBudgetScenario: carryover ist nur für budgetType 'entlastungsbetrag_45b' möglich",
    );
  }

  const ib = spec.initialBalance;
  const carry = spec.carryover;
  if (ib && carry) {
    if (ib.type !== carry.type) {
      throw new Error(
        "setupBudgetScenario: initialBalance.type und carryover.type müssen übereinstimmen",
      );
    }
    const targetYear = carry.year + 1;
    const ibYear = parseInt(normalizeValidFromToDate(ib.validFrom).slice(0, 4), 10);
    if (ibYear !== targetYear) {
      throw new Error(
        `setupBudgetScenario: initialBalance.validFrom (Jahr=${ibYear}) muss im Folgejahr von carryover.year=${carry.year} liegen (Jahr=${targetYear})`,
      );
    }
    const res = await apiPost<InitialBudgetResponse>(
      `/api/budget/${customerId}/initial-budget`,
      {
        budgetType: ib.type,
        currentYearAmountCents: ib.amountCents,
        carryoverAmountCents: carry.amountCents,
        budgetStartDate: normalizeValidFromToDate(ib.validFrom),
      },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(
        `setupBudgetScenario: initial-budget fehlgeschlagen (status=${res.status})`,
      );
    }
  } else if (ib) {
    const res = await apiPost<InitialBudgetResponse>(
      `/api/budget/${customerId}/initial-budget`,
      {
        budgetType: ib.type,
        currentYearAmountCents: ib.amountCents,
        carryoverAmountCents: 0,
        budgetStartDate: normalizeValidFromToDate(ib.validFrom),
      },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(
        `setupBudgetScenario: initial-budget fehlgeschlagen (status=${res.status})`,
      );
    }
  } else if (carry) {
    const res = await apiPost<InitialBudgetResponse>(
      `/api/budget/${customerId}/initial-budget`,
      {
        budgetType: carry.type,
        currentYearAmountCents: 0,
        carryoverAmountCents: carry.amountCents,
        budgetStartDate: `${carry.year + 1}-01-01`,
      },
    );
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(
        `setupBudgetScenario: initial-budget fehlgeschlagen (status=${res.status})`,
      );
    }
  }

  const typesRes = await apiPut<ServerTypeSetting[]>(
    `/api/budget/${customerId}/type-settings`,
    { settings: spec.types.map((t) => toServerTypeSetting(t, pflegegrad)) },
  );
  if (typesRes.status !== 200) {
    throw new Error(
      `setupBudgetScenario: type-settings fehlgeschlagen (status=${typesRes.status})`,
    );
  }

  const manualAdjustmentTxIds: number[] = [];
  if (spec.manualAdjustments && spec.manualAdjustments.length > 0) {
    for (const adj of spec.manualAdjustments) {
      const adjRes = await apiPost<ApiManualAdjustmentResponse>(
        `/api/budget/${customerId}/manual-adjustment`,
        {
          budgetType: adj.type,
          amountCents: adj.amountCents,
          notes: adj.notes ?? "BudgetScenario-Adjustment",
        },
      );
      if (adjRes.status !== 201) {
        throw new Error(
          `setupBudgetScenario: manual-adjustment fehlgeschlagen (status=${adjRes.status})`,
        );
      }
      if (adjRes.data.type === "transaction" && adjRes.data.data?.id) {
        manualAdjustmentTxIds.push(adjRes.data.data.id);
      }
    }
  }

  const internalAppointmentIds: number[] = [];
  const internalTransactions: BudgetScenarioTransaction[] = [];
  const internalTransactionIds: number[] = [];

  if (spec.appointments && spec.appointments.length > 0) {
    const catalog = await getServiceCatalog();
    for (let i = 0; i < spec.appointments.length; i++) {
      const a = spec.appointments[i];

      const services = a.services.map((s) => {
        const svc = findServiceByCode(catalog, s.code);
        return { serviceId: svc.id, durationMinutes: s.durationMinutes };
      });

      const totalDuration = services.reduce((sum, s) => sum + s.durationMinutes, 0);
      const scheduledEnd =
        a.scheduledEnd ?? addMinutesToTimeHHMMSS(a.scheduledStart, totalDuration);

      const apptRes = await apiPost<ApiAppointment>(
        "/api/appointments/kundentermin",
        {
          customerId,
          date: a.date,
          scheduledStart: a.scheduledStart,
          scheduledEnd,
          notes: a.notes ?? `BudgetScenario-Appt-${Date.now()}-${i}`,
          assignedEmployeeId: employeeId,
          services,
        },
      );
      if (apptRes.status !== 201) {
        throw new Error(
          `setupBudgetScenario: appointment fehlgeschlagen (status=${apptRes.status}, date=${a.date}, time=${a.scheduledStart})`,
        );
      }
      const appointmentId = apptRes.data.id;
      internalAppointmentIds.push(appointmentId);

      if (a.document) {
        const docRes = await apiPost<ApiDocumentationResponse>(
          `/api/appointments/${appointmentId}/document`,
          {
            actualStart: a.actualStart ?? a.scheduledStart,
            travelOriginType: "home",
            travelKilometers: a.travelKilometers ?? 0,
            customerKilometers: a.customerKilometers ?? 0,
            services: services.map((s) => ({
              serviceId: s.serviceId,
              actualDurationMinutes: s.durationMinutes,
              details: "BudgetScenario-Doc",
            })),
          },
        );
        if (docRes.status !== 200) {
          throw new Error(
            `setupBudgetScenario: document fehlgeschlagen (status=${docRes.status}, appointmentId=${appointmentId})`,
          );
        }
        const tx = docRes.data.budgetTransaction;
        if (tx) {
          internalTransactionIds.push(tx.id);
          internalTransactions.push({
            id: tx.id,
            appointmentId,
            allocationId: tx.allocationId,
            amountCents: tx.amountCents,
          });
        }
      }
    }
  }

  return {
    customerId,
    employeeId,
    appointmentIds: internalAppointmentIds,
    transactions: internalTransactions,
    manualAdjustmentTxIds,
    async cleanup() {
      for (const txId of [...internalTransactionIds, ...manualAdjustmentTxIds].reverse()) {
        try {
          await apiPost(`/api/budget/transactions/${txId}/reverse`, {});
        } catch {
          // best-effort
        }
      }
      for (const apptId of [...internalAppointmentIds].reverse()) {
        try {
          await apiDelete(`/api/appointments/${apptId}`);
        } catch {
          // best-effort
        }
      }
      await cleanupCustomer(customerId);
      await deactivateTestEmployee(employeeId);
    },
  };
}
