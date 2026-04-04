/**
 * API Response Types
 * 
 * Re-exports shared API types for frontend consumption.
 * Canonical definitions live in @shared/api/.
 */

export type {
  PaginationParams,
  PaginatedResponse,
  EmployeeListItem,
  CustomerListItem,
  CustomerListParams,
  CustomerPricingInfo,
  BudgetSummaryInfo,
  CustomerBudgetsInfo,
  CustomerNeedsAssessmentInfo,
  CustomerContractInfo,
  CustomerContactItem,
  CustomerCareLevelHistoryItem,
  CustomerDetail,
  CreateCustomerRequest,
  InsuranceProviderItem,
  TimeEntryType,
  TimeEntry,
  TimeEntryWithUser,
  CreateTimeEntryRequest,
  UpdateTimeEntryRequest,
  VacationSummary,
  AppointmentServiceBreakdown,
  AppointmentWithCustomerName,
  ServiceHoursSummary,
  TravelSummary,
  TimeEntrySummary,
  TimeOverviewData,
  TimesPageData,
} from "@shared/api";

export type { AppointmentWithCustomer } from "@shared/api";
