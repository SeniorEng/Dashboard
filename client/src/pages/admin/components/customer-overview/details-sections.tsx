import { useState } from "react";
import { SectionCard } from "@/components/patterns/section-card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { iconSize } from "@/design-system";
import { EditButton, SaveCancelButtons } from "./section-helpers";
import { Stethoscope, PawPrint, Send, Mail, Truck } from "lucide-react";
import type { SectionProps } from "./types";

export function MedicalSection({ customer, customerId, editingSection, setEditingSection, saving, setSaving, invalidateCustomer }: SectionProps) {
  const { toast } = useToast();
  const [vorerkrankungen, setVorerkrankungen] = useState("");

  const initVorerkrankungen = () => {
    setVorerkrankungen(customer.vorerkrankungen || "");
  };

  const handleSaveVorerkrankungen = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        vorerkrankungen: vorerkrankungen.trim() || null,
      });
      unwrapResult(result);
      toast({ title: "Vorerkrankungen gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    initVorerkrankungen();
    setEditingSection("vorerkrankungen");
  };

  return (
    <SectionCard
      title="Vorerkrankungen"
      icon={<Stethoscope className={iconSize.sm} />}
      actions={editingSection !== "vorerkrankungen" ? <EditButton section="vorerkrankungen" editingSection={editingSection} startEditing={startEditing} /> : undefined}
    >
      {editingSection === "vorerkrankungen" ? (
        <div className="space-y-4">
          <Textarea
            value={vorerkrankungen}
            onChange={(e) => setVorerkrankungen(e.target.value)}
            placeholder="Vorerkrankungen des Kunden..."
            rows={3}
            data-testid="input-vorerkrankungen"
          />
          <SaveCancelButtons onSave={handleSaveVorerkrankungen} testIdPrefix="vorerkrankungen" saving={saving} onCancel={() => setEditingSection(null)} />
        </div>
      ) : (
        <p className="text-gray-700 whitespace-pre-wrap" data-testid="text-vorerkrankungen">
          {customer.vorerkrankungen || "Keine Angabe"}
        </p>
      )}
    </SectionCard>
  );
}

export function SpecialFeaturesSection({ customer, customerId, editingSection, setEditingSection, saving, setSaving, invalidateCustomer }: SectionProps) {
  const { toast } = useToast();
  const [besonderheiten, setBesonderheiten] = useState({
    haustierVorhanden: false,
    haustierDetails: "",
  });

  const initBesonderheiten = () => {
    setBesonderheiten({
      haustierVorhanden: customer.haustierVorhanden ?? false,
      haustierDetails: customer.haustierDetails || "",
    });
  };

  const handleSaveBesonderheiten = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        haustierVorhanden: besonderheiten.haustierVorhanden,
        haustierDetails: besonderheiten.haustierVorhanden ? (besonderheiten.haustierDetails?.trim() || null) : null,
      });
      unwrapResult(result);
      toast({ title: "Besonderheiten gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    initBesonderheiten();
    setEditingSection("besonderheiten");
  };

  return (
    <SectionCard
      title="Besonderheiten"
      icon={<PawPrint className={iconSize.sm} />}
      actions={editingSection !== "besonderheiten" ? <EditButton section="besonderheiten" editingSection={editingSection} startEditing={startEditing} /> : undefined}
    >
      {editingSection === "besonderheiten" ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label htmlFor="haustierVorhanden" className="cursor-pointer">Haustier vorhanden</Label>
            <Switch
              id="haustierVorhanden"
              checked={besonderheiten.haustierVorhanden}
              onCheckedChange={(checked) => setBesonderheiten((prev) => ({ ...prev, haustierVorhanden: checked }))}
              data-testid="switch-haustier"
            />
          </div>
          {besonderheiten.haustierVorhanden && (
            <div className="space-y-2">
              <Label htmlFor="haustierDetails">Details zum Haustier</Label>
              <Input
                id="haustierDetails"
                value={besonderheiten.haustierDetails}
                onChange={(e) => setBesonderheiten((prev) => ({ ...prev, haustierDetails: e.target.value }))}
                placeholder="z.B. Hund, Katze..."
                data-testid="input-haustier-details"
              />
            </div>
          )}
          <SaveCancelButtons onSave={handleSaveBesonderheiten} testIdPrefix="besonderheiten" saving={saving} onCancel={() => setEditingSection(null)} />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-gray-700" data-testid="text-haustier">
            <PawPrint className={`${iconSize.sm} text-gray-500`} />
            Haustier: {customer.haustierVorhanden ? "Ja" : "Nein"}
            {customer.haustierVorhanden && customer.haustierDetails && (
              <span className="text-gray-500">({customer.haustierDetails})</span>
            )}
          </div>
        </div>
      )}
    </SectionCard>
  );
}

