/**
 * OpenAPI / Schema-First — Single Source of Truth für die maschinenlesbare
 * API-Oberfläche (Task #775, Audit-Prio 9 „Vorbereitung externe API").
 *
 * Hintergrund / Abweichung vom Task-Wortlaut:
 *   Der Task ging davon aus, dass in `shared/api/` bereits Zod-Schemas liegen.
 *   Tatsächlich enthält `shared/api/` reine TypeScript-Interfaces, die app-weit
 *   (Frontend + Server, ~13 Module) als Typ-SSoT konsumiert werden. Ein
 *   Wholesale-Umbau dieser Interfaces auf `z.infer` wäre breaking + riskant.
 *
 *   Deshalb leben die Zod-Schemas hier in einem dedizierten Modul. Damit Zod
 *   und die Interfaces NICHT silent driften können, gibt es weiter unten
 *   Compile-Time-Parity-Assertions (`Exact<…>`): Weicht ein Zod-Schema von
 *   seinem Interface ab, schlägt `tsc --noEmit` (CI-Gate 2) fehl. Zod ist damit
 *   die effektive SSoT der Wire-Shapes, ohne die bestehenden Konsumenten zu
 *   brechen.
 *
 * Regeneration der Spec-Datei:  `npm run gen:openapi`  → `docs/api/openapi.json`
 * Drift-Gate (CI):              `npm run gen:openapi -- --check`
 */

