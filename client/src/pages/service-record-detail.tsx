import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SignaturePad, SignatureDisplay } from "@/components/ui/signature-pad";
import { ErrorState } from "@/components/patterns/error-state";
import { 
  ArrowLeft, Loader2, Calendar, Clock, MapPin, User,
  FileText, Check, AlertTriangle, Car
} from "lucide-react";
import { iconSize } from "@/design-system";
import { formatDateForDisplay, formatTimeHHMM } from "@shared/utils/datetime";
import { useToast } from "@/hooks/use-toast";
import { api } from "@/lib/api/client";
import type { MonthlyServiceRecord, Customer } from "@shared/schema";
import type { AppointmentWithCustomer } from "@shared/types";

const MONTH_NAMES = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember"
];

function getStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Warte auf Mitarbeiter-Unterschrift</Badge>;
    case "employee_signed":
      return <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">Warte auf Kundenunterschrift</Badge>;
    case "completed":
      return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">Abgeschlossen</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

export default function ServiceRecordDetailPage() {
  const { toast } = useToast();
  const [, params] = useRoute("/service-records/:id");
  const recordId = params?.id ? parseInt(params.id, 10) : null;
  const queryClient = useQueryClient();
  const [showEmployeeSignature, setShowEmployeeSignature] = useState(false);
  const [showCustomerSignature, setShowCustomerSignature] = useState(false);

  const { data: record, isLoading: recordLoading, error: recordError, refetch } = useQuery<MonthlyServiceRecord>({
    queryKey: ["/api/service-records", recordId],
    queryFn: async () => {
      const response = await fetch(`/api/service-records/${recordId}`);
      if (!response.ok) throw new Error("Leistungsnachweis konnte nicht geladen werden");
      return response.json();
    },
    enabled: !!recordId,
  });

  const { data: customer } = useQuery<Customer>({
    queryKey: ["customer", record?.customerId],
    queryFn: async () => {
      const response = await fetch(`/api/customers/${record?.customerId}`);
      if (!response.ok) throw new Error("Kunde konnte nicht geladen werden");
      return response.json();
    },
    enabled: !!record?.customerId,
  });

  const { data: appointments = [], isLoading: appointmentsLoading } = useQuery<AppointmentWithCustomer[]>({
    queryKey: ["/api/service-records", recordId, "appointments"],
    queryFn: async () => {
      const response = await fetch(`/api/service-records/${recordId}/appointments`);
      if (!response.ok) throw new Error("Termine konnten nicht geladen werden");
      return response.json();
    },
    enabled: !!recordId,
  });

  const { data: employeeMap = {} } = useQuery<Record<number, string>>({
    queryKey: ["employee-names-map"],
    queryFn: async () => {
      const res = await fetch("/api/service-records/employee-names", { credentials: "include" });
      if (!res.ok) return {};
      const employees: { id: number; displayName: string }[] = await res.json();
      const map: Record<number, string> = {};
      employees.forEach(e => { map[e.id] = e.displayName; });
      return map;
    },
  });

  const signMutation = useMutation({
    mutationFn: async ({ signatureData, signerType }: { signatureData: string; signerType: "employee" | "customer" }) => {
      const result = await api.post<MonthlyServiceRecord>(`/service-records/${recordId}/sign`, { signatureData, signerType });
      if (!result.success) {
        throw new Error(result.error.message || "Unterschrift konnte nicht gespeichert werden");
      }
      return result.data;
    },
    onSuccess: (data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/service-records"] });
      toast({
        title: variables.signerType === "employee"
          ? "Mitarbeiter-Unterschrift gespeichert"
          : "Kundenunterschrift gespeichert - Leistungsnachweis abgeschlossen",
      });
      setShowEmployeeSignature(false);
      setShowCustomerSignature(false);
    },
    onError: (error: Error) => {
      toast({ variant: "destructive", title: "Fehler", description: error.message });
    },
  });

  if (recordLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (recordError || !record) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <ErrorState
            title="Leistungsnachweis nicht gefunden"
            description={recordError instanceof Error ? recordError.message : "Der Leistungsnachweis konnte nicht geladen werden."}
            onRetry={() => refetch()}
          />
        </div>
      </Layout>
    );
  }

  const customerName = customer ? `${customer.vorname} ${customer.nachname}` : "Kunde";
  const periodLabel = `${MONTH_NAMES[record.month - 1]} ${record.year}`;

  const handleEmployeeSign = (signatureData: string) => {
    signMutation.mutate({ signatureData, signerType: "employee" });
  };

  const handleCustomerSign = (signatureData: string) => {
    signMutation.mutate({ signatureData, signerType: "customer" });
  };

  const totalMinutes = appointments.reduce((sum, apt) => {
    return sum + 
      (apt.hauswirtschaftActualDauer || 0) + 
      (apt.alltagsbegleitungActualDauer || 0) + 
      (apt.erstberatungActualDauer || 0);
  }, 0);

  const totalTravelKm = appointments.reduce((sum, apt) => sum + (apt.travelKilometers || 0), 0);
  const totalCustomerKm = appointments.reduce((sum, apt) => sum + (apt.customerKilometers || 0), 0);

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-4">
          <Link href="/service-records">
            <Button variant="ghost" size="icon" className="shrink-0" data-testid="button-back">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <div>
            <h1 className="text-xl font-semibold text-foreground" data-testid="text-title">
              Leistungsnachweis
            </h1>
            <p className="text-sm text-muted-foreground">
              {customerName} - {periodLabel}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 mb-6">
          {getStatusBadge(record.status)}
        </div>

        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Zusammenfassung</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="flex items-center gap-2">
                <Calendar className={`${iconSize.sm} text-muted-foreground`} />
                <span>{appointments.length} Termine</span>
              </div>
              <div className="flex items-center gap-2">
                <Clock className={`${iconSize.sm} text-muted-foreground`} />
                <span>{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}min</span>
              </div>
              <div className="flex items-center gap-2">
                <Car className={`${iconSize.sm} text-muted-foreground`} />
                <span>{totalTravelKm} km Anfahrt</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin className={`${iconSize.sm} text-muted-foreground`} />
                <span>{totalCustomerKm} km mit Kunde</span>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Erbrachte Leistungen</CardTitle>
          </CardHeader>
          <CardContent>
            {appointmentsLoading ? (
              <div className="flex justify-center py-4">
                <Loader2 className={`${iconSize.md} animate-spin text-primary`} />
              </div>
            ) : appointments.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                Keine Termine gefunden
              </p>
            ) : (
              <div className="space-y-3">
                {appointments.map((apt) => (
                  <AppointmentSummaryRow key={apt.id} appointment={apt} employeeMap={employeeMap} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-6">
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Unterschriften</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border-b pb-4">
              <h4 className="text-sm font-medium mb-2">Mitarbeiter</h4>
              {record.employeeSignatureData ? (
                <SignatureDisplay
                  signatureData={record.employeeSignatureData}
                  signedAt={record.employeeSignedAt}
                />
              ) : showEmployeeSignature ? (
                <SignaturePad
                  title="Mitarbeiter-Unterschrift"
                  description="Mit meiner Unterschrift bestätige ich die Richtigkeit der oben aufgeführten Leistungen."
                  onSave={handleEmployeeSign}
                  onCancel={() => setShowEmployeeSignature(false)}
                  disabled={signMutation.isPending}
                />
              ) : (
                <Button
                  onClick={() => setShowEmployeeSignature(true)}
                  disabled={record.status !== "pending"}
                  data-testid="button-employee-sign"
                >
                  Unterschreiben
                </Button>
              )}
            </div>

            <div>
              <h4 className="text-sm font-medium mb-2">Kunde: {customerName}</h4>
              {record.customerSignatureData ? (
                <SignatureDisplay
                  signatureData={record.customerSignatureData}
                  signedAt={record.customerSignedAt}
                />
              ) : showCustomerSignature ? (
                <SignaturePad
                  title="Kundenunterschrift"
                  description="Ich bestätige, dass die oben aufgeführten Leistungen erbracht wurden."
                  onSave={handleCustomerSign}
                  onCancel={() => setShowCustomerSignature(false)}
                  disabled={signMutation.isPending}
                />
              ) : (
                <div className="space-y-2">
                  <Button
                    onClick={() => setShowCustomerSignature(true)}
                    disabled={record.status !== "employee_signed"}
                    data-testid="button-customer-sign"
                  >
                    Unterschreiben
                  </Button>
                  {record.status === "pending" && (
                    <p className="text-xs text-muted-foreground">
                      Der Mitarbeiter muss zuerst unterschreiben.
                    </p>
                  )}
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {record.status === "completed" && (
          <div className="flex items-center gap-2 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800">
            <Check className={iconSize.sm} />
            <span className="text-sm font-medium">
              Leistungsnachweis vollständig abgeschlossen
            </span>
          </div>
        )}
      </div>
    </Layout>
  );
}

interface AppointmentSummaryRowProps {
  appointment: AppointmentWithCustomer;
  employeeMap: Record<number, string>;
}

function AppointmentSummaryRow({ appointment, employeeMap }: AppointmentSummaryRowProps) {
  const services: string[] = [];
  
  if (appointment.hauswirtschaftActualDauer) {
    services.push(`Hauswirtschaft: ${appointment.hauswirtschaftActualDauer} min`);
    if (appointment.hauswirtschaftDetails) {
      services.push(`  → ${appointment.hauswirtschaftDetails}`);
    }
  }
  if (appointment.alltagsbegleitungActualDauer) {
    services.push(`Alltagsbegleitung: ${appointment.alltagsbegleitungActualDauer} min`);
    if (appointment.alltagsbegleitungDetails) {
      services.push(`  → ${appointment.alltagsbegleitungDetails}`);
    }
  }
  if (appointment.erstberatungActualDauer) {
    services.push(`Erstberatung: ${appointment.erstberatungActualDauer} min`);
    if (appointment.erstberatungDetails) {
      services.push(`  → ${appointment.erstberatungDetails}`);
    }
  }

  const performerId = appointment.performedByEmployeeId;
  const assignedId = appointment.assignedEmployeeId;
  const showPerformer = performerId && performerId !== assignedId;
  const performerName = performerId ? employeeMap[performerId] : null;

  return (
    <div className="border rounded-lg p-3 bg-muted/30" data-testid={`appointment-row-${appointment.id}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Calendar className={`${iconSize.xs} text-muted-foreground`} />
          {formatDateForDisplay(appointment.date)}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Clock className={iconSize.xs} />
          {formatTimeHHMM(appointment.actualStart || appointment.scheduledStart)} - {formatTimeHHMM(appointment.actualEnd || appointment.scheduledEnd || "")}
        </div>
      </div>

      {showPerformer && (
        <div className="flex items-center gap-1.5 text-xs text-blue-700 bg-blue-50 rounded px-2 py-1 mb-2" data-testid={`performer-${appointment.id}`}>
          <User className={iconSize.xs} />
          <span>Durchgeführt von: {performerName || "Unbekannter Mitarbeiter"}</span>
        </div>
      )}
      
      <div className="space-y-1 text-sm">
        {services.map((service, index) => (
          <p key={index} className={service.startsWith("  →") ? "text-muted-foreground pl-3" : ""}>
            {service}
          </p>
        ))}
      </div>

      {(appointment.travelKilometers || appointment.customerKilometers) && (
        <div className="mt-2 pt-2 border-t flex gap-4 text-xs text-muted-foreground">
          {appointment.travelKilometers && (
            <span>Anfahrt: {appointment.travelKilometers} km</span>
          )}
          {appointment.customerKilometers && (
            <span>Km mit Kunde: {appointment.customerKilometers} km</span>
          )}
        </div>
      )}
    </div>
  );
}
