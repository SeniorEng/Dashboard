import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Loader2, PawPrint, Pencil, Save,
} from "lucide-react";
import { iconSize } from "@/design-system";
import type { Customer } from "@shared/schema";
import type { EditSection } from "@/features/customers/hooks/use-customer-detail-form";

interface CustomerPetsSectionProps {
  customer: Customer;
  editingSection: EditSection;
  petForm: { haustierVorhanden: boolean; haustierDetails: string };
  setPetForm: React.Dispatch<React.SetStateAction<{ haustierVorhanden: boolean; haustierDetails: string }>>;
  handleSavePet: () => void;
  isSaving: boolean;
  cancelEditing: () => void;
  startEditing: (section: EditSection) => void;
}

export function CustomerPetsSection({
  customer,
  editingSection,
  petForm,
  setPetForm,
  handleSavePet,
  isSaving,
  cancelEditing,
  startEditing,
}: CustomerPetsSectionProps) {
  return (
    <Card className="mb-4" data-testid="card-pet">
      <CardContent className="p-4">
        {editingSection === "pet" ? (
          <div className="space-y-3">
            <h2 className="text-sm font-semibold flex items-center gap-2">
              <PawPrint className={`${iconSize.sm} text-amber-600`} />
              Haustier bearbeiten
            </h2>
            <div className="flex items-center gap-3">
              <Switch
                checked={petForm.haustierVorhanden}
                onCheckedChange={(checked) => setPetForm(f => ({ ...f, haustierVorhanden: checked }))}
                data-testid="switch-pet"
              />
              <Label>{petForm.haustierVorhanden ? "Haustier vorhanden" : "Kein Haustier"}</Label>
            </div>
            {petForm.haustierVorhanden && (
              <div>
                <Label>Details (Art, Name, Hinweise)</Label>
                <Input
                  value={petForm.haustierDetails}
                  onChange={(e) => setPetForm(f => ({ ...f, haustierDetails: e.target.value }))}
                  placeholder="z.B. Hund, freundlich"
                  data-testid="input-pet-details"
                />
              </div>
            )}
            <div className="flex gap-2 pt-1">
              <Button size="sm" onClick={handleSavePet} disabled={isSaving} className="min-h-[36px]" data-testid="button-save-pet">
                {isSaving ? <Loader2 className={`${iconSize.sm} animate-spin`} /> : <><Save className={`${iconSize.sm} mr-1`} />Speichern</>}
              </Button>
              <Button size="sm" variant="outline" onClick={cancelEditing} disabled={isSaving} className="min-h-[36px]" data-testid="button-cancel-pet">
                Abbrechen
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold flex items-center gap-2">
                <PawPrint className={`${iconSize.sm} text-amber-600`} />
                Haustier
              </h2>
              <Button variant="ghost" size="sm" className="min-h-[44px] min-w-[44px] p-0" onClick={() => startEditing("pet")} data-testid="button-edit-pet">
                <Pencil className="h-3.5 w-3.5 text-muted-foreground" />
              </Button>
            </div>
            <p className="text-sm text-muted-foreground" data-testid="text-pet-details">
              {customer.haustierVorhanden
                ? (customer.haustierDetails || "Ja, keine weiteren Details")
                : "Kein Haustier"}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
