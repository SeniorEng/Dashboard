import { Mail, Truck, AlertCircle, Check } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { CustomerFormData } from "./customer-types";

interface DeliveryStepProps {
  formData: CustomerFormData;
  onChange: (field: keyof CustomerFormData, value: any) => void;
}

const OPTIONS = [
  {
    value: "email" as const,
    icon: Mail,
    title: "Per E-Mail",
    description: "Der Kunde erhält alle Vertragsunterlagen digital per E-Mail.",
    color: "teal",
  },
  {
    value: "post" as const,
    icon: Truck,
    title: "Per Deutsche Post",
    description: "Der Kunde erhält alle Vertragsunterlagen ausgedruckt per Post.",
    color: "amber",
  },
];

export function DeliveryStep({ formData, onChange }: DeliveryStepProps) {
  const isEmailSelected = formData.documentDeliveryMethod === "email";
  const hasEmail = !!formData.email.trim();

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Wie möchte der Kunde die unterschriebenen Vertragsunterlagen erhalten?
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {OPTIONS.map((option) => {
          const isSelected = formData.documentDeliveryMethod === option.value;
          const Icon = option.icon;
          const borderClass = isSelected
            ? option.color === "teal"
              ? "border-teal-500 bg-teal-50 ring-2 ring-teal-200"
              : "border-amber-500 bg-amber-50 ring-2 ring-amber-200"
            : "border-gray-200 bg-white hover:border-gray-300";
          const iconBgClass = isSelected
            ? option.color === "teal"
              ? "bg-teal-100 text-teal-600"
              : "bg-amber-100 text-amber-600"
            : "bg-gray-100 text-gray-500";

          return (
            <button
              key={option.value}
              type="button"
              onClick={() => onChange("documentDeliveryMethod", option.value)}
              className={`flex flex-col items-center gap-3 p-6 rounded-xl border-2 transition-all cursor-pointer text-center ${borderClass}`}
              data-testid={`button-delivery-${option.value}`}
            >
              <div className={`p-3 rounded-full ${iconBgClass}`}>
                <Icon className="h-8 w-8" />
              </div>
              <div>
                <p className="font-semibold text-base text-gray-900">{option.title}</p>
                <p className="text-sm text-gray-500 mt-1">{option.description}</p>
              </div>
            </button>
          );
        })}
      </div>

      {isEmailSelected && !hasEmail && (
        <div className="p-4 rounded-lg bg-amber-50 border border-amber-200 space-y-3">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
            <p className="text-sm text-amber-800">
              Für den E-Mail-Versand wird eine E-Mail-Adresse benötigt. Bitte hier nacherfassen:
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delivery-email">E-Mail-Adresse *</Label>
            <Input
              id="delivery-email"
              type="email"
              value={formData.email}
              onChange={(e) => onChange("email", e.target.value)}
              placeholder="kunde@beispiel.de"
              className="bg-white"
              data-testid="input-delivery-email"
            />
          </div>
        </div>
      )}

      {isEmailSelected && hasEmail && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-50 border border-green-200">
          <Check className="h-4 w-4 text-green-600 shrink-0" />
          <p className="text-sm text-green-800">
            Versand an: <span className="font-medium">{formData.email}</span>
          </p>
        </div>
      )}
    </div>
  );
}
