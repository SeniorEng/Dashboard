import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { AddressAutocomplete } from "@/components/address-autocomplete";
import { Car, Clock, MapPin, Building2, Loader2, AlertTriangle, Home } from "lucide-react";
import { iconSize } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";

interface TravelTimeResult {
  distanceKm: number;
  durationMinutes: number;
  bufferMinutes: number;
  pickupTime: string;
}

export interface FahrtdienstState {
  enabled: boolean;
  doctorName: string;
  doctorAppointmentTime: string;
  doctorStrasse: string;
  doctorNr: string;
  doctorPlz: string;
  doctorStadt: string;
}

interface FahrtdienstPanelProps {
  fahrtdienst: FahrtdienstState;
  onChange: (state: FahrtdienstState) => void;
  customerLat?: number | null;
  customerLng?: number | null;
  onPickupTimeCalculated?: (pickupTime: string, travelMinutes: number, bufferMinutes: number, distanceKm: number, doctorLat?: number, doctorLng?: number) => void;
  errors?: Record<string, string>;
  isGeocodingCustomer?: boolean;
  geocodingError?: string | null;
}

export function FahrtdienstPanel({
  fahrtdienst,
  onChange,
  customerLat,
  customerLng,
  onPickupTimeCalculated,
  errors,
  isGeocodingCustomer,
  geocodingError,
}: FahrtdienstPanelProps) {
  const [debouncedParams, setDebouncedParams] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canCalculate =
    fahrtdienst.enabled &&
    fahrtdienst.doctorAppointmentTime &&
    fahrtdienst.doctorStrasse &&
    fahrtdienst.doctorPlz &&
    fahrtdienst.doctorStadt &&
    customerLat &&
    customerLng;

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!canCalculate) {
      setDebouncedParams(null);
      return;
    }
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams({
        fromLat: String(customerLat),
        fromLng: String(customerLng),
        toStrasse: fahrtdienst.doctorStrasse,
        toPlz: fahrtdienst.doctorPlz,
        toStadt: fahrtdienst.doctorStadt,
        doctorAppointmentTime: fahrtdienst.doctorAppointmentTime,
      });
      if (fahrtdienst.doctorNr) {
        params.set("toNr", fahrtdienst.doctorNr);
      }
      setDebouncedParams(params.toString());
    }, 800);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [
    canCalculate,
    customerLat,
    customerLng,
    fahrtdienst.doctorStrasse,
    fahrtdienst.doctorNr,
    fahrtdienst.doctorPlz,
    fahrtdienst.doctorStadt,
    fahrtdienst.doctorAppointmentTime,
  ]);

  const { data: travelTime, isLoading: travelLoading, isError: travelError } = useQuery<TravelTimeResult>({
    queryKey: ["/api/travel-time", debouncedParams],
    queryFn: async () => {
      const result = await api.get<TravelTimeResult>(`/travel-time?${debouncedParams}`);
      return unwrapResult(result);
    },
    enabled: !!debouncedParams,
    staleTime: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (travelTime && onPickupTimeCalculated) {
      onPickupTimeCalculated(
        travelTime.pickupTime,
        travelTime.durationMinutes,
        travelTime.bufferMinutes,
        travelTime.distanceKm
      );
    }
  }, [travelTime, onPickupTimeCalculated]);

  const updateField = (field: keyof FahrtdienstState, value: string | boolean) => {
    onChange({ ...fahrtdienst, [field]: value });
  };

  const handleAddressSelect = useCallback((address: { strasse: string; hausnummer: string; plz: string; stadt: string }) => {
    onChange({
      ...fahrtdienst,
      doctorStrasse: address.strasse,
      doctorNr: address.hausnummer,
      doctorPlz: address.plz,
      doctorStadt: address.stadt,
    });
  }, [fahrtdienst, onChange]);

  if (!fahrtdienst.enabled) {
    return (
      <div className="rounded-lg border p-4" data-testid="panel-fahrtdienst">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Car className={`${iconSize.sm} text-primary`} />
            <Label htmlFor="fahrtdienst-toggle" className="font-medium cursor-pointer">
              Fahrtdienst (Arztbegleitung)
            </Label>
          </div>
          <Switch
            id="fahrtdienst-toggle"
            checked={false}
            onCheckedChange={(checked) => updateField("enabled", checked)}
            data-testid="switch-fahrtdienst-toggle"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-4" data-testid="panel-fahrtdienst">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Car className={`${iconSize.sm} text-primary`} />
          <Label htmlFor="fahrtdienst-toggle" className="font-medium cursor-pointer text-primary">
            Fahrtdienst (Arztbegleitung)
          </Label>
        </div>
        <Switch
          id="fahrtdienst-toggle"
          checked={true}
          onCheckedChange={(checked) => updateField("enabled", checked)}
          data-testid="switch-fahrtdienst-toggle"
        />
      </div>

      <div className="space-y-4 pt-2 border-t border-primary/10">
        <div className="space-y-2">
          <Label htmlFor="fd-doctor-time">
            <Clock className={`${iconSize.sm} inline mr-1`} /> Arzt-Termin Uhrzeit *
          </Label>
          <Input
            id="fd-doctor-time"
            type="time"
            value={fahrtdienst.doctorAppointmentTime}
            onChange={(e) => updateField("doctorAppointmentTime", e.target.value)}
            className="text-base"
            data-testid="input-doctor-time"
          />
          {errors?.doctorAppointmentTime && (
            <p className="text-xs text-destructive">{errors.doctorAppointmentTime}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="fd-doctor-name">
            <Building2 className={`${iconSize.sm} inline mr-1`} /> Arzt / Praxis (optional)
          </Label>
          <Input
            id="fd-doctor-name"
            type="text"
            placeholder="z.B. Dr. Müller, Kardiologe"
            value={fahrtdienst.doctorName}
            onChange={(e) => updateField("doctorName", e.target.value)}
            maxLength={200}
            data-testid="input-doctor-name"
          />
        </div>

        <div className="space-y-2">
          <Label>
            <MapPin className={`${iconSize.sm} inline mr-1`} /> Arzt-Adresse *
          </Label>
          <div className="grid grid-cols-4 gap-2">
            <div className="col-span-3">
              <AddressAutocomplete
                id="fd-doctor-strasse"
                value={fahrtdienst.doctorStrasse}
                onChange={(val) => updateField("doctorStrasse", val)}
                onAddressSelect={handleAddressSelect}
                placeholder="Straße"
                data-testid="input-doctor-strasse"
              />
              {errors?.doctorStrasse && (
                <p className="text-xs text-destructive mt-1">{errors.doctorStrasse}</p>
              )}
            </div>
            <div>
              <Input
                placeholder="Nr."
                value={fahrtdienst.doctorNr}
                onChange={(e) => updateField("doctorNr", e.target.value)}
                maxLength={20}
                data-testid="input-doctor-nr"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <Input
                placeholder="PLZ"
                value={fahrtdienst.doctorPlz}
                onChange={(e) => updateField("doctorPlz", e.target.value.replace(/\D/g, "").slice(0, 5))}
                maxLength={5}
                inputMode="numeric"
                data-testid="input-doctor-plz"
              />
              {errors?.doctorPlz && (
                <p className="text-xs text-destructive mt-1">{errors.doctorPlz}</p>
              )}
            </div>
            <div className="col-span-2">
              <Input
                placeholder="Ort"
                value={fahrtdienst.doctorStadt}
                onChange={(e) => updateField("doctorStadt", e.target.value)}
                data-testid="input-doctor-stadt"
              />
              {errors?.doctorStadt && (
                <p className="text-xs text-destructive mt-1">{errors.doctorStadt}</p>
              )}
            </div>
          </div>
        </div>

        {isGeocodingCustomer && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm" data-testid="geocoding-customer-loading">
            <Loader2 className={`${iconSize.sm} animate-spin`} />
            <span>Kundenadresse wird geprüft...</span>
          </div>
        )}

        {geocodingError && (
          <div className="flex items-center gap-2 text-amber-600 text-sm" data-testid="geocoding-customer-error">
            <AlertTriangle className={iconSize.sm} />
            <span>{geocodingError}</span>
          </div>
        )}

        {!isGeocodingCustomer && !geocodingError && !customerLat && !customerLng && fahrtdienst.doctorStrasse && (
          <div className="flex items-center gap-2 text-amber-600 text-sm" data-testid="warning-no-customer-coords">
            <AlertTriangle className={iconSize.sm} />
            <span>Kundenadresse hat keine Koordinaten — Fahrtzeit kann nicht berechnet werden.</span>
          </div>
        )}

        {travelLoading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm" data-testid="travel-loading">
            <Loader2 className={`${iconSize.sm} animate-spin`} />
            <span>Fahrtzeit wird berechnet...</span>
          </div>
        )}

        {travelError && canCalculate && !travelLoading && (
          <div className="flex items-center gap-2 text-amber-600 text-sm" data-testid="travel-error">
            <AlertTriangle className={iconSize.sm} />
            <span>Fahrtzeit konnte nicht berechnet werden. Bitte Adressen prüfen.</span>
          </div>
        )}

        {travelTime && !travelLoading && (
          <div className="rounded-lg bg-white/80 border border-primary/20 p-3 space-y-2" data-testid="travel-result">
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Home className="h-3.5 w-3.5" /> Abholzeit
              </span>
              <span className="font-semibold text-primary text-base" data-testid="text-pickup-time">
                {travelTime.pickupTime} Uhr
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Car className="h-3.5 w-3.5" /> Fahrtzeit
              </span>
              <span data-testid="text-travel-duration">
                ~{travelTime.durationMinutes} Min. ({travelTime.distanceKm} km)
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="h-3.5 w-3.5" /> Puffer
              </span>
              <span data-testid="text-travel-buffer">
                +{travelTime.bufferMinutes} Min.
              </span>
            </div>
            <div className="flex items-center justify-between text-sm border-t border-primary/10 pt-2">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <Building2 className="h-3.5 w-3.5" /> Arzt-Termin
              </span>
              <span className="font-medium" data-testid="text-doctor-time">
                {fahrtdienst.doctorAppointmentTime} Uhr
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
