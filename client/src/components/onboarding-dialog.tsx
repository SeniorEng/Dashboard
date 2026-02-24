import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { api, unwrapResult } from "@/lib/api/client";
import {
  Calendar,
  Users,
  CheckSquare,
  FileSignature,
  Clock,
  ArrowRight,
  ArrowLeft,
  Sparkles,
  Rocket,
} from "lucide-react";

interface OnboardingStep {
  icon: React.ElementType;
  iconColor: string;
  iconBg: string;
  title: string;
  description: string;
}

const STEPS: OnboardingStep[] = [
  {
    icon: Sparkles,
    iconColor: "text-primary",
    iconBg: "bg-primary/10",
    title: "Willkommen bei CareConnect!",
    description:
      "CareConnect hilft dir, deinen Arbeitsalltag in der Pflege effizient zu organisieren. In dieser kurzen Tour zeigen wir dir die wichtigsten Bereiche.",
  },
  {
    icon: Calendar,
    iconColor: "text-blue-600",
    iconBg: "bg-blue-50",
    title: "Termine",
    description:
      "Hier findest du deine Tagesplanung. Du siehst alle Termine auf einen Blick, kannst neue Termine anlegen und erledigte Einsätze direkt dokumentieren.",
  },
  {
    icon: Users,
    iconColor: "text-emerald-600",
    iconBg: "bg-emerald-50",
    title: "Kunden",
    description:
      "Verwalte deine Kunden mit allen wichtigen Informationen — Pflegegrad, Versicherung, Kontaktdaten und Vertragsinformationen. Alles an einem Ort.",
  },
  {
    icon: CheckSquare,
    iconColor: "text-amber-600",
    iconBg: "bg-amber-50",
    title: "Aufgaben",
    description:
      "Deine persönliche Aufgabenliste und Systemhinweise. Hier siehst du offene Dokumentationen, ausstehende Unterschriften und andere wichtige Aufgaben.",
  },
  {
    icon: FileSignature,
    iconColor: "text-purple-600",
    iconBg: "bg-purple-50",
    title: "Nachweise",
    description:
      "Erstelle und verwalte monatliche Leistungsnachweise für deine Kunden. Mit digitaler Unterschrift — direkt auf dem Handy.",
  },
  {
    icon: Clock,
    iconColor: "text-rose-600",
    iconBg: "bg-rose-50",
    title: "Zeiten",
    description:
      "Erfasse deine Arbeitszeiten — für Kundentermine, interne Aufgaben und Urlaub. Alles wird automatisch zusammengefasst.",
  },
  {
    icon: Rocket,
    iconColor: "text-primary",
    iconBg: "bg-primary/10",
    title: "Los geht's!",
    description:
      "Du bist bereit! Bei Fragen hilft dir dein Administrator gerne weiter. Wir wünschen dir viel Erfolg mit CareConnect.",
  },
];

export function OnboardingDialog({ open, onComplete }: { open: boolean; onComplete: () => void }) {
  const [step, setStep] = useState(0);
  const queryClient = useQueryClient();

  const completeMutation = useMutation({
    mutationFn: async () => {
      const result = await api.post("/auth/onboarding/complete", {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
      onComplete();
    },
    onError: () => {
      onComplete();
    },
  });

  const currentStep = STEPS[step];
  const isFirst = step === 0;
  const isLast = step === STEPS.length - 1;
  const Icon = currentStep.icon;

  const handleComplete = () => {
    completeMutation.mutate();
  };

  const handleSkip = () => {
    completeMutation.mutate();
  };

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-md p-0 gap-0 [&>button]:hidden"
        onPointerDownOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <div className="flex flex-col items-center text-center px-6 pt-8 pb-6">
          <div className={`w-16 h-16 rounded-2xl ${currentStep.iconBg} flex items-center justify-center mb-5`}>
            <Icon className={`w-8 h-8 ${currentStep.iconColor}`} />
          </div>

          <h2 className="text-xl font-bold text-gray-900 mb-2" data-testid="text-onboarding-title">
            {currentStep.title}
          </h2>

          <p className="text-sm text-gray-600 leading-relaxed max-w-sm" data-testid="text-onboarding-description">
            {currentStep.description}
          </p>
        </div>

        <div className="flex items-center justify-center gap-1.5 pb-4">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                i === step ? "w-6 bg-primary" : "w-1.5 bg-gray-200"
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between px-6 pb-6 pt-2">
          {isFirst ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSkip}
              disabled={completeMutation.isPending}
              data-testid="button-onboarding-skip"
            >
              Überspringen
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setStep((s) => s - 1)}
              data-testid="button-onboarding-back"
            >
              <ArrowLeft className="w-4 h-4 mr-1" />
              Zurück
            </Button>
          )}

          {isLast ? (
            <Button
              onClick={handleComplete}
              disabled={completeMutation.isPending}
              data-testid="button-onboarding-finish"
            >
              Loslegen
              <Rocket className="w-4 h-4 ml-1" />
            </Button>
          ) : (
            <Button
              onClick={() => setStep((s) => s + 1)}
              data-testid="button-onboarding-next"
            >
              Weiter
              <ArrowRight className="w-4 h-4 ml-1" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
