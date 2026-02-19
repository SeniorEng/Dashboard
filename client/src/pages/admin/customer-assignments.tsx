import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/patterns/status-badge";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, User, Users, Save } from "lucide-react";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";

interface Customer {
  id: number;
  name: string;
  vorname: string | null;
  nachname: string | null;
  address: string;
  pflegegrad: number | null;
  primaryEmployeeId: number | null;
  backupEmployeeId: number | null;
}

interface Employee {
  id: number;
  displayName: string;
  email: string;
  roles: string[];
}

export default function AdminCustomerAssignments() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [editingCustomer, setEditingCustomer] = useState<number | null>(null);
  const [assignments, setAssignments] = useState<
    Record<number, { primary: number | null; backup: number | null }>
  >({});

  const { data: customers, isLoading: customersLoading } = useQuery<Customer[]>({
    queryKey: ["customers"],
    queryFn: async () => {
      const res = await fetch("/api/customers", { credentials: "include" });
      if (!res.ok) throw new Error("Kunden konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: employees, isLoading: employeesLoading } = useQuery<Employee[]>({
    queryKey: ["admin", "employees"],
    queryFn: async () => {
      const res = await fetch("/api/admin/employees", { credentials: "include" });
      if (!res.ok) throw new Error("Mitarbeiter konnten nicht geladen werden");
      return res.json();
    },
  });

  const assignMutation = useMutation({
    mutationFn: async ({
      customerId,
      primaryEmployeeId,
      backupEmployeeId,
    }: {
      customerId: number;
      primaryEmployeeId: number | null;
      backupEmployeeId: number | null;
    }) => {
      const result = await api.patch(`/admin/customers/${customerId}/assign`, { primaryEmployeeId, backupEmployeeId });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["customers"] });
      setEditingCustomer(null);
      toast({ title: "Zuordnung gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const isLoading = customersLoading || employeesLoading;

  const employeeOptions = useMemo(() => [
    { value: "none", label: "Nicht zugewiesen" },
    ...(employees?.map((emp) => ({
      value: emp.id.toString(),
      label: emp.displayName,
    })) || []),
  ], [employees]);

  const getEmployeeName = (id: number | null) => {
    if (!id) return null;
    return employees?.find((e) => e.id === id)?.displayName || null;
  };

  const handleStartEdit = (customer: Customer) => {
    setEditingCustomer(customer.id);
    setAssignments({
      ...assignments,
      [customer.id]: {
        primary: customer.primaryEmployeeId,
        backup: customer.backupEmployeeId,
      },
    });
  };

  const handleSave = (customerId: number) => {
    const assignment = assignments[customerId];
    if (!assignment) return;

    assignMutation.mutate({
      customerId,
      primaryEmployeeId: assignment.primary,
      backupEmployeeId: assignment.backup,
    });
  };

  return (
    <Layout variant="admin">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Kundenzuordnung</h1>
              <p className="text-gray-600">
                Weisen Sie Kunden einem Hauptansprechpartner und einer Vertretung zu
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Loader2 className={`${iconSize.xl} animate-spin text-teal-600`} />
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {customers?.map((customer) => {
                const isEditing = editingCustomer === customer.id;
                const assignment = assignments[customer.id] || {
                  primary: customer.primaryEmployeeId,
                  backup: customer.backupEmployeeId,
                };

                return (
                  <Card key={customer.id} data-testid={`card-customer-${customer.id}`}>
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between mb-4">
                        <div>
                          <p className="font-medium text-gray-900">
                            {customer.vorname && customer.nachname
                              ? `${customer.vorname} ${customer.nachname}`
                              : customer.name}
                          </p>
                          <p className="text-sm text-gray-500">{customer.address}</p>
                          {customer.pflegegrad && (
                            <StatusBadge type="pflegegrad" value={customer.pflegegrad} className="mt-1" />
                          )}
                        </div>
                        {!isEditing ? (
                          <Button
                            variant="outline"
                            onClick={() => handleStartEdit(customer)}
                            data-testid={`button-edit-assignment-${customer.id}`}
                          >
                            Bearbeiten
                          </Button>
                        ) : (
                          <Button
                            onClick={() => handleSave(customer.id)}
                            disabled={assignMutation.isPending}
                            className="bg-teal-600 hover:bg-teal-700"
                            data-testid={`button-save-assignment-${customer.id}`}
                          >
                            {assignMutation.isPending ? (
                              <Loader2 className={`${iconSize.sm} animate-spin`} />
                            ) : (
                              <>
                                <Save className={`${iconSize.sm} mr-2`} />
                                Speichern
                              </>
                            )}
                          </Button>
                        )}
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <User className={`${iconSize.sm} text-teal-600`} />
                            <span className="text-sm font-medium">Hauptansprechpartner</span>
                          </div>
                          {isEditing ? (
                            <SearchableSelect
                              options={employeeOptions}
                              value={assignment.primary?.toString() || "none"}
                              onValueChange={(value) =>
                                setAssignments({
                                  ...assignments,
                                  [customer.id]: {
                                    ...assignment,
                                    primary: value === "none" ? null : parseInt(value),
                                  },
                                })
                              }
                              placeholder="Mitarbeiter wählen"
                              searchPlaceholder="Mitarbeiter suchen..."
                              emptyText="Kein Mitarbeiter gefunden."
                              data-testid={`select-primary-${customer.id}`}
                            />
                          ) : (
                            <p className="text-gray-700">
                              {getEmployeeName(customer.primaryEmployeeId) || (
                                <span className="text-gray-400">Nicht zugewiesen</span>
                              )}
                            </p>
                          )}
                        </div>

                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <Users className={`${iconSize.sm} text-orange-600`} />
                            <span className="text-sm font-medium">Vertretung</span>
                          </div>
                          {isEditing ? (
                            <SearchableSelect
                              options={employeeOptions}
                              value={assignment.backup?.toString() || "none"}
                              onValueChange={(value) =>
                                setAssignments({
                                  ...assignments,
                                  [customer.id]: {
                                    ...assignment,
                                    backup: value === "none" ? null : parseInt(value),
                                  },
                                })
                              }
                              placeholder="Vertretung wählen"
                              searchPlaceholder="Mitarbeiter suchen..."
                              emptyText="Kein Mitarbeiter gefunden."
                              data-testid={`select-backup-${customer.id}`}
                            />
                          ) : (
                            <p className="text-gray-700">
                              {getEmployeeName(customer.backupEmployeeId) || (
                                <span className="text-gray-400">Nicht zugewiesen</span>
                              )}
                            </p>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })}

              {customers?.length === 0 && (
                <Card>
                  <CardContent className="p-8 text-center text-gray-500">
                    Keine Kunden vorhanden
                  </CardContent>
                </Card>
              )}
            </div>
          )}
    </Layout>
  );
}
