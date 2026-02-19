import { useState, useEffect, useRef } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Loader2, Upload, Trash2, ImageIcon } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize } from "@/design-system";
import type { SystemSettings, CompanySettings } from "@shared/schema";

const BUNDESLAENDER = [
  "Baden-Württemberg",
  "Bayern",
  "Berlin",
  "Brandenburg",
  "Bremen",
  "Hamburg",
  "Hessen",
  "Mecklenburg-Vorpommern",
  "Niedersachsen",
  "Nordrhein-Westfalen",
  "Rheinland-Pfalz",
  "Saarland",
  "Sachsen",
  "Sachsen-Anhalt",
  "Schleswig-Holstein",
  "Thüringen",
];

const emptyCompanyForm = {
  companyName: "",
  geschaeftsfuehrer: "",
  strasse: "",
  hausnummer: "",
  plz: "",
  stadt: "",
  telefon: "",
  email: "",
  website: "",
  steuernummer: "",
  ustId: "",
  iban: "",
  bic: "",
  bankName: "",
  ikNummer: "",
  anerkennungsnummer45a: "",
  anerkennungsBundesland: "",
};

export default function AdminSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<SystemSettings>({
    queryKey: ["settings"],
    queryFn: async () => {
      const res = await fetch("/api/settings", { credentials: "include" });
      if (!res.ok) throw new Error("Einstellungen konnten nicht geladen werden");
      return res.json();
    },
  });

  const { data: companyData, isLoading: isCompanyLoading } = useQuery<CompanySettings>({
    queryKey: ["company-settings"],
    queryFn: async () => {
      const res = await fetch("/api/company-settings", { credentials: "include" });
      if (!res.ok) throw new Error("Firmendaten konnten nicht geladen werden");
      return res.json();
    },
  });

  const [companyForm, setCompanyForm] = useState(emptyCompanyForm);

  useEffect(() => {
    if (companyData) {
      setCompanyForm({
        companyName: companyData.companyName ?? "",
        geschaeftsfuehrer: companyData.geschaeftsfuehrer ?? "",
        strasse: companyData.strasse ?? "",
        hausnummer: companyData.hausnummer ?? "",
        plz: companyData.plz ?? "",
        stadt: companyData.stadt ?? "",
        telefon: companyData.telefon ?? "",
        email: companyData.email ?? "",
        website: companyData.website ?? "",
        steuernummer: companyData.steuernummer ?? "",
        ustId: companyData.ustId ?? "",
        iban: companyData.iban ?? "",
        bic: companyData.bic ?? "",
        bankName: companyData.bankName ?? "",
        ikNummer: companyData.ikNummer ?? "",
        anerkennungsnummer45a: companyData.anerkennungsnummer45a ?? "",
        anerkennungsBundesland: companyData.anerkennungsBundesland ?? "",
      });
    }
  }, [companyData]);

  const updateField = (field: keyof typeof companyForm, value: string) => {
    setCompanyForm((prev) => ({ ...prev, [field]: value }));
  };

  const companySaveMutation = useMutation({
    mutationFn: async (data: typeof companyForm) => {
      const result = await api.patch<CompanySettings>("/company-settings", data);
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Firmendaten gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const toggleMutation = useMutation({
    mutationFn: async (autoBreaksEnabled: boolean) => {
      const result = await api.patch<SystemSettings>("/settings", { autoBreaksEnabled });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["settings"], data);
      toast({
        title: data.autoBreaksEnabled
          ? "Automatische Pausen aktiviert"
          : "Automatische Pausen deaktiviert",
      });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  const logoUploadMutation = useMutation({
    mutationFn: async (file: File) => {
      setLogoUploading(true);
      const uploadRes = await api.post<{ uploadURL: string; objectPath: string; metadata: { name: string } }>(
        "/uploads/request-url",
        { name: file.name, size: file.size, contentType: file.type }
      );
      const uploadData = unwrapResult(uploadRes);

      await fetch(uploadData.uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });

      const result = await api.patch<CompanySettings>("/company-settings", {
        logoUrl: uploadData.objectPath,
      });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Logo hochgeladen" });
      setLogoUploading(false);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler beim Logo-Upload", description: error.message, variant: "destructive" });
      setLogoUploading(false);
    },
  });

  const logoDeleteMutation = useMutation({
    mutationFn: async () => {
      const result = await api.patch<CompanySettings>("/company-settings", { logoUrl: null });
      return unwrapResult(result);
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["company-settings"], data);
      toast({ title: "Logo entfernt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleLogoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast({ title: "Nur Bilddateien erlaubt", variant: "destructive" });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast({ title: "Datei zu groß (max. 2 MB)", variant: "destructive" });
      return;
    }

    logoUploadMutation.mutate(file);
    e.target.value = "";
  };

  const loading = isLoading || isCompanyLoading;

  return (
    <Layout variant="admin">
          <div className="flex items-center gap-4 mb-6">
            <Link href="/admin">
              <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <div>
              <h1 className="text-2xl font-bold text-gray-900">Einstellungen</h1>
              <p className="text-gray-600">Systemweite Konfiguration</p>
            </div>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-8 w-8 animate-spin text-teal-600" />
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <Card data-testid="card-company-logo">
                <CardHeader>
                  <CardTitle>Firmenlogo</CardTitle>
                  <CardDescription>
                    Wird im Header der Anwendung und auf Dokumenten angezeigt.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center gap-6">
                    <div className="w-24 h-24 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center overflow-hidden bg-gray-50 shrink-0">
                      {companyData?.logoUrl ? (
                        <img
                          src={companyData.logoUrl}
                          alt="Firmenlogo"
                          className="w-full h-full object-contain p-1"
                          data-testid="img-company-logo"
                        />
                      ) : (
                        <ImageIcon className="h-8 w-8 text-gray-400" />
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/png,image/jpeg,image/svg+xml,image/webp"
                        className="hidden"
                        onChange={handleLogoSelect}
                        data-testid="input-logo-file"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={logoUploading}
                        onClick={() => fileInputRef.current?.click()}
                        data-testid="button-upload-logo"
                      >
                        {logoUploading ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <Upload className="mr-2 h-4 w-4" />
                        )}
                        {companyData?.logoUrl ? "Logo ändern" : "Logo hochladen"}
                      </Button>
                      {companyData?.logoUrl && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={logoDeleteMutation.isPending}
                          onClick={() => logoDeleteMutation.mutate()}
                          className="text-red-600 hover:text-red-700 hover:bg-red-50 justify-start"
                          data-testid="button-delete-logo"
                        >
                          {logoDeleteMutation.isPending ? (
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="mr-2 h-4 w-4" />
                          )}
                          Logo entfernen
                        </Button>
                      )}
                      <p className="text-xs text-gray-500">
                        PNG, JPG, SVG oder WebP. Max. 2 MB.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card data-testid="card-company-settings">
                <CardHeader>
                  <CardTitle>Firmenstammdaten</CardTitle>
                  <CardDescription>
                    Diese Daten werden auf Rechnungen und Leistungsnachweisen verwendet.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      companySaveMutation.mutate(companyForm);
                    }}
                    className="flex flex-col gap-6"
                  >
                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Firma</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="companyName">Firmenname</Label>
                          <Input
                            id="companyName"
                            data-testid="input-company-companyName"
                            value={companyForm.companyName}
                            onChange={(e) => updateField("companyName", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="geschaeftsfuehrer">Geschäftsführer</Label>
                          <Input
                            id="geschaeftsfuehrer"
                            data-testid="input-company-geschaeftsfuehrer"
                            value={companyForm.geschaeftsfuehrer}
                            onChange={(e) => updateField("geschaeftsfuehrer", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Adresse</h3>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="strasse">Straße</Label>
                          <Input
                            id="strasse"
                            data-testid="input-company-strasse"
                            value={companyForm.strasse}
                            onChange={(e) => updateField("strasse", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="hausnummer">Hausnummer</Label>
                          <Input
                            id="hausnummer"
                            data-testid="input-company-hausnummer"
                            value={companyForm.hausnummer}
                            onChange={(e) => updateField("hausnummer", e.target.value)}
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <Label htmlFor="plz">PLZ</Label>
                          <Input
                            id="plz"
                            data-testid="input-company-plz"
                            value={companyForm.plz}
                            onChange={(e) => updateField("plz", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="stadt">Stadt</Label>
                          <Input
                            id="stadt"
                            data-testid="input-company-stadt"
                            value={companyForm.stadt}
                            onChange={(e) => updateField("stadt", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Kontakt</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="telefon">Telefon</Label>
                          <Input
                            id="telefon"
                            data-testid="input-company-telefon"
                            value={companyForm.telefon}
                            onChange={(e) => updateField("telefon", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="email">E-Mail</Label>
                          <Input
                            id="email"
                            data-testid="input-company-email"
                            value={companyForm.email}
                            onChange={(e) => updateField("email", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="website">Website</Label>
                          <Input
                            id="website"
                            data-testid="input-company-website"
                            value={companyForm.website}
                            onChange={(e) => updateField("website", e.target.value)}
                            placeholder="Optional"
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Steuerdaten</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="steuernummer">Steuernummer</Label>
                          <Input
                            id="steuernummer"
                            data-testid="input-company-steuernummer"
                            value={companyForm.steuernummer}
                            onChange={(e) => updateField("steuernummer", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="ustId">USt-ID</Label>
                          <Input
                            id="ustId"
                            data-testid="input-company-ustId"
                            value={companyForm.ustId}
                            onChange={(e) => updateField("ustId", e.target.value)}
                            placeholder="Optional"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                            Entfällt bei Steuerbefreiung nach §4 Nr. 16 UStG
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Bankverbindung</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="iban">IBAN</Label>
                          <Input
                            id="iban"
                            data-testid="input-company-iban"
                            value={companyForm.iban}
                            onChange={(e) => updateField("iban", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="bic">BIC</Label>
                          <Input
                            id="bic"
                            data-testid="input-company-bic"
                            value={companyForm.bic}
                            onChange={(e) => updateField("bic", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="bankName">Bank</Label>
                          <Input
                            id="bankName"
                            data-testid="input-company-bankName"
                            value={companyForm.bankName}
                            onChange={(e) => updateField("bankName", e.target.value)}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col gap-3">
                      <h3 className="text-sm font-medium text-gray-700">Anerkennung</h3>
                      <div className="flex flex-col gap-3">
                        <div>
                          <Label htmlFor="ikNummer">IK-Nummer</Label>
                          <Input
                            id="ikNummer"
                            data-testid="input-company-ikNummer"
                            value={companyForm.ikNummer}
                            onChange={(e) => updateField("ikNummer", e.target.value)}
                            placeholder="9 Ziffern, Institutionskennzeichen"
                          />
                        </div>
                        <div>
                          <Label htmlFor="anerkennungsnummer45a">Anerkennungsnummer (§45a)</Label>
                          <Input
                            id="anerkennungsnummer45a"
                            data-testid="input-company-anerkennungsnummer45a"
                            value={companyForm.anerkennungsnummer45a}
                            onChange={(e) => updateField("anerkennungsnummer45a", e.target.value)}
                          />
                        </div>
                        <div>
                          <Label htmlFor="anerkennungsBundesland">Bundesland der Anerkennung</Label>
                          <Select
                            value={companyForm.anerkennungsBundesland}
                            onValueChange={(value) => updateField("anerkennungsBundesland", value)}
                          >
                            <SelectTrigger data-testid="select-company-bundesland" id="anerkennungsBundesland">
                              <SelectValue placeholder="Bundesland wählen" />
                            </SelectTrigger>
                            <SelectContent>
                              {BUNDESLAENDER.map((bl) => (
                                <SelectItem key={bl} value={bl}>
                                  {bl}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    </div>

                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        data-testid="button-save-company"
                        disabled={companySaveMutation.isPending}
                      >
                        {companySaveMutation.isPending && (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        )}
                        Speichern
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>

              <Card data-testid="card-auto-breaks">
                <CardHeader>
                  <CardTitle>Automatische Pausen</CardTitle>
                  <CardDescription>
                    Beim Monatsabschluss werden fehlende Pausen automatisch ergänzt,
                    basierend auf den gesetzlichen Vorgaben (§4 ArbZG).
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="flex flex-col gap-4">
                    <div className="flex items-center justify-between">
                      <Label htmlFor="auto-breaks-toggle" className="text-base font-medium">
                        Auto-Pausen beim Monatsabschluss
                      </Label>
                      <Switch
                        id="auto-breaks-toggle"
                        data-testid="switch-auto-breaks"
                        checked={settings?.autoBreaksEnabled ?? true}
                        disabled={toggleMutation.isPending}
                        onCheckedChange={(checked) => toggleMutation.mutate(checked)}
                      />
                    </div>
                    <div className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
                      <p className="font-medium mb-1">Gesetzliche Regelung (§4 ArbZG):</p>
                      <ul className="list-disc list-inside space-y-1">
                        <li>Unter 6 Stunden: Keine Pause erforderlich</li>
                        <li>6 bis 9 Stunden: Mindestens 30 Minuten Pause</li>
                        <li>Über 9 Stunden: Mindestens 45 Minuten Pause</li>
                      </ul>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
    </Layout>
  );
}
