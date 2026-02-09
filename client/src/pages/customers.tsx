import { useState, useMemo, memo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  MapPin, Phone, User, Search, 
  Heart, Loader2, Users, Cake, Gift
} from "lucide-react";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { formatDateForDisplay } from "@shared/utils/datetime";
import { EmptyState } from "@/components/patterns/empty-state";
import { ErrorState } from "@/components/patterns/error-state";
import { 
  iconSize, 
  getPflegegradColors,
  componentStyles
} from "@/design-system";
import { formatAddress } from "@shared/utils/format";
import { useAuth } from "@/hooks/use-auth";
import type { CustomerWithAccess } from "@/features/appointments";
import type { BirthdayEntry } from "@shared/types";

type CustomerTab = "kunden" | "geburtstage";

const BIRTHDAY_HORIZON_DAYS = 30;

function getDaysLabel(days: number): string {
  if (days === 0) return "Heute";
  if (days === 1) return "Morgen";
  return `In ${days} Tagen`;
}

function getGroupLabel(days: number): string {
  if (days === 0) return "Heute";
  if (days <= 7) return "Diese Woche";
  if (days <= 14) return "Nächste Woche";
  return "Später";
}

function groupBirthdays(birthdays: BirthdayEntry[]): Record<string, BirthdayEntry[]> {
  const groups: Record<string, BirthdayEntry[]> = {
    "Heute": [],
    "Diese Woche": [],
    "Nächste Woche": [],
    "Später": [],
  };

  for (const birthday of birthdays) {
    const group = getGroupLabel(birthday.daysUntil);
    groups[group].push(birthday);
  }

  return groups;
}

function getPflegegradLabel(pflegegrad: number | null): string | null {
  if (!pflegegrad) return null;
  return `Pflegegrad ${pflegegrad}`;
}

