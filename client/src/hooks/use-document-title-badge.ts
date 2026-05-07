import { useEffect, useRef } from "react";
import { setFaviconBadge } from "@/lib/favicon-badge";

export function useDocumentTitleBadge(unreadCount: number) {
  const baseTitleRef = useRef<string | null>(null);

  if (baseTitleRef.current === null && typeof document !== "undefined") {
    const current = document.title || "EngelDesk";
    const stripped = current.replace(/^\(\d+\)\s+/, "");
    baseTitleRef.current = stripped || "EngelDesk";
  }

  useEffect(() => {
    const base = baseTitleRef.current ?? "EngelDesk";
    if (unreadCount > 0) {
      const display = unreadCount > 99 ? "99+" : String(unreadCount);
      document.title = `(${display}) ${base}`;
    } else {
      document.title = base;
    }
    void setFaviconBadge(unreadCount > 0);
  }, [unreadCount]);

  useEffect(() => {
    return () => {
      if (baseTitleRef.current) {
        document.title = baseTitleRef.current;
      }
      void setFaviconBadge(false);
    };
  }, []);
}