import { z } from "zod";
import {
  extendZodWithOpenApi,
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from "@asteasolutions/zod-to-openapi";

import { EMPLOYEE_ROLES } from "../schema/users";
import type {
  EmployeeListItem,
  InsuranceProviderItem,
  BirthdayEntry,
  MissingBreakDay,
  OpenTasksSummary,
  PaginationParams,
  CustomerListItem,
  CustomerListParams,
  CustomerContactItem,
  BudgetSetupMissingCount,
  CreateCustomerRequest,
  BillingCustomerItem,
  InvoiceItem,
  InvoiceDetail,
  DeliveryRecord,
  BillingInvoicePreview,
  GenerateInvoiceResponse,
  SendInvoiceResponse,
  BatchSendInvoiceResponse,
  PayerSummary,
  BulkSendInvoiceResponse,
  TimeEntry,
  TimeEntryWithUser,
  CreateTimeEntryRequest,
  UpdateTimeEntryRequest,
  VacationEntitlementHistoryItem,
  VacationMonthlyBreakdownItem,
  VacationSummary,
  ServiceHoursSummary,
  TravelSummary,
  TimeEntrySummary,
  BudgetOverview45bDTO,
  BudgetOverview45aDTO,
  BudgetOverview39_42aDTO,
  BudgetOverviewDTO,
} from "./index";

extendZodWithOpenApi(z);

export const registry = new OpenAPIRegistry();

/** Registriert ein Schema unter `name` als wiederverwendbare Component. */
function component<T extends z.ZodTypeAny>(name: string, schema: T): T {
  return registry.register(name, schema) as unknown as T;
}

const nullableString = () => z.string().nullable();

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export const PaginationParamsSchema = component(
  "PaginationParams",
  z.object({
    page: z.number().int().optional(),
    limit: z.number().int().optional(),
    search: z.string().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Employees
// ---------------------------------------------------------------------------

export const EmployeeRoleSchema = component(
  "EmployeeRole",
  z.enum(EMPLOYEE_ROLES),
);

export const EmployeeListItemSchema = component(
  "EmployeeListItem",
  z.object({
    id: z.number().int(),
    email: z.string(),
    displayName: z.string(),
    vorname: nullableString(),
    nachname: nullableString(),
    isActive: z.boolean(),
    isAdmin: z.boolean(),
    roles: z.array(EmployeeRoleSchema),
    createdAt: z.string(),
  }),
);

// ---------------------------------------------------------------------------
// Insurance
// ---------------------------------------------------------------------------

export const InsuranceProviderItemSchema = component(
  "InsuranceProviderItem",
  z.object({
    id: z.number().int(),
    name: z.string(),
    empfaenger: nullableString(),
    empfaengerZeile2: nullableString(),
    isPrivate: z.boolean(),
    ikNummer: nullableString(),
    strasse: nullableString(),
    hausnummer: nullableString(),
    plz: nullableString(),
    stadt: nullableString(),
    telefon: nullableString(),
    fax: nullableString(),
    email: nullableString(),
    emailVerhinderungspflege: nullableString(),
    kimAdresse: nullableString(),
    ansprechpartner: nullableString(),
    datenannahmeIk: nullableString(),
    emailInvoiceEnabled: z.boolean(),
    zahlungsbedingungen: nullableString(),
    zahlungsart: nullableString(),
    isActive: z.boolean(),
    createdAt: z.string(),
    isUsed: z.boolean().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Birthdays
// ---------------------------------------------------------------------------

export const BirthdayEntrySchema = component(
  "BirthdayEntry",
  z.object({
    id: z.number().int(),
    type: z.enum(["employee", "customer"]),
    name: z.string(),
    geburtsdatum: z.string(),
    daysUntil: z.number(),
    age: z.number(),
    address: z.string().optional(),
    cardSent: z.boolean().optional(),
    cardSentAt: z.string().nullable().optional(),
  }),
);

// ---------------------------------------------------------------------------
// Labor law
// ---------------------------------------------------------------------------

export const MissingBreakDaySchema = component(
  "MissingBreakDay",
  z.object({
    date: z.string(),
    totalWorkMinutes: z.number(),
    requiredBreakMinutes: z.number(),
    documentedBreakMinutes: z.number(),
  }),
);

export const OpenTasksSummarySchema = component(
  "OpenTasksSummary",
  z.object({
    daysWithMissingBreaks: z.array(MissingBreakDaySchema),
  }),
);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

const employeeRefSchema = z
  .object({ id: z.number().int(), displayName: z.string() })
  .nullable();

export const CustomerListItemSchema = component(
  "CustomerListItem",
  z.object({
    id: z.number().int(),
    name: z.string(),
    vorname: nullableString(),
    nachname: nullableString(),
    billingType: nullableString(),
    email: nullableString(),
    telefon: nullableString(),
    festnetz: nullableString(),
    address: nullableString(),
    stadt: nullableString(),
    pflegegrad: z.number().int().nullable(),
    geburtsdatum: nullableString(),
    status: z.string(),
    inaktivAb: nullableString(),
    primaryEmployee: employeeRefSchema,
    backupEmployee: employeeRefSchema,
    backupEmployee2: employeeRefSchema,
    matchedRole: z.enum(["primary", "backup", "backup2"]).optional(),
    hasActiveContract: z.boolean(),
    hasBetreuer: z.boolean(),
    rechnungAnKunde: z.boolean(),
    budgetSetupMissing: z.boolean(),
    contractEnd: nullableString(),
    contractTerminated: z.boolean(),
    createdAt: z.string(),
  }),
);

export const CustomerListParamsSchema = component(
  "CustomerListParams",
  z.object({
    page: z.number().int().optional(),
    limit: z.number().int().optional(),
    search: z.string().optional(),
    pflegegrad: z.string().optional(),
    billingType: z.string().optional(),
    responsibleEmployeeId: z.string().optional(),
    status: z.string().optional(),
    insuranceProviderId: z.string().optional(),
    budgetSetupMissing: z.string().optional(),
    lifecycle: z.string().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.string().optional(),
  }),
);

export const CustomerContactItemSchema = component(
  "CustomerContactItem",
  z.object({
    id: z.number().int(),
    contactType: z.string(),
    isPrimary: z.boolean(),
    vorname: z.string(),
    nachname: z.string(),
    festnetz: nullableString(),
    mobilnummer: nullableString(),
    email: nullableString(),
    notes: nullableString(),
  }),
);

export const BudgetSetupMissingCountSchema = component(
  "BudgetSetupMissingCount",
  z.object({ count: z.number().int() }),
);

export const CreateCustomerRequestSchema = component(
  "CreateCustomerRequest",
  z.object({
    skipDuplicateCheck: z.boolean().optional(),
    acknowledgeRecentDuplicate: z.boolean().optional(),
    vorname: z.string(),
    nachname: z.string(),
    telefon: z.string().optional(),
    festnetz: z.string().optional(),
    email: z.string().optional(),
    strasse: z.string(),
    nr: z.string(),
    plz: z.string(),
    stadt: z.string(),
    pflegegrad: z.number().int().optional(),
    pflegegradSeit: z.string().optional(),
    vorerkrankungen: z.string().optional(),
    haustierVorhanden: z.boolean().optional(),
    haustierDetails: z.string().optional(),
    personenbefoerderungGewuenscht: z.boolean().optional(),
    acceptsPrivatePayment: z.boolean().optional(),
    rechnungAnKunde: z.boolean().optional(),
    documentDeliveryMethod: z.enum(["email", "post"]).optional(),
    receivesMonthlyInvoice: z.boolean().optional(),
    billingType: z
      .enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"])
      .optional(),
    insurance: z
      .object({
        providerId: z.number().int(),
        versichertennummer: z.string(),
        validFrom: z.string(),
      })
      .optional(),
    contacts: z
      .array(
        z.object({
          contactType: z.string(),
          isPrimary: z.boolean(),
          vorname: z.string(),
          nachname: z.string(),
          festnetz: z.string().optional(),
          mobilnummer: z.string().optional(),
          email: z.string().optional(),
          notes: z.string().optional(),
        }),
      )
      .optional(),
    budgets: z
      .object({
        entlastungsbetrag45b: z.number(),
        verhinderungspflege39: z.number(),
        pflegesachleistungen36: z.number(),
        validFrom: z.string(),
      })
      .optional(),
    contract: z
      .object({
        contractStart: z.string(),
        contractDate: z.string().optional(),
        vereinbarteLeistungen: z.string().optional(),
        hoursPerPeriod: z.number(),
        periodType: z.string(),
        rates: z
          .array(
            z.object({
              serviceCategory: z.string(),
              hourlyRateCents: z.number().int(),
            }),
          )
          .optional(),
      })
      .optional(),
  }),
);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

export const BillingCustomerItemSchema = component(
  "BillingCustomerItem",
  z.object({
    id: z.number().int(),
    name: z.string(),
    vorname: nullableString(),
    nachname: nullableString(),
    billingType: z.string(),
    status: z.string(),
    completedAppointments: z.number().int(),
    coveredAppointments: z.number().int(),
  }),
);

export const InvoiceItemSchema = component(
  "InvoiceItem",
  z.object({
    id: z.number().int(),
    invoiceNumber: z.string(),
    customerId: z.number().int(),
    billingType: z.string(),
    invoiceType: z.string(),
    billingMonth: z.number().int(),
    billingYear: z.number().int(),
    recipientName: z.string(),
    customerName: z.string(),
    customerVorname: nullableString(),
    customerNachname: nullableString(),
    netAmountCents: z.number().int(),
    vatAmountCents: z.number().int(),
    grossAmountCents: z.number().int(),
    vatRate: z.number().nullable(),
    status: z.string(),
    sentAt: nullableString(),
    dueDate: nullableString(),
    pdfPath: nullableString(),
    createdAt: z.string(),
    billingRunId: nullableString(),
    budgetType: nullableString(),
  }),
);

const invoiceLineItemSchema = z.object({
  id: z.number().int(),
  appointmentDate: z.string(),
  serviceDescription: z.string(),
  serviceCode: nullableString(),
  startTime: nullableString(),
  endTime: nullableString(),
  durationMinutes: z.number().int(),
  quantityRaw: z.number().nullable(),
  quantityUnit: z.enum(["hours", "km"]).nullable(),
  totalCents: z.number().int(),
  unitPriceCents: z.number().int(),
  employeeName: nullableString(),
});

export const InvoiceDetailSchema = component(
  "InvoiceDetail",
  InvoiceItemSchema.extend({
    lineItems: z.array(invoiceLineItemSchema),
    pdfDrift: z.boolean().optional(),
    leistungsnachweisDrift: z.boolean().optional(),
  }),
);

export const DeliveryRecordSchema = component(
  "DeliveryRecord",
  z.object({
    id: z.number().int(),
    deliveryMethod: z.string(),
    status: z.string(),
    recipientEmail: nullableString(),
    recipientName: nullableString(),
    recipientAddress: nullableString(),
    documentFileNames: nullableString(),
    sentAt: nullableString(),
    createdAt: z.string(),
    errorMessage: nullableString(),
    letterxpressLetterId: nullableString(),
  }),
);

export const BillingInvoicePreviewSchema = component(
  "BillingInvoicePreview",
  z.object({
    serviceRecordCount: z.number().int(),
    coveredAppointments: z.number().int(),
    completedAppointments: z.number().int(),
    totalCents: z.number().int(),
    splitInvoices: z.boolean(),
    splitPots: z.array(
      z.enum([
        "entlastungsbetrag_45b",
        "umwandlung_45a",
        "ersatzpflege_39_42a",
        "private",
      ]),
    ),
  }),
);

export const GenerateInvoiceResponseSchema = component(
  "GenerateInvoiceResponse",
  z.object({
    splitInvoices: z.boolean().optional(),
    invoices: z.array(z.object({ id: z.number().int() })).optional(),
    message: z.string().optional(),
  }),
);

export const SendInvoiceResponseSchema = component(
  "SendInvoiceResponse",
  z.object({
    message: z.string(),
    invoice: InvoiceItemSchema.optional(),
    results: z
      .array(
        z.object({
          invoiceId: z.number().int(),
          status: z.string(),
          recipientEmail: z.string(),
          customerCopy: z.boolean().optional(),
        }),
      )
      .optional(),
  }),
);

export const BatchSendInvoiceResponseSchema = component(
  "BatchSendInvoiceResponse",
  z.object({
    message: z.string(),
    summary: z.object({
      sent: z.number().int(),
      errors: z.number().int(),
      skipped: z.number().int(),
      total: z.number().int(),
    }),
    results: z.array(
      z.object({
        invoiceId: z.number().int(),
        invoiceNumber: z.string(),
        status: z.string(),
        error: z.string().optional(),
        recipientEmail: z.string().optional(),
      }),
    ),
  }),
);

export const PayerSummarySchema = component(
  "PayerSummary",
  z.object({
    insuranceProviderId: z.number().int(),
    name: z.string(),
  }),
);

export const BulkSendInvoiceResponseSchema = component(
  "BulkSendInvoiceResponse",
  z.object({
    summary: z.object({
      total: z.number().int(),
      markedSent: z.number().int(),
      skipped: z.number().int(),
      errors: z.number().int(),
    }),
    results: z.array(
      z.object({
        invoiceId: z.number().int(),
        invoiceNumber: z.string(),
        customerId: z.number().int(),
        billingType: z.string(),
        status: z.enum(["marked_sent", "skipped", "error"]),
        message: z.string().optional(),
      }),
    ),
  }),
);

// ---------------------------------------------------------------------------
// Time tracking
// ---------------------------------------------------------------------------

export const TimeEntryTypeSchema = component(
  "TimeEntryType",
  z.enum([
    "urlaub",
    "krankheit",
    "pause",
    "bueroarbeit",
    "vertrieb",
    "sonstiges",
    "verfuegbar",
    "blocker",
  ]),
);

export const TimeEntrySchema = component(
  "TimeEntry",
  z.object({
    id: z.number().int(),
    userId: z.number().int(),
    entryType: TimeEntryTypeSchema,
    entryDate: z.string(),
    startTime: nullableString(),
    endTime: nullableString(),
    isFullDay: z.boolean(),
    durationMinutes: z.number().int().nullable(),
    kilometers: z.number().nullable(),
    notes: nullableString(),
    isAutoGenerated: z.boolean(),
    createdAt: z.string(),
    updatedAt: z.string(),
  }),
);

export const TimeEntryWithUserSchema = component(
  "TimeEntryWithUser",
  TimeEntrySchema.extend({
    user: z.object({ displayName: z.string() }),
  }),
);

export const CreateTimeEntryRequestSchema = component(
  "CreateTimeEntryRequest",
  z.object({
    entryType: TimeEntryTypeSchema,
    entryDate: z.string(),
    endDate: nullableString().optional(),
    startTime: nullableString().optional(),
    endTime: nullableString().optional(),
    isFullDay: z.boolean().optional(),
    durationMinutes: z.number().int().nullable().optional(),
    kilometers: z.number().nullable().optional(),
    notes: nullableString().optional(),
    targetUserId: z.number().int().optional(),
  }),
);

export const UpdateTimeEntryRequestSchema = component(
  "UpdateTimeEntryRequest",
  CreateTimeEntryRequestSchema.partial(),
);

export const VacationEntitlementHistoryItemSchema = component(
  "VacationEntitlementHistoryItem",
  z.object({
    validFromYear: z.number().int(),
    validFromMonth: z.number().int(),
    daysPerYear: z.number(),
  }),
);

export const VacationMonthlyBreakdownItemSchema = component(
  "VacationMonthlyBreakdownItem",
  z.object({
    fromMonth: z.number().int(),
    toMonth: z.number().int(),
    daysPerYear: z.number(),
  }),
);

export const VacationSummarySchema = component(
  "VacationSummary",
  z.object({
    year: z.number().int(),
    totalDays: z.number(),
    configuredAnnualDays: z.number(),
    eintrittsdatum: nullableString(),
    entitlementHistory: z.array(VacationEntitlementHistoryItemSchema),
    monthlyBreakdown: z.array(VacationMonthlyBreakdownItemSchema),
    carryOverDays: z.number(),
    usedDays: z.number(),
    plannedDays: z.number(),
    remainingDays: z.number(),
    sickDays: z.number(),
  }),
);

export const ServiceHoursSummarySchema = component(
  "ServiceHoursSummary",
  z.object({
    hauswirtschaftMinutes: z.number(),
    alltagsbegleitungMinutes: z.number(),
    erstberatungMinutes: z.number(),
  }),
);

export const TravelSummarySchema = component(
  "TravelSummary",
  z.object({
    totalKilometers: z.number(),
    customerKilometers: z.number(),
    timeEntryKilometers: z.number(),
    totalMinutes: z.number(),
  }),
);

export const TimeEntrySummarySchema = component(
  "TimeEntrySummary",
  z.object({
    urlaubDays: z.number(),
    krankheitDays: z.number(),
    urlaubHours: z.number(),
    krankheitHours: z.number(),
    pauseMinutes: z.number(),
    bueroarbeitMinutes: z.number(),
    vertriebMinutes: z.number(),
    sonstigesMinutes: z.number(),
  }),
);

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export const BudgetOverview45bDTOSchema = component(
  "BudgetOverview45bDTO",
  z.object({
    totalAllocatedCents: z.number().int(),
    totalUsedCents: z.number().int(),
    availableCents: z.number().int(),
    plannedCents: z.number().int(),
    availableAfterPlannedCents: z.number().int(),
    currentMonthUsedCents: z.number().int(),
    currentMonthAvailableCents: z.number().int(),
    monthlyLimitCents: z.number().int().nullable(),
    carryoverCents: z.number().int(),
    carryoverExpiresAt: nullableString(),
    currentYearAllocatedCents: z.number().int(),
    isCurrentlyActive: z.boolean(),
    plannedShortfallMonth: nullableString(),
  }),
);

export const BudgetOverview45aDTOSchema = component(
  "BudgetOverview45aDTO",
  z.object({
    monthlyBudgetCents: z.number().int(),
    currentMonthAllocatedCents: z.number().int(),
    currentMonthUsedCents: z.number().int(),
    currentMonthAvailableCents: z.number().int(),
    isCurrentlyActive: z.boolean(),
    label: z.string(),
  }),
);

export const BudgetOverview39_42aDTOSchema = component(
  "BudgetOverview39_42aDTO",
  z.object({
    yearlyBudgetCents: z.number().int(),
    currentYearAllocatedCents: z.number().int(),
    currentYearUsedCents: z.number().int(),
    currentYearAvailableCents: z.number().int(),
    label: z.string(),
  }),
);

export const BudgetOverviewDTOSchema = component(
  "BudgetOverviewDTO",
  z.object({
    entlastungsbetrag45b: BudgetOverview45bDTOSchema,
    umwandlung45a: BudgetOverview45aDTOSchema,
    ersatzpflege39_42a: BudgetOverview39_42aDTOSchema,
  }),
);

// ---------------------------------------------------------------------------
// Compile-time parity guards (Zod ↔ Interface). Brechen `tsc --noEmit`,
// sobald ein Zod-Schema von seinem TS-Interface abweicht.
// ---------------------------------------------------------------------------

type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile-Fehler, wenn `T` nicht exakt `true` ist. */
function assertExact<_T extends true>(): void {}

assertExact<Exact<z.infer<typeof PaginationParamsSchema>, PaginationParams>>();
assertExact<Exact<z.infer<typeof EmployeeListItemSchema>, EmployeeListItem>>();
assertExact<
  Exact<z.infer<typeof InsuranceProviderItemSchema>, InsuranceProviderItem>
>();
assertExact<Exact<z.infer<typeof BirthdayEntrySchema>, BirthdayEntry>>();
assertExact<Exact<z.infer<typeof MissingBreakDaySchema>, MissingBreakDay>>();
assertExact<Exact<z.infer<typeof OpenTasksSummarySchema>, OpenTasksSummary>>();
assertExact<Exact<z.infer<typeof CustomerListItemSchema>, CustomerListItem>>();
assertExact<
  Exact<z.infer<typeof CustomerListParamsSchema>, CustomerListParams>
>();
assertExact<
  Exact<z.infer<typeof CustomerContactItemSchema>, CustomerContactItem>
>();
assertExact<
  Exact<z.infer<typeof BudgetSetupMissingCountSchema>, BudgetSetupMissingCount>
>();
assertExact<
  Exact<z.infer<typeof CreateCustomerRequestSchema>, CreateCustomerRequest>
>();
assertExact<
  Exact<z.infer<typeof BillingCustomerItemSchema>, BillingCustomerItem>
>();
assertExact<Exact<z.infer<typeof InvoiceItemSchema>, InvoiceItem>>();
assertExact<Exact<z.infer<typeof InvoiceDetailSchema>, InvoiceDetail>>();
assertExact<Exact<z.infer<typeof DeliveryRecordSchema>, DeliveryRecord>>();
assertExact<
  Exact<z.infer<typeof BillingInvoicePreviewSchema>, BillingInvoicePreview>
>();
assertExact<
  Exact<z.infer<typeof GenerateInvoiceResponseSchema>, GenerateInvoiceResponse>
>();
assertExact<
  Exact<z.infer<typeof SendInvoiceResponseSchema>, SendInvoiceResponse>
>();
assertExact<
  Exact<z.infer<typeof BatchSendInvoiceResponseSchema>, BatchSendInvoiceResponse>
>();
assertExact<Exact<z.infer<typeof PayerSummarySchema>, PayerSummary>>();
assertExact<
  Exact<z.infer<typeof BulkSendInvoiceResponseSchema>, BulkSendInvoiceResponse>
>();
assertExact<Exact<z.infer<typeof TimeEntrySchema>, TimeEntry>>();
assertExact<Exact<z.infer<typeof TimeEntryWithUserSchema>, TimeEntryWithUser>>();
assertExact<
  Exact<z.infer<typeof CreateTimeEntryRequestSchema>, CreateTimeEntryRequest>
>();
assertExact<
  Exact<z.infer<typeof UpdateTimeEntryRequestSchema>, UpdateTimeEntryRequest>
>();
assertExact<
  Exact<
    z.infer<typeof VacationEntitlementHistoryItemSchema>,
    VacationEntitlementHistoryItem
  >
>();
assertExact<
  Exact<
    z.infer<typeof VacationMonthlyBreakdownItemSchema>,
    VacationMonthlyBreakdownItem
  >
>();
assertExact<Exact<z.infer<typeof VacationSummarySchema>, VacationSummary>>();
assertExact<
  Exact<z.infer<typeof ServiceHoursSummarySchema>, ServiceHoursSummary>
>();
assertExact<Exact<z.infer<typeof TravelSummarySchema>, TravelSummary>>();
assertExact<Exact<z.infer<typeof TimeEntrySummarySchema>, TimeEntrySummary>>();
assertExact<
  Exact<z.infer<typeof BudgetOverview45bDTOSchema>, BudgetOverview45bDTO>
>();
assertExact<
  Exact<z.infer<typeof BudgetOverview45aDTOSchema>, BudgetOverview45aDTO>
>();
assertExact<
  Exact<z.infer<typeof BudgetOverview39_42aDTOSchema>, BudgetOverview39_42aDTO>
>();
assertExact<Exact<z.infer<typeof BudgetOverviewDTOSchema>, BudgetOverviewDTO>>();

// ---------------------------------------------------------------------------
// Path registration — kuratierte Auswahl der wichtigsten Endpunkte. Die
// Components oben sind das Hauptdeliverable (vollständige Wire-Shapes); die
// Pfade dokumentieren beispielhaft, wie sie an Endpunkten hängen.
// ---------------------------------------------------------------------------

function jsonResponse(schema: z.ZodTypeAny, description: string) {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

function registerPaths(): void {
  registry.registerPath({
    method: "get",
    path: "/api/customers",
    summary: "Kundenliste (paginiert, filterbar)",
    tags: ["Customers"],
    request: {
      query: CustomerListParamsSchema,
    },
    responses: {
      200: jsonResponse(z.array(CustomerListItemSchema), "Liste der Kunden"),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/admin/customers",
    summary: "Kunde anlegen",
    tags: ["Customers"],
    request: {
      body: {
        content: { "application/json": { schema: CreateCustomerRequestSchema } },
      },
    },
    responses: {
      201: jsonResponse(
        CustomerListItemSchema,
        "Angelegter Kunde (Wire-Shape vereinfacht)",
      ),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/budget/{customerId}/overview",
    summary: "Budget-Übersicht (Drei-Topf-Ledger)",
    tags: ["Budget"],
    request: {
      params: z.object({ customerId: z.string() }),
    },
    responses: {
      200: jsonResponse(BudgetOverviewDTOSchema, "Budget-Übersicht je Topf"),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/billing/customers",
    summary: "Abrechnungsfähige Kunden",
    tags: ["Billing"],
    responses: {
      200: jsonResponse(
        z.array(BillingCustomerItemSchema),
        "Kunden mit Abrechnungsstatus",
      ),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/api/billing/generate",
    summary: "Rechnung(en) erzeugen",
    tags: ["Billing"],
    responses: {
      200: jsonResponse(
        GenerateInvoiceResponseSchema,
        "Erzeugte Rechnung(en)",
      ),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/api/employees",
    summary: "Mitarbeiterliste",
    tags: ["Employees"],
    responses: {
      200: jsonResponse(z.array(EmployeeListItemSchema), "Liste der Mitarbeiter"),
    },
  });
}

/** Baut das vollständige OpenAPI-3.0-Dokument. */
export function buildOpenApiDocument(): ReturnType<
  OpenApiGeneratorV3["generateDocument"]
> {
  registerPaths();
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.0",
    info: {
      title: "CareConnect API",
      version: "1.0.0",
      description:
        "Maschinenlesbare API-Oberfläche, generiert aus Zod-Schemas " +
        "(Schema-First). Quelle: shared/api/openapi.ts. Nicht von Hand " +
        "editieren — `npm run gen:openapi` ausführen.",
    },
    servers: [{ url: "/", description: "CareConnect" }],
  });
}
