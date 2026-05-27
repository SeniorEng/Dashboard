import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  UserCheck,
  UserX,
  Pencil,
  Key,
  Mail,
  ArrowRightLeft,
  ShieldOff,
  MoreHorizontal,
  Palmtree,
  Info,
} from "lucide-react";
import { formatVacationDays } from "@/lib/utils";
import { WorkloadBarTooltip, WorkloadInfoTooltip } from "@/features/team/components/workload-info-tooltip";
import { UserData, ROLE_LABELS, formatPhoneForDisplay } from "@/features/team/components/user-types";
import type { WorkloadMetrics } from "@/features/team/components/workload-metrics";
import type { EmployeeWorkloadResponse } from "@/features/customers/hooks/use-employee-workload";

export interface VacationSummary {
  remainingDays: number;
  usedDays: number;
  plannedDays: number;
  sickDays: number;
}

export interface UserCardProps {
  user: UserData;
  metrics: WorkloadMetrics | null | undefined;
  workloadData: EmployeeWorkloadResponse | undefined;
  vacation: VacationSummary | undefined;
  onEdit: (id: number) => void;
  onResetPassword: (user: UserData) => void;
  onResendWelcome: (id: number) => void;
  resendWelcomePending: boolean;
  onHandover: (user: UserData) => void;
  onToggleActive: (id: number, activate: boolean) => void;
  onAnonymize: (user: UserData) => void;
}

