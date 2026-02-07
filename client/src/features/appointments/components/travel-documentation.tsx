import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Car, Home, MapPin } from "lucide-react";
import { iconSize } from "@/design-system";

interface TravelDocumentationProps {
  travelOriginType: "home" | "appointment";
  onTravelOriginTypeChange: (value: "home" | "appointment") => void;
  travelKilometers: number;
  onTravelKilometersChange: (value: number) => void;
  travelMinutes: number;
  onTravelMinutesChange: (value: number) => void;
  previousCustomerName?: string | null;
  notes: string;
  onNotesChange: (value: string) => void;
}

export function TravelDocumentation({
  travelOriginType,
  onTravelOriginTypeChange,
  travelKilometers,
  onTravelKilometersChange,
  travelMinutes,
  onTravelMinutesChange,
  previousCustomerName,
  notes,
  onNotesChange,
}: TravelDocumentationProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-lg flex items-center gap-2">
          <Car className={`${iconSize.md} text-primary`} />
          Anfahrt dokumentieren
        </CardTitle>
        <CardDescription>
          Woher kamen Sie zu diesem Termin?
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <RadioGroup
          value={travelOriginType}
          onValueChange={(value) => onTravelOriginTypeChange(value as "home" | "appointment")}
          className="space-y-3"
        >
          <div className={`flex items-center space-x-3 p-3 rounded-lg border ${travelOriginType === "home" ? "border-primary bg-primary/5" : "border-border"}`}>
            <RadioGroupItem value="home" id="origin-home" data-testid="radio-origin-home" />
            <Label htmlFor="origin-home" className="flex items-center gap-2 cursor-pointer flex-1">
              <Home className={`${iconSize.sm} text-muted-foreground`} />
              <span className="font-medium">Von zu Hause</span>
            </Label>
          </div>
          
          <div className={`flex items-center space-x-3 p-3 rounded-lg border ${travelOriginType === "appointment" ? "border-primary bg-primary/5" : "border-border"}`}>
            <RadioGroupItem value="appointment" id="origin-appointment" data-testid="radio-origin-appointment" />
            <Label htmlFor="origin-appointment" className="flex items-center gap-2 cursor-pointer flex-1">
              <MapPin className={`${iconSize.sm} text-muted-foreground`} />
              <div>
                <span className="font-medium">Vom vorherigen Kunden</span>
                {previousCustomerName && (
                  <p className="text-xs text-muted-foreground">
                    {previousCustomerName}
                  </p>
                )}
              </div>
            </Label>
          </div>
        </RadioGroup>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="kilometers">Gefahrene Kilometer (Anfahrt)</Label>
            <div className="relative">
              <Input
                id="kilometers"
                type="number"
                min="0"
                step="0.1"
                value={travelKilometers || ""}
                onChange={(e) => onTravelKilometersChange(parseFloat(e.target.value) || 0)}
                placeholder="0"
                className="pr-12"
                data-testid="input-kilometers"
              />
              <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                km
              </span>
            </div>
          </div>
          
          {travelOriginType === "appointment" && (
            <div className="space-y-2">
              <Label htmlFor="travelMinutes">Fahrzeit</Label>
              <div className="relative">
                <Input
                  id="travelMinutes"
                  type="number"
                  min="0"
                  value={travelMinutes || ""}
                  onChange={(e) => onTravelMinutesChange(parseInt(e.target.value) || 0)}
                  placeholder="0"
                  className="pr-12"
                  data-testid="input-travel-minutes"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                  Min.
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="notes">Zusätzliche Notizen (optional)</Label>
          <Textarea
            id="notes"
            value={notes}
            onChange={(e) => onNotesChange(e.target.value)}
            placeholder="Weitere Anmerkungen zum Termin..."
            rows={3}
            data-testid="textarea-notes"
          />
        </div>
      </CardContent>
    </Card>
  );
}
