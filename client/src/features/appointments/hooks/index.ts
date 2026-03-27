export { useAppointments, useAppointment, useDeleteAppointment, useWeekAppointmentCounts } from "./use-appointments";
export { useCreateKundentermin, useCreateErstberatung, useDocumentAppointment, useTravelSuggestion, useRouteCalculation } from "./use-appointment-mutations";
export { useCustomerList, type CustomerWithAccess } from "./use-customer-list";
export { useActiveEmployees, useAdminEmployees } from "./use-active-employees";
export { useDocumentationForm, type ServiceFormData, type DocumentationFormData } from "./use-documentation-form";
export { useNewAppointmentForm } from "./use-new-appointment-form";
export { useAppointmentCoverage, type CoverageData } from "./use-appointment-coverage";
export {
  useAppointmentSeriesList,
  useAppointmentSeriesDetail,
  useCreateAppointmentSeries,
  useUpdateSeriesAppointment,
  useDeleteSeriesAppointment,
  useExtendSeries,
  useShortenSeries,
  useEndSeries,
  formatWeekdays,
  formatSeriesInfo,
  WEEKDAY_LABELS,
  WEEKDAY_FULL_LABELS,
  type SeriesWithDetails,
  type SeriesDetailResponse,
} from "./use-appointment-series";