export function UserCard({
  user,
  metrics: m,
  workloadData,
  vacation: vac,
  onEdit,
  onResetPassword,
  onResendWelcome,
  resendWelcomePending,
  onHandover,
  onToggleActive,
  onAnonymize,
}: UserCardProps) {
  const roleTag = user.isAdmin
    ? { label: "ADMIN", cls: "text-teal-700" }
    : user.isTeamLead
    ? { label: "TEAMLEITUNG", cls: "text-indigo-700" }
    : { label: "MITARBEITER", cls: "text-gray-500" };
  const visibleRoles = user.roles.slice(0, 2);
  const moreRoles = user.roles.length - visibleRoles.length;
  const barWidth = m?.auslastungPct != null ? Math.min(m.auslastungPct, 150) / 1.5 : 0;
  const barColor =
    m?.auslastungPct == null
      ? "bg-gray-300"
      : m.auslastungPct > 100
      ? "bg-red-500"
      : m.auslastungPct >= 85
      ? "bg-amber-500"
      : "bg-emerald-500";
  const pctColor =
    m?.auslastungPct == null
      ? "text-gray-400"
      : m.auslastungPct > 100
      ? "text-red-600"
      : m.auslastungPct >= 85
      ? "text-amber-600"
      : "text-emerald-600";

  return (
    <Card
      data-testid={`card-user-${user.id}`}
      className={`rounded-2xl border-gray-200 ${user.isAnonymized ? "opacity-60" : !user.isActive ? "opacity-80" : ""}`}
    >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          <div className="min-w-0 flex-1">
            <div className={`text-base font-bold leading-tight ${user.isAnonymized ? "text-gray-500 italic" : "text-gray-900"}`}>
              {user.displayName}
            </div>
            {!user.isAnonymized && (
              <div className="mt-0.5 flex items-center gap-2 text-xs">
                <span className={`font-semibold tracking-wide ${roleTag.cls}`}>{roleTag.label}</span>
                <span className="text-gray-400">·</span>
                {user.telefon ? (
                  <a href={`tel:${user.telefon}`} className="text-gray-600 hover:text-primary">
                    {formatPhoneForDisplay(user.telefon)}
                  </a>
                ) : (
                  <span className="text-gray-400">–</span>
                )}
                {!user.isActive && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-600 font-semibold uppercase tracking-wide">
                    Inaktiv
                  </span>
                )}
              </div>
            )}
            {user.isAnonymized && (
              <div className="mt-0.5 text-xs">
                <span className="px-1.5 py-0.5 rounded bg-purple-100 text-purple-600 text-[10px] font-semibold uppercase tracking-wide">
                  Anonymisiert
                </span>
              </div>
            )}
          </div>

          {!user.isAnonymized && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 rounded-full border border-gray-200 text-gray-500 shrink-0"
                  data-testid={`button-actions-${user.id}`}
                  aria-label="Aktionen"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel>Aktionen</DropdownMenuLabel>
                <DropdownMenuItem onClick={() => onEdit(user.id)} data-testid={`button-edit-user-${user.id}`}>
                  <Pencil className="h-4 w-4 mr-2 text-gray-600" />
                  Bearbeiten
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onResetPassword(user)} data-testid={`button-reset-password-${user.id}`}>
                  <Key className="h-4 w-4 mr-2 text-gray-600" />
                  Passwort zurücksetzen
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => onResendWelcome(user.id)}
                  disabled={resendWelcomePending}
                  data-testid={`button-resend-welcome-${user.id}`}
                >
                  <Mail className="h-4 w-4 mr-2 text-gray-600" />
                  Willkommens-E-Mail senden
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onHandover(user)} data-testid={`button-handover-${user.id}`}>
                  <ArrowRightLeft className="h-4 w-4 mr-2 text-teal-600" />
                  Kunden &amp; Termine übergeben
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onToggleActive(user.id, !user.isActive)}
                  data-testid={`button-toggle-active-${user.id}`}
                >
                  {user.isActive ? (
                    <>
                      <UserX className="h-4 w-4 mr-2 text-red-500" />
                      Deaktivieren
                    </>
                  ) : (
                    <>
                      <UserCheck className="h-4 w-4 mr-2 text-green-500" />
                      Aktivieren
                    </>
                  )}
                </DropdownMenuItem>
                {!user.isActive && (
                  <DropdownMenuItem
                    onClick={() => onAnonymize(user)}
                    data-testid={`button-anonymize-user-${user.id}`}
                    className="text-purple-600 focus:text-purple-700"
                  >
                    <ShieldOff className="h-4 w-4 mr-2" />
                    DSGVO-Anonymisierung
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {!user.isAnonymized && m && m.hasSoll && (
          <div className="mt-3" data-testid={`workload-stats-${user.id}`}>
            <WorkloadBarTooltip>
              <div className="relative h-2 rounded-full bg-gray-100 overflow-hidden">
                <div
                  className={`h-full ${barColor} transition-all`}
                  style={{ width: `${barWidth}%` }}
                  data-testid={`workload-bar-${user.id}`}
                />
                <div
                  className="absolute top-0 bottom-0 w-px bg-gray-300"
                  style={{ left: `${100 / 1.5}%` }}
                />
              </div>
            </WorkloadBarTooltip>
            <div className="mt-1.5 flex items-center justify-between text-sm">
              <div className="flex items-center gap-1.5 text-gray-700 flex-wrap">
                <span className="font-semibold" data-testid={`workload-hv-primary-${user.id}`}>
                  {m.primaryCount} Kunden
                </span>
                <span className="text-gray-400">·</span>
                <span className="text-gray-500">Soll</span>
                <WorkloadInfoTooltip testId={`tooltip-workload-info-${user.id}`} />
                <span className="font-semibold" data-testid={`workload-soll-${user.id}`}>
                  {m.sollHours}h
                </span>
                {m.hasIstBasis && m.auslastungPct !== null && m.auslastungPct > 100 && (
                  <>
                    <span className="text-gray-400">·</span>
                    <span className="text-red-600 font-semibold" data-testid={`workload-over-${user.id}`}>
                      +{(m.istHours - m.sollHours!).toLocaleString("de-DE", { maximumFractionDigits: 1 })} h über
                    </span>
                  </>
                )}
                {m.freieKunden !== null && m.freieKunden > 0 && (
                  <>
                    <span className="text-gray-400">·</span>
                    <span className="text-emerald-600 font-semibold" data-testid={`workload-zusatzkunden-${user.id}`}>
                      +{m.freieKunden} mögliche Kunden
                    </span>
                  </>
                )}
              </div>
              <span
                className={`font-bold ${pctColor}`}
                data-testid={`workload-auslastung-${user.id}`}
              >
                {m.auslastungPct !== null ? `${m.auslastungPct}%` : "—"}
              </span>
            </div>
          </div>
        )}

        {!user.isAnonymized && !user.isAdmin && workloadData && m && !m.hasSoll && (
          <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-700" data-testid={`workload-soll-missing-${user.id}`}>
            <Info className="h-3.5 w-3.5" />
            <span>Vertragsstunden fehlen</span>
          </div>
        )}

        {!user.isAnonymized && user.roles.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {visibleRoles.map((role) => (
              <span
                key={role}
                className="inline-flex items-center px-2.5 py-1 rounded-md bg-gray-100 text-gray-700 text-xs font-medium"
              >
                {ROLE_LABELS[role] || role}
              </span>
            ))}
            {moreRoles > 0 && (
              <span
                className="inline-flex items-center px-2.5 py-1 rounded-md border border-dashed border-gray-300 text-gray-500 text-xs"
                title={user.roles.slice(2).map((r) => ROLE_LABELS[r] || r).join(", ")}
              >
                +{moreRoles} mehr
              </span>
            )}
          </div>
        )}

        {!user.isAnonymized && vac && (
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-gray-500" data-testid={`vacation-stats-${user.id}`}>
            <Palmtree className="h-3 w-3" />
            <span
              className={`font-medium ${
                vac.remainingDays <= 0
                  ? "text-red-600"
                  : vac.remainingDays <= 3
                  ? "text-amber-600"
                  : "text-emerald-700"
              }`}
              data-testid={`vacation-remaining-${user.id}`}
            >
              {formatVacationDays(vac.remainingDays)} Tage übrig
            </span>
            <span>
              · {vac.usedDays} genommen{vac.plannedDays > 0 ? ` · ${vac.plannedDays} geplant` : ""}
              {vac.sickDays > 0 ? ` · ${vac.sickDays} krank` : ""}
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
