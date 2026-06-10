import { useState, useEffect, useMemo, useRef } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Calendar, Loader2, User } from "lucide-react";
import { iconSize } from "@/design-system";
import { useCustomers } from "@/features/customers";
import { useCustomerAppointments } from "../hooks/use-appointments";
import { AppointmentCard } from "./appointment-card";

type AppointmentFilter = "upcoming" | "past" | "all";

function todayISO(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function CustomerAppointmentsTab() {
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [filter, setFilter] = useState<AppointmentFilter>("upcoming");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(search), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [search]);

  const { data: customerData, isLoading: customersLoading } = useCustomers({
    search: debouncedSearch || undefined,
    limit: 50,
    sortBy: "name",
    sortOrder: "asc",
  });

  const customerOptions = useMemo(
    () => (customerData?.data ?? []).map((c) => ({
      value: String(c.id),
      label: c.name,
    })),
    [customerData],
  );

  const customerId = selectedCustomerId ? parseInt(selectedCustomerId, 10) : null;
  const { data: appointments = [], isLoading: appointmentsLoading } = useCustomerAppointments(customerId);

  const today = todayISO();
  const filteredAppointments = useMemo(() => {
    if (filter === "all") return appointments;
    if (filter === "past") return appointments.filter((a) => a.date < today);
    return appointments.filter((a) => a.date >= today);
  }, [appointments, filter, today]);

  return (
    <div className="space-y-6">
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="customer-picker">Kunde</Label>
            <SearchableSelect
              options={customerOptions}
              value={selectedCustomerId}
              onValueChange={setSelectedCustomerId}
              onSearchChange={setSearch}
              serverSideSearch
              isLoading={customersLoading}
              placeholder="Kunde auswählen…"
              searchPlaceholder="Kunde suchen…"
              emptyText="Kein Kunde gefunden."
              data-testid="select-customer-appointments"
            />
          </div>

          {customerId && (
            <div className="space-y-2">
              <Label>Zeitraum</Label>
              <div className="flex flex-wrap gap-2" data-testid="toggle-appointment-filter">
                {([
                  { value: "upcoming", label: "Anstehend" },
                  { value: "past", label: "Vergangen" },
                  { value: "all", label: "Alle" },
                ] as { value: AppointmentFilter; label: string }[]).map((opt) => (
                  <Button
                    key={opt.value}
                    type="button"
                    variant={filter === opt.value ? "default" : "outline"}
                    size="sm"
                    onClick={() => setFilter(opt.value)}
                    data-testid={`filter-${opt.value}`}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {!customerId ? (
        <Card>
          <CardContent className="py-12 text-center">
            <User className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground">Bitte wählen Sie einen Kunden aus, um dessen Termine anzuzeigen.</p>
          </CardContent>
        </Card>
      ) : appointmentsLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className={`${iconSize.lg} animate-spin text-primary`} />
        </div>
      ) : filteredAppointments.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Calendar className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
            <p className="text-muted-foreground" data-testid="text-no-appointments">Keine Termine in diesem Zeitraum.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2" data-testid="list-customer-appointments">
          {filteredAppointments.map((appointment) => (
            <AppointmentCard
              key={appointment.id}
              appointment={appointment}
              showDate
            />
          ))}
        </div>
      )}
    </div>
  );
}