export function DocumentDeliverySection({ customer, customerId, editingSection, setEditingSection, saving, setSaving, invalidateCustomer }: SectionProps) {
  const { toast } = useToast();
  const [documentDeliveryMethod, setDocumentDeliveryMethod] = useState<"email" | "post">("email");

  const initDocumentDelivery = () => {
    setDocumentDeliveryMethod((customer.documentDeliveryMethod as "email" | "post") || "email");
  };

  const handleSaveDocumentDelivery = async () => {
    setSaving(true);
    try {
      const result = await api.patch(`/admin/customers/${customerId}`, {
        documentDeliveryMethod,
      });
      unwrapResult(result);
      toast({ title: "Versandart gespeichert" });
      invalidateCustomer();
      setEditingSection(null);
    } catch (error: unknown) {
      toast({ variant: "destructive", title: "Fehler", description: error instanceof Error ? error.message : "Speichern fehlgeschlagen." });
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    initDocumentDelivery();
    setEditingSection("versandart");
  };

  return (
    <SectionCard
      title="Versandart Unterlagen"
      icon={<Send className={iconSize.sm} />}
      actions={editingSection !== "versandart" ? <EditButton section="versandart" editingSection={editingSection} startEditing={startEditing} /> : undefined}
    >
      {editingSection === "versandart" ? (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setDocumentDeliveryMethod("email")}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all cursor-pointer text-center ${
                documentDeliveryMethod === "email"
                  ? "border-teal-500 bg-teal-50 ring-2 ring-teal-200"
                  : "border-gray-200 bg-white hover:border-gray-300"
              }`}
              data-testid="button-delivery-email"
            >
              <div className={`p-2 rounded-full ${
                documentDeliveryMethod === "email" ? "bg-teal-100 text-teal-600" : "bg-gray-100 text-gray-500"
              }`}>
                <Mail className="h-6 w-6" />
              </div>
              <div>
                <p className="font-semibold text-sm text-gray-900">Per E-Mail</p>
                <p className="text-xs text-gray-500 mt-0.5">Digital per E-Mail</p>
              </div>
            </button>
            <button
              type="button"
              onClick={() => setDocumentDeliveryMethod("post")}
              className={`flex flex-col items-center gap-2 p-4 rounded-xl border-2 transition-all cursor-pointer text-center ${
                documentDeliveryMethod === "post"
                  ? "border-amber-500 bg-amber-50 ring-2 ring-amber-200"
                  : "border-gray-200 bg-white hover:border-gray-300"
              }`}
              data-testid="button-delivery-post"
            >
              <div className={`p-2 rounded-full ${
                documentDeliveryMethod === "post" ? "bg-amber-100 text-amber-600" : "bg-gray-100 text-gray-500"
              }`}>
                <Truck className="h-6 w-6" />
              </div>
              <div>
                <p className="font-semibold text-sm text-gray-900">Per Post</p>
                <p className="text-xs text-gray-500 mt-0.5">Ausgedruckt per Post</p>
              </div>
            </button>
          </div>
          <SaveCancelButtons onSave={handleSaveDocumentDelivery} testIdPrefix="versandart" saving={saving} onCancel={() => setEditingSection(null)} />
        </div>
      ) : (
        <p className="text-gray-700" data-testid="text-delivery-method">
          {customer.documentDeliveryMethod === "post" ? "Per Deutsche Post (gedruckt)" : "Per E-Mail (digital)"}
        </p>
      )}
    </SectionCard>
  );
}
