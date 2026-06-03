import { ServiceSelector } from "./service-selector";
import { FahrtdienstDetails, type FahrtdienstState } from "./fahrtdienst-panel";
import { AppointmentSummary } from "./appointment-summary";
import { CostEstimatePreview, type CostEstimate } from "./cost-estimate-preview";

export interface EditAppointmentSummary {
  startTime: string;
  endTime: string;
  totalFormatted: string;
  services?: Array<{ name: string; duration: number }>;
  totalMinutes?: number;
  hasServices?: boolean;
}

interface EditAppointmentServicesSectionProps {
  services: Array<{ serviceId: number; durationMinutes: number }>;
  setServices: (services: Array<{ serviceId: number; durationMinutes: number }>) => void;
  errors: Record<string, string>;
  fahrtdienst: FahrtdienstState;
  setFahrtdienst: (state: FahrtdienstState) => void;
  effectiveCustomerLat: number | null;
  effectiveCustomerLng: number | null;
  handlePickupTimeCalculated: (
    pickupTime: string,
    travelMinutes: number,
    bufferMinutes: number,
    distanceKm: number,
    doctorLat?: number,
    doctorLng?: number,
  ) => void;
  time: string;
  setTime: (value: string) => void;
  isGeocodingCustomer: boolean;
  geocodingError: string | null;
  summary: EditAppointmentSummary | null;
  costEstimate: CostEstimate | null | undefined;
  billingType: string | null | undefined;
}

export function EditAppointmentServicesSection({
  services,
  setServices,
  errors,
  fahrtdienst,
  setFahrtdienst,
  effectiveCustomerLat,
  effectiveCustomerLng,
  handlePickupTimeCalculated,
  time,
  setTime,
  isGeocodingCustomer,
  geocodingError,
  summary,
  costEstimate,
  billingType,
}: EditAppointmentServicesSectionProps) {
  return (
    <div className="space-y-4">
      <ServiceSelector
        services={services}
        onChange={setServices}
        error={errors.services}
        renderAlltagsbegleitungDetails={() => (
          <FahrtdienstDetails
            fahrtdienst={fahrtdienst}
            onChange={setFahrtdienst}
            customerLat={effectiveCustomerLat}
            customerLng={effectiveCustomerLng}
            onPickupTimeCalculated={handlePickupTimeCalculated}
            currentStartTime={time}
            onApplyPickupTime={setTime}
            errors={errors}
            isGeocodingCustomer={isGeocodingCustomer}
            geocodingError={geocodingError}
          />
        )}
      />

      {summary && summary.hasServices && (
        <AppointmentSummary
          startTime={summary.startTime}
          endTime={summary.endTime}
          services={summary.services || []}
          totalFormatted={summary.totalFormatted}
        />
      )}

      <CostEstimatePreview
        costEstimate={costEstimate}
        billingType={billingType}
      />
    </div>
  );
}
