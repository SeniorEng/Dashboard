/**
 * API Response Types
 *
 * Re-exports shared API types for frontend consumption.
 * Canonical definitions live in @shared/api/.
 */

export type {
  PaginatedResponse,
  EmployeeListItem,
  CustomerListItem,
  CustomerListParams,
  CustomerContactItem,
  CustomerDetail,
  CreateCustomerRequest,
  InsuranceProviderItem,
  TimeEntryType,
  TimeEntry,
  TimeEntryWithUser,
  CreateTimeEntryRequest,
  UpdateTimeEntryRequest,
  VacationSummary,
  AppointmentWithCustomerName,
  TimeOverviewData,
  TimesPageData,
} from "@shared/api";
