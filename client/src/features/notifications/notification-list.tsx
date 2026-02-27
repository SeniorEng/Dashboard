import { useLocation } from "wouter";
import { Users, Calendar, CheckSquare, CheckCheck, Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useNotifications, useMarkAsRead, useMarkAllAsRead } from "./use-notifications";
import type { Notification } from "@shared/schema";
import { useState } from "react";

function getIcon(type: string) {
  switch (type) {
    case "customer_assigned":
      return <Users className="h-4 w-4 text-blue-600 shrink-0" />;
    case "appointment_created":
      return <Calendar className="h-4 w-4 text-green-600 shrink-0" />;
    case "task_assigned":
      return <CheckSquare className="h-4 w-4 text-purple-600 shrink-0" />;
    default:
      return <Bell className="h-4 w-4 text-gray-600 shrink-0" />;
  }
}

function getNavigationPath(notification: Notification): string | null {
  if (!notification.referenceId || !notification.referenceType) return null;
  switch (notification.referenceType) {
    case "customer":
      return `/customers/${notification.referenceId}`;
    case "appointment":
      return `/appointments`;
    case "task":
      return `/tasks`;
    default:
      return null;
  }
}

function formatTimeAgo(dateStr: string | Date): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return "Gerade eben";
  if (diffMin < 60) return `vor ${diffMin} Min.`;
  if (diffHours < 24) return `vor ${diffHours} Std.`;
  if (diffDays === 1) return "Gestern";
  if (diffDays < 7) return `vor ${diffDays} Tagen`;
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit" });
}

export function NotificationList() {
  const { data: notifications, isLoading } = useNotifications();
  const markAsRead = useMarkAsRead();
  const markAllAsRead = useMarkAllAsRead();
  const [, navigate] = useLocation();
  const [showRead, setShowRead] = useState(false);

  if (isLoading || !notifications) return null;

  const unread = notifications.filter((n) => !n.readAt);
  const read = notifications.filter((n) => n.readAt);

  if (unread.length === 0 && !showRead) return null;

  const handleClick = (notification: Notification) => {
    if (!notification.readAt) {
      markAsRead.mutate(notification.id);
    }
    const path = getNavigationPath(notification);
    if (path) {
      navigate(path);
    }
  };

  return (
    <Card className="border-blue-200 bg-blue-50/50" data-testid="notification-list">
      <CardHeader className="pb-2 pt-3 px-4">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Bell className="h-4 w-4" />
            Benachrichtigungen
            {unread.length > 0 && (
              <span className="bg-blue-600 text-white text-xs px-1.5 py-0.5 rounded-full" data-testid="notification-unread-badge">
                {unread.length}
              </span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            {read.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2 text-muted-foreground"
                onClick={() => setShowRead(!showRead)}
                data-testid="button-toggle-read"
              >
                {showRead ? "Ältere ausblenden" : `${read.length} ältere`}
              </Button>
            )}
            {unread.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs h-7 px-2 text-muted-foreground"
                onClick={() => markAllAsRead.mutate()}
                disabled={markAllAsRead.isPending}
                data-testid="button-mark-all-read"
              >
                <CheckCheck className="h-3.5 w-3.5 mr-1" />
                Alle gelesen
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-3 pt-0">
        <div className="space-y-1">
          {unread.map((n) => (
            <button
              key={n.id}
              onClick={() => handleClick(n)}
              className="w-full text-left flex items-start gap-2.5 p-2 rounded-md hover:bg-blue-100/50 transition-colors"
              data-testid={`notification-item-${n.id}`}
            >
              <div className="mt-0.5">{getIcon(n.type)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground leading-tight">{n.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{n.message}</p>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">{formatTimeAgo(n.createdAt)}</span>
            </button>
          ))}
          {showRead && read.map((n) => (
            <button
              key={n.id}
              onClick={() => handleClick(n)}
              className="w-full text-left flex items-start gap-2.5 p-2 rounded-md hover:bg-gray-100/50 transition-colors opacity-60"
              data-testid={`notification-item-${n.id}`}
            >
              <div className="mt-0.5">{getIcon(n.type)}</div>
              <div className="flex-1 min-w-0">
                <p className="text-sm text-foreground leading-tight">{n.title}</p>
                <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{n.message}</p>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0 mt-0.5">{formatTimeAgo(n.createdAt)}</span>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
