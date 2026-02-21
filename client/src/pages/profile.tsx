import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { PageHeader, SectionCard } from "@/components/patterns";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { api, unwrapResult } from "@/lib/api/client";
import { useUpload } from "@/hooks/use-upload";
import { formatPhoneForDisplay, validateGermanPhone } from "@shared/utils/phone";
import {
  User as UserIcon,
  Phone,
  MapPin,
  Mail,
  Lock,
  Heart,
  AlertTriangle,
  FileText,
  Upload,
  Loader2,
  Save,
  PawPrint,
  GraduationCap,
  CheckCircle2,
  Clock,
  XCircle,
} from "lucide-react";
import { iconSize } from "@/design-system";
import type { DocumentType, EmployeeDocument } from "@shared/schema";

interface ProfileData {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  telefon: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  geburtsdatum: string | null;
  eintrittsdatum: string | null;
  haustierAkzeptiert: boolean;
  lbnr: string | null;
  notfallkontaktName: string | null;
  notfallkontaktTelefon: string | null;
  notfallkontaktBeziehung: string | null;
  roles: string[];
}

export default function ProfilePage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const { data: profile, isLoading } = useQuery<ProfileData>({
    queryKey: ["profile"],
    queryFn: async () => {
      const result = await api.get<ProfileData>("/profile");
      return unwrapResult(result);
    },
  });

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-8 w-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!profile) {
    return (
      <Layout>
        <PageHeader title="Mein Profil" backHref="/" />
        <p className="text-muted-foreground text-center py-8">Profil konnte nicht geladen werden.</p>
      </Layout>
    );
  }

  return (
    <Layout>
      <PageHeader title="Mein Profil" backHref="/" />
      <div className="space-y-4">
        <PersonalDataSection profile={profile} />
        <EmergencyContactSection profile={profile} />
        <PetAcceptanceSection profile={profile} />
        <PasswordSection />
        <ProofsSection />
        <DocumentsSection employeeId={profile.id} />
      </div>
    </Layout>
  );
}

