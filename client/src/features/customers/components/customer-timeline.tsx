import { useQuery } from "@tanstack/react-query";
import { api, unwrapResult } from "@/lib/api/client";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { SectionCard } from "@/components/patterns/section-card";
import { Loader2, Clock, UserCheck, FileText, Wallet, ShieldCheck, Pencil, UserPlus, Undo2, Trash2, CalendarCheck, ArrowRightLeft, Phone, Mail, StickyNote, RefreshCw } from "lucide-react";
import { iconSize } from "@/design-system";

interface TimelineEntry {
  id: number;
  action: string;
  userName: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
}

interface ProspectTimelineEntry {
  phase: "akquise" | "kunde";
  type: string;
  text: string;
  createdAt: string;
  userId?: number | null;
}

interface ProspectTimeline {
  prospectId: number | null;
  entries: ProspectTimelineEntry[];
}

const ACTION_CONFIG: Record<string, { label: string; icon: typeof Clock; color: string }> = {
  customer_created: { label: "Kunde angelegt", icon: UserPlus, color: "text-green-600" },
  customer_updated: { label: "Kundendaten geändert", icon: Pencil, color: "text-blue-600" },
  customer_care_level_changed: { label: "Pflegegrad geändert", icon: ShieldCheck, color: "text-purple-600" },
  customer_contract_updated: { label: "Vertrag aktualisiert", icon: FileText, color: "text-amber-600" },
  customer_anonymized: { label: "Kundendaten anonymisiert", icon: Trash2, color: "text-red-600" },
  prospect_converted: { label: "Aus Interessent konvertiert", icon: ArrowRightLeft, color: "text-teal-600" },
  budget_manual_adjustment: { label: "Budget manuell angepasst", icon: Wallet, color: "text-indigo-600" },
  budget_reversal: { label: "Buchung storniert", icon: Undo2, color: "text-orange-600" },
  budget_type_settings_updated: { label: "Budget-Einstellungen geändert", icon: Wallet, color: "text-indigo-600" },
  budget_preferences_updated: { label: "Budget-Präferenzen geändert", icon: Wallet, color: "text-indigo-600" },
  budget_initial_setup: { label: "Budget eingerichtet", icon: Wallet, color: "text-green-600" },
  initial_balance_set: { label: "Anfangssaldo gesetzt", icon: Wallet, color: "text-green-600" },
  initial_balance_deleted: { label: "Anfangssaldo gelöscht", icon: Wallet, color: "text-red-600" },
  documentation_submitted: { label: "Dokumentation eingereicht", icon: CalendarCheck, color: "text-blue-600" },
  appointment_revoked: { label: "Termin storniert", icon: Undo2, color: "text-red-600" },
  appointment_reopened: { label: "Termin wiedereröffnet", icon: CalendarCheck, color: "text-amber-600" },
  service_record_created: { label: "Leistungsnachweis erstellt", icon: FileText, color: "text-blue-600" },
  service_record_signed_employee: { label: "LN vom Mitarbeiter unterschrieben", icon: UserCheck, color: "text-green-600" },
  service_record_signed_customer: { label: "LN vom Kunden unterschrieben", icon: UserCheck, color: "text-green-600" },
  invoice_created: { label: "Rechnung erstellt", icon: FileText, color: "text-blue-600" },
  invoice_cancelled: { label: "Rechnung storniert", icon: Undo2, color: "text-red-600" },
};

const PROSPECT_NOTE_CONFIG: Record<string, { label: string; icon: typeof Clock; color: string }> = {
  anruf: { label: "Anruf", icon: Phone, color: "text-blue-600" },
  email: { label: "E-Mail", icon: Mail, color: "text-purple-600" },
  notiz: { label: "Notiz", icon: StickyNote, color: "text-amber-600" },
  statuswechsel: { label: "Statuswechsel", icon: RefreshCw, color: "text-teal-600" },
  conversion: { label: "Vertragsabschluss", icon: ArrowRightLeft, color: "text-green-700" },
};

function getDetailText(entry: TimelineEntry): string | null {
  const meta = entry.metadata;
  if (!meta) return null;

  switch (entry.action) {
    case "customer_updated": {
      const fields = meta.changedFields as string[] | undefined;
      if (fields && fields.length > 0) {
        const FIELD_LABELS: Record<string, string> = {
          vorname: "Vorname", nachname: "Nachname", telefon: "Telefon",
          email: "E-Mail", strasse: "Straße", plz: "PLZ", stadt: "Stadt",
          pflegegrad: "Pflegegrad", status: "Status", billingType: "Abrechnungsart",
          geburtsdatum: "Geburtsdatum",
        };
        const labeled = fields.map(f => FIELD_LABELS[f] || f);
        return labeled.join(", ");
      }
      return null;
    }
    case "customer_care_level_changed": {
      const old = meta.oldPflegegrad as number | null;
      const neu = meta.newPflegegrad as number;
      return old ? `PG ${old} → PG ${neu}` : `PG ${neu} zugewiesen`;
    }
    case "customer_created": {
      const name = meta.customerName as string | undefined;
      return name || null;
    }
    default:
      return null;
  }
}

