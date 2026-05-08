import { SectionCard } from "@/components/patterns";
import { Switch } from "@/components/ui/switch";
import { Bell, Volume2 } from "lucide-react";
import { iconSize } from "@/design-system";
import {
  useBrowserNotificationPermission,
  useBrowserPushToggle,
  useSoundToggle,
} from "@/hooks/use-browser-notifications";

export function BrowserNotificationsSection() {
  const { permission, request } = useBrowserNotificationPermission();
  const { enabled: pushEnabled, setEnabled: setPushEnabled } = useBrowserPushToggle();
  const { enabled: soundEnabled, setEnabled: setSoundEnabled } = useSoundToggle();

  const supported = permission !== "unsupported";
  const granted = permission === "granted";
  const denied = permission === "denied";

  const handlePushToggle = async (next: boolean) => {
    setPushEnabled(next);
    if (next && permission === "default") {
      await request();
    }
  };

  return (
    <SectionCard title="Browser-Benachrichtigungen" icon={<Bell className={iconSize.sm} />}>
      <div className="space-y-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-medium">Pop-ups vom Browser</p>
            <p className="text-xs text-muted-foreground">
              Zeigt eine System-Benachrichtigung an, sobald ein neuer Eintrag eintrifft —
              auch wenn der Tab im Hintergrund liegt.
            </p>
            {!supported && (
              <p className="text-xs text-amber-700 mt-1">
                Dein Browser unterstützt diese Funktion nicht.
              </p>
            )}
            {denied && (
              <p className="text-xs text-amber-700 mt-1">
                Pushes wurden im Browser blockiert. Bitte in den Browser-Einstellungen
                wieder erlauben.
              </p>
            )}
            {!granted && supported && !denied && pushEnabled && (
              <button
                type="button"
                onClick={() => void request()}
                className="mt-2 text-xs font-medium text-primary hover:underline"
                data-testid="button-request-browser-permission"
              >
                Berechtigung anfragen
              </button>
            )}
          </div>
          <Switch
            checked={pushEnabled && supported && !denied}
            onCheckedChange={(v) => void handlePushToggle(v)}
            disabled={!supported || denied}
            data-testid="switch-browser-push"
          />
        </div>

        <div className="flex items-start justify-between gap-3 border-t pt-4">
          <div className="min-w-0">
            <p className="text-sm font-medium flex items-center gap-1.5">
              <Volume2 className="h-4 w-4 text-muted-foreground" />
              Pling-Ton bei neuen Einträgen
            </p>
            <p className="text-xs text-muted-foreground">
              Spielt einen kurzen Hinweiston ab. Standardmäßig ausgeschaltet.
            </p>
          </div>
          <Switch
            checked={soundEnabled}
            onCheckedChange={setSoundEnabled}
            data-testid="switch-notification-sound"
          />
        </div>
      </div>
    </SectionCard>
  );
}
