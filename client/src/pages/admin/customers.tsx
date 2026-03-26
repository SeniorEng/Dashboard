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
import { useCustomers, useEmployees, useInsuranceProviders, useAssignCustomer } from "@/features/customers";
import { useToast } from "@/hooks/use-toast";
import { iconSize, getPflegegradColors, componentStyles } from "@/design-system";
import { isChild } from "@shared/utils/datetime";
import {
  Plus,
  Loader2,
  Search,
  SlidersHorizontal,
  ChevronLeft,
  AlertTriangle,
  ChevronRight,
  User2,
  MapPin,
  Phone,
  AlertCircle,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { PFLEGEGRAD_SELECT_OPTIONS, BILLING_TYPE_SELECT_OPTIONS } from "@shared/domain/customers";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import type { CustomerListItem } from "@/lib/api/types";

const ROLE_LABELS: Record<string, string> = {
  primary: "Hauptverantwortlich",
  backup: "1. Vertretung",
  backup2: "2. Vertretung",
};

export default function AdminCustomers() {
  const [, setLocation] = useLocation();
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("aktiv");
  const [pflegegradFilter, setPflegegradFilter] = useState<string>("");
  const [billingTypeFilter, setBillingTypeFilter] = useState<string>("");
  const [employeeFilter, setEmployeeFilter] = useState<string>("");
  const [insuranceProviderFilter, setInsuranceProviderFilter] = useState<string>("");
  const [currentPage, setCurrentPage] = useState(1);
  const [sortBy, setSortBy] = useState<string>("name");
  const [sortOrder, setSortOrder] = useState<string>("asc");
  const [filterSheetOpen, setFilterSheetOpen] = useState(false);

  const [editingCustomerId, setEditingCustomerId] = useState<number | null>(null);
  const [editData, setEditData] = useState({
    primaryEmployeeId: "",
    backupEmployeeId: "",
    backupEmployeeId2: "",
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const { toast } = useToast();
  const { data: employees } = useEmployees();
  const { data: insuranceProviders } = useInsuranceProviders();
  const assignCustomer = useAssignCustomer();

  const employeeFilterOptions = useMemo(() => [
    { value: "all", label: "Alle Mitarbeiter" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })).sort((a, b) => a.label.localeCompare(b.label, "de")) || []),
  ], [employees]);

  const employeeEditOptions = useMemo(() => [
    { value: "", label: "Nicht zugewiesen" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })).sort((a, b) => a.label.localeCompare(b.label, "de")) || []),
  ], [employees]);

  const insuranceProviderFilterOptions = useMemo(() => [
    { value: "all", label: "Alle Kostenträger" },
    ...(insuranceProviders?.map((p) => ({
      value: p.id.toString(),
      label: `${p.name} (${p.ikNummer})`,
    })).sort((a, b) => a.label.localeCompare(b.label, "de")) || []),
  ], [insuranceProviders]);

  const queryParams = useMemo(() => ({
    search: debouncedSearch || undefined,
    status: statusFilter || undefined,
    pflegegrad: pflegegradFilter || undefined,
    billingType: billingTypeFilter || undefined,
    responsibleEmployeeId: employeeFilter || undefined,
    insuranceProviderId: insuranceProviderFilter || undefined,
    sortBy: sortBy || undefined,
    sortOrder: sortOrder || undefined,
    page: currentPage,
    limit: 15,
  }), [debouncedSearch, statusFilter, pflegegradFilter, billingTypeFilter, employeeFilter, insuranceProviderFilter, sortBy, sortOrder, currentPage]);

  const { data, isLoading, error, refetch } = useCustomers(queryParams);

  const handlePageChange = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    setCurrentPage(1);
  }, []);

  const handleFilterChange = useCallback((type: "pflegegrad" | "employee" | "status" | "billingType" | "insuranceProvider", value: string) => {
    if (type === "pflegegrad") {
      setPflegegradFilter(value === "all" ? "" : value);
    } else if (type === "billingType") {
      setBillingTypeFilter(value === "all" ? "" : value);
    } else if (type === "employee") {
      setEmployeeFilter(value === "all" ? "" : value);
    } else if (type === "insuranceProvider") {
      setInsuranceProviderFilter(value === "all" ? "" : value);
    } else if (type === "status") {
      setStatusFilter(value === "all" ? "" : value);
    }
    setCurrentPage(1);
  }, []);

  const handleSortChange = useCallback((value: string) => {
    const [newSortBy, newSortOrder] = value.split("_");
    setSortBy(newSortBy);
    setSortOrder(newSortOrder);
    setCurrentPage(1);
  }, []);

  const clearFilters = useCallback(() => {
    setStatusFilter("aktiv");
    setPflegegradFilter("");
    setBillingTypeFilter("");
    setEmployeeFilter("");
    setInsuranceProviderFilter("");
    setSortBy("name");
    setSortOrder("asc");
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
    if (insuranceProviderFilter) count++;
    if (sortBy !== "name" || sortOrder !== "asc") count++;
    return count;
  }, [statusFilter, pflegegradFilter, billingTypeFilter, employeeFilter, insuranceProviderFilter, sortBy, sortOrder]);

  const startEditing = useCallback((customer: CustomerListItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingCustomerId(customer.id);
    setEditData({
      primaryEmployeeId: customer.primaryEmployee?.id?.toString() || "",
      backupEmployeeId: customer.backupEmployee?.id?.toString() || "",
      backupEmployeeId2: customer.backupEmployee2?.id?.toString() || "",
    });
  }, []);

  const cancelEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingCustomerId(null);
  }, []);

  const saveAssignment = useCallback((customerId: number, e: React.MouseEvent) => {
    e.stopPropagation();
    const primaryId = editData.primaryEmployeeId ? parseInt(editData.primaryEmployeeId) : null;
    const backupId = editData.backupEmployeeId ? parseInt(editData.backupEmployeeId) : null;
    const backupId2 = editData.backupEmployeeId2 ? parseInt(editData.backupEmployeeId2) : null;

    const ids = [primaryId, backupId, backupId2].filter((id): id is number => id !== null);
    const uniqueIds = new Set(ids);
    if (ids.length !== uniqueIds.size) {
      toast({ title: "Ungültige Auswahl", description: "Alle zugewiesenen Mitarbeiter müssen unterschiedlich sein.", variant: "destructive" });
      return;
    }

    assignCustomer.mutate({
      customerId,
      primaryEmployeeId: primaryId,
      backupEmployeeId: backupId,
      backupEmployeeId2: backupId2,
    }, {
      onSuccess: () => setEditingCustomerId(null),
    });
  }, [editData, assignCustomer]);

  const customers = data?.data || [];
  const totalPages = data?.totalPages || 1;
  const total = data?.total || 0;

  return (
    <Layout variant="admin">
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
              <Search className={`absolute left-3 top-1/2 transform -translate-y-1/2 ${iconSize.sm} text-gray-500`} />
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

                  <div className="space-y-2">
                    <Label>Kostenträger</Label>
                    <SearchableSelect
                      options={insuranceProviderFilterOptions}
                      value={insuranceProviderFilter || "all"}
                      onValueChange={(value) => handleFilterChange("insuranceProvider", value)}
                      placeholder="Alle Kostenträger"
                      searchPlaceholder="Kostenträger suchen..."
                      emptyText="Kein Kostenträger gefunden."
                      data-testid="select-insurance-provider"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label>Sortierung</Label>
                    <Select
                      value={`${sortBy}_${sortOrder}`}
                      onValueChange={handleSortChange}
                    >
                      <SelectTrigger data-testid="select-sort">
                        <SelectValue placeholder="Sortierung wählen" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="name_asc">Name (A-Z)</SelectItem>
                        <SelectItem value="name_desc">Name (Z-A)</SelectItem>
                        <SelectItem value="contractStart_desc">Vertragsbeginn (neueste zuerst)</SelectItem>
                        <SelectItem value="contractStart_asc">Vertragsbeginn (älteste zuerst)</SelectItem>
                        <SelectItem value="createdAt_desc">Angelegt (neueste zuerst)</SelectItem>
                        <SelectItem value="createdAt_asc">Angelegt (älteste zuerst)</SelectItem>
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
                  onClick={editingCustomerId === customer.id ? undefined : () => setLocation(`/admin/customers/${customer.id}`)}
                  className={`bg-white ${editingCustomerId === customer.id ? "cursor-default ring-2 ring-teal-300" : ""}`}
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
                        {(customer.telefon || customer.festnetz) && (
                          <div className="flex items-center gap-1 text-sm text-gray-600">
                            <Phone className={iconSize.xs} />
                            <span>
                              {[
                                customer.telefon ? formatPhoneForDisplay(customer.telefon) : null,
                                customer.festnetz ? formatPhoneForDisplay(customer.festnetz) : null,
                              ].filter(Boolean).join(" · ")}
                            </span>
                          </div>
                        )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      {customer.status === "inaktiv" && (
                        <StatusBadge type="warning" value="Inaktiv" data-testid={`badge-status-${customer.id}`} />
                      )}
                      {customer.status === "aktiv" && customer.inaktivAb && (
                        <StatusBadge type="info" value="Auslaufend" data-testid={`badge-auslaufend-${customer.id}`} />
                      )}
                      {customer.billingType && (
                        <StatusBadge type="billingType" value={customer.billingType} data-testid={`badge-billingtype-${customer.id}`} />
                      )}
                      {customer.pflegegrad !== null && customer.pflegegrad > 0 && (
                        <StatusBadge type="pflegegrad" value={customer.pflegegrad} />
                      )}
                      {isChild(customer.geburtsdatum) && (
                        <StatusBadge type="warning" value="Minderjährig" data-testid={`badge-minor-${customer.id}`} />
                      )}
                      {customer.matchedRole && (
                        <Badge variant="outline" className="text-xs border-teal-300 text-teal-700 bg-teal-50" data-testid={`badge-role-${customer.id}`}>
                          {ROLE_LABELS[customer.matchedRole]}
                        </Badge>
                      )}
                    </div>
                  </div>

                  {editingCustomerId === customer.id ? (
                    <div className="mt-3 pt-3 border-t border-gray-100" onClick={(e) => e.stopPropagation()}>
                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                        <div className="space-y-1">
                          <Label className="text-xs text-gray-500">Hauptverantwortlich</Label>
                          <SearchableSelect
                            options={employeeEditOptions}
                            value={editData.primaryEmployeeId}
                            onValueChange={(value) => setEditData((prev) => ({ ...prev, primaryEmployeeId: value }))}
                            placeholder="Auswählen..."
                            searchPlaceholder="Suchen..."
                            emptyText="Nicht gefunden."
                            data-testid={`inline-select-primary-${customer.id}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-gray-500">1. Vertretung</Label>
                          <SearchableSelect
                            options={employeeEditOptions}
                            value={editData.backupEmployeeId}
                            onValueChange={(value) => setEditData((prev) => ({ ...prev, backupEmployeeId: value }))}
                            placeholder="Auswählen..."
                            searchPlaceholder="Suchen..."
                            emptyText="Nicht gefunden."
                            data-testid={`inline-select-backup-${customer.id}`}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs text-gray-500">2. Vertretung</Label>
                          <SearchableSelect
                            options={employeeEditOptions}
                            value={editData.backupEmployeeId2}
                            onValueChange={(value) => setEditData((prev) => ({ ...prev, backupEmployeeId2: value }))}
                            placeholder="Auswählen..."
                            searchPlaceholder="Suchen..."
                            emptyText="Nicht gefunden."
                            data-testid={`inline-select-backup2-${customer.id}`}
                          />
                        </div>
                      </div>
                      <div className="flex justify-end gap-2 mt-3">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={cancelEditing}
                          disabled={assignCustomer.isPending}
                          data-testid={`button-cancel-assign-${customer.id}`}
                        >
                          <X className="h-4 w-4 mr-1" />
                          Abbrechen
                        </Button>
                        <Button
                          size="sm"
                          onClick={(e) => saveAssignment(customer.id, e)}
                          disabled={assignCustomer.isPending}
                          className="bg-teal-600 hover:bg-teal-700"
                          data-testid={`button-save-assign-${customer.id}`}
                        >
                          {assignCustomer.isPending ? (
                            <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          ) : (
                            <Check className="h-4 w-4 mr-1" />
                          )}
                          Speichern
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {(customer.primaryEmployee || customer.backupEmployee || customer.backupEmployee2) ? (
                        <div className="mt-3 pt-3 border-t border-gray-100 flex items-center justify-between">
                          <div className="text-sm text-gray-600 space-y-0.5">
                            {customer.primaryEmployee && (
                              <div data-testid={`text-primary-${customer.id}`}>
                                <span className="text-gray-400 text-xs">HV</span>{" "}
                                {customer.primaryEmployee.displayName}
                              </div>
                            )}
                            {(customer.backupEmployee || customer.backupEmployee2) && (
                              <div className="flex flex-wrap gap-x-4 text-xs text-gray-500">
                                {customer.backupEmployee && (
                                  <span data-testid={`text-backup-${customer.id}`}>
                                    V1: {customer.backupEmployee.displayName}
                                  </span>
                                )}
                                {customer.backupEmployee2 && (
                                  <span data-testid={`text-backup2-${customer.id}`}>
                                    V2: {customer.backupEmployee2.displayName}
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-gray-400 hover:text-gray-600"
                            onClick={(e) => startEditing(customer, e)}
                            data-testid={`button-edit-assign-${customer.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="mt-2 flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1.5" data-testid={`banner-no-betreuer-${customer.id}`}>
                            <AlertTriangle className="h-3.5 w-3.5 flex-shrink-0" />
                            <span>Kein Betreuer / Vertreter hinterlegt</span>
                          </div>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-gray-400 hover:text-gray-600"
                            onClick={(e) => startEditing(customer, e)}
                            data-testid={`button-edit-assign-${customer.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </>
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
                aria-label="Vorherige Seite"
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
                aria-label="Nächste Seite"
              >
                <ChevronRight className={iconSize.sm} />
              </Button>
            </div>
          )}
    </Layout>
  );
}
