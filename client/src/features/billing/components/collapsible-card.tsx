import type { ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronRight } from "lucide-react";
import { iconSize } from "@/design-system";
import { useLocalStorageBoolean } from "@/hooks/use-local-storage-boolean";

interface CollapsibleCardProps {
  /** Stabiler Schlüssel pro Karte — der Klapp-Zustand wird darunter gemerkt. */
  storageKey: string;
  icon: ReactNode;
  title: ReactNode;
  /** Optionaler Header-Inhalt rechts (z.B. Dimensions-Umschalter). Wird im
   *  eingeklappten Zustand ausgeblendet, da er den verborgenen Inhalt steuert. */
  headerRight?: ReactNode;
  defaultCollapsed?: boolean;
  testId?: string;
  toggleTestId: string;
  children: ReactNode;
}

// Task #1465 — Wiederverwendbarer Klapp-Mechanismus für die großen Analyse-
// Karten der Abrechnungsseite. Der Header ist ein Toggle-Button (mit
// Chevron-Indikator); der Zustand wird pro Karte in `localStorage` persistiert,
// sodass er einen Reload überlebt. Reine Anzeige-Präferenz — kein Datenmodell.
export function CollapsibleCard({
  storageKey,
  icon,
  title,
  headerRight,
  defaultCollapsed = false,
  testId,
  toggleTestId,
  children,
}: CollapsibleCardProps) {
  const [collapsed, setCollapsed] = useLocalStorageBoolean(
    `billing-card-collapsed:${storageKey}`,
    defaultCollapsed,
  );

  return (
    <Card className="mb-6" data-testid={testId}>
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-expanded={!collapsed}
            className="-m-1 flex items-center gap-2 rounded p-1 text-left hover:bg-gray-50"
            data-testid={toggleTestId}
          >
            {collapsed ? (
              <ChevronRight className={`${iconSize.sm} text-gray-400`} />
            ) : (
              <ChevronDown className={`${iconSize.sm} text-gray-400`} />
            )}
            {icon}
            <h2 className="text-sm font-semibold text-gray-900">{title}</h2>
          </button>
          {headerRight && !collapsed ? <div>{headerRight}</div> : null}
        </div>
        {!collapsed ? children : null}
      </CardContent>
    </Card>
  );
}
