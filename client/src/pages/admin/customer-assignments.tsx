import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Layout } from "@/components/layout";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeft, Loader2, User, Users, Save } from "lucide-react";

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
      const res = await fetch(`/api/admin/customers/${customerId}/assign`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ primaryEmployeeId, backupEmployeeId }),
        credentials: "include",
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.message || "Zuordnung konnte nicht gespeichert werden");
      }
      return res.json();
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
    <Layout>
      <div className="min-h-screen bg-gradient-to-br from-[#f5e6d3] to-[#e8d4c4]">
        <div className="container mx-auto px-4 py-6 max-w-4xl">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" data-testid="button-back">
                <ArrowLeft className="h-5 w-5" />
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
              <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
            </div>
          ) : (
            <div className="space-y-4">
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
                            <Badge variant="outline" className="mt-1">
                              Pflegegrad {customer.pflegegrad}
                            </Badge>
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
                              <Loader2 className="h-4 w-4 animate-spin" />
                            ) : (
                              <>
                                <Save className="h-4 w-4 mr-2" />
                                Speichern
                              </>
                            )}
                          </Button>
                        )}
                      </div>

                      <div className="grid gap-4 md:grid-cols-2">
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <User className="h-4 w-4 text-teal-600" />
                            <span className="text-sm font-medium">Hauptansprechpartner</span>
                          </div>
                          {isEditing ? (
                            <Select
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
                            >
                              <SelectTrigger data-testid={`select-primary-${customer.id}`}>
                                <SelectValue placeholder="Mitarbeiter wählen" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Nicht zugewiesen</SelectItem>
                                {employees?.map((employee) => (
                                  <SelectItem
                                    key={employee.id}
                                    value={employee.id.toString()}
                                    disabled={assignment.backup === employee.id}
                                  >
                                    {employee.displayName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
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
                            <Users className="h-4 w-4 text-orange-600" />
                            <span className="text-sm font-medium">Vertretung</span>
                          </div>
                          {isEditing ? (
                            <Select
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
                            >
                              <SelectTrigger data-testid={`select-backup-${customer.id}`}>
                                <SelectValue placeholder="Vertretung wählen" />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="none">Nicht zugewiesen</SelectItem>
                                {employees?.map((employee) => (
                                  <SelectItem
                                    key={employee.id}
                                    value={employee.id.toString()}
                                    disabled={assignment.primary === employee.id}
                                  >
                                    {employee.displayName}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
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
        </div>
      </div>
    </Layout>
  );
}
