import { useCallback, useEffect, useRef, useState } from "react";
import type { Notification as AppNotification } from "@shared/schema";

const PERMISSION_REQUESTED_KEY = "careconnect_browser_push_requested";
export const BROWSER_PUSH_TOGGLE_KEY = "careconnect_browser_push_enabled";
export const SOUND_TOGGLE_KEY = "careconnect_notification_sound_enabled";
const SOUND_SRC = "/sounds/notification-ping.mp3";

export type BrowserNotificationPermission = "default" | "granted" | "denied" | "unsupported";

function getPermission(): BrowserNotificationPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission as BrowserNotificationPermission;
}

function readToggle(key: string, defaultValue: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return defaultValue;
    return raw === "1" || raw === "true";
  } catch {
    return defaultValue;
  }
}

function writeToggle(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

export function useBrowserNotificationPermission() {
  const [permission, setPermission] = useState<BrowserNotificationPermission>(() => getPermission());

  const request = useCallback(async () => {
    if (typeof window === "undefined" || !("Notification" in window)) return "unsupported" as const;
    try {
      const result = await window.Notification.requestPermission();
      try {
        localStorage.setItem(PERMISSION_REQUESTED_KEY, "1");
      } catch {
        /* ignore */
      }
      setPermission(result as BrowserNotificationPermission);
      return result as BrowserNotificationPermission;
    } catch {
      return getPermission();
    }
  }, []);

  return { permission, request };
}

export function useBrowserPushToggle() {
  const [enabled, setEnabledState] = useState<boolean>(() => readToggle(BROWSER_PUSH_TOGGLE_KEY, true));
  const setEnabled = useCallback((v: boolean) => {
    writeToggle(BROWSER_PUSH_TOGGLE_KEY, v);
    setEnabledState(v);
  }, []);
  return { enabled, setEnabled };
}

export function useSoundToggle() {
  const [enabled, setEnabledState] = useState<boolean>(() => readToggle(SOUND_TOGGLE_KEY, false));
  const setEnabled = useCallback((v: boolean) => {
    writeToggle(SOUND_TOGGLE_KEY, v);
    setEnabledState(v);
  }, []);
  return { enabled, setEnabled };
}

function playPing() {
  try {
    const audio = new Audio(SOUND_SRC);
    audio.volume = 0.4;
    void audio.play().catch(() => {
      /* autoplay blocked or asset missing */
    });
  } catch {
    /* ignore */
  }
}

export interface BrowserPushOptions {
  unreadCount: number;
  notifications: AppNotification[] | undefined;
  onNotificationClick: (notification: AppNotification) => void;
}

/**
 * Fires OS notifications and an optional ping sound when new unread items
 * arrive. Mirrors `tag` per notification id so multiple polls don't duplicate.
 * Skips the very first poll cycle so login doesn't bombard the user.
 */
export function useBrowserPushNotifications({
  unreadCount,
  notifications,
  onNotificationClick,
}: BrowserPushOptions) {
  const prevUnreadRef = useRef<number | null>(null);
  const seenIdsRef = useRef<Set<number>>(new Set());
  const initializedRef = useRef(false);
  const onClickRef = useRef(onNotificationClick);
  onClickRef.current = onNotificationClick;

  useEffect(() => {
    if (!notifications) return;

    if (!initializedRef.current) {
      initializedRef.current = true;
      prevUnreadRef.current = unreadCount;
      for (const n of notifications) {
        if (!n.readAt) seenIdsRef.current.add(n.id);
      }
      return;
    }

    const prev = prevUnreadRef.current ?? unreadCount;
    prevUnreadRef.current = unreadCount;

    if (unreadCount <= prev) {
      // Reconcile seen set so dismissed items can re-fire if they reappear.
      const currentUnread = new Set<number>();
      for (const n of notifications) {
        if (!n.readAt) currentUnread.add(n.id);
      }
      seenIdsRef.current = currentUnread;
      return;
    }

    const newOnes: AppNotification[] = [];
    for (const n of notifications) {
      if (!n.readAt && !seenIdsRef.current.has(n.id)) {
        newOnes.push(n);
        seenIdsRef.current.add(n.id);
      }
    }
    if (newOnes.length === 0) return;

    const pushEnabled = readToggle(BROWSER_PUSH_TOGGLE_KEY, true);
    const soundEnabled = readToggle(SOUND_TOGGLE_KEY, false);

    if (
      pushEnabled &&
      typeof window !== "undefined" &&
      "Notification" in window &&
      window.Notification.permission === "granted"
    ) {
      for (const n of newOnes) {
        try {
          const notif = new window.Notification(n.title, {
            body: n.message,
            tag: `notification-${n.id}`,
            icon: "/favicon.png",
          });
          notif.onclick = () => {
            try {
              window.focus();
            } catch {
              /* ignore */
            }
            onClickRef.current(n);
            notif.close();
          };
        } catch {
          /* notification spawn failed */
        }
      }
    }

    if (soundEnabled) {
      playPing();
    }
  }, [notifications, unreadCount]);
}
