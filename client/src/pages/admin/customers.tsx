/**
 * Admin Customer List Page
 * 
 * Displays paginated list of customers with search, filtering, and navigation.
 * Uses design system patterns for consistent styling.
 */

import { useState, useMemo, useCallback, useEffect } from "react";
import { Link, useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Layout } from "@/components/layout";
import { PageHeader } from "@/components/patterns/page-header";
import { SectionCard } from "@/components/patterns/section-card";
import { DataList, DataListItem } from "@/components/patterns/data-list";
import { EmptyState } from "@/components/patterns/empty-state";
import { StatusBadge } from "@/components/patterns/status-badge";
import { useCustomers, useEmployees } from "@/features/customers";
import { iconSize, getPflegegradColors, componentStyles } from "@/design-system";
import {
  Plus,
  Loader2,
  Search,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
  User2,
  MapPin,
  Phone,
  FileText,
  AlertCircle,
} from "lucide-react";
import { PFLEGEGRAD_SELECT_OPTIONS, BILLING_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";

export default function AdminCustomers() {
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("aktiv");
  const [pflegegradFilter, setPflegegradFilter] = useState<string>("");
  const [billingTypeFilter, setBillingTypeFilter] = useState<string>("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { data: employees } = useEmployees();

  const employeeFilterOptions = useMemo(() => [
    { value: "all", label: "Alle Mitarbeiter" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })) || []),
  ], [employees]);

  const queryParams = useMemo(() => ({
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
    pflegegrad: pflegegradFilter || undefined,
    billingType: billingTypeFilter || undefined,
    primaryEmployeeId: employeeFilter || undefined,
    page: currentPage,
    limit: 15,
  }), [debouncedSearch, statusFilter, pflegegradFilter, billingTypeFilter, employeeFilter, currentPage]);

  const { data, isLoading, error, refetch } = useCustomers(queryParams);

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  }, []);

  const handleFilterChange = useCallback((type: "pflegegrad" | "employee" | "status" | "billingType", value: string) => {
    if (type === "pflegegrad") {
      setPflegegradFilter(value === "all" ? "" : value);
    } else if (type === "billingType") {
      setBillingTypeFilter(value === "all" ? "" : value);
    } else if (type === "employee") {
      setEmployeeFilter(value === "all" ? "" : value);
    } else if (type === "status") {
      setStatusFilter(value === "all" ? "" : value);
    }
    setCurrentPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setStatusFilter("aktiv");
    setPflegegradFilter("");
    setBillingTypeFilter("");
    setEmployeeFilter("");
    setSearchQuery("");
    setCurrentPage(1);
    setFilterSheetOpen(false);
  }, []);

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (statusFilter && statusFilter !== "aktiv") count++;
    if (pflegegradFilter) count++;
    if (billingTypeFilter) count++;
    if (employeeFilter) count++;
    return count;
  }, [statusFilter, pflegegradFilter, billingTypeFilter, employeeFilter]);

  const customers = data?.data || [];
  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;

  return (
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <PageHeader
            title="Kundenverwaltung"
            subtitle={`${total} ${total === 1 ? "Kunde" : "Kunden"} gefunden`}
            backHref="/admin"
            actions={
              <Link href="/admin/customers/new" className={componentStyles.pageHeaderActionBtn}>
                <Button className={`${componentStyles.btnPrimary} w-full sm:w-auto`} data-testid="button-new-customer">
                  <Plus className={iconSize.sm + " mr-2"} />
                  Neuer Kunde
                </Button>
              </Link>
            }
          />

          <div className="flex gap-1 mb-4 bg-white rounded-lg p-1 border" data-testid="status-filter">
            {[
              { value: "aktiv", label: "Aktiv" },
              { value: "erstberatung", label: "Erstberatung" },
              { value: "inaktiv", label: "Inaktiv" },
              { value: "all", label: "Alle" },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleFilterChange("status", opt.value)}
                className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                  (statusFilter || "all") === opt.value
                    ? "bg-teal-600 text-white"
                    : "text-gray-600 hover:bg-gray-100"
                }`}
                data-testid={`status-filter-${opt.value}`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex gap-3 mb-6">
            <div className="flex-1 relative">
              <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 ${iconSize.sm} text-gray-400`} />
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
                  <SlidersHorizontal className={iconSize.sm + " mr-2"} />
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
                        {PFLEGEGRAD_SELECT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Kundentyp</Label>
                    <Select
                      value={billingTypeFilter || "all"}
                      onValueChange={(value) => handleFilterChange("billingType", value)}
                    >
                      <SelectTrigger data-testid="select-billingtype">
                        <SelectValue placeholder="Alle Kundentypen" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="all">Alle Kundentypen</SelectItem>
                        {BILLING_TYPE_SELECT_OPTIONS.map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-2">
                    <Label>Zuständiger Mitarbeiter</Label>
                    <SearchableSelect
                      options={employeeFilterOptions}
                      value={employeeFilter || "all"}
                      onValueChange={(value) => handleFilterChange("employee", value)}
                      placeholder="Alle Mitarbeiter"
                      searchPlaceholder="Mitarbeiter suchen..."
                      emptyText="Kein Mitarbeiter gefunden."
                      data-testid="select-employee"
                    />
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
            <SectionCard className="mb-6 border-red-200 bg-red-50">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <AlertCircle className={`${iconSize.md} text-red-600`} />
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
              </div>
            </SectionCard>
          )}

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
            </div>
          ) : customers.length === 0 ? (
            <SectionCard variant="muted">
              <EmptyState
                icon={<User2 className={iconSize.xl} />}
                title="Keine Kunden gefunden"
                description={
                  searchQuery || activeFilterCount > 0
                    ? "Versuchen Sie andere Suchbegriffe oder Filter"
                    : "Erstellen Sie Ihren ersten Kunden"
                }
                action={
                  (searchQuery || activeFilterCount > 0) && (
                    <Button variant="outline" onClick={clearFilters}>
                      Filter zurücksetzen
                    </Button>
                  )
                }
              />
            </SectionCard>
          ) : (
            <DataList>
              {customers.map((customer) => (
                <DataListItem
                  key={customer.id}
                  onClick={() => setLocation(`/admin/customers/${customer.id}`)}
                  className="bg-white"
                  data-testid={`card-customer-${customer.id}`}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <h3 className="font-medium text-gray-900">
                        {customer.name}
                      </h3>
                        {customer.address && (
                          <div className="flex items-center gap-1 text-sm text-gray-600 mt-1">
                            <MapPin className={iconSize.xs} />
                            <span>{customer.address}</span>
                          </div>
                        )}
                        {customer.telefon && (
                          <div className="flex items-center gap-1 text-sm text-gray-600">
                            <Phone className={iconSize.xs} />
                            <span>{customer.telefon}</span>
                          </div>
                        )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {customer.status === "erstberatung" && (
                        <StatusBadge type="status" value="Erstberatung" data-testid={`badge-status-${customer.id}`} />
                      )}
                      {customer.status === "inaktiv" && (
                        <StatusBadge type="warning" value="Inaktiv" data-testid={`badge-status-${customer.id}`} />
                      )}
                      {customer.billingType && (
                        <StatusBadge type="billingType" value={customer.billingType} data-testid={`badge-billingtype-${customer.id}`} />
                      )}
                      {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                        <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                      )}
                      {customer.hasActiveContract && (
                        <StatusBadge type="info" value="Vertrag" data-testid={`badge-contract-${customer.id}`} />
                      )}
                    </div>
                  </div>
                  {customer.primaryEmployee && (
                    <div className="mt-3 pt-3 border-t border-gray-100 text-sm text-gray-600">
                      Betreut von: {customer.primaryEmployee.displayName}
                    </div>
                  )}
                </DataListItem>
              ))}
            </DataList>
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
                <ChevronLeft className={iconSize.sm} />
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
                <ChevronRight className={iconSize.sm} />
              </Button>
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
}
