import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SectionCard } from "@/components/patterns/section-card";
import { Stethoscope, AlertTriangle, AlertCircle, CheckCircle2, ChevronDown, ChevronRight } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import type {
  DocumentationDiagnosis,
  DiagnosisSeverity,
} from "@shared/domain/documentation-diagnostics";

interface DiagnosisService {
  id: number;
  serviceName: string;
  serviceCode: string | null;
  plannedDurationMinutes: number;
  actualDurationMinutes: number | null;
  details: string | null;
}

interface DiagnosisAuditEntry {
  id: number;
  action: string;
  userId: number;
  userName: string;
  createdAt: string;
  metadata: unknown;
}

interface DiagnosisResponse {
  appointmentId: number;
  status: string;
  date: string;
  scheduledStart: string;
  scheduledEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  assignedEmployeeId: number | null;
  performedByEmployeeId: number | null;
  signature: {
    hasSignatureData: boolean;
    signatureHash: string | null;
    signedAt: string | null;
    signedByUserId: number | null;
  };
  travel: {
    travelKilometers: number | null;
    travelMinutes: number | null;
    customerKilometers: number | null;
  };
  services: DiagnosisService[];
  documentedServicesCount: number;
  auditEntries: DiagnosisAuditEntry[];
  diagnosis: DocumentationDiagnosis;
}

const SEVERITY_CLASSES: Record<DiagnosisSeverity, string> = {
  info: "bg-emerald-50 border-emerald-200 text-emerald-800",
  warning: "bg-amber-50 border-amber-200 text-amber-800",
  error: "bg-red-50 border-red-200 text-red-800",
};

const SEVERITY_ICONS: Record<DiagnosisSeverity, React.ComponentType<{ className?: string }>> = {
  info: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

const ACTION_LABELS: Record<string, string> = {
  appointment_created: "Termin angelegt",
  appointment_updated: "Termin bearbeitet",
  appointment_deleted: "Termin gelöscht",
  appointment_revoked: "Unterschrift storniert",
  appointment_reopened: "Dokumentation wieder geöffnet",
  appointment_expired_unsigned: "Auf \u201ENicht abgerechnet\u201C gesetzt",
  appointment_no_show_documented: "Vergebliche Anfahrt dokumentiert",
  documentation_submitted: "Dokumentation gespeichert",
  documentation_signature_added: "Unterschrift erfasst",
};

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatTime(value: string | null): string {
  if (!value) return "—";
  return value.slice(0, 5);
}

export function AppointmentDocumentationDiagnosis({ appointmentId }: { appointmentId: number }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, error } = useQuery<DiagnosisResponse>({
    queryKey: ["appointment-diagnose", appointmentId],
    queryFn: async () => {
      const result = await api.get<DiagnosisResponse>(`/appointments/${appointmentId}/diagnose`);
      return unwrapResult(result);
    },
    enabled: appointmentId > 0 && open,
  });

  return (
    <SectionCard
      title="Doku-Diagnose"
      icon={<Stethoscope className="h-4 w-4" />}
      className="mb-4"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-sm text-left text-muted-foreground hover:text-foreground"
        data-testid="button-diagnose-toggle"
      >
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <span>{open ? "Diagnose ausblenden" : "Diagnose anzeigen"}</span>
      </button>

      {open && (
        <div className="mt-3">
          {isLoading && (
            <p className="text-sm text-muted-foreground" data-testid="text-diagnose-loading">
              Diagnose wird geladen…
            </p>
          )}
          {isError && (
            <p className="text-sm text-destructive" data-testid="text-diagnose-error">
              {error instanceof Error ? error.message : "Diagnose konnte nicht geladen werden."}
            </p>
          )}
          {data && <DiagnosisContent data={data} />}
        </div>
      )}
    </SectionCard>
  );
}

