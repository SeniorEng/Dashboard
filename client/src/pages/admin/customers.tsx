import { useState, useMemo, useCallback, useEffect } from "react";
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
  name: string;
  vorname: string | null;
  nachname: string | null;
  telefon: string | null;
  address: string | null;
  stadt: string | null;
  pflegegrad: number | null;
  primaryEmployee: { displayName: string } | null;
  hasActiveContract: boolean;
}

interface PaginatedResponse {
  data: CustomerListItem[];
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
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [pflegegradFilter, setPflegegradFilter] = useState<string>("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);
  
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  
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
  
  const { data, isLoading, error, refetch } = useQuery<PaginatedResponse>({
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
    setSearchQuery("");
    setCurrentPage(1);
    setFilterSheetOpen(false);
  }, []);
  
  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (pflegegradFilter) count++;
    if (employeeFilter) count++;
    return count;
  }, [pflegegradFilter, employeeFilter]);

  const customers = data?.data || [];
  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;

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
              <div>
                <h1 className="text-2xl font-bold text-gray-900">Kundenverwaltung</h1>
                <p className="text-sm text-gray-600">
                  {total} {total === 1 ? "Kunde" : "Kunden"} gefunden
                </p>
              </div>
            </div>
            <Link href="/admin/customers/new">
              <Button className="bg-teal-600 hover:bg-teal-700" data-testid="button-new-customer">
                <Plus className="h-4 w-4 mr-2" />
                Neuer Kunde
              </Button>
            </Link>
          </div>

          <div className="flex gap-3 mb-6">
            <div className="flex-1 relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-gray-400" />
              <Input
                placeholder="Name, Telefon oder Adresse suchen..."
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
                className="pl-10"
                data-testid="input-search"
              />
            </div>
            <Sheet open={filterSheetOpen} onOpenChange={setFilterSheetOpen}>
              <SheetTrigger asChild>
                <Button variant="outline" className="relative" data-testid="button-filter">
                  <SlidersHorizontal className="h-4 w-4 mr-2" />
                  Filter
                  {activeFilterCount > 0 && (
                    <Badge className="absolute -top-2 -right-2 h-5 w-5 flex items-center justify-center p-0 bg-teal-600">
                      {activeFilterCount}
                    </Badge>
                  )}
                </Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Filter</SheetTitle>
                </SheetHeader>
                <div className="mt-6 space-y-6">
                  <div className="space-y-2">
                    <Label>Pflegegrad</Label>
                    <Select
                      value={pflegegradFilter || "all"}
                      onValueChange={(value) => handleFilterChange("pflegegrad", value)}
                    >
                      <SelectTrigger data-testid="select-pflegegrad">
                        <SelectValue placeholder="Alle Pflegegrade" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Alle Pflegegrade</SelectItem>
                        {PFLEGEGRAD_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
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
                      <SelectTrigger data-testid="select-employee">
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
                  
                  <Button
                    variant="outline"
                    onClick={clearFilters}
                    className="w-full"
                    data-testid="button-clear-filters"
                  >
                    Filter zurücksetzen
                  </Button>
                </div>
              </SheetContent>
            </Sheet>
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
                  onClick={() => refetch()}
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
          ) : customers.length === 0 ? (
            <Card className="bg-white/80 backdrop-blur-sm">
              <CardContent className="flex flex-col items-center justify-center py-12 text-center">
                <User2 className="h-12 w-12 text-gray-400 mb-4" />
                <h3 className="text-lg font-medium text-gray-900 mb-2">
                  Keine Kunden gefunden
                </h3>
                <p className="text-gray-600 mb-4">
                  {searchQuery || activeFilterCount > 0
                    ? "Versuchen Sie andere Suchbegriffe oder Filter"
                    : "Erstellen Sie Ihren ersten Kunden"}
                </p>
                {(searchQuery || activeFilterCount > 0) && (
                  <Button variant="outline" onClick={clearFilters}>
                    Filter zurücksetzen
                  </Button>
                )}
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {customers.map((customer) => (
                <Card
                  key={customer.id}
                  className="bg-white/80 backdrop-blur-sm hover:shadow-md transition-shadow cursor-pointer"
                  onClick={() => setLocation(`/admin/customers/${customer.id}`)}
                  data-testid={`card-customer-${customer.id}`}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between">
                      <div className="flex items-start gap-3">
                        <div className="h-10 w-10 rounded-full bg-teal-100 flex items-center justify-center">
                          <User2 className="h-5 w-5 text-teal-600" />
                        </div>
                        <div>
                          <h3 className="font-medium text-gray-900">
                            {customer.name}
                          </h3>
                          {customer.address && (
                            <div className="flex items-center gap-1 text-sm text-gray-600 mt-1">
                              <MapPin className="h-3 w-3" />
                              <span>{customer.address}</span>
                            </div>
                          )}
                          {customer.telefon && (
                            <div className="flex items-center gap-1 text-sm text-gray-600">
                              <Phone className="h-3 w-3" />
                              <span>{customer.telefon}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-2">
                        {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                          <Badge variant="outline" className="bg-blue-50 text-blue-700 border-blue-200">
                            <Heart className="h-3 w-3 mr-1" />
                            PG {customer.pflegegrad}
                          </Badge>
                        )}
                        {customer.hasActiveContract && (
                          <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200">
                            <FileText className="h-3 w-3 mr-1" />
                            Vertrag
                          </Badge>
                        )}
                      </div>
                    </div>
                    {customer.primaryEmployee && (
                      <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600">
                        Betreut von: {customer.primaryEmployee.displayName}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 mt-6">
              <Button
                variant="outline"
                size="icon"
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1}
                data-testid="button-prev-page"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-gray-600">
                Seite {currentPage} von {totalPages}
              </span>
              <Button
                variant="outline"
                size="icon"
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === totalPages}
                data-testid="button-next-page"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
