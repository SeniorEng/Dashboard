/**
 * ResponsiveTabs Component
 * 
 * Responsive tab navigation that shows all tabs on desktop but collapses
 * overflow tabs into a "Mehr" dropdown menu on mobile screens.
 * 
 * Uses the "priority+" pattern: shows as many tabs as fit on mobile,
 * all tabs visible on larger screens (sm breakpoint and up).
 */

import { useState, useEffect, useLayoutEffect, useCallback } from "react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MoreHorizontal, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { iconSize, componentStyles } from "@/design-system";

export interface TabItem {
  value: string;
  label: string;
  testId?: string;
}

interface ResponsiveTabsProps {
  tabs: TabItem[];
  defaultValue?: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
  className?: string;
  mobileVisibleCount?: number;
}

function getInitialMediaMatch(query: string): boolean {
  if (typeof window === "undefined") return true;
  return window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => getInitialMediaMatch(query));

  useLayoutEffect(() => {
    const media = window.matchMedia(query);
    if (media.matches !== matches) {
      setMatches(media.matches);
    }
    
    const listener = (e: MediaQueryListEvent) => setMatches(e.matches);
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  }, [query, matches]);

  return matches;
}

export function ResponsiveTabs({
  tabs,
  defaultValue,
  value,
  onValueChange,
  children,
  className,
  mobileVisibleCount = 3,
}: ResponsiveTabsProps) {
  const [activeValue, setActiveValue] = useState(value || defaultValue || tabs[0]?.value);
  const isDesktop = useMediaQuery("(min-width: 640px)");
  
  const handleValueChange = useCallback((newValue: string) => {
    setActiveValue(newValue);
    onValueChange?.(newValue);
  }, [onValueChange]);

  useEffect(() => {
    if (value !== undefined) {
      setActiveValue(value);
    }
  }, [value]);

  const visibleCount = isDesktop ? tabs.length : mobileVisibleCount;
  const visibleTabs = tabs.slice(0, visibleCount);
  const overflowTabs = tabs.slice(visibleCount);
  const hasOverflow = overflowTabs.length > 0;
  
  const isActiveInOverflow = overflowTabs.some(tab => tab.value === activeValue);
  const activeOverflowTab = overflowTabs.find(tab => tab.value === activeValue);

  return (
    <Tabs
      value={activeValue}
      onValueChange={handleValueChange}
      className={cn("space-y-4", className)}
    >
      <TabsList className={cn(componentStyles.tabsList, "flex")}>
        {visibleTabs.map((tab) => (
          <TabsTrigger
            key={tab.value}
            value={tab.value}
            data-testid={tab.testId || `tab-${tab.value}`}
            className={componentStyles.tabsTrigger}
          >
            {tab.label}
          </TabsTrigger>
        ))}
        
        {hasOverflow && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className={cn(
                  componentStyles.tabsOverflowBtn,
                  "transition-all",
                  isActiveInOverflow
                    ? componentStyles.tabsOverflowActive
                    : componentStyles.tabsOverflowInactive
                )}
                data-testid="tab-more"
              >
                {isActiveInOverflow ? activeOverflowTab?.label : "Mehr"}
                <MoreHorizontal className={cn(iconSize.sm, "ml-1")} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[140px]">
              {overflowTabs.map((tab) => (
                <DropdownMenuItem
                  key={tab.value}
                  onClick={() => handleValueChange(tab.value)}
                  className={cn(
                    "flex items-center justify-between cursor-pointer",
                    tab.value === activeValue && "bg-teal-50 text-teal-700"
                  )}
                  data-testid={tab.testId || `tab-${tab.value}`}
                >
                  {tab.label}
                  {tab.value === activeValue && (
                    <Check className={cn(iconSize.sm, "text-teal-600")} />
                  )}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </TabsList>
      
      {children}
    </Tabs>
  );
}

export { TabsContent };