function ConversionDivider({ date }: { date: string }) {
  return (
    <div className="relative flex items-center py-3" data-testid="timeline-conversion-divider">
      <div className="flex-1 border-t-2 border-teal-400 border-dashed" />
      <div className="flex items-center gap-2 px-3 py-1.5 bg-teal-50 border-2 border-teal-400 rounded-full">
        <ArrowRightLeft className="h-3.5 w-3.5 text-teal-700" />
        <span className="text-xs font-semibold text-teal-700">
          Vertragsabschluss am {formatDateForDisplay(date.substring(0, 10))}
        </span>
      </div>
      <div className="flex-1 border-t-2 border-teal-400 border-dashed" />
    </div>
  );
}

function ProspectPhaseSection({ entries }: { entries: ProspectTimelineEntry[] }) {
  const noteEntries = entries.filter(e => e.type !== "conversion");
  if (noteEntries.length === 0) return null;

  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Akquise-Phase</span>
      </div>
      <div className="relative space-y-0">
        {noteEntries.map((entry, index) => {
          const config = PROSPECT_NOTE_CONFIG[entry.type] || { label: entry.type, icon: StickyNote, color: "text-gray-500" };
          const Icon = config.icon;
          const isLast = index === noteEntries.length - 1;

          return (
            <div key={`prospect-${index}`} className="relative flex gap-3 pb-4" data-testid={`timeline-prospect-entry-${index}`}>
              <div className="flex flex-col items-center">
                <div className={`rounded-full p-1.5 bg-white border-2 border-current ${config.color} z-10`}>
                  <Icon className="h-3.5 w-3.5" />
                </div>
                {!isLast && (
                  <div className="w-px flex-1 bg-gray-200 mt-1" />
                )}
              </div>
              <div className="flex-1 min-w-0 pt-0.5">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className="text-sm font-medium">{config.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatDateForDisplay(String(entry.createdAt).substring(0, 10))}
                  </span>
                </div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {entry.text}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function CustomerTimeline({ customerId }: { customerId: number }) {
  const { data: timeline, isLoading: auditLoading } = useQuery<TimelineEntry[]>({
    queryKey: ["customer-timeline", customerId],
    queryFn: async () => {
      const result = await api.get<TimelineEntry[]>(`/admin/customers/${customerId}/timeline`);
      return unwrapResult(result);
    },
    staleTime: 30_000,
  });

  const { data: prospectTimeline } = useQuery<ProspectTimeline>({
    queryKey: ["customer-prospect-timeline", customerId],
    queryFn: async () => {
      const result = await api.get<ProspectTimeline>(`/customers/${customerId}/timeline`);
      return unwrapResult(result);
    },
    staleTime: 30_000,
  });

  if (auditLoading) {
    return (
      <SectionCard title="Verlauf" icon={<Clock className={iconSize.sm} />}>
        <div className="flex items-center justify-center py-8 text-muted-foreground">
          <Loader2 className={`${iconSize.sm} animate-spin mr-2`} />
          Wird geladen...
        </div>
      </SectionCard>
    );
  }

  const hasAuditEntries = timeline && timeline.length > 0;
  const hasProspectEntries = prospectTimeline?.entries && prospectTimeline.entries.length > 0;
  const conversionEntry = prospectTimeline?.entries?.find(e => e.type === "conversion");

  if (!hasAuditEntries && !hasProspectEntries) {
    return (
      <SectionCard title="Verlauf" icon={<Clock className={iconSize.sm} />}>
        <p className="text-sm text-muted-foreground py-4" data-testid="text-timeline-empty">
          Noch keine Einträge vorhanden.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Verlauf" icon={<Clock className={iconSize.sm} />}>
      {hasProspectEntries && (
        <>
          <ProspectPhaseSection entries={prospectTimeline!.entries} />
          {conversionEntry && (
            <ConversionDivider date={String(conversionEntry.createdAt)} />
          )}
        </>
      )}

      {hasAuditEntries && (
        <div className="relative space-y-0" data-testid="customer-timeline">
          {hasProspectEntries && (
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Kundenphase</span>
            </div>
          )}
          {timeline!.map((entry, index) => {
            const config = ACTION_CONFIG[entry.action] || { label: entry.action, icon: Clock, color: "text-gray-500" };
            const Icon = config.icon;
            const detail = getDetailText(entry);
            const isLast = index === timeline!.length - 1;

            return (
              <div key={entry.id} className="relative flex gap-3 pb-4" data-testid={`timeline-entry-${entry.id}`}>
                <div className="flex flex-col items-center">
                  <div className={`rounded-full p-1.5 bg-white border-2 border-current ${config.color} z-10`}>
                    <Icon className="h-3.5 w-3.5" />
                  </div>
                  {!isLast && (
                    <div className="w-px flex-1 bg-gray-200 mt-1" />
                  )}
                </div>
                <div className="flex-1 min-w-0 pt-0.5">
                  <div className="flex items-baseline gap-2 flex-wrap">
                    <span className="text-sm font-medium">{config.label}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateForDisplay(String(entry.createdAt).substring(0, 10))}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    von {entry.userName}
                  </div>
                  {detail && (
                    <div className="text-xs text-muted-foreground mt-0.5 italic">
                      {detail}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}