function PersonalDataSection({ profile }: { profile: ProfileData }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({
    telefon: profile.telefon || "",
    email: profile.email || "",
    strasse: profile.strasse || "",
    hausnummer: profile.hausnummer || "",
    plz: profile.plz || "",
    stadt: profile.stadt || "",
  });

  const updateMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const updates: Record<string, string> = {};
      if (data.telefon !== (profile.telefon || "")) {
        if (data.telefon) {
          const phoneResult = validateGermanPhone(data.telefon);
          if (!phoneResult.valid) {
            throw new Error(!phoneResult.valid ? phoneResult.error : "Ungültige Telefonnummer");
          }
          updates.telefon = phoneResult.normalized;
        } else {
          updates.telefon = "";
        }
      }
      if (data.email !== profile.email) updates.email = data.email;
      if (data.strasse !== (profile.strasse || "")) updates.strasse = data.strasse;
      if (data.hausnummer !== (profile.hausnummer || "")) updates.hausnummer = data.hausnummer;
      if (data.plz !== (profile.plz || "")) updates.plz = data.plz;
      if (data.stadt !== (profile.stadt || "")) updates.stadt = data.stadt;

      if (Object.keys(updates).length === 0) return profile;
      const result = await api.patch("/profile", updates);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["user"] });
      setIsEditing(false);
      toast({ title: "Profil aktualisiert", description: "Ihre Daten wurden gespeichert." });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    setForm({
      telefon: profile.telefon || "",
      email: profile.email || "",
      strasse: profile.strasse || "",
      hausnummer: profile.hausnummer || "",
      plz: profile.plz || "",
      stadt: profile.stadt || "",
    });
    setIsEditing(false);
  };

  return (
    <SectionCard
      title="Kontaktdaten"
      icon={<UserIcon className={iconSize.sm} />}
      actions={
        !isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-contact">
            Bearbeiten
          </Button>
        ) : undefined
      }
    >
      {isEditing ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="profile-email">E-Mail</Label>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="profile-email"
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                className="pl-10 text-base"
                data-testid="input-profile-email"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="profile-telefon">Telefon</Label>
            <div className="relative">
              <Phone className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                id="profile-telefon"
                type="tel"
                value={form.telefon}
                onChange={(e) => setForm((f) => ({ ...f, telefon: e.target.value }))}
                placeholder="z.B. 0171 1234567"
                className="pl-10 text-base"
                data-testid="input-profile-telefon"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="profile-strasse">Straße</Label>
              <Input
                id="profile-strasse"
                value={form.strasse}
                onChange={(e) => setForm((f) => ({ ...f, strasse: e.target.value }))}
                className="text-base"
                data-testid="input-profile-strasse"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="profile-hausnummer">Nr.</Label>
              <Input
                id="profile-hausnummer"
                value={form.hausnummer}
                onChange={(e) => setForm((f) => ({ ...f, hausnummer: e.target.value }))}
                className="text-base"
                data-testid="input-profile-hausnummer"
              />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-2">
              <Label htmlFor="profile-plz">PLZ</Label>
              <Input
                id="profile-plz"
                value={form.plz}
                onChange={(e) => setForm((f) => ({ ...f, plz: e.target.value }))}
                className="text-base"
                data-testid="input-profile-plz"
              />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="profile-stadt">Stadt</Label>
              <Input
                id="profile-stadt"
                value={form.stadt}
                onChange={(e) => setForm((f) => ({ ...f, stadt: e.target.value }))}
                className="text-base"
                data-testid="input-profile-stadt"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => updateMutation.mutate(form)}
              disabled={updateMutation.isPending}
              className="flex-1"
              data-testid="button-save-contact"
            >
              {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Speichern
            </Button>
            <Button variant="outline" onClick={handleCancel} disabled={updateMutation.isPending} data-testid="button-cancel-contact">
              Abbrechen
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <InfoRow icon={<Mail className="h-4 w-4" />} label="E-Mail" value={profile.email} testId="text-profile-email" />
          <InfoRow
            icon={<Phone className="h-4 w-4" />}
            label="Telefon"
            value={profile.telefon ? formatPhoneForDisplay(profile.telefon) : "—"}
            testId="text-profile-telefon"
          />
          <InfoRow
            icon={<MapPin className="h-4 w-4" />}
            label="Adresse"
            value={
              profile.strasse
                ? `${profile.strasse} ${profile.hausnummer || ""}, ${profile.plz || ""} ${profile.stadt || ""}`.trim()
                : "—"
            }
            testId="text-profile-adresse"
          />
          {profile.lbnr && (
            <InfoRow
              icon={<FileText className="h-4 w-4" />}
              label="LBNR (Beschäftigtennummer)"
              value={profile.lbnr}
              testId="text-profile-lbnr"
            />
          )}
        </div>
      )}
    </SectionCard>
  );
}

