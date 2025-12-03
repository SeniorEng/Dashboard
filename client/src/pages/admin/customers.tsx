import { useState, useMemo, useCallback } from "react";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Layout } from "@/components/layout";
import { useDebounce } from "@/hooks/use-debounce";
import {
  ArrowLeft,
  Plus,
  Loader2,
  Search,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  User2,
  MapPin,
  Phone,
  Heart,
  FileText,
  AlertCircle,
} from "lucide-react";

interface CustomerListItem {
  id: number;
  vorname: string;
  nachname: string;
  telefon: string | null;
  festnetz: string | null;
  strasse: string | null;
  nr: string | null;
  plz: string | null;
  stadt: string | null;
  pflegegrad: number | null;
  primaryEmployeeId: number | null;
  backupEmployeeId: number | null;
  currentInsurance: {
    providerName: string;
  } | null;
  activeContractCount: number;
}

interface PaginatedResponse {
  customers: CustomerListItem[];
  total: number;
  limit: number;
  offset: number;
  page: number;
  totalPages: number;
}

interface Employee {
  id: number;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
}

const PFLEGEGRAD_OPTIONS = [
  { value: "0", label: "Ohne Pflegegrad" },
  { value: "1", label: "Pflegegrad 1" },
  { value: "2", label: "Pflegegrad 2" },
  { value: "3", label: "Pflegegrad 3" },
  { value: "4", label: "Pflegegrad 4" },
  { value: "5", label: "Pflegegrad 5" },
];

