import { useState, useMemo } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { 
  MapPin, Phone, User, Search, ChevronRight, 
  Heart, Loader2, Users
} from "lucide-react";
import type { Customer } from "@shared/schema";
import { formatPhoneForDisplay } from "@shared/utils/phone";

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

function getPflegegradColor(pflegegrad: number | null): string {
  if (!pflegegrad) return "bg-gray-100 text-gray-600";
  if (pflegegrad <= 2) return "bg-green-100 text-green-700";
  if (pflegegrad <= 3) return "bg-amber-100 text-amber-700";
  return "bg-red-100 text-red-700";
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
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="mb-6 animate-in slide-in-from-top-4 duration-500">
        <div className="flex items-center gap-3 mb-1">
          <Users className="w-7 h-7 text-primary" />
          <h1 className="text-2xl font-bold text-foreground tracking-tight" data-testid="text-customers-title">
            Kunden
          </h1>
        </div>
        <p className="text-muted-foreground text-sm ml-10" data-testid="text-customers-count">
          {customers.length} {customers.length === 1 ? "Kunde" : "Kunden"} insgesamt
        </p>
      </div>

      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-muted-foreground" />
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
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <User className="w-12 h-12 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground font-medium">
              {searchQuery ? "Keine Kunden gefunden" : "Noch keine Kunden vorhanden"}
            </p>
            <p className="text-sm text-muted-foreground/70 mt-1">
              {searchQuery 
                ? "Versuchen Sie einen anderen Suchbegriff" 
                : "Kunden werden bei der Erstberatung angelegt"
              }
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
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

  return (
    <Link href={`/customer/${customer.id}`}>
      <Card 
        className="overflow-hidden hover:shadow-md transition-shadow cursor-pointer"
        data-testid={`card-customer-${customer.id}`}
      >
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
                <User className="w-5 h-5 text-primary" />
              </div>
              <div className="min-w-0">
                <h3 className="font-semibold text-foreground truncate" data-testid={`text-customer-name-${customer.id}`}>
                  {customer.name}
                </h3>
                {pflegegradLabel && (
                  <Badge 
                    variant="secondary" 
                    className={`text-xs mt-0.5 ${getPflegegradColor(customer.pflegegrad)}`}
                    data-testid={`badge-customer-pflegegrad-${customer.id}`}
                  >
                    {pflegegradLabel}
                  </Badge>
                )}
              </div>
            </div>

            <div className="space-y-1.5 text-sm">
              <div className="flex items-start gap-2 text-muted-foreground">
                <MapPin className="w-4 h-4 mt-0.5 flex-shrink-0 text-primary/60" />
                <span className="break-words" data-testid={`text-customer-address-${customer.id}`}>
                  {address}
                </span>
              </div>

              <div className="flex items-center gap-2 text-muted-foreground">
                <Phone className="w-4 h-4 flex-shrink-0 text-primary/60" />
                {phone ? (
                  <span 
                    className="text-primary"
                    data-testid={`text-customer-phone-${customer.id}`}
                  >
                    {phone}
                  </span>
                ) : (
                  <span className="text-muted-foreground/60" data-testid={`text-customer-phone-${customer.id}`}>
                    Keine Telefonnummer
                  </span>
                )}
              </div>

              {customer.needs && customer.needs.length > 0 && (
                <div className="flex items-start gap-2 pt-1" data-testid={`container-customer-needs-${customer.id}`}>
                  <Heart className="w-4 h-4 mt-0.5 flex-shrink-0 text-rose-400" />
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
