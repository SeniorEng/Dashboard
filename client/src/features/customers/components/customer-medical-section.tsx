import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/patterns/status-badge";
import { isChild } from "@shared/utils/datetime";
import {
  Loader2, Pencil, Save, Stethoscope, ClipboardList,
} from "lucide-react";
import { iconSize } from "@/design-system";
import type { Customer } from "@shared/schema";
import type { EditSection } from "@/features/customers/hooks/use-customer-detail-form";

interface CustomerMedicalSectionProps {
  customer: Customer;
  editingSection: EditSection;
  pflegegradForm: { pflegegrad: string; seitDatum: string };
  setPflegegradForm: React.Dispatch<React.SetStateAction<{ pflegegrad: string; seitDatum: string }>>;
  handleSavePflegegrad: () => void;
  medicalForm: string;
  setMedicalForm: React.Dispatch<React.SetStateAction<string>>;
  handleSaveMedical: () => void;
  servicesForm: string;
  setServicesForm: React.Dispatch<React.SetStateAction<string>>;
  handleSaveServices: () => void;
  isSaving: boolean;
  cancelEditing: () => void;
  startEditing: (section: EditSection) => void;
  vereinbarteLeistungen: string | null | undefined;
}

export function CustomerMedicalSection({
  customer,
  editingSection,
  pflegegradForm,
  setPflegegradForm,
  handleSavePflegegrad,
  medicalForm,
  setMedicalForm,
  handleSaveMedical,
  servicesForm,
  setServicesForm,
  handleSaveServices,
  isSaving,
  cancelEditing,
  startEditing,
  vereinbarteLeistungen,
}: CustomerMedicalSectionProps) {
  const hasPflegegrad = customer.pflegegrad && customer.pflegegrad > 0;

  return (
    <>
      <Card className="mb-4" data-testid="card-pflegegrad">
        <CardContent className="p-4">
          {editingSection === "pflegegrad" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold">Pflegegrad ändern</h2>
              </div>
              <p className="text-xs text-amber-600">Änderungen werden mit Datum historisiert und sind abrechnungsrelevant.</p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Pflegegrad</Label>
                  <Select value={pflegegradForm.pflegegrad} onValueChange={(v) => setPflegegradForm(f => ({ ...f, pflegegrad: v }))}>
                    <SelectTrigger data-testid="select-pflegegrad">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {[1,2,3,4,5].map(g => (
                        <SelectItem key={g} value={String(g)}>Pflegegrad {g}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>Gültig seit</Label>
                  <Input
                    type="date"
                    value={pflegegradForm.seitDatum}
                    onChange={(e) => setPflegegradForm(f => ({ ...f, seitDatum: e.target.value }))}
                    data-testid="input-pflegegrad-seit"
                  />
                </div>
              </div>
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSavePflegegrad} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-pflegegrad">
                  {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                </Button>
                <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-pflegegrad">
                  Abbrechen
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 flex-wrap">
                {hasPflegegrad ? (
                  <StatusBadge type="pflegegrad" value={customer.pflegegrad!} data-testid="badge-pflegegrad" />
                ) : (
                  <span className="text-xs text-muted-foreground/60">Kein Pflegegrad</span>
                )}
                {isChild(customer.geburtsdatum) && (
                  <StatusBadge type="warning" value="Minderjährig" data-testid="badge-minor" />
                )}
              </div>
              <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={() => startEditing("pflegegrad")} data-testid="button-edit-pflegegrad">
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4" data-testid="card-medical-history">
        <CardContent className="p-4">
          {editingSection === "medical" ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <Stethoscope className={`${iconSize.sm} text-rose-500`} />
                Vorerkrankungen bearbeiten
              </h2>
              <Textarea
                value={medicalForm}
                onChange={(e) => setMedicalForm(e.target.value)}
                placeholder="Bekannte Vorerkrankungen..."
                rows={4}
                data-testid="textarea-medical"
              />
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSaveMedical} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-medical">
                  {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                </Button>
                <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-medical">
                  Abbrechen
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <Stethoscope className={`${iconSize.sm} text-rose-500`} />
                  Vorerkrankungen
                </h2>
                <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={() => startEditing("medical")} data-testid="button-edit-medical">
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground whitespace-pre-line" data-testid="text-medical-history">
                {customer.vorerkrankungen || "Keine Angabe"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4" data-testid="card-agreed-services">
        <CardContent className="p-4">
          {editingSection === "services" ? (
            <div className="space-y-3">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <ClipboardList className={`${iconSize.sm} text-green-600`} />
                Vereinbarte Leistungen bearbeiten
              </h2>
              <Textarea
                value={servicesForm}
                onChange={(e) => setServicesForm(e.target.value)}
                placeholder="Vereinbarte Leistungen..."
                rows={4}
                data-testid="textarea-services"
              />
              <div className="flex gap-2 pt-1">
                <Button size="sm" onClick={handleSaveServices} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-services">
                  {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
                </Button>
                <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-services">
                  Abbrechen
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-sm font-semibold flex items-center gap-2">
                  <ClipboardList className={`${iconSize.sm} text-green-600`} />
                  Vereinbarte Leistungen
                </h2>
                <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={() => startEditing("services")} data-testid="button-edit-services">
                  <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </div>
              <p className="text-sm text-muted-foreground whitespace-pre-line" data-testid="text-agreed-services">
                {vereinbarteLeistungen || "Keine Angabe"}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