export default function CustomersPage() {
  const [activeTab, setActiveTab] = useState<CustomerTab>("kunden");
  const [searchQuery, setSearchQuery] = useState("");
  const { user } = useAuth();

  const { data: customers = [], isLoading, error, refetch } = useQuery<CustomerWithAccess[]>({
    queryKey: ["customers"],
    staleTime: 30000,
    queryFn: async () => {
      const res = await fetch("/api/customers");
      if (!res.ok) throw new Error("Kunden konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: birthdays = [], isLoading: birthdaysLoading, error: birthdaysError, refetch: refetchBirthdays } = useQuery<BirthdayEntry[]>({
    queryKey: ["/api/birthdays"],
    staleTime: 5 * 60 * 1000,
    enabled: activeTab === "geburtstage",
  });

  const filteredCustomers = useMemo(() => {
    if (!searchQuery.trim()) return customers;
    const query = searchQuery.toLowerCase();
    return customers.filter(customer => {
      const fullName = customer.name.toLowerCase();
      const address = formatAddress(customer).toLowerCase();
      const phone = customer.telefon?.toLowerCase() || "";
      return fullName.includes(query) || address.includes(query) || phone.includes(query);
    });
  }, [customers, searchQuery]);

  const sortedCustomers = useMemo(() => {
    return [...filteredCustomers].sort((a, b) => {
      const aLegacy = a.isCurrentlyAssigned === false ? 1 : 0;
      const bLegacy = b.isCurrentlyAssigned === false ? 1 : 0;
      if (aLegacy !== bLegacy) return aLegacy - bLegacy;
      return a.name.localeCompare(b.name, "de");
    });
  }, [filteredCustomers]);

  const groups = useMemo(() => groupBirthdays(birthdays), [birthdays]);
  const hasAnyBirthdays = birthdays.length > 0;

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  if (error) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <ErrorState
            title="Kunden konnten nicht geladen werden"
            description={error instanceof Error ? error.message : "Ein unbekannter Fehler ist aufgetreten."}
            onRetry={() => refetch()}
          />
        </div>
      </Layout>
    );
  }

  const subtitle = activeTab === "kunden"
    ? `${customers.length} ${customers.length === 1 ? "Kunde" : "Kunden"} insgesamt`
    : user?.isAdmin 
      ? `Alle Geburtstage der nächsten ${BIRTHDAY_HORIZON_DAYS} Tage`
      : `Geburtstage in den nächsten ${BIRTHDAY_HORIZON_DAYS} Tagen`;

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-1">
          <Users className={`${iconSize.lg} text-primary`} />
          <h1 className={componentStyles.pageTitle} data-testid="text-customers-title">
            Kunden
          </h1>
        </div>
        <p className="text-muted-foreground text-sm ml-10" data-testid="text-customers-subtitle">
          {subtitle}
        </p>
      </div>

      <div className="flex items-center gap-1 bg-muted rounded-lg p-1 mb-4" data-testid="tab-switcher-customers">
        <button
          onClick={() => setActiveTab("kunden")}
          className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
            activeTab === "kunden" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-kunden"
        >
          Kunden
        </button>
        <button
          onClick={() => setActiveTab("geburtstage")}
          className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-all ${
            activeTab === "geburtstage" ? "bg-background shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
          data-testid="tab-geburtstage"
        >
          Geburtstage
        </button>
      </div>

      {activeTab === "kunden" ? (
        <>
          <div className="relative mb-4">
            <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 ${iconSize.sm} text-muted-foreground`} />
            <Input
              type="text"
              placeholder="Name, Adresse oder Telefon suchen..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
              data-testid="input-customer-search"
            />
          </div>

          {sortedCustomers.length === 0 ? (
            <Card className="border-dashed">
              <CardContent className="p-0">
                <EmptyState
                  icon={<User className={iconSize["2xl"]} />}
                  title={searchQuery ? "Keine Kunden gefunden" : "Noch keine Kunden vorhanden"}
                  description={searchQuery 
                    ? "Versuchen Sie einen anderen Suchbegriff" 
                    : "Kunden werden bei der Erstberatung angelegt"
                  }
                />
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-3">
              {sortedCustomers.map((customer) => (
                <CustomerCard key={customer.id} customer={customer} />
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {birthdaysLoading ? (
            <div className="flex items-center justify-center min-h-[30vh]">
              <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
            </div>
          ) : birthdaysError ? (
            <ErrorState
              title="Geburtstage konnten nicht geladen werden"
              description={birthdaysError instanceof Error ? birthdaysError.message : "Bitte versuchen Sie es erneut."}
              onRetry={() => refetchBirthdays()}
            />
          ) : !hasAnyBirthdays ? (
            <Card className="border-dashed">
              <CardContent className="py-10">
                <EmptyState
                  icon={<Gift className={`${iconSize["2xl"]} text-muted-foreground/40`} />}
                  title={`Keine Geburtstage in den nächsten ${BIRTHDAY_HORIZON_DAYS} Tagen`}
                />
              </CardContent>
            </Card>
          ) : (
            <div className="flex flex-col gap-6">
              {Object.entries(groups).map(([groupName, groupBirthdays]) => {
                if (groupBirthdays.length === 0) return null;
                
                return (
                  <div key={groupName}>
                    <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3 flex items-center gap-2">
                      {groupName === "Heute" && <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />}
                      {groupName}
                      <Badge variant="secondary" className="text-xs">
                        {groupBirthdays.length}
                      </Badge>
                    </h2>
                    
                    <div className="flex flex-col gap-3">
                      {groupBirthdays.map((birthday) => (
                        <BirthdayCard key={`${birthday.type}-${birthday.id}`} birthday={birthday} />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
    </Layout>
  );
}

function BirthdayCard({ birthday }: { birthday: BirthdayEntry }) {
  const isToday = birthday.daysUntil === 0;
  const isSoon = birthday.daysUntil <= 3;
  
  const content = (
    <Card 
      className={`overflow-hidden ${
        isToday 
          ? "border-green-300 bg-green-50/50 shadow-md" 
          : isSoon 
            ? "border-amber-200 bg-amber-50/30" 
            : ""
      }`}
      data-testid={`card-birthday-${birthday.type}-${birthday.id}`}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5">
              <h3 className="font-semibold text-foreground truncate" data-testid={`text-birthday-name-${birthday.type}-${birthday.id}`}>
                {birthday.name}
              </h3>
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Badge 
                variant="outline" 
                className={`text-xs ${birthday.type === "employee" ? "bg-blue-50 text-blue-700 border-blue-200" : "bg-primary/10 text-primary border-primary/20"}`}
              >
                {birthday.type === "employee" ? "Mitarbeiter" : "Kunde"}
              </Badge>
              <span className="text-muted-foreground/50">·</span>
              <span data-testid={`text-birthday-date-${birthday.type}-${birthday.id}`}>
                {formatDateForDisplay(birthday.geburtsdatum, { day: "numeric", month: "long" })}
              </span>
              <span className="text-muted-foreground/50">·</span>
              <span>wird {birthday.age}</span>
            </div>
          </div>
          
          <Badge 
            variant={isToday ? "default" : isSoon ? "secondary" : "outline"}
            className={`shrink-0 ${isToday ? "bg-green-600" : ""}`}
            data-testid={`badge-birthday-days-${birthday.type}-${birthday.id}`}
          >
            {getDaysLabel(birthday.daysUntil)}
          </Badge>
        </div>
      </CardContent>
    </Card>
  );

  if (birthday.type === "customer") {
    return (
      <Link href={`/customer/${birthday.id}`}>
        {content}
      </Link>
    );
  }

  return content;
}

const CustomerCard = memo(function CustomerCard({ customer }: { customer: CustomerWithAccess }) {
  const address = formatAddress(customer);
  const phone = customer.telefon ? formatPhoneForDisplay(customer.telefon) : null;
  const pflegegradLabel = getPflegegradLabel(customer.pflegegrad);
  const pflegegradColors = customer.pflegegrad ? getPflegegradColors(customer.pflegegrad) : null;
  const isLegacy = customer.isCurrentlyAssigned === false;

  return (
    <Link href={`/customer/${customer.id}`}>
      <Card 
        data-testid={`card-customer-${customer.id}`}
        className={isLegacy ? "opacity-75 border-dashed" : ""}
      >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className={`font-semibold truncate ${isLegacy ? "text-muted-foreground" : "text-foreground"}`} data-testid={`text-customer-name-${customer.id}`}>
                {customer.name}
              </h3>
              <div className="flex items-center gap-1.5 shrink-0">
                {isLegacy && (
                  <Badge 
                    variant="outline" 
                    className="text-xs bg-amber-50 text-amber-700 border-amber-200"
                    data-testid={`badge-customer-legacy-${customer.id}`}
                  >
                    Frühere Zuordnung
                  </Badge>
                )}
                {pflegegradLabel && pflegegradColors && (
                  <Badge 
                    variant="secondary" 
                    className={`text-xs ${pflegegradColors.bg} ${pflegegradColors.text} ${pflegegradColors.border}`}
                    data-testid={`badge-customer-pflegegrad-${customer.id}`}
                  >
                    {pflegegradLabel}
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-1.5 text-sm">
              <div className="flex items-start gap-2 text-muted-foreground">
                <MapPin className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-primary/60`} />
                <span className="break-words" data-testid={`text-customer-address-${customer.id}`}>
                  {address}
                </span>
              </div>

              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className={`${iconSize.sm} flex-shrink-0 text-primary/60`} />
                {phone && customer.telefon ? (
                  <button 
                    type="button"
                    className="text-primary hover:underline text-left"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      window.location.href = `tel:${customer.telefon}`;
                    }}
                    data-testid={`button-customer-phone-${customer.id}`}
                  >
                    {phone}
                  </button>
                ) : (
                  <span className="text-muted-foreground/60" data-testid={`text-customer-phone-${customer.id}`}>
                    Keine Telefonnummer
                  </span>
                )}
              </div>

              {customer.needs && customer.needs.length > 0 && (
                <div className="flex items-start gap-2 pt-1" data-testid={`container-customer-needs-${customer.id}`}>
                  <Heart className={`${iconSize.sm} mt-0.5 flex-shrink-0 text-rose-400`} />
                  <div className="flex flex-wrap gap-1">
                    {customer.needs.map((need, index) => (
                      <Badge 
                        key={index} 
                        variant="outline" 
                        className="text-xs bg-rose-50 text-rose-700 border-rose-200"
                        data-testid={`badge-customer-need-${customer.id}-${index}`}
                      >
                        {need}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
    </Link>
  );
});