function EmergencyContactSection({ profile }: { profile: ProfileData }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState({
    notfallkontaktName: profile.notfallkontaktName || "",
    notfallkontaktTelefon: profile.notfallkontaktTelefon || "",
    notfallkontaktBeziehung: profile.notfallkontaktBeziehung || "",
  });

  const updateMutation = useMutation({
    mutationFn: async (data: typeof form) => {
      const updates: Record<string, string> = {};
      if (data.notfallkontaktTelefon && data.notfallkontaktTelefon.trim()) {
        const phoneResult = validateGermanPhone(data.notfallkontaktTelefon);
        if (!phoneResult.valid) {
          throw new Error(!phoneResult.valid ? phoneResult.error : "Ungültige Telefonnummer für Notfallkontakt");
        }
        updates.notfallkontaktTelefon = phoneResult.normalized;
      } else {
        updates.notfallkontaktTelefon = "";
      }
      updates.notfallkontaktName = data.notfallkontaktName;
      updates.notfallkontaktBeziehung = data.notfallkontaktBeziehung;

      const result = await api.patch("/profile", updates);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      setIsEditing(false);
      toast({ title: "Notfallkontakt aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    setForm({
      notfallkontaktName: profile.notfallkontaktName || "",
      notfallkontaktTelefon: profile.notfallkontaktTelefon || "",
      notfallkontaktBeziehung: profile.notfallkontaktBeziehung || "",
    });
    setIsEditing(false);
  };

  const hasContact = profile.notfallkontaktName || profile.notfallkontaktTelefon;

  return (
    <SectionCard
      title="Notfallkontakt"
      icon={<AlertTriangle className={iconSize.sm} />}
      actions={
        !isEditing ? (
          <Button variant="outline" size="sm" onClick={() => setIsEditing(true)} data-testid="button-edit-emergency">
            {hasContact ? "Bearbeiten" : "Hinzufügen"}
          </Button>
        ) : undefined
      }
    >
      {isEditing ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="emergency-name">Name</Label>
            <Input
              id="emergency-name"
              value={form.notfallkontaktName}
              onChange={(e) => setForm((f) => ({ ...f, notfallkontaktName: e.target.value }))}
              placeholder="Name des Notfallkontakts"
              className="text-base"
              data-testid="input-emergency-name"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="emergency-phone">Telefon</Label>
            <Input
              id="emergency-phone"
              type="tel"
              value={form.notfallkontaktTelefon}
              onChange={(e) => setForm((f) => ({ ...f, notfallkontaktTelefon: e.target.value }))}
              placeholder="z.B. 0171 1234567"
              className="text-base"
              data-testid="input-emergency-phone"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="emergency-relation">Beziehung</Label>
            <Input
              id="emergency-relation"
              value={form.notfallkontaktBeziehung}
              onChange={(e) => setForm((f) => ({ ...f, notfallkontaktBeziehung: e.target.value }))}
              placeholder="z.B. Ehepartner, Eltern, Geschwister"
              className="text-base"
              data-testid="input-emergency-relation"
            />
          </div>
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => updateMutation.mutate(form)}
              disabled={updateMutation.isPending}
              className="flex-1"
              data-testid="button-save-emergency"
            >
              {updateMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Save className="h-4 w-4 mr-2" />}
              Speichern
            </Button>
            <Button variant="outline" onClick={handleCancel} disabled={updateMutation.isPending} data-testid="button-cancel-emergency">
              Abbrechen
            </Button>
          </div>
        </div>
      ) : hasContact ? (
        <div className="space-y-3">
          <InfoRow icon={<UserIcon className="h-4 w-4" />} label="Name" value={profile.notfallkontaktName || "—"} testId="text-emergency-name" />
          <InfoRow
            icon={<Phone className="h-4 w-4" />}
            label="Telefon"
            value={profile.notfallkontaktTelefon ? formatPhoneForDisplay(profile.notfallkontaktTelefon) : "—"}
            testId="text-emergency-phone"
          />
          <InfoRow icon={<Heart className="h-4 w-4" />} label="Beziehung" value={profile.notfallkontaktBeziehung || "—"} testId="text-emergency-relation" />
        </div>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="text-no-emergency">
          Kein Notfallkontakt hinterlegt. Bitte fügen Sie einen Notfallkontakt hinzu.
        </p>
      )}
    </SectionCard>
  );
}

