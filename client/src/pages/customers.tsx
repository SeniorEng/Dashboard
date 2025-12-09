import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  MapPin, Phone, User, Search, 
  Heart, Loader2, Users
} from "lucide-react";
import type { Customer } from "@shared/schema";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { EmptyState } from "@/components/patterns/empty-state";
import { 
  iconSize, 
  getPflegegradColors,
  componentStyles,
  semanticSpacing 
} from "@/design-system";

function formatAddress(customer: Customer): string {
  if (customer.strasse && customer.nr && customer.plz && customer.stadt) {
    return `${customer.strasse} ${customer.nr}, ${customer.plz} ${customer.stadt}`;
  }
  return customer.address;
}

function getPflegegradLabel(pflegegrad: number | null): string | null {
  if (!pflegegrad) return null;
  return `Pflegegrad ${pflegegrad}`;
}

export default function CustomersPage() {
  const [searchQuery, setSearchQuery] = useState("");

  const { data: customers = [], isLoading } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await fetch("/api/customers");
      if (!res.ok) throw new Error("Kunden konnten nicht geladen werden");
      return res.json();
    },
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
    return [...filteredCustomers].sort((a, b) => a.name.localeCompare(b.name, "de"));
  }, [filteredCustomers]);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[50vh]">
          <Loader2 className={`${iconSize.xl} animate-spin text-primary`} />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-1">
          <Users className={`${iconSize.lg} text-primary`} />
          <h1 className={componentStyles.pageTitle} data-testid="text-customers-title">
            Kunden
          </h1>
        </div>
        <p className="text-muted-foreground text-sm ml-10" data-testid="text-customers-count">
          {customers.length} {customers.length === 1 ? "Kunde" : "Kunden"} insgesamt
        </p>
      </div>

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
        <div className={semanticSpacing.listGap}>
          {sortedCustomers.map((customer) => (
            <CustomerCard key={customer.id} customer={customer} />
          ))}
        </div>
      )}
    </Layout>
  );
}

function CustomerCard({ customer }: { customer: Customer }) {
  const address = formatAddress(customer);
  const phone = customer.telefon ? formatPhoneForDisplay(customer.telefon) : null;
  const pflegegradLabel = getPflegegradLabel(customer.pflegegrad);
  const pflegegradColors = customer.pflegegrad ? getPflegegradColors(customer.pflegegrad) : null;

  return (
    <Link href={`/customer/${customer.id}`}>
      <Card 
        className={componentStyles.cardHover}
        data-testid={`card-customer-${customer.id}`}
      >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <div className={`${componentStyles.avatarContainer} bg-primary/10`}>
                <User className={`${iconSize.md} text-primary`} />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground truncate" data-testid={`text-customer-name-${customer.id}`}>
                  {customer.name}
                </h3>
                {pflegegradLabel && pflegegradColors && (
                  <Badge 
                    variant="secondary" 
                    className={`text-xs mt-0.5 ${pflegegradColors.bg} ${pflegegradColors.text} ${pflegegradColors.border}`}
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
                  <a 
                    href={`tel:${customer.telefon}`}
                    className="text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                    data-testid={`link-customer-phone-${customer.id}`}
                  >
                    {phone}
                  </a>
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
}