function DiagnosisContent({ data }: { data: DiagnosisResponse }) {
  const SeverityIcon = SEVERITY_ICONS[data.diagnosis.severity];

  return (
    <div className="space-y-4">
      <div
        className={`rounded-md border p-3 flex items-start gap-2 ${SEVERITY_CLASSES[data.diagnosis.severity]}`}
        data-testid="diagnose-verdict"
      >
        <SeverityIcon className="h-4 w-4 mt-0.5 flex-shrink-0" />
        <div className="text-sm">
          <div className="font-medium">{data.diagnosis.message}</div>
          <div className="text-xs opacity-70 mt-1">Code: {data.diagnosis.code}</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <div className="text-muted-foreground">Status</div>
        <div data-testid="text-diagnose-status">{data.status}</div>

        <div className="text-muted-foreground">Geplant</div>
        <div>
          {formatTime(data.scheduledStart)} – {formatTime(data.scheduledEnd)}
        </div>

        <div className="text-muted-foreground">Tatsächlich</div>
        <div data-testid="text-diagnose-actual">
          {formatTime(data.actualStart)} – {formatTime(data.actualEnd)}
        </div>

        <div className="text-muted-foreground">Zugewiesen</div>
        <div>{data.assignedEmployeeId ?? "—"}</div>

        <div className="text-muted-foreground">Durchgeführt von</div>
        <div data-testid="text-diagnose-performed-by">{data.performedByEmployeeId ?? "—"}</div>

        <div className="text-muted-foreground">signatureData</div>
        <div data-testid="text-diagnose-signature-data">
          {data.signature.hasSignatureData ? "gesetzt" : "nicht gesetzt"}
        </div>

        <div className="text-muted-foreground">signatureHash</div>
        <div data-testid="text-diagnose-signature-hash">
          {data.signature.signatureHash ? "gesetzt" : "nicht gesetzt"}
        </div>

        <div className="text-muted-foreground">signedAt</div>
        <div data-testid="text-diagnose-signed-at">
          {data.signature.signedAt ? formatTimestamp(data.signature.signedAt) : "nicht gesetzt"}
        </div>

        <div className="text-muted-foreground">signedByUserId</div>
        <div data-testid="text-diagnose-signed-by">
          {data.signature.signedByUserId ?? "nicht gesetzt"}
        </div>

        <div className="text-muted-foreground">Anfahrt</div>
        <div>
          {data.travel.travelKilometers ?? 0} km
          {data.travel.travelMinutes != null ? `, ${data.travel.travelMinutes} Min` : ""}
        </div>
      </div>

      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Services ({data.documentedServicesCount} von {data.services.length} dokumentiert)
        </div>
        {data.services.length === 0 ? (
          <div className="text-xs text-muted-foreground" data-testid="text-diagnose-no-services">
            Keine Services hinterlegt.
          </div>
        ) : (
          <ul className="text-xs space-y-1" data-testid="list-diagnose-services">
            {data.services.map((s) => (
              <li key={s.id} className="flex justify-between gap-2">
                <span>{s.serviceName}</span>
                <span className="text-muted-foreground">
                  {s.actualDurationMinutes ?? "—"} / {s.plannedDurationMinutes} Min
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div>
        <div className="text-xs font-medium text-muted-foreground mb-1">
          Letzte Audit-Einträge ({data.auditEntries.length})
        </div>
        {data.auditEntries.length === 0 ? (
          <div className="text-xs text-muted-foreground" data-testid="text-diagnose-no-audit">
            Keine Audit-Einträge zu diesem Termin gefunden.
          </div>
        ) : (
          <ul className="text-xs space-y-1" data-testid="list-diagnose-audit">
            {data.auditEntries.map((entry) => (
              <li key={entry.id} className="flex flex-col">
                <span>
                  <span className="font-medium">
                    {ACTION_LABELS[entry.action] ?? entry.action}
                  </span>
                  <span className="text-muted-foreground"> · {entry.userName}</span>
                </span>
                <span className="text-muted-foreground">{formatTimestamp(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
