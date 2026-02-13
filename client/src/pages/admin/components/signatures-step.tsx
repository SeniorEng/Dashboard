import { Card, CardContent } from "@/components/ui/card";
import { FileText, PenTool, Shield } from "lucide-react";
import { iconSize } from "@/design-system";

const SIGNATURE_DOCUMENTS = [
  {
    id: "kundenvertrag",
    title: "Kundenvertrag",
    description: "Der Vertrag über die vereinbarten Betreuungsleistungen.",
    icon: FileText,
  },
  {
    id: "forderungsabtretung",
    title: "Forderungsabtretung",
    description: "Abtretungserklärung zur direkten Abrechnung mit der Pflegekasse.",
    icon: PenTool,
  },
  {
    id: "datenschutzerklaerung",
    title: "Datenschutzerklärung",
    description: "Einwilligung zur Verarbeitung personenbezogener Daten gemäß DSGVO.",
    icon: Shield,
  },
];

export function SignaturesStep() {
  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Folgende Dokumente müssen vom Kunden und Mitarbeiter unterschrieben werden.
      </p>

      <div className="space-y-4">
        {SIGNATURE_DOCUMENTS.map((doc) => (
          <Card key={doc.id} className="border-dashed border-2 border-gray-300" data-testid={`signature-doc-${doc.id}`}>
            <CardContent className="p-4">
              <div className="flex items-start gap-3">
                <div className="flex items-center justify-center w-10 h-10 rounded-full bg-gray-100 text-gray-400 shrink-0">
                  <doc.icon className={iconSize.md} />
                </div>
                <div className="flex-1">
                  <h4 className="font-medium text-gray-900">{doc.title}</h4>
                  <p className="text-sm text-gray-500 mt-1">{doc.description}</p>
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <p className="text-xs text-amber-700">
                      Unterschriftsfunktion wird in Kürze verfügbar sein.
                    </p>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg">
        <p className="text-xs text-gray-500">
          Die digitale Unterschrift wird in einem zukünftigen Update implementiert. Sie können den Kunden trotzdem anlegen und die Unterschriften später nachholen.
        </p>
      </div>
    </div>
  );
}