function PetAcceptanceSection({ profile }: { profile: ProfileData }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateMutation = useMutation({
    mutationFn: async (value: boolean) => {
      const result = await api.patch("/profile", { haustierAkzeptiert: value });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile"] });
      queryClient.invalidateQueries({ queryKey: ["user"] });
      toast({ title: "Einstellung gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  return (
    <SectionCard title="Haustiere" icon={<PawPrint className={iconSize.sm} />}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Haustiere akzeptiert</p>
          <p className="text-xs text-muted-foreground">Ich bin bereit, bei Kunden mit Haustieren zu arbeiten</p>
        </div>
        <Switch
          checked={profile.haustierAkzeptiert}
          onCheckedChange={(checked) => updateMutation.mutate(checked)}
          disabled={updateMutation.isPending}
          data-testid="switch-pet-acceptance"
        />
      </div>
    </SectionCard>
  );
}

function PasswordSection() {
  const { toast } = useToast();
  const [isChanging, setIsChanging] = useState(false);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");

  const changeMutation = useMutation({
    mutationFn: async () => {
      if (newPassword.length < 8) throw new Error("Passwort muss mindestens 8 Zeichen haben");
      if (newPassword !== confirmPassword) throw new Error("Passwörter stimmen nicht überein");
      const result = await api.post("/auth/change-password", { newPassword });
      return unwrapResult(result);
    },
    onSuccess: () => {
      toast({ title: "Passwort geändert", description: "Sie werden abgemeldet und müssen sich neu anmelden." });
      setTimeout(() => {
        window.location.href = "/login";
      }, 1500);
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleCancel = () => {
    setNewPassword("");
    setConfirmPassword("");
    setIsChanging(false);
  };

  return (
    <SectionCard title="Passwort" icon={<Lock className={iconSize.sm} />}>
      {isChanging ? (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="new-password">Neues Passwort</Label>
            <Input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Mindestens 8 Zeichen"
              className="text-base"
              data-testid="input-new-password"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="confirm-password">Passwort bestätigen</Label>
            <Input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Passwort wiederholen"
              className="text-base"
              data-testid="input-confirm-password"
            />
          </div>
          {newPassword && confirmPassword && newPassword !== confirmPassword && (
            <p className="text-sm text-destructive">Passwörter stimmen nicht überein</p>
          )}
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => changeMutation.mutate()}
              disabled={changeMutation.isPending || !newPassword || !confirmPassword || newPassword !== confirmPassword}
              className="flex-1"
              data-testid="button-save-password"
            >
              {changeMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Lock className="h-4 w-4 mr-2" />}
              Passwort ändern
            </Button>
            <Button variant="outline" onClick={handleCancel} disabled={changeMutation.isPending} data-testid="button-cancel-password">
              Abbrechen
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setIsChanging(true)} className="w-full" data-testid="button-change-password">
          <Lock className="h-4 w-4 mr-2" />
          Passwort ändern
        </Button>
      )}
    </SectionCard>
  );
}

interface ProofItem {
  id: number;
  qualificationId: number;
  documentTypeId: number;
  status: string;
  fileName: string | null;
  objectPath: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  documentType: { id: number; name: string };
  qualification: { id: number; name: string };
}

function ProofsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile, isUploading } = useUpload();

  const { data: proofs = [], isLoading } = useQuery<ProofItem[]>({
    queryKey: ["profile-proofs"],
    queryFn: async () => unwrapResult(await api.get<ProofItem[]>("/profile/proofs")),
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, proofId }: { file: File; proofId: number }) => {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) throw new Error("Upload fehlgeschlagen");
      const result = await api.patch<ProofItem>(`/profile/proofs/${proofId}/upload`, {
        fileName: file.name,
        objectPath: uploadResult.objectPath,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile-proofs"] });
      toast({ title: "Nachweis hochgeladen" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <SectionCard title="Qualifikations-Nachweise" icon={<GraduationCap className={iconSize.sm} />}>
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      </SectionCard>
    );
  }

  if (proofs.length === 0) return null;

  const grouped = proofs.reduce<Record<string, ProofItem[]>>((acc, proof) => {
    const key = proof.qualification.name;
    if (!acc[key]) acc[key] = [];
    acc[key].push(proof);
    return acc;
  }, {});

  return (
    <SectionCard title="Qualifikations-Nachweise" icon={<GraduationCap className={iconSize.sm} />}>
      <div className="space-y-4">
        {Object.entries(grouped).map(([qualName, qualProofs]) => (
          <div key={qualName}>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <GraduationCap className="h-3.5 w-3.5 text-primary" />
              {qualName}
            </h4>
            <div className="space-y-2 ml-5">
              {qualProofs.map((proof) => (
                <div key={proof.id} className="flex items-center justify-between p-3 rounded-lg border" data-testid={`proof-${proof.id}`}>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{proof.documentType.name}</p>
                    <div className="flex items-center gap-1 mt-0.5">
                      {proof.status === "approved" && <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />}
                      {proof.status === "pending" && <Clock className="h-3.5 w-3.5 text-amber-500" />}
                      {proof.status === "uploaded" && <Upload className="h-3.5 w-3.5 text-blue-500" />}
                      {proof.status === "rejected" && <XCircle className="h-3.5 w-3.5 text-red-500" />}
                      <span className="text-xs text-muted-foreground">
                        {proof.status === "approved" && "Freigegeben"}
                        {proof.status === "pending" && "Bitte hochladen"}
                        {proof.status === "uploaded" && "Wird geprüft"}
                        {proof.status === "rejected" && `Abgelehnt${proof.rejectionReason ? `: ${proof.rejectionReason}` : ""}`}
                      </span>
                    </div>
                    {proof.fileName && proof.status !== "rejected" && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{proof.fileName}</p>
                    )}
                  </div>
                  {(proof.status === "pending" || proof.status === "rejected") && (
                    <div className="ml-2 shrink-0">
                      <label className="cursor-pointer">
                        <input
                          type="file"
                          className="hidden"
                          accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) {
                              uploadMutation.mutate({ file, proofId: proof.id });
                              e.target.value = "";
                            }
                          }}
                          disabled={isUploading || uploadMutation.isPending}
                          data-testid={`input-upload-proof-${proof.id}`}
                        />
                        <div className="inline-flex items-center justify-center h-9 px-3 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors">
                          {uploadMutation.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <>
                              <Upload className="h-4 w-4 mr-1" />
                              {proof.status === "rejected" ? "Erneut hochladen" : "Hochladen"}
                            </>
                          )}
                        </div>
                      </label>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

interface DocumentWithType extends EmployeeDocument {
  documentType?: DocumentType;
}

function DocumentsSection({ employeeId }: { employeeId: number }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { uploadFile, isUploading } = useUpload();

  const { data: documents = [], isLoading: docsLoading } = useQuery<DocumentWithType[]>({
    queryKey: ["profile-documents"],
    queryFn: async () => {
      const result = await api.get<DocumentWithType[]>("/profile/documents");
      return unwrapResult(result);
    },
  });

  const { data: documentTypes = [] } = useQuery<DocumentType[]>({
    queryKey: ["profile-document-types"],
    queryFn: async () => {
      const result = await api.get<DocumentType[]>("/profile/document-types");
      return unwrapResult(result);
    },
  });

  const uploadMutation = useMutation({
    mutationFn: async ({ file, documentTypeId }: { file: File; documentTypeId: number }) => {
      const uploadResult = await uploadFile(file);
      if (!uploadResult) throw new Error("Upload fehlgeschlagen");

      const result = await api.post("/profile/documents", {
        documentTypeId,
        fileName: file.name,
        objectPath: uploadResult.objectPath,
      });
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["profile-documents"] });
      toast({ title: "Dokument hochgeladen" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const uploadedTypeIds = new Set(documents.filter(d => d.isCurrent).map((d) => d.documentTypeId));

  return (
    <SectionCard title="Meine Dokumente" icon={<FileText className={iconSize.sm} />}>
      {docsLoading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="space-y-3">
          {documentTypes.map((docType) => {
            const currentDoc = documents.find((d) => d.documentTypeId === docType.id && d.isCurrent);
            return (
              <div key={docType.id} className="flex items-center justify-between p-3 rounded-lg border" data-testid={`doc-type-${docType.id}`}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{docType.name}</p>
                  {currentDoc ? (
                    <p className="text-xs text-muted-foreground truncate">
                      {currentDoc.fileName} — hochgeladen am {new Date(currentDoc.uploadedAt).toLocaleString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" })}
                    </p>
                  ) : (
                    <p className="text-xs text-amber-600">Noch nicht hochgeladen</p>
                  )}
                </div>
                <div className="ml-2 shrink-0">
                  <label className="cursor-pointer">
                    <input
                      type="file"
                      className="hidden"
                      accept=".pdf,.jpg,.jpeg,.png,.doc,.docx"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          uploadMutation.mutate({ file, documentTypeId: docType.id });
                          e.target.value = "";
                        }
                      }}
                      disabled={isUploading || uploadMutation.isPending}
                      data-testid={`input-upload-doc-${docType.id}`}
                    />
                    <div className="inline-flex items-center justify-center h-9 px-3 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors">
                      {uploadMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : currentDoc ? (
                        <>
                          <Upload className="h-4 w-4 mr-1" />
                          Aktualisieren
                        </>
                      ) : (
                        <>
                          <Upload className="h-4 w-4 mr-1" />
                          Hochladen
                        </>
                      )}
                    </div>
                  </label>
                </div>
              </div>
            );
          })}
          {documentTypes.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4" data-testid="text-no-doc-types">
              Keine Dokumententypen konfiguriert.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  );
}

function InfoRow({
  icon,
  label,
  value,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  testId: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 text-muted-foreground shrink-0">{icon}</div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium" data-testid={testId}>
          {value}
        </p>
      </div>
    </div>
  );
}
