import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  ArrowLeft,
  Plus,
  Search,
  Phone,
  Mail,
  MapPin,
  UserPlus,
  Clock,
  MessageSquare,
  PhoneCall,
  Trash2,
  CalendarClock,
  CalendarCheck,
  XCircle,
  ArrowRightCircle,
  Loader2,
  RefreshCw,
  CheckCircle2,
  ShieldCheck,
  FileText,
  Ban,
  Pencil,
  Check,
  X,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useProspects, useProspectStats, useProspect, useCreateProspect, useUpdateProspect, useAddProspectNote, useReparseProspect, useDeleteProspect, useQualifyProspect, useProspectOffer, useDeclineProspectOffer } from "@/features/prospects";
import { AddressFields } from "@/pages/admin/components/address-fields";
import { isDachPhone } from "@shared/schema/common";
import { PROSPECT_STATUS_LABELS, PROSPECT_STATUSES, PROSPECT_NOTE_TYPE_LABELS, DISQUALIFICATION_REASON_LABELS, DISQUALIFICATION_REASONS, type ProspectStatus, type ProspectNoteType, type DisqualificationReason } from "@shared/schema";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { formatAddress } from "@shared/utils/format";

const STATUS_COLORS: Record<ProspectStatus, string> = {
  neu: "bg-blue-100 text-blue-800",
  kontaktiert: "bg-amber-100 text-amber-800",
  wiedervorlage: "bg-purple-100 text-purple-800",
  qualifiziert: "bg-teal-100 text-teal-800",
  disqualifiziert: "bg-red-100 text-red-800",
  erstberatung_vereinbart: "bg-cyan-100 text-cyan-800",
  erstberatung_durchgeführt: "bg-emerald-100 text-emerald-800",
  angebot_gemacht: "bg-amber-100 text-amber-800",
  gewonnen: "bg-green-100 text-green-800",
  nicht_interessiert: "bg-gray-100 text-gray-800",
  absage: "bg-red-100 text-red-800",
};

const NOTE_TYPE_ICONS: Record<ProspectNoteType, typeof Phone> = {
  anruf: PhoneCall,
  email: Mail,
  notiz: MessageSquare,
  statuswechsel: ArrowRightCircle,
};

function StatusBadge({ status }: { status: string }) {
  const label = PROSPECT_STATUS_LABELS[status as ProspectStatus] || status;
  const colorClass = STATUS_COLORS[status as ProspectStatus] || "bg-gray-100 text-gray-800";
  return <Badge className={`${colorClass} font-medium`} data-testid={`badge-status-${status}`}>{label}</Badge>;
}

function PipelineStats({ stats }: { stats: Record<string, number> }) {
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  return (
    <div className="grid grid-cols-4 md:grid-cols-8 gap-2 mb-4" data-testid="pipeline-stats">
      {PROSPECT_STATUSES.map((status) => (
        <div
          key={status}
          className="flex flex-col items-center justify-start text-center px-1.5 py-2 rounded-lg bg-white/60 border min-h-[72px] md:min-h-[76px]"
        >
          <div className="text-lg font-bold leading-none mb-1" data-testid={`stat-count-${status}`}>
            {stats[status] || 0}
          </div>
          <div className="text-[10px] md:text-xs leading-tight text-muted-foreground break-words hyphens-auto w-full">
            {PROSPECT_STATUS_LABELS[status]}
          </div>
        </div>
      ))}
    </div>
  );
}

function CreateProspectSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [vorname, setVorname] = useState("");
  const [nachname, setNachname] = useState("");
  const [telefon, setTelefon] = useState("");
  const [email, setEmail] = useState("");
  const [strasse, setStrasse] = useState("");
  const [nr, setNr] = useState("");
  const [plz, setPlz] = useState("");
  const [stadt, setStadt] = useState("");
  const [quelle, setQuelle] = useState("");
  const [notiz, setNotiz] = useState("");
  const [wiedervorlageDate, setWiedervorlageDate] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const createMutation = useCreateProspect();

  const handleAddressChange = useCallback((field: string, value: string) => {
    if (field === "strasse") setStrasse(value);
    else if (field === "nr") setNr(value);
    else if (field === "plz") setPlz(value);
    else if (field === "stadt") setStadt(value);
  }, []);

  const handleSubmit = () => {
    const errs: Record<string, string> = {};
    if (!vorname.trim()) errs.vorname = "Vorname ist erforderlich";
    if (!nachname.trim()) errs.nachname = "Nachname ist erforderlich";
    if (telefon.trim() && !isDachPhone(telefon.trim())) {
      errs.telefon = "Ungültige Telefonnummer (DE/AT/CH)";
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      errs.email = "Ungültige E-Mail-Adresse";
    }
    if (plz.trim() && !/^\d{5}$/.test(plz.trim())) {
      errs.plz = "PLZ muss 5 Ziffern haben";
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;

    createMutation.mutate({
      vorname,
      nachname,
      telefon: telefon || null,
      email: email || null,
      strasse: strasse || null,
      nr: nr || null,
      plz: plz || null,
      stadt: stadt || null,
      quelle: quelle || null,
      status: wiedervorlageDate ? "wiedervorlage" : "neu",
      wiedervorlageDate: wiedervorlageDate || null,
      _initialNote: notiz || undefined,
    }, {
      onSuccess: () => {
        setVorname(""); setNachname(""); setTelefon(""); setEmail("");
        setStrasse(""); setNr(""); setPlz(""); setStadt("");
        setQuelle(""); setNotiz(""); setWiedervorlageDate("");
        setErrors({});
        onClose();
      },
    });
  };

  return (
    <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Neuer Interessent</SheetTitle>
        </SheetHeader>
        <div className="space-y-4 mt-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Vorname *</Label>
              <Input value={vorname} onChange={(e) => setVorname(e.target.value)} className={errors.vorname ? "border-destructive" : ""} data-testid="input-prospect-vorname" />
              {errors.vorname && <p className="text-destructive text-xs mt-1">{errors.vorname}</p>}
            </div>
            <div>
              <Label>Nachname *</Label>
              <Input value={nachname} onChange={(e) => setNachname(e.target.value)} className={errors.nachname ? "border-destructive" : ""} data-testid="input-prospect-nachname" />
              {errors.nachname && <p className="text-destructive text-xs mt-1">{errors.nachname}</p>}
            </div>
          </div>
          <div>
            <Label>Telefon</Label>
            <Input value={telefon} onChange={(e) => setTelefon(e.target.value)} type="tel" className={errors.telefon ? "border-destructive" : ""} data-testid="input-prospect-telefon" />
            {errors.telefon && <p className="text-destructive text-xs mt-1">{errors.telefon}</p>}
          </div>
          <div>
            <Label>E-Mail</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" className={errors.email ? "border-destructive" : ""} data-testid="input-prospect-email" />
            {errors.email && <p className="text-destructive text-xs mt-1">{errors.email}</p>}
          </div>
          <AddressFields
            strasse={strasse}
            nr={nr}
            plz={plz}
            stadt={stadt}
            onChange={handleAddressChange}
            testIdPrefix="prospect"
          />
          {errors.plz && <p className="text-destructive text-xs">{errors.plz}</p>}
          <div>
            <Label>Quelle</Label>
            <Input value={quelle} onChange={(e) => setQuelle(e.target.value)} placeholder="z.B. pflege24.de" data-testid="input-prospect-quelle" />
          </div>
          <div>
            <Label>Wiedervorlage am</Label>
            <Input type="date" value={wiedervorlageDate} onChange={(e) => setWiedervorlageDate(e.target.value)} data-testid="input-prospect-wiedervorlage" />
            <p className="text-[11px] text-gray-500 mt-1">Wenn gesetzt, wird der Status automatisch auf „Wiedervorlage" gesetzt</p>
          </div>
          <div>
            <Label>Notiz</Label>
            <Textarea value={notiz} onChange={(e) => setNotiz(e.target.value)} placeholder="z.B. Wünscht Hauswirtschaft 2x wöchentlich, Rückruf vereinbart" rows={3} data-testid="input-prospect-notiz" />
          </div>
          <Button onClick={handleSubmit} disabled={!vorname || !nachname || createMutation.isPending} className="w-full" data-testid="button-create-prospect">
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Plus className="h-4 w-4 mr-2" />}
            Interessent anlegen
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ProspectDetailSheet({ prospectId, open, onClose }: { prospectId: number | null; open: boolean; onClose: () => void }) {
  const { data: prospect, isLoading } = useProspect(prospectId);
  const updateMutation = useUpdateProspect({ adminEndpoint: true });
  const qualifyMutation = useQualifyProspect();
  const addNoteMutation = useAddProspectNote();
  const deleteMutation = useDeleteProspect();
  const reparseMutation = useReparseProspect();
  const declineOfferMutation = useDeclineProspectOffer();
  const { data: openOffer } = useProspectOffer(prospect?.status === "angebot_gemacht" ? prospectId : null);
  const [, navigate] = useLocation();
  const [noteText, setNoteText] = useState("");
  const [noteType, setNoteType] = useState<ProspectNoteType>("notiz");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showWiedervorlageDialog, setShowWiedervorlageDialog] = useState(false);
  const [showNichtInteressiertDialog, setShowNichtInteressiertDialog] = useState(false);
  const [showDisqualifyDialog, setShowDisqualifyDialog] = useState(false);
  const [dialogWiedervorlageDate, setDialogWiedervorlageDate] = useState("");
  const [dialogKommentar, setDialogKommentar] = useState("");
  const [disqualifyReason, setDisqualifyReason] = useState<string>("");

  const [editingContact, setEditingContact] = useState(false);
  const [editVorname, setEditVorname] = useState("");
  const [editNachname, setEditNachname] = useState("");
  const [editTelefon, setEditTelefon] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editStrasse, setEditStrasse] = useState("");
  const [editNr, setEditNr] = useState("");
  const [editPlz, setEditPlz] = useState("");
  const [editStadt, setEditStadt] = useState("");
  const [editPflegegrad, setEditPflegegrad] = useState("");

  const prevProspectId = useRef(prospectId);
  useEffect(() => {
    if (prospectId !== prevProspectId.current || !open) {
      setEditingContact(false);
      prevProspectId.current = prospectId;
    }
  }, [prospectId, open]);

  const startEditingContact = () => {
    if (!prospect) return;
    setEditVorname(prospect.vorname || "");
    setEditNachname(prospect.nachname || "");
    setEditTelefon(prospect.telefon || "");
    setEditEmail(prospect.email || "");
    setEditStrasse(prospect.strasse || "");
    setEditNr(prospect.nr || "");
    setEditPlz(prospect.plz || "");
    setEditStadt(prospect.stadt || "");
    setEditPflegegrad(prospect.pflegegrad?.toString() || "");
    setEditingContact(true);
  };

  const [editErrors, setEditErrors] = useState<Record<string, string>>({});

  const handleSaveContact = () => {
    if (!prospectId || !editVorname.trim() || !editNachname.trim()) return;
    const errs: Record<string, string> = {};
    if (editTelefon.trim() && !isDachPhone(editTelefon.trim())) {
      errs.telefon = "Ungültige Telefonnummer (DE/AT/CH)";
    }
    if (editEmail.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(editEmail.trim())) {
      errs.email = "Ungültige E-Mail-Adresse";
    }
    if (editPlz.trim() && !/^\d{5}$/.test(editPlz.trim())) {
      errs.plz = "PLZ muss 5 Ziffern haben";
    }
    setEditErrors(errs);
    if (Object.keys(errs).length > 0) return;

    updateMutation.mutate({
      id: prospectId,
      data: {
        vorname: editVorname.trim(),
        nachname: editNachname.trim(),
        telefon: editTelefon.trim() || null,
        email: editEmail.trim() || null,
        strasse: editStrasse.trim() || null,
        nr: editNr.trim() || null,
        plz: editPlz.trim() || null,
        stadt: editStadt.trim() || null,
        pflegegrad: editPflegegrad && editPflegegrad !== "none" ? parseInt(editPflegegrad) : null,
      },
    }, {
      onSuccess: () => {
        setEditingContact(false);
        setEditErrors({});
      },
    });
  };

  const handleKontaktiert = () => {
    if (!prospectId) return;
    updateMutation.mutate({ id: prospectId, data: { status: "kontaktiert" } });
  };

  const handleWiedervorlageConfirm = () => {
    if (!prospectId || !dialogWiedervorlageDate) return;
    const data: Record<string, unknown> = {
      status: "wiedervorlage",
      wiedervorlageDate: dialogWiedervorlageDate,
    };
    if (dialogKommentar.trim()) {
      data.statusNotiz = dialogKommentar.trim();
    }
    updateMutation.mutate({ id: prospectId, data }, {
      onSuccess: () => {
        setShowWiedervorlageDialog(false);
        setDialogWiedervorlageDate("");
        setDialogKommentar("");
      },
    });
  };

  const handleNichtInteressiertConfirm = () => {
    if (!prospectId) return;
    const data: Record<string, unknown> = { status: "nicht_interessiert" };
    if (dialogKommentar.trim()) {
      data.statusNotiz = dialogKommentar.trim();
    }
    updateMutation.mutate({ id: prospectId, data }, {
      onSuccess: () => {
        setShowNichtInteressiertDialog(false);
        setDialogKommentar("");
      },
    });
  };

  const handleAddNote = () => {
    if (!prospectId || !noteText.trim()) return;
    addNoteMutation.mutate({
      prospectId,
      data: { noteText, noteType },
    }, {
      onSuccess: () => {
        setNoteText("");
        setNoteType("notiz");
      },
    });
  };

  const handleDelete = () => {
    if (!prospectId) return;
    deleteMutation.mutate(prospectId, {
      onSuccess: () => {
        onClose();
        setShowDeleteDialog(false);
      },
    });
  };

  const handleConvertToErstberatung = () => {
    if (!prospect) return;
    navigate(`/new-appointment?type=erstberatung&prospectId=${prospect.id}`);
  };

  const handleQualifizieren = () => {
    if (!prospectId) return;
    qualifyMutation.mutate({ id: prospectId, action: "qualify" });
  };

  const handleDisqualifizierenConfirm = () => {
    if (!prospectId || !disqualifyReason) return;
    qualifyMutation.mutate({ id: prospectId, action: "disqualify", disqualificationReason: disqualifyReason }, {
      onSuccess: () => {
        setShowDisqualifyDialog(false);
        setDisqualifyReason("");
      },
    });
  };

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          {isLoading || !prospect ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  {prospect.vorname} {prospect.nachname}
                  <StatusBadge status={prospect.status} />
                </SheetTitle>
              </SheetHeader>

              <div className="space-y-6 mt-4">
                <Card>
                  <CardHeader className="pb-2">
                    <div className="flex items-center justify-between">
                      <CardTitle className="text-sm">Kontaktdaten</CardTitle>
                      <div className="flex gap-1">
                        {prospect.rawEmailContent && !editingContact && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs gap-1"
                            onClick={() => prospectId && reparseMutation.mutate(prospectId)}
                            disabled={reparseMutation.isPending}
                            data-testid="button-reparse-prospect"
                          >
                            <RefreshCw className={`h-3 w-3 ${reparseMutation.isPending ? "animate-spin" : ""}`} />
                            Neu parsen
                          </Button>
                        )}
                        {!editingContact && (
                          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={startEditingContact} data-testid="button-edit-contact">
                            <Pencil className="h-3 w-3" /> Bearbeiten
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {editingContact ? (
                      <div className="space-y-3">
                        <div className="grid grid-cols-2 gap-2">
                          <div className="space-y-1">
                            <Label className="text-xs">Vorname *</Label>
                            <Input value={editVorname} onChange={(e) => setEditVorname(e.target.value)} placeholder="Vorname" data-testid="input-edit-vorname" />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Nachname *</Label>
                            <Input value={editNachname} onChange={(e) => setEditNachname(e.target.value)} placeholder="Nachname" data-testid="input-edit-nachname" />
                          </div>
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">Telefon</Label>
                          <Input value={editTelefon} onChange={(e) => setEditTelefon(e.target.value)} placeholder="z.B. 0151 12345678" className={editErrors.telefon ? "border-destructive" : ""} data-testid="input-edit-telefon" />
                          {editErrors.telefon && <p className="text-destructive text-xs">{editErrors.telefon}</p>}
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">E-Mail</Label>
                          <Input value={editEmail} onChange={(e) => setEditEmail(e.target.value)} placeholder="E-Mail-Adresse" type="email" className={editErrors.email ? "border-destructive" : ""} data-testid="input-edit-email" />
                          {editErrors.email && <p className="text-destructive text-xs">{editErrors.email}</p>}
                        </div>
                        <AddressFields
                          strasse={editStrasse}
                          nr={editNr}
                          plz={editPlz}
                          stadt={editStadt}
                          onChange={(field, value) => {
                            if (field === "strasse") setEditStrasse(value);
                            else if (field === "nr") setEditNr(value);
                            else if (field === "plz") setEditPlz(value);
                            else if (field === "stadt") setEditStadt(value);
                          }}
                          testIdPrefix="edit"
                        />
                        {editErrors.plz && <p className="text-destructive text-xs">{editErrors.plz}</p>}
                        <div className="space-y-1">
                          <Label className="text-xs">Pflegegrad</Label>
                          <Select value={editPflegegrad} onValueChange={setEditPflegegrad}>
                            <SelectTrigger data-testid="select-edit-pflegegrad">
                              <SelectValue placeholder="Nicht bekannt" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">Nicht bekannt</SelectItem>
                              {[1, 2, 3, 4, 5].map(g => (
                                <SelectItem key={g} value={g.toString()}>Pflegegrad {g}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="flex gap-2 pt-1">
                          <Button size="sm" className="flex-1" onClick={handleSaveContact} disabled={updateMutation.isPending || !editVorname.trim() || !editNachname.trim()} data-testid="button-save-contact">
                            {updateMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                            Speichern
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => setEditingContact(false)} data-testid="button-cancel-edit-contact">
                            <X className="h-3.5 w-3.5 mr-1" /> Abbrechen
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        {prospect.telefon && (
                          <a href={`tel:${prospect.telefon}`} className="flex items-center gap-2 text-primary" data-testid="link-prospect-phone">
                            <Phone className="h-3.5 w-3.5" /> {formatPhoneForDisplay(prospect.telefon)}
                          </a>
                        )}
                        {prospect.email && (
                          <a href={`mailto:${prospect.email}`} className="flex items-center gap-2 text-primary" data-testid="link-prospect-email">
                            <Mail className="h-3.5 w-3.5" /> {prospect.email}
                          </a>
                        )}
                        {(prospect.strasse || prospect.stadt) && (
                          <a
                            href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(prospect))}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center gap-2 text-primary hover:underline"
                            data-testid="link-prospect-address"
                          >
                            <MapPin className="h-3.5 w-3.5" />
                            {formatAddress(prospect)}
                          </a>
                        )}
                        {prospect.pflegegrad && (
                          <Badge variant="outline" className="mt-1">Pflegegrad {prospect.pflegegrad}</Badge>
                        )}
                        {!prospect.telefon && !prospect.email && !prospect.strasse && !prospect.stadt && (
                          <p className="text-muted-foreground italic">Keine Kontaktdaten hinterlegt — <button className="text-primary underline" onClick={startEditingContact}>jetzt ergänzen</button></p>
                        )}
                        {prospect.quelle && (
                          <div className="text-xs text-muted-foreground">Quelle: {prospect.quelle}</div>
                        )}
                        <div className="text-xs text-muted-foreground">
                          Erstellt: {formatDateForDisplay(String(prospect.createdAt).substring(0, 10))}
                        </div>
                        {prospect.wiedervorlageDate && (
                          (() => {
                            const dateStr = String(prospect.wiedervorlageDate).substring(0, 10);
                            const today = todayISO();
                            const isOverdue = dateStr < today;
                            return (
                              <div className={`flex items-center gap-1.5 mt-2 text-sm font-medium ${isOverdue ? "text-red-600" : "text-purple-700"}`} data-testid="text-wiedervorlage-date">
                                <CalendarClock className="h-3.5 w-3.5" />
                                Wiedervorlage am {formatDateForDisplay(dateStr)}
                                {isOverdue && <Badge variant="outline" className="text-red-600 border-red-300 text-xs ml-1">Überfällig</Badge>}
                              </div>
                            );
                          })()
                        )}
                      </>
                    )}
                  </CardContent>
                </Card>

                {prospect.status === "kontaktiert" && (
                  <Card data-testid="panel-qualification">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <ShieldCheck className="h-4 w-4" /> Qualifizierung
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="space-y-2 text-sm">
                        <div className="flex items-center gap-2">
                          {prospect.geoQualified === true ? (
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          ) : prospect.geoQualified === false ? (
                            <XCircle className="h-4 w-4 text-red-500" />
                          ) : (
                            <Clock className="h-4 w-4 text-gray-500" />
                          )}
                          <span>Geo-Check {prospect.geoQualified === true ? "bestanden" : prospect.geoQualified === false ? "nicht bestanden" : "ausstehend"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          {prospect.pflegegrad ? (
                            <CheckCircle2 className="h-4 w-4 text-green-600" />
                          ) : (
                            <Clock className="h-4 w-4 text-gray-500" />
                          )}
                          <span>Pflegegrad {prospect.pflegegrad ? `${prospect.pflegegrad} bestätigt` : "nicht bestätigt"}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="h-4 w-4 text-green-600" />
                          <span>Kapazität verfügbar</span>
                        </div>
                      </div>
                      <div className="flex gap-2 pt-1">
                        <Button size="sm" className="flex-1" onClick={handleQualifizieren} disabled={qualifyMutation.isPending} data-testid="button-qualify">
                          <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Qualifizieren
                        </Button>
                        <Button size="sm" variant="outline" className="flex-1 text-red-600" onClick={() => setShowDisqualifyDialog(true)} data-testid="button-disqualify">
                          <Ban className="h-3.5 w-3.5 mr-1" /> Disqualifizieren
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {prospect.status === "angebot_gemacht" && (
                  <Card data-testid="panel-offer">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm flex items-center gap-2">
                        <FileText className="h-4 w-4" /> Offenes Angebot
                      </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800" data-testid="banner-angebot">
                        <p className="font-medium">Angebot wurde erstellt</p>
                        {openOffer && (
                          <p className="text-xs mt-1">Erstellt am {formatDateForDisplay(String(openOffer.createdAt).substring(0, 10))}</p>
                        )}
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" variant="outline" className="flex-1 text-red-600" onClick={() => prospectId && declineOfferMutation.mutate({ prospectId })} disabled={declineOfferMutation.isPending} data-testid="button-decline-offer">
                          <XCircle className="h-3.5 w-3.5 mr-1" /> Ablehnen
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {prospect.status !== "gewonnen" && prospect.status !== "absage" && prospect.status !== "nicht_interessiert" && prospect.status !== "disqualifiziert" && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Aktionen</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {prospect.status === "neu" && (
                          <Button size="sm" variant="outline" onClick={handleKontaktiert} disabled={updateMutation.isPending} data-testid="button-status-kontaktiert">
                            <PhoneCall className="h-3.5 w-3.5 mr-1" /> Kontaktiert
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => setShowWiedervorlageDialog(true)} data-testid="button-status-wiedervorlage">
                          <CalendarClock className="h-3.5 w-3.5 mr-1" /> Wiedervorlage
                        </Button>
                        {prospect.status !== "erstberatung_vereinbart" && prospect.status !== "kontaktiert" && !["qualifiziert", "erstberatung_durchgeführt", "angebot_gemacht"].includes(prospect.status) && (
                          <Button size="sm" variant="outline" className="text-teal-600" onClick={handleQualifizieren} disabled={qualifyMutation.isPending} data-testid="button-status-qualifiziert">
                            <UserPlus className="h-3.5 w-3.5 mr-1" /> Qualifizieren
                          </Button>
                        )}
                        <Button size="sm" variant="outline" className="text-red-600" onClick={() => setShowNichtInteressiertDialog(true)} data-testid="button-status-nicht-interessiert">
                          <XCircle className="h-3.5 w-3.5 mr-1" /> Nicht interessiert
                        </Button>
                      </div>

                      {(prospect.status === "qualifiziert" || prospect.status === "erstberatung_vereinbart") && (
                        <Button
                          className="w-full"
                          onClick={handleConvertToErstberatung}
                          data-testid="button-convert-erstberatung"
                        >
                          <ArrowRightCircle className="h-4 w-4 mr-2" />
                          {prospect.status === "erstberatung_vereinbart" ? "Erstberatung neu planen" : "Erstberatung planen"}
                        </Button>
                      )}

                    </CardContent>
                  </Card>
                )}

                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm">Notiz hinzufügen</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex gap-2">
                      <Select value={noteType} onValueChange={(v) => setNoteType(v as ProspectNoteType)}>
                        <SelectTrigger className="w-[130px]" data-testid="select-note-type">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="anruf">Anruf</SelectItem>
                          <SelectItem value="email">E-Mail</SelectItem>
                          <SelectItem value="notiz">Notiz</SelectItem>
                        </SelectContent>
                      </Select>
                      <Textarea
                        value={noteText}
                        onChange={(e) => setNoteText(e.target.value)}
                        placeholder="Notiz eingeben..."
                        className="min-h-[60px]"
                        data-testid="input-note-text"
                      />
                    </div>
                    <Button size="sm" onClick={handleAddNote} disabled={!noteText.trim() || addNoteMutation.isPending} data-testid="button-add-note">
                      {addNoteMutation.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" /> : <Plus className="h-3.5 w-3.5 mr-1" />}
                      Notiz speichern
                    </Button>
                  </CardContent>
                </Card>

                {prospect.notes && prospect.notes.length > 0 && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Verlauf</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <div className="space-y-3">
                        {prospect.notes.map((note) => {
                          const Icon = NOTE_TYPE_ICONS[note.noteType as ProspectNoteType] || MessageSquare;
                          return (
                            <div key={note.id} className="flex gap-3 text-sm" data-testid={`note-${note.id}`}>
                              <div className="mt-0.5">
                                <Icon className="h-4 w-4 text-muted-foreground" />
                              </div>
                              <div className="flex-1">
                                <div className="text-foreground">{note.noteText}</div>
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  {PROSPECT_NOTE_TYPE_LABELS[note.noteType as ProspectNoteType] || note.noteType}
                                  {" · "}
                                  {formatDateForDisplay(String(note.createdAt).substring(0, 10))}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                )}

                <Button variant="ghost" className="text-red-600 w-full" onClick={() => setShowDeleteDialog(true)} data-testid="button-delete-prospect">
                  <Trash2 className="h-4 w-4 mr-2" /> Interessent löschen
                </Button>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent className="fixed inset-0 flex items-center justify-center">
          <div className="bg-background rounded-lg p-6 max-w-md w-full mx-4 shadow-lg border">
            <AlertDialogHeader>
              <AlertDialogTitle>Interessent löschen?</AlertDialogTitle>
              <AlertDialogDescription>
                Der Interessent wird dauerhaft entfernt. Diese Aktion kann nicht rückgängig gemacht werden.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel data-testid="button-cancel-delete">Abbrechen</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-red-600 hover:bg-red-700" data-testid="button-confirm-delete">
                Löschen
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showWiedervorlageDialog} onOpenChange={(v) => { if (!v) { setShowWiedervorlageDialog(false); setDialogWiedervorlageDate(""); setDialogKommentar(""); } }}>
        <DialogContent className="fixed inset-0 flex items-center justify-center">
          <div className="bg-background rounded-lg p-6 max-w-md w-full mx-4 shadow-lg border">
            <DialogHeader>
              <DialogTitle>Wiedervorlage planen</DialogTitle>
              <DialogDescription>
                Wann soll dieser Interessent erneut kontaktiert werden?
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 mt-4">
              <div>
                <Label>Datum *</Label>
                <Input
                  type="date"
                  value={dialogWiedervorlageDate}
                  onChange={(e) => setDialogWiedervorlageDate(e.target.value)}
                  min={todayISO()}
                  data-testid="input-wiedervorlage-date"
                />
              </div>
              <div>
                <Label>Kommentar</Label>
                <Textarea
                  value={dialogKommentar}
                  onChange={(e) => setDialogKommentar(e.target.value)}
                  placeholder="z.B. nochmal anrufen, Unterlagen schicken..."
                  className="min-h-[60px]"
                  data-testid="input-wiedervorlage-kommentar"
                />
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => { setShowWiedervorlageDialog(false); setDialogWiedervorlageDate(""); setDialogKommentar(""); }} data-testid="button-cancel-wiedervorlage">
                Abbrechen
              </Button>
              <Button onClick={handleWiedervorlageConfirm} disabled={!dialogWiedervorlageDate || updateMutation.isPending} data-testid="button-confirm-wiedervorlage">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Wiedervorlage setzen
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={showNichtInteressiertDialog} onOpenChange={(v) => { if (!v) { setShowNichtInteressiertDialog(false); setDialogKommentar(""); } }}>
        <AlertDialogContent className="fixed inset-0 flex items-center justify-center">
          <div className="bg-background rounded-lg p-6 max-w-md w-full mx-4 shadow-lg border">
            <AlertDialogHeader>
              <AlertDialogTitle>Nicht interessiert markieren?</AlertDialogTitle>
              <AlertDialogDescription>
                Der Interessent wird als „Nicht interessiert" markiert und erscheint nicht mehr in der aktiven Pipeline.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="mt-3">
              <Label>Grund / Kommentar</Label>
              <Textarea
                value={dialogKommentar}
                onChange={(e) => setDialogKommentar(e.target.value)}
                placeholder="Warum kein Interesse? (optional)"
                className="min-h-[60px]"
                data-testid="input-nicht-interessiert-kommentar"
              />
            </div>
            <AlertDialogFooter className="mt-4">
              <AlertDialogCancel onClick={() => { setShowNichtInteressiertDialog(false); setDialogKommentar(""); }} data-testid="button-cancel-nicht-interessiert">Abbrechen</AlertDialogCancel>
              <AlertDialogAction onClick={handleNichtInteressiertConfirm} className="bg-red-600 hover:bg-red-700" disabled={updateMutation.isPending} data-testid="button-confirm-nicht-interessiert">
                {updateMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Bestätigen
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={showDisqualifyDialog} onOpenChange={(v) => { if (!v) { setShowDisqualifyDialog(false); setDisqualifyReason(""); } }}>
        <DialogContent className="fixed inset-0 flex items-center justify-center">
          <div className="bg-background rounded-lg p-6 max-w-md w-full mx-4 shadow-lg border">
            <DialogHeader>
              <DialogTitle>Interessent disqualifizieren</DialogTitle>
              <DialogDescription>
                Bitte wählen Sie einen Grund für die Disqualifizierung.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 mt-4">
              <div>
                <Label>Grund *</Label>
                <Select value={disqualifyReason} onValueChange={setDisqualifyReason}>
                  <SelectTrigger data-testid="select-disqualify-reason">
                    <SelectValue placeholder="Grund auswählen..." />
                  </SelectTrigger>
                  <SelectContent>
                    {DISQUALIFICATION_REASONS.map((reason) => (
                      <SelectItem key={reason} value={reason}>
                        {DISQUALIFICATION_REASON_LABELS[reason]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter className="mt-4">
              <Button variant="outline" onClick={() => { setShowDisqualifyDialog(false); setDisqualifyReason(""); }} data-testid="button-cancel-disqualify">
                Abbrechen
              </Button>
              <Button onClick={handleDisqualifizierenConfirm} disabled={!disqualifyReason || qualifyMutation.isPending} className="bg-red-600 hover:bg-red-700 text-white" data-testid="button-confirm-disqualify">
                {qualifyMutation.isPending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                Disqualifizieren
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default function AdminProspects() {
  const searchString = useSearch();
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateSheet, setShowCreateSheet] = useState(false);
  const [selectedProspectId, setSelectedProspectId] = useState<number | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    if (params.get("create") === "true") {
      setShowCreateSheet(true);
    }
  }, []);

  const queryParams = useMemo(() => ({
    status: statusFilter === "all" ? undefined : statusFilter,
    search: searchQuery || undefined,
  }), [statusFilter, searchQuery]);

  const { data: stats } = useProspectStats();
  const { data: prospects, isLoading } = useProspects(queryParams);

  const handleOpenCreate = useCallback(() => setShowCreateSheet(true), []);
  const handleCloseCreate = useCallback(() => setShowCreateSheet(false), []);
  const handleSelectProspect = useCallback((id: number) => setSelectedProspectId(id), []);
  const handleCloseDetail = useCallback(() => setSelectedProspectId(null), []);

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-4 mb-4">
        <Link href="/admin">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div className="flex-1">
          <h1 className={componentStyles.pageTitle}>Interessenten</h1>
          <p className="text-sm text-muted-foreground">Lead-Pipeline & Kontaktverwaltung</p>
        </div>
        <Button size="sm" onClick={handleOpenCreate} data-testid="button-new-prospect">
          <UserPlus className="h-4 w-4 mr-1" /> Neu
        </Button>
      </div>

      {stats && <PipelineStats stats={stats} />}

      <div className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Name, Telefon, E-Mail..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
            data-testid="input-search-prospects"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Alle Status</SelectItem>
            {PROSPECT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>{PROSPECT_STATUS_LABELS[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : prospects && prospects.length > 0 ? (
        <div className="space-y-2">
          {prospects.map((prospect) => (
            <Card
              key={prospect.id}
              className="cursor-pointer hover:shadow-md transition-shadow focus-visible:ring-2 focus-visible:ring-primary"
              onClick={() => handleSelectProspect(prospect.id)}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); handleSelectProspect(prospect.id); } }}
              role="button"
              tabIndex={0}
              data-testid={`card-prospect-${prospect.id}`}
            >
              <CardContent className="p-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm truncate">
                        {prospect.vorname} {prospect.nachname}
                      </span>
                      <StatusBadge status={prospect.status} />
                      {prospect.pflegegrad && (
                        <Badge variant="outline" className="text-xs">PG {prospect.pflegegrad}</Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {prospect.telefon && (
                        <a href={`tel:${prospect.telefon}`} className="flex items-center gap-1 text-primary hover:underline" data-testid="link-prospect-phone-mobile">
                          <Phone className="h-3 w-3" /> {formatPhoneForDisplay(prospect.telefon)}
                        </a>
                      )}
                      {(prospect.stadt || prospect.strasse) && (
                        <a
                          href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(prospect) || prospect.stadt || '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="flex items-center gap-1 text-primary hover:underline"
                          data-testid={`link-prospect-address-${prospect.id}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MapPin className="h-3 w-3" /> {formatAddress(prospect) || prospect.stadt}
                        </a>
                      )}
                      {prospect.quelle && (
                        <span className="italic">{prospect.quelle}</span>
                      )}
                    </div>
                    {prospect.wiedervorlageDate && prospect.status === "wiedervorlage" && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-purple-600">
                        <CalendarClock className="h-3 w-3" />
                        Wiedervorlage: {formatDateForDisplay(String(prospect.wiedervorlageDate).substring(0, 10))}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                    {formatDateForDisplay(String(prospect.createdAt).substring(0, 10), { day: "2-digit", month: "2-digit" })}
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="text-center py-12 text-muted-foreground" data-testid="empty-prospects">
          <UserPlus className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm font-medium">Keine Interessenten gefunden</p>
          <p className="text-xs mt-1">Erstelle einen neuen Interessenten oder warte auf eingehende Leads per E-Mail.</p>
        </div>
      )}

      <CreateProspectSheet open={showCreateSheet} onClose={handleCloseCreate} />
      <ProspectDetailSheet
        prospectId={selectedProspectId}
        open={!!selectedProspectId}
        onClose={handleCloseDetail}
      />
    </Layout>
  );
}
