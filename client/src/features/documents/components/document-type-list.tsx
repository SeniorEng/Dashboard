import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Loader2,
  Pencil,
  FileCheck2,
  CalendarClock,
  Bell,
  Users,
  User,
  FileText,
  Upload,
  PenTool,
  Shield,
  RotateCcw,
  Info,
} from "lucide-react";
import { iconSize } from "@/design-system";
import { CONTEXT_OPTIONS } from "../constants";
import type { DocumentTypeData } from "../types";

interface DocumentTypeListProps {
  isLoading: boolean;
  filterTarget: string;
  filteredDocTypes: DocumentTypeData[] | undefined;
  onEdit: (dt: DocumentTypeData) => void;
}

export function DocumentTypeList({
  isLoading,
  filterTarget,
  filteredDocTypes,
  onEdit,
}: DocumentTypeListProps) {
  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {filteredDocTypes?.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-gray-500">
            {filterTarget === "all"
              ? "Noch keine Dokumententypen definiert. Erstellen Sie den ersten Typ."
              : `Keine Dokumententypen für ${filterTarget === "employee" ? "Mitarbeiter" : "Kunden"} gefunden.`
            }
          </CardContent>
        </Card>
      )}
      {filteredDocTypes?.map((dt) => (
        <Card key={dt.id} className={!dt.isActive ? "opacity-60" : ""} data-testid={`card-doctype-${dt.id}`}>
          <CardContent className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <FileCheck2 className={`${iconSize.sm} text-amber-600 shrink-0`} />
                  <span className="font-semibold text-gray-900">{dt.name}</span>
                  <span className={`text-xs px-2 py-0.5 rounded inline-flex items-center gap-1 ${
                    dt.targetType === "customer"
                      ? "bg-blue-100 text-blue-700"
                      : "bg-purple-100 text-purple-700"
                  }`}>
                    {dt.targetType === "customer" ? (
                      <><User className="h-3 w-3" /> Kunde</>
                    ) : (
                      <><Users className="h-3 w-3" /> Mitarbeiter</>
                    )}
                  </span>
                  {dt.isMandatory && (
                    <span className="text-xs px-2 py-0.5 rounded bg-amber-100 text-amber-700 inline-flex items-center gap-1">
                      <Shield className="h-3 w-3" /> Pflicht
                    </span>
                  )}
                  {!dt.isActive && (
                    <span className="text-xs px-2 py-0.5 rounded bg-red-100 text-red-600">Inaktiv</span>
                  )}
                </div>
                {dt.description && (
                  <p className="text-sm text-gray-500 mb-2 ml-6">{dt.description}</p>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 ml-6">
                  <span className="text-xs text-gray-500 flex items-center gap-1">
                    {dt.inputMethod === "info" ? (
                      <><Info className="h-3 w-3 text-blue-500" /> Zur Kenntnisnahme</>
                    ) : dt.inputMethod === "signature" ? (
                      <><PenTool className="h-3 w-3" /> Digitale Unterschrift</>
                    ) : dt.inputMethod === "both" ? (
                      <><FileText className="h-3 w-3" /> Upload oder Unterschrift</>
                    ) : dt.hasTemplate ? (
                      <><FileText className="h-3 w-3 text-teal-600" /> Digitale Vorlage: {dt.templateName}</>
                    ) : (
                      <><Upload className="h-3 w-3" /> Nur Upload</>
                    )}
                  </span>
                  {dt.context !== "beide" && (
                    <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">
                      {CONTEXT_OPTIONS.find(c => c.value === dt.context)?.label || dt.context}
                    </span>
                  )}
                  {dt.renewalDays && (
                    <span className="text-xs text-gray-500 flex items-center gap-1">
                      <RotateCcw className="h-3 w-3" />
                      Wiedervorlage: {dt.renewalDays} Tage
                    </span>
                  )}
                  {dt.reviewIntervalMonths ? (
                    <span className="text-xs text-gray-500 flex items-center gap-1">
                      <CalendarClock className="h-3 w-3" />
                      Prüfung alle {dt.reviewIntervalMonths} Monate
                    </span>
                  ) : (
                    <span className="text-xs text-gray-500">Keine Prüffrist</span>
                  )}
                  {dt.reviewIntervalMonths && dt.reminderLeadTimeDays && (
                    <span className="text-xs text-gray-500 flex items-center gap-1">
                      <Bell className="h-3 w-3" />
                      {dt.reminderLeadTimeDays} {dt.reminderLeadTimeDays === 1 ? 'Tag' : 'Tage'} Vorlauf
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 shrink-0"
                onClick={() => onEdit(dt)}
                data-testid={`button-edit-doctype-${dt.id}`}
              >
                <Pencil className={`${iconSize.sm} text-gray-600`} />
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
