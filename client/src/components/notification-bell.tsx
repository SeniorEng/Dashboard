import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { Bell } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  NotificationList,
  getNavigationPath,
} from "@/features/notifications/notification-list";
import {
  useNotifications,
  useNotificationVisibilityRefetch,
  useUnreadCount,
} from "@/features/notifications/use-notifications";
import { useDocumentTitleBadge } from "@/hooks/use-document-title-badge";
import {
  useBrowserNotificationPermission,
  useBrowserPushNotifications,
  useBrowserPushToggle,
} from "@/hooks/use-browser-notifications";

const SHAKE_DURATION_MS = 1200;
const SHAKE_DEBOUNCE_MS = 2000;

function formatCount(n: number): string {
  if (n <= 0) return "";
  if (n > 99) return "99+";
  return String(n);
}

export function NotificationBell() {
  const [, navigate] = useLocation();
  const { data: unreadCount = 0 } = useUnreadCount();
  const { data: notifications } = useNotifications();
  useNotificationVisibilityRefetch();
  useDocumentTitleBadge(unreadCount);

  const [open, setOpen] = useState(false);
  const [isShaking, setIsShaking] = useState(false);

  const prevUnreadRef = useRef<number | null>(null);
  const lastShakeAtRef = useRef<number>(0);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (prevUnreadRef.current === null) {
      prevUnreadRef.current = unreadCount;
      return;
    }
    if (unreadCount > prevUnreadRef.current) {
      const now = Date.now();
      if (now - lastShakeAtRef.current >= SHAKE_DEBOUNCE_MS) {
        lastShakeAtRef.current = now;
        setIsShaking(true);
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
        shakeTimerRef.current = setTimeout(() => setIsShaking(false), SHAKE_DURATION_MS);
      }
    }
    prevUnreadRef.current = unreadCount;
  }, [unreadCount]);

  useEffect(() => {
    return () => {
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    };
  }, []);

  const { permission, request } = useBrowserNotificationPermission();
  const { enabled: pushEnabled, setEnabled: setPushEnabled } = useBrowserPushToggle();

  useBrowserPushNotifications({
    unreadCount,
    notifications,
    onNotificationClick: (n) => {
      const path = getNavigationPath(n);
      if (path) navigate(path);
    },
  });

  const showPermissionPrompt = permission === "default" && pushEnabled;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-10 w-10 shrink-0"
          aria-label="Benachrichtigungen"
          data-testid="button-notification-bell"
        >
          <Bell className={`h-5 w-5 ${isShaking ? "animate-bell-shake origin-top" : ""}`} />
          {unreadCount > 0 && (
            <span
              className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center shadow-sm ring-2 ring-white"
              data-testid="text-notification-count"
            >
              {formatCount(unreadCount)}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-[min(380px,calc(100vw-1rem))] p-3"
        data-testid="popover-notification-list"
      >
        <NotificationList
          withCard={false}
          alwaysRender
          onItemClick={() => setOpen(false)}
          footer={
            showPermissionPrompt ? (
              <button
                type="button"
                onClick={() => {
                  void request();
                }}
                className="w-full text-left text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted transition-colors"
                data-testid="button-enable-browser-push"
              >
                Browser-Pushes erlauben — auch wenn der Tab im Hintergrund liegt.
              </button>
            ) : permission === "denied" && pushEnabled ? (
              <p className="text-xs text-muted-foreground px-2 py-1">
                Browser-Pushes sind blockiert. Aktivieren in den Browser-Einstellungen.
              </p>
            ) : !pushEnabled ? (
              <button
                type="button"
                onClick={() => setPushEnabled(true)}
                className="w-full text-left text-xs text-muted-foreground hover:text-foreground px-2 py-1.5 rounded-md hover:bg-muted transition-colors"
                data-testid="button-reenable-browser-push"
              >
                Browser-Pushes wieder aktivieren.
              </button>
            ) : null
          }
        />
      </PopoverContent>
    </Popover>
  );
}
