import { BILLING_TYPES, BILLING_TYPE_LABELS, BILLING_TYPE_DESCRIPTIONS, type BillingType } from "@shared/domain/customers";
import { Building2, Shield, User } from "lucide-react";
import { iconSize } from "@/design-system";

interface CustomerTypeStepProps {
  selectedType: BillingType;
  onChange: (type: BillingType) => void;
}

const BILLING_TYPE_ICONS: Record<BillingType, typeof Building2> = {
  pflegekasse_gesetzlich: Shield,
  pflegekasse_privat: Building2,
  selbstzahler: User,
};

const BILLING_TYPE_COLORS: Record<BillingType, { border: string; bg: string; ring: string }> = {
  pflegekasse_gesetzlich: { border: "border-blue-300", bg: "bg-blue-50", ring: "ring-blue-400" },
  pflegekasse_privat: { border: "border-purple-300", bg: "bg-purple-50", ring: "ring-purple-400" },
  selbstzahler: { border: "border-amber-300", bg: "bg-amber-50", ring: "ring-amber-400" },
};

export function CustomerTypeStep({ selectedType, onChange }: CustomerTypeStepProps) {
  return (
    <div className="space-y-4">
      <div className="text-center mb-6">
        <h2 className="text-lg font-semibold text-gray-900">Welche Art von Kunde?</h2>
        <p className="text-sm text-gray-500 mt-1">
          Die Auswahl bestimmt, welche Schritte und Dokumente benötigt werden.
        </p>
      </div>

      <div className="grid gap-3">
        {BILLING_TYPES.map((type) => {
          const isSelected = selectedType === type;
          const Icon = BILLING_TYPE_ICONS[type];
          const colors = BILLING_TYPE_COLORS[type];

          return (
            <button
              key={type}
              type="button"
              onClick={() => onChange(type)}
              className={`w-full text-left p-4 rounded-lg border-2 transition-all ${
                isSelected
                  ? `${colors.border} ${colors.bg} ring-2 ${colors.ring}`
                  : "border-gray-200 hover:border-gray-300 bg-white"
              }`}
              data-testid={`card-billing-type-${type}`}
            >
              <div className="flex items-start gap-3">
                <div className={`mt-0.5 p-2 rounded-lg ${isSelected ? colors.bg : "bg-gray-100"}`}>
                  <Icon className={`${iconSize.md} ${isSelected ? "text-gray-800" : "text-gray-500"}`} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">
                      {BILLING_TYPE_LABELS[type]}
                    </span>
                    {isSelected && (
                      <span className="text-xs font-medium text-teal-700 bg-teal-100 px-2 py-0.5 rounded-full">
                        Ausgewählt
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    {BILLING_TYPE_DESCRIPTIONS[type]}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
