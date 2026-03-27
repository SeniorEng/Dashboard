import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ArrowLeft, Check, Loader2, Users, AlertTriangle } from "lucide-react";
import { Link } from "wouter";
import { iconSize, componentStyles } from "@/design-system";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api";
import { CONTACT_TYPE_SELECT_OPTIONS, CONTACT_TYPE_LABELS } from "@shared/domain/customers";

interface LegacyContact {
  id: number;
  customerId: number;
  customerName: string;
  vorname: string;
  nachname: string;
  contactType: string;
  telefon: string;
  isPrimary: boolean;
  isActive: boolean;
}

export default function ContactMigrationPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selections, setSelections] = useState<Record<number, string>>({});

  const { data: contacts, isLoading } = useQuery<LegacyContact[]>({
    queryKey: ["admin", "contact-migration", "legacy"],
    queryFn: async () => {
      const result = await api.get<LegacyContact[]>("/admin/contact-migration/legacy");
      return unwrapResult(result);
    },
  });

  const migrateMutation = useMutation({
    mutationFn: async ({ id, contactType }: { id: number; contactType: string }) => {
      const result = await api.patch(`/admin/contact-migration/${id}`, { contactType });
      return unwrapResult(result);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "contact-migration", "legacy"] });
      setSelections((prev) => {
        const next = { ...prev };
        delete next[variables.id];
        return next;
      });
      toast({ title: "Kontakttyp aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const migrateAllMutation = useMutation({
    mutationFn: async (entries: { id: number; contactType: string }[]) => {
      const errors: string[] = [];
      for (const entry of entries) {
        const result = await api.patch(`/admin/contact-migration/${entry.id}`, { contactType: entry.contactType });
        try {
          unwrapResult(result);
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          errors.push(`Kontakt ${entry.id}: ${msg}`);
        }
      }
      if (errors.length > 0) {
        throw new Error(`${errors.length} Fehler: ${errors[0]}`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin", "contact-migration", "legacy"] });
      setSelections({});
      toast({ title: "Alle ausgewählten Kontakte migriert" });
    },
    onError: (error: Error) => {
      queryClient.invalidateQueries({ queryKey: ["admin", "contact-migration", "legacy"] });
      toast({ title: "Fehler bei Migration", description: error.message, variant: "destructive" });
    },
  });

  const handleMigrateAll = () => {
    const entries = Object.entries(selections)
      .filter(([, type]) => type)
      .map(([id, contactType]) => ({ id: Number(id), contactType }));
    if (entries.length === 0) {
      toast({ title: "Keine Auswahl", description: "Bitte wählen Sie zuerst neue Kontakttypen aus.", variant: "destructive" });
      return;
    }
    migrateAllMutation.mutate(entries);
  };

  const selectedCount = Object.values(selections).filter(Boolean).length;
  const totalCount = contacts?.length ?? 0;

  return (
    <Layout>
      <div className="max-w-5xl mx-auto space-y-4">
        <div className="flex items-center gap-3">
          <Link href="/admin/customers">
            <Button variant="ghost" size="sm" data-testid="button-back-customers">
              <ArrowLeft className={`${iconSize.sm} mr-1`} />
              Zurück
            </Button>
          </Link>
        </div>

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Users className={iconSize.md} />
                <div>
                  <CardTitle className="text-lg">Kontakttypen-Migration</CardTitle>
                  <p className="text-sm text-gray-500 mt-1">
                    Bestehende Kontakte mit alten Typen („Familienmitglied", „Angehörige") auf die neuen, spezifischeren Kontakttypen umstellen.
                  </p>
                </div>
              </div>
              {selectedCount > 0 && (
                <Button
                  onClick={handleMigrateAll}
                  disabled={migrateAllMutation.isPending}
                  className={componentStyles.btnPrimary}
                  data-testid="button-migrate-all"
                >
                  {migrateAllMutation.isPending ? (
                    <><Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />Migriere...</>
                  ) : (
                    <><Check className={`${iconSize.sm} mr-1`} />{selectedCount} migrieren</>
                  )}
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
              </div>
            ) : totalCount === 0 ? (
              <div className="text-center py-12 space-y-3">
                <Check className={`${iconSize.xl} text-green-500 mx-auto`} />
                <p className="text-lg font-medium text-gray-700" data-testid="text-migration-complete">
                  Migration abgeschlossen
                </p>
                <p className="text-sm text-gray-500">
                  Alle Kontakte verwenden bereits die neuen Kontakttypen.
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertTriangle className={`${iconSize.sm} text-amber-600 shrink-0`} />
                  <p className="text-sm text-amber-800">
                    {totalCount} Kontakt{totalCount !== 1 ? "e" : ""} mit alten Typen gefunden. Bitte neuen Typ auswählen und migrieren.
                  </p>
                </div>

                <div className="border rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b">
                      <tr>
                        <th className="text-left px-4 py-3 font-medium text-gray-600">Kunde</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-600">Kontakt</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-600">Alter Typ</th>
                        <th className="text-left px-4 py-3 font-medium text-gray-600">Neuer Typ</th>
                        <th className="text-right px-4 py-3 font-medium text-gray-600">Aktion</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {contacts?.map((contact) => (
                        <tr key={contact.id} className="hover:bg-gray-50" data-testid={`row-contact-${contact.id}`}>
                          <td className="px-4 py-3">
                            <Link href={`/admin/customers/${contact.customerId}`}>
                              <span className="text-teal-600 hover:underline cursor-pointer" data-testid={`link-customer-${contact.customerId}`}>
                                {contact.customerName}
                              </span>
                            </Link>
                          </td>
                          <td className="px-4 py-3">
                            <span data-testid={`text-contact-name-${contact.id}`}>
                              {contact.vorname} {contact.nachname}
                            </span>
                            {contact.isPrimary && (
                              <Badge variant="secondary" className="ml-2 text-[10px]">Haupt</Badge>
                            )}
                          </td>
                          <td className="px-4 py-3">
                            <Badge variant="outline" className="text-amber-700 border-amber-300 bg-amber-50">
                              {CONTACT_TYPE_LABELS[contact.contactType] ?? contact.contactType}
                            </Badge>
                          </td>
                          <td className="px-4 py-3">
                            <Select
                              value={selections[contact.id] ?? ""}
                              onValueChange={(v) => setSelections((prev) => ({ ...prev, [contact.id]: v }))}
                            >
                              <SelectTrigger className="w-[200px]" data-testid={`select-new-type-${contact.id}`}>
                                <SelectValue placeholder="Neuen Typ wählen..." />
                              </SelectTrigger>
                              <SelectContent>
                                {CONTACT_TYPE_SELECT_OPTIONS.map((t) => (
                                  <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="px-4 py-3 text-right">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!selections[contact.id] || migrateMutation.isPending}
                              onClick={() => migrateMutation.mutate({ id: contact.id, contactType: selections[contact.id] })}
                              data-testid={`button-migrate-${contact.id}`}
                            >
                              {migrateMutation.isPending && migrateMutation.variables?.id === contact.id ? (
                                <Loader2 className={`${iconSize.sm} animate-spin`} />
                              ) : (
                                <Check className={iconSize.sm} />
                              )}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
