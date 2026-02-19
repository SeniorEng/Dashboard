import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { iconSize, colors } from "@/design-system";

export default function NotFound() {
  return (
    <div className={`min-h-screen w-full flex items-center justify-center ${colors.surface.page}`}>
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex mb-4 gap-2">
            <AlertCircle className={`${iconSize.xl} text-red-500`} />
            <h1 className="text-2xl font-bold text-gray-900">404 – Seite nicht gefunden</h1>
          </div>

          <p className="mt-4 text-sm text-gray-600">
            Die angeforderte Seite existiert nicht oder wurde verschoben.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
