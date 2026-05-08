import { Link, useLocation } from "wouter";
import { useState, useRef, useEffect, useSyncExternalStore, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import logo from "@assets/Logo-04_250x250_1764898165379.jpg";
import { useAuth } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Shield, LogOut, Search, X, User as UserIcon, Calendar, CheckSquare, FileSignature, Settings, Clock, Users, BookOpen, CalendarPlus, UserPlus, WifiOff, Eye, ChevronDown, HelpCircle, Gauge } from "lucide-react";
import { type LayoutVariant, layoutVariants, colors } from "@/design-system";
import { useUnreadCount } from "@/features/notifications/use-notifications";
import { NotificationBell } from "@/components/notification-bell";
import { MonthCloseBanner } from "@/components/month-close-banner";
import { useViewAsEmployee } from "@/hooks/use-view-as-employee";
import { useActiveEmployees } from "@/features/appointments/hooks/use-active-employees";

function useOnlineStatus() {
  const subscribe = useCallback((callback: () => void) => {
    window.addEventListener("online", callback);
    window.addEventListener("offline", callback);
    return () => {
      window.removeEventListener("online", callback);
      window.removeEventListener("offline", callback);
    };
  }, []);
  return useSyncExternalStore(subscribe, () => navigator.onLine);
}

interface SearchResult {
  type: "customer" | "appointment";
  id: number;
  title: string;
  subtitle: string;
  hint?: string;
  href: string;
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((n) => n[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

function GlobalSearch() {
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const { data: results, isLoading } = useQuery<SearchResult[]>({
    queryKey: ["search", query],
    queryFn: async () => {
      if (query.length < 2) return [];
      const result = await api.get<SearchResult[]>(`/search?q=${encodeURIComponent(query)}`);
      return unwrapResult(result);
    },
    enabled: query.length >= 2,
    staleTime: 30000,
  });

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleSelect = (result: SearchResult) => {
    navigate(result.href);
    setQuery("");
    setIsOpen(false);
  };

  return (
    <div ref={containerRef} className="relative flex-1 max-w-md mx-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <input
          ref={inputRef}
          type="text"
          placeholder="Suchen..."
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          className="w-full min-h-[44px] pl-9 pr-8 rounded-lg border border-border bg-muted/50 text-base md:text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
          data-testid="input-global-search"
        />
        {query && (
          <button
            onClick={() => {
              setQuery("");
              inputRef.current?.focus();
            }}
            className="absolute right-1 top-1/2 -translate-y-1/2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full hover:bg-muted"
            aria-label="Suche löschen"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        )}
      </div>

      {isOpen && query.length >= 2 && (
        <div className="absolute top-full left-0 right-0 mt-1 bg-background border border-border rounded-lg shadow-lg overflow-hidden z-50">
          {isLoading ? (
            <div className="px-4 py-3 text-sm text-muted-foreground">Suche...</div>
          ) : results && results.length > 0 ? (
            <div className="max-h-64 overflow-y-auto">
              {results.map((result) => (
                <button
                  key={`${result.type}-${result.id}`}
                  onClick={() => handleSelect(result)}
                  className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-muted transition-colors text-left"
                  data-testid={`search-result-${result.type}-${result.id}`}
                >
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center ${
                    result.type === "customer" ? "bg-primary/10 text-primary" : "bg-amber-100 text-amber-600"
                  }`}>
                    {result.type === "customer" ? (
                      <UserIcon className="w-4 h-4" />
                    ) : (
                      <Calendar className="w-4 h-4" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{result.title}</div>
                    <div className="text-xs text-muted-foreground truncate">{result.subtitle}</div>
                    {result.hint && (
                      <div className="text-xs text-primary/80 truncate" data-testid={`search-result-hint-${result.type}-${result.id}`}>
                        {result.hint}
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <div className="px-4 py-3 text-sm text-muted-foreground">Keine Ergebnisse gefunden</div>
          )}
        </div>
      )}
    </div>
  );
}

function ViewAsEmployeeBanner() {
  const { isViewingAsEmployee, viewAsEmployeeName, clearViewAs } = useViewAsEmployee();
  if (!isViewingAsEmployee) return null;

  return (
    <div className="bg-amber-50 border-b border-amber-200 px-4 py-1.5 flex items-center justify-between text-sm" data-testid="banner-view-as-employee">
      <div className="flex items-center gap-2 text-amber-800">
        <Eye className="w-4 h-4" />
        <span>Ansicht: <strong>{viewAsEmployeeName}</strong></span>
      </div>
      <button
        onClick={clearViewAs}
        className="ml-4 px-2 py-0.5 rounded text-xs font-medium text-amber-800 hover:bg-amber-100 transition-colors"
        data-testid="button-clear-view-as"
      >
        Zurücksetzen
      </button>
    </div>
  );
}

function ViewAsEmployeeSelector() {
  const { user } = useAuth();
  const { viewAsEmployeeId, setViewAsEmployee } = useViewAsEmployee();
  // Teamleitungen besitzen firmenweite Admin-Sicht und dürfen ebenfalls die
  // Mitarbeiter-Ansicht wechseln.
  const canViewAsEmployee = (user?.isAdmin ?? false) || (user?.isTeamLead ?? false);
  const { data: employees = [] } = useActiveEmployees({ enabled: canViewAsEmployee });

  if (!canViewAsEmployee) return null;

  const handleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === "") {
      setViewAsEmployee(null, null);
    } else {
      const id = parseInt(value);
      const emp = employees.find(e => e.id === id);
      setViewAsEmployee(id, emp?.displayName ?? null);
    }
  };

  return (
    <div className="flex items-center gap-1.5 shrink-0" data-testid="selector-view-as-employee">
      <Eye className="w-3.5 h-3.5 text-muted-foreground" />
      <div className="relative">
        <select
          value={viewAsEmployeeId ?? ""}
          onChange={handleChange}
          className="appearance-none bg-muted/60 text-xs font-medium pl-2 pr-6 py-1 rounded-md border border-border/60 cursor-pointer hover:bg-muted transition-colors focus:outline-none focus:ring-1 focus:ring-primary/30"
          data-testid="select-view-as-employee"
        >
          <option value="">Alle Mitarbeiter</option>
          {employees.map(emp => (
            <option key={emp.id} value={emp.id}>{emp.displayName}</option>
          ))}
        </select>
        <ChevronDown className="absolute right-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
      </div>
    </div>
  );
}

function OfflineBanner() {
  const isOnline = useOnlineStatus();
  const [dismissed, setDismissed] = useState(false);

  if (isOnline || dismissed) return null;

  return (
    <div className="bg-amber-500 text-white px-4 py-2 flex items-center justify-between text-sm" data-testid="banner-offline">
      <div className="flex items-center gap-2">
        <WifiOff className="w-4 h-4" />
        <span>Keine Internetverbindung</span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="ml-4 p-1 rounded hover:bg-amber-600 transition-colors"
        aria-label="Hinweis schließen"
        data-testid="button-dismiss-offline"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}

export function Layout({ children, variant = 'default' }: { children: React.ReactNode; variant?: LayoutVariant }) {
  const [location, navigate] = useLocation();
  const { user, logout, isAuthenticated, badgeCount, birthdayCount } = useAuth();
  const { data: notificationUnreadCount = 0 } = useUnreadCount();
  const { toast } = useToast();

  const hasBadge = badgeCount > 0 || notificationUnreadCount > 0;
  const hasBirthdayBadge = birthdayCount > 0;
  // Hinweis: Der frühere Session-Toast „N neue Benachrichtigungen" entfällt,
  // weil die Header-Bell mit Zähler, Wackel-Animation, Tab-Titel-Präfix und
  // Favicon-Punkt die Sichtbarkeit dauerhaft sicherstellt (Task #378).

  const { data: companySettings } = useQuery<{ logoUrl?: string | null }>({
    queryKey: ["company-settings"],
    queryFn: async () => {
      const result = await api.get<{ logoUrl?: string | null }>("/company-settings");
      if (!result.success) return {};
      return result.data;
    },
    enabled: isAuthenticated,
    staleTime: 60000,
  });

  const displayLogo = companySettings?.logoUrl || logo;

  const queryClient = useQueryClient();

  const resetOnboarding = useMutation({
    mutationFn: async () => {
      const result = await api.post("/auth/onboarding/reset", {});
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "auth");
      window.dispatchEvent(new Event("restart-onboarding"));
    },
    onError: (error: Error) => {
      toast({
        title: "Fehler",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const handleLogout = async () => {
    try {
      await logout();
      navigate("/login");
    } catch (error) {
      console.error("Logout failed:", error);
    }
  };

  const isAdmin = user?.isAdmin ?? false;
  const isTeamLead = user?.isTeamLead ?? false;
  // Teamleitungen besitzen firmenweite Admin-Sicht und dürfen Termin- und
  // Erstberatungs-Workflows bedienen. Admin-Toggle, Schnell-Aktionen für
  // Termin/Interessent und der „View as Employee"-Selector werden deshalb
  // ebenfalls für sie eingeblendet. Reine Admin-Aktionen wie „+ Kunde" oder
  // der Eintrag „Administration" bleiben Admins vorbehalten.
  const hasAdminScope = isAdmin || isTeamLead;
  const isOnAdminPage = location.startsWith("/admin");

  const employeeNavItems = [
    { href: "/", label: "Termine", icon: Calendar, testId: "appointments", match: (loc: string) => loc === "/" },
    { href: "/customers", label: "Kunden", icon: Users, testId: "customers", match: (loc: string) => loc === "/customers", badge: hasBirthdayBadge, badgeType: "birthday" as const },
    { href: "/tasks", label: "Aufgaben", icon: CheckSquare, testId: "tasks", match: (loc: string) => loc === "/tasks", badge: hasBadge, badgeType: "task" as const },
    { href: "/service-records", label: "Nachweise", icon: FileSignature, testId: "service-records", match: (loc: string) => loc.startsWith("/service-records") },
    { href: "/my-times", label: "Zeiten", icon: Clock, testId: "my-times", match: (loc: string) => loc === "/my-times" },
  ];

  const desktopNavItems = employeeNavItems;

  return (
    <div className={`min-h-screen ${colors.surface.page} font-sans text-foreground pb-20 md:pb-0`}>
      <OfflineBanner />
      <ViewAsEmployeeBanner />
      {hasAdminScope && !isOnAdminPage && (
        <div className="md:hidden bg-white border-b border-border/30 px-4 py-2 flex items-center justify-end">
          <ViewAsEmployeeSelector />
        </div>
      )}
      {/* Header */}
      <header className="sticky top-0 z-50 w-full bg-white border-b border-border/40 shadow-sm">
        <div className="container mx-auto px-4 h-16 flex items-center justify-between">
          <Link href="/" className="shrink-0 hover:opacity-80 transition-opacity cursor-pointer" data-testid="link-logo-home">
            <img src={displayLogo} alt="Logo" width={40} height={40} className="h-10 w-10 object-contain rounded-lg shadow-sm pointer-events-none" />
          </Link>

          {isAuthenticated && <GlobalSearch />}
          
          {isAuthenticated && user ? (
            <div className="flex items-center gap-1">
              <NotificationBell />
              <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="flex items-center gap-3 hover:opacity-80 transition-opacity focus:outline-none" data-testid="button-user-menu">
                  <div className="hidden md:flex text-sm text-muted-foreground">
                    <span className="font-medium text-foreground">{user.displayName}</span>
                  </div>
                  <div className="h-9 w-9 rounded-full bg-secondary flex items-center justify-center text-secondary-foreground font-bold ring-2 ring-background shadow-sm">
                    {getInitials(user.displayName)}
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <div className="px-2 py-1.5">
                  <p className="text-sm font-medium">{user.displayName}</p>
                  <p className="text-xs text-muted-foreground">{user.email}</p>
                </div>
                {hasAdminScope && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => navigate("/new-appointment")} data-testid="menu-quick-appointment">
                      <CalendarPlus className="mr-2 h-4 w-4 text-teal-600" />
                      + Termin
                    </DropdownMenuItem>
                    {/* „+ Interessent" und „+ Kunde" bleiben admin-only,
                        weil die zugehörigen Routen (`/admin/prospects`,
                        `/admin/customers/new`) admin-geschützt sind und
                        Stammdaten-Berechtigungen voraussetzen, die
                        Teamleitungen nicht haben. */}
                    {isAdmin && (
                      <>
                        <DropdownMenuItem onClick={() => navigate("/admin/prospects?create=true")} data-testid="menu-quick-interessent">
                          <UserPlus className="mr-2 h-4 w-4 text-teal-600" />
                          + Interessent
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => navigate("/admin/customers/new")} data-testid="menu-quick-customer">
                          <UserPlus className="mr-2 h-4 w-4 text-teal-600" />
                          + Kunde
                        </DropdownMenuItem>
                      </>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/profile")} data-testid="menu-profile">
                  <Settings className="mr-2 h-4 w-4" />
                  Mein Profil
                </DropdownMenuItem>
                {hasAdminScope && (
                  <DropdownMenuItem onClick={() => navigate("/team-auslastung")} data-testid="menu-team-workload">
                    <Gauge className="mr-2 h-4 w-4 text-teal-600" />
                    Team-Auslastung
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => navigate("/help")} data-testid="menu-help">
                  <HelpCircle className="mr-2 h-4 w-4" />
                  Hilfe
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => resetOnboarding.mutate()}
                  disabled={resetOnboarding.isPending}
                  data-testid="menu-restart-tour"
                >
                  <BookOpen className="mr-2 h-4 w-4" />
                  Tour erneut starten
                </DropdownMenuItem>
                {hasAdminScope && (
                  <>
                    {/* Teamleitungen haben (außer der Erstberatungs-Übersicht)
                        keinen Zugriff auf den Admin-Bereich; das Menü zeigt
                        deshalb für sie direkt auf die für sie freigegebene
                        Seite. */}
                    <DropdownMenuItem
                      onClick={() => navigate(isAdmin ? "/admin" : "/admin/planned-consultations")}
                      data-testid="menu-admin"
                    >
                      <Shield className="mr-2 h-4 w-4" />
                      Administration
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={handleLogout} data-testid="menu-logout">
                  <LogOut className="mr-2 h-4 w-4" />
                  Abmelden
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <Link href="/login" className="text-sm text-primary hover:underline">
                Anmelden
              </Link>
            </div>
          )}
        </div>

        {/* Desktop Navigation */}
        {isAuthenticated && user && (
          <nav className="hidden md:block border-t border-border/30 bg-white/80" aria-label="Hauptnavigation" data-testid="nav-desktop">
            <div className="container mx-auto px-4">
              <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
                {hasAdminScope && (
                  <div className="flex items-center mr-2 shrink-0 gap-1">
                    <button
                      onClick={() => navigate(isAdmin ? "/admin" : "/admin/planned-consultations")}
                      className={`px-3 py-2 text-xs font-semibold rounded-md transition-colors ${
                        isOnAdminPage
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                      data-testid="nav-desktop-toggle-admin"
                    >
                      Admin
                    </button>
                    <button
                      onClick={() => navigate("/team-auslastung")}
                      className={`px-3 py-2 text-xs font-semibold rounded-md transition-colors inline-flex items-center gap-1 ${
                        location === "/team-auslastung"
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:text-foreground hover:bg-muted"
                      }`}
                      data-testid="nav-desktop-team-workload"
                    >
                      <Gauge className="w-3.5 h-3.5" />
                      Team-Auslastung
                    </button>
                    <div className="w-px h-6 bg-border/60 ml-2" />
                  </div>
                )}
                {desktopNavItems.map((item) => {
                  const Icon = item.icon;
                  const isActive = item.match(location);
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium whitespace-nowrap transition-colors relative shrink-0 ${
                        isActive
                          ? "text-primary"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      data-testid={`nav-desktop-${item.testId}`}
                    >
                      <Icon className="w-4 h-4" />
                      {item.label}
                      {'badge' in item && (item as any).badge && (
                        <span className="w-2 h-2 bg-red-500 rounded-full" />
                      )}
                      {isActive && (
                        <span className="absolute bottom-0 left-3 right-3 h-0.5 bg-primary rounded-full" />
                      )}
                    </Link>
                  );
                })}
                {hasAdminScope && (
                  <>
                    <div className="w-px h-6 bg-border/60 mx-1" />
                    <ViewAsEmployeeSelector />
                  </>
                )}
              </div>
            </div>
          </nav>
        )}
      </header>

      <MonthCloseBanner />

      {/* Main Content */}
      <main className={`container mx-auto px-4 py-6 ${layoutVariants[variant]}`}>
        {children}
      </main>

      {/* Mobile Bottom Nav */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border p-2 flex justify-around items-center pb-safe z-40 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
         <Link href="/" className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-colors ${location === '/' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="18" height="18" x="3" y="4" rx="2" ry="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/></svg>
          <span className="text-[10px] font-medium">Termine</span>
        </Link>
        <Link href="/customers" className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-colors relative ${location === '/customers' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`} data-testid="nav-customers">
          <div className="relative">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            {hasBirthdayBadge && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full" data-testid="badge-birthdays-dot" />
            )}
          </div>
          <span className="text-[10px] font-medium">Kunden</span>
        </Link>
        <Link href="/tasks" className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-colors relative ${location === '/tasks' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`} data-testid="nav-tasks">
          <div className="relative">
            <CheckSquare className="w-6 h-6" />
            {hasBadge && (
              <span className="absolute -top-1 -right-1 w-2.5 h-2.5 bg-red-500 rounded-full" data-testid="badge-tasks-dot" />
            )}
          </div>
          <span className="text-[10px] font-medium">Aufgaben</span>
        </Link>
        <Link href="/service-records" className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-colors ${location.startsWith('/service-records') ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}>
          <FileSignature className="w-6 h-6" />
          <span className="text-[10px] font-medium">Nachweise</span>
        </Link>
        <Link href="/my-times" className={`p-2 rounded-xl flex flex-col items-center gap-1 transition-colors ${location === '/my-times' ? 'text-primary bg-primary/10' : 'text-muted-foreground hover:text-foreground'}`}>
          <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span className="text-[10px] font-medium">Zeiten</span>
        </Link>
      </div>
    </div>
  );
}