export default function AdminCustomers() {
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [pflegegradFilter, setPflegegradFilter] = useState<string>("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  
  const debouncedSearch = useDebounce(searchQuery, 300);
  
  const { data: employees } = useQuery<Employee[]>({
    queryKey: ["admin", "employees"],
    queryFn: async () => {
      const res = await fetch("/api/admin/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Mitarbeiter konnten nicht geladen werden");
      return res.json();
    },
  });
  
  const queryParams = useMemo(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (pflegegradFilter) params.set("pflegegrad", pflegegradFilter);
    if (employeeFilter) params.set("primaryEmployeeId", employeeFilter);
    params.set("page", currentPage.toString());
    params.set("limit", "15");
    return params.toString();
  }, [debouncedSearch, pflegegradFilter, employeeFilter, currentPage]);
  
  const { data, isLoading, error } = useQuery<PaginatedResponse>({
    queryKey: ["admin", "customers", queryParams],
    queryFn: async () => {
      const res = await fetch(`/api/admin/customers?${queryParams}`, { credentials: "include" });
      if (!res.ok) {
        const errorData = await res.json();
        throw new Error(errorData.message || "Kunden konnten nicht geladen werden");
      }
      return res.json();
    },
  });

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);
  
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  }, []);
  
  const handleFilterChange = useCallback((type: "pflegegrad" | "employee", value: string) => {
    if (type === "pflegegrad") {
      setPflegegradFilter(value === "all" ? "" : value);
    } else {
      setEmployeeFilter(value === "all" ? "" : value);
    }
    setCurrentPage(1);
  }, []);
  
  const clearFilters = useCallback(() => {
    setPflegegradFilter("");
    setEmployeeFilter("");
    setCurrentPage(1);
  }, []);
  
  const hasActiveFilters = pflegegradFilter || employeeFilter;
  
  const formatAddress = (customer: CustomerListItem) => {
    const parts = [];
    if (customer.strasse) {
      parts.push(`${customer.strasse}${customer.nr ? ` ${customer.nr}` : ""}`);
    }
    if (customer.plz || customer.stadt) {
      parts.push(`${customer.plz || ""} ${customer.stadt || ""}`.trim());
    }
    return parts.join(", ") || "Keine Adresse";
  };
  
  const getPhoneDisplay = (customer: CustomerListItem) => {
    return customer.telefon || customer.festnetz || "Keine Telefonnummer";
  };
  
  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-4">
              <Link href="/admin">
                <Button variant="ghost" size="icon" data-testid="button-back">
                  <ArrowLeft className="h-5 w-5" />
                </Button>
              </Link>
              <h1 className="text-2xl font-bold text-gray-900">Kundenverwaltung</h1>
            </div>
            <Link href="/admin/customers/new">
              <Button className="bg-teal-600 hover:bg-teal-700" data-testid="button-create-customer">
                <Plus className="h-4 w-4 mr-2" />
                Neuer Kunde
              </Button>
            </Link>
          </div>

          <div className="mb-6 space-y-4">
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
                <Input
                  placeholder="Suchen nach Name, Adresse, Telefon..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-10 bg-white"
                  data-testid="input-search-customers"
                />
              </div>
              <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
                <SheetTrigger asChild>
                  <Button 
                    variant="outline" 
                    className={`bg-white ${hasActiveFilters ? "border-teal-500 text-teal-700" : ""}`}
                    data-testid="button-open-filters"
                  >
                    <SlidersHorizontal className="h-4 w-4 mr-2" />
                    Filter
                    {hasActiveFilters && (
                      <Badge variant="secondary" className="ml-2 bg-teal-100 text-teal-700">
                        {(pflegegradFilter ? 1 : 0) + (employeeFilter ? 1 : 0)}
                      </Badge>
                    )}
                  </Button>
                </SheetTrigger>
                <SheetContent>
                  <SheetHeader>
                    <SheetTitle>Filter</SheetTitle>
                  </SheetHeader>
                  <div className="space-y-6 mt-6">
                    <div className="space-y-2">
                      <Label>Pflegegrad</Label>
                      <Select
                        value={pflegegradFilter || "all"}
                        onValueChange={(value) => handleFilterChange("pflegegrad", value)}
                      >
                        <SelectTrigger data-testid="select-pflegegrad-filter">
                          <SelectValue placeholder="Alle Pflegegrade" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Alle Pflegegrade</SelectItem>
                          {PFLEGEGRAD_OPTIONS.map((opt) => (
                            <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    
                    <div className="space-y-2">
                      <Label>Zuständiger Mitarbeiter</Label>
                      <Select
                        value={employeeFilter || "all"}
                        onValueChange={(value) => handleFilterChange("employee", value)}
                      >
                        <SelectTrigger data-testid="select-employee-filter">
                          <SelectValue placeholder="Alle Mitarbeiter" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">Alle Mitarbeiter</SelectItem>
                          {employees?.map((emp) => (
                            <SelectItem key={emp.id} value={emp.id.toString()}>
                              {emp.displayName}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    
                    {hasActiveFilters && (
                      <Button
                        variant="outline"
                        onClick={clearFilters}
                        className="w-full"
                        data-testid="button-clear-filters"
                      >
                        Filter zurücksetzen
                      </Button>
                    )}
                  </div>
                </SheetContent>
              </Sheet>
            </div>

            {hasActiveFilters && (
              <div className="flex flex-wrap gap-2">
                {pflegegradFilter && (
                  <Badge 
                    variant="secondary" 
                    className="bg-teal-100 text-teal-800 cursor-pointer"
                    onClick={() => handleFilterChange("pflegegrad", "all")}
                  >
                    {PFLEGEGRAD_OPTIONS.find(o => o.value === pflegegradFilter)?.label}
                    <span className="ml-1">×</span>
                  </Badge>
                )}
                {employeeFilter && (
                  <Badge 
                    variant="secondary"
                    className="bg-teal-100 text-teal-800 cursor-pointer"
                    onClick={() => handleFilterChange("employee", "all")}
                  >
                    {employees?.find(e => e.id.toString() === employeeFilter)?.displayName}
                    <span className="ml-1">×</span>
                  </Badge>
                )}
              </div>
            )}
          </div>

          {error && (
            <Card className="mb-6 border-red-200 bg-red-50">
              <CardContent className="flex items-center justify-between p-4">
                <div className="flex items-center gap-3">
                  <AlertCircle className="h-5 w-5 text-red-600" />
                  <p className="text-red-800">{error.message}</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => window.location.reload()}
                  data-testid="button-retry"
                >
                  Erneut versuchen
                </Button>
              </CardContent>
            </Card>
          )}

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
            </div>
          ) : data?.customers.length === 0 ? (
            <Card className="bg-white/80">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <User2 className="h-12 w-12 text-gray-300 mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  {searchQuery || hasActiveFilters
                    ? "Keine Kunden gefunden"
                    : "Noch keine Kunden"
                  }
                </h3>
                <p className="text-gray-500 mb-4">
                  {searchQuery || hasActiveFilters
                    ? "Versuchen Sie, Ihre Suche oder Filter anzupassen."
                    : "Erstellen Sie Ihren ersten Kunden, um loszulegen."
                  }
                </p>
                {(searchQuery || hasActiveFilters) ? (
                  <Button variant="outline" onClick={() => { setSearchQuery(""); clearFilters(); }}>
                    Suche zurücksetzen
                  </Button>
                ) : (
                  <Link href="/admin/customers/new">
                    <Button className="bg-teal-600 hover:bg-teal-700">
                      <Plus className="h-4 w-4 mr-2" />
                      Neuer Kunde
                    </Button>
                  </Link>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="flex justify-between items-center mb-4 text-sm text-gray-600">
                <span>
                  {data?.total} {data?.total === 1 ? "Kunde" : "Kunden"} gefunden
                </span>
                <span>
                  Seite {data?.page} von {data?.totalPages}
                </span>
              </div>

              <div className="space-y-3">
                {data?.customers.map((customer) => (
                  <Card 
                    key={customer.id} 
                    className="bg-white hover:shadow-md transition-shadow cursor-pointer"
                    onClick={() => setLocation(`/admin/customers/${customer.id}`)}
                    data-testid={`card-customer-${customer.id}`}
                  >
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between">
                        <div className="flex items-start gap-3">
                          <div className="p-2 rounded-full bg-teal-100">
                            <User2 className="h-5 w-5 text-teal-600" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2 mb-1">
                              <h3 className="font-semibold text-gray-900">
                                {customer.vorname} {customer.nachname}
                              </h3>
                              {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                                <Badge variant="outline" className="text-xs bg-blue-50 text-blue-700 border-blue-200">
                                  PG {customer.pflegegrad}
                                </Badge>
                              )}
                              {customer.activeContractCount > 0 && (
                                <Badge variant="outline" className="text-xs bg-green-50 text-green-700 border-green-200">
                                  <FileText className="h-3 w-3 mr-1" />
                                  {customer.activeContractCount} Vertrag{customer.activeContractCount !== 1 ? "e" : ""}
                                </Badge>
                              )}
                            </div>
                            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500">
                              <span className="flex items-center gap-1">
                                <MapPin className="h-3.5 w-3.5" />
                                {formatAddress(customer)}
                              </span>
                              <span className="flex items-center gap-1">
                                <Phone className="h-3.5 w-3.5" />
                                {getPhoneDisplay(customer)}
                              </span>
                            </div>
                            {customer.currentInsurance && (
                              <div className="flex items-center gap-1 mt-1 text-sm text-gray-500">
                                <Heart className="h-3.5 w-3.5" />
                                {customer.currentInsurance.providerName}
                              </div>
                            )}
                          </div>
                        </div>
                        <ChevronRight className="h-5 w-5 text-gray-400" />
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>

              {data && data.totalPages > 1 && (
                <div className="flex items-center justify-center gap-2 mt-6">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(data.page - 1)}
                    disabled={data.page <= 1}
                    data-testid="button-prev-page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    Zurück
                  </Button>
                  <div className="flex items-center gap-1">
                    {Array.from({ length: Math.min(5, data.totalPages) }, (_, i) => {
                      let pageNum: number;
                      if (data.totalPages <= 5) {
                        pageNum = i + 1;
                      } else if (data.page <= 3) {
                        pageNum = i + 1;
                      } else if (data.page >= data.totalPages - 2) {
                        pageNum = data.totalPages - 4 + i;
                      } else {
                        pageNum = data.page - 2 + i;
                      }
                      return (
                        <Button
                          key={pageNum}
                          variant={pageNum === data.page ? "default" : "outline"}
                          size="sm"
                          onClick={() => handlePageChange(pageNum)}
                          className={pageNum === data.page ? "bg-teal-600 hover:bg-teal-700" : ""}
                          data-testid={`button-page-${pageNum}`}
                        >
                          {pageNum}
                        </Button>
                      );
                    })}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handlePageChange(data.page + 1)}
                    disabled={data.page >= data.totalPages}
                    data-testid="button-next-page"
                  >
                    Weiter
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </Layout>
  );
}
