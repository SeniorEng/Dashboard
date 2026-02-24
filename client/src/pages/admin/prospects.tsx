import { useState } from "react";
import { Link, useLocation } from "wouter";
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
  XCircle,
  ArrowRightCircle,
  Loader2,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { useProspects, useProspectStats, useProspect, useCreateProspect, useUpdateProspect, useAddProspectNote, useDeleteProspect } from "@/features/prospects";
import { PROSPECT_STATUS_LABELS, PROSPECT_STATUSES, PROSPECT_NOTE_TYPE_LABELS, type ProspectStatus, type ProspectNoteType } from "@shared/schema";
import { format } from "date-fns";
import { de } from "date-fns/locale";

const STATUS_COLORS: Record<ProspectStatus, string> = {
  neu: "bg-blue-100 text-blue-800",
  kontaktiert: "bg-amber-100 text-amber-800",
  wiedervorlage: "bg-purple-100 text-purple-800",
  nicht_interessiert: "bg-gray-100 text-gray-800",
  absage: "bg-red-100 text-red-800",
  erstberatung: "bg-emerald-100 text-emerald-800",
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
    <div className="grid grid-cols-3 md:grid-cols-6 gap-2 mb-4" data-testid="pipeline-stats">
      {PROSPECT_STATUSES.map((status) => (
        <div key={status} className="text-center p-2 rounded-lg bg-white/60 border">
          <div className="text-lg font-bold" data-testid={`stat-count-${status}`}>
            {stats[status] || 0}
          </div>
          <div className="text-xs text-muted-foreground">
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
  const [stadt, setStadt] = useState("");
  const [quelle, setQuelle] = useState("");
  const createMutation = useCreateProspect();

  const handleSubmit = () => {
    createMutation.mutate({
      vorname,
      nachname,
      telefon: telefon || null,
      email: email || null,
      stadt: stadt || null,
      quelle: quelle || null,
      status: "neu",
    }, {
      onSuccess: () => {
        setVorname(""); setNachname(""); setTelefon(""); setEmail(""); setStadt(""); setQuelle("");
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
              <Input value={vorname} onChange={(e) => setVorname(e.target.value)} data-testid="input-prospect-vorname" />
            </div>
            <div>
              <Label>Nachname *</Label>
              <Input value={nachname} onChange={(e) => setNachname(e.target.value)} data-testid="input-prospect-nachname" />
            </div>
          </div>
          <div>
            <Label>Telefon</Label>
            <Input value={telefon} onChange={(e) => setTelefon(e.target.value)} type="tel" data-testid="input-prospect-telefon" />
          </div>
          <div>
            <Label>E-Mail</Label>
            <Input value={email} onChange={(e) => setEmail(e.target.value)} type="email" data-testid="input-prospect-email" />
          </div>
          <div>
            <Label>Stadt</Label>
            <Input value={stadt} onChange={(e) => setStadt(e.target.value)} data-testid="input-prospect-stadt" />
          </div>
          <div>
            <Label>Quelle</Label>
            <Input value={quelle} onChange={(e) => setQuelle(e.target.value)} placeholder="z.B. pflege24.de" data-testid="input-prospect-quelle" />
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
  const updateMutation = useUpdateProspect();
  const addNoteMutation = useAddProspectNote();
  const deleteMutation = useDeleteProspect();
  const [, navigate] = useLocation();
  const [noteText, setNoteText] = useState("");
  const [noteType, setNoteType] = useState<ProspectNoteType>("notiz");
  const [statusNotiz, setStatusNotiz] = useState("");
  const [wiedervorlageDate, setWiedervorlageDate] = useState("");
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  const handleStatusChange = (newStatus: ProspectStatus) => {
    const data: Record<string, unknown> = { status: newStatus };
    if (newStatus === "wiedervorlage" && wiedervorlageDate) {
      data.wiedervorlageDate = wiedervorlageDate;
    }
    if (statusNotiz) {
      data.statusNotiz = statusNotiz;
    }
    if (prospectId) {
      updateMutation.mutate({ id: prospectId, data });
      setStatusNotiz("");
      setWiedervorlageDate("");
    }
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
    const params = new URLSearchParams({
      fromProspect: String(prospect.id),
      vorname: prospect.vorname,
      nachname: prospect.nachname,
      ...(prospect.telefon && { telefon: prospect.telefon }),
      ...(prospect.strasse && { strasse: prospect.strasse }),
      ...(prospect.nr && { nr: prospect.nr }),
      ...(prospect.plz && { plz: prospect.plz }),
      ...(prospect.stadt && { stadt: prospect.stadt }),
      ...(prospect.pflegegrad && { pflegegrad: String(prospect.pflegegrad) }),
    });
    navigate(`/new-appointment?type=erstberatung&${params}`);
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
                    <CardTitle className="text-sm">Kontaktdaten</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    {prospect.telefon && (
                      <a href={`tel:${prospect.telefon}`} className="flex items-center gap-2 text-primary" data-testid="link-prospect-phone">
                        <Phone className="h-3.5 w-3.5" /> {prospect.telefon}
                      </a>
                    )}
                    {prospect.email && (
                      <a href={`mailto:${prospect.email}`} className="flex items-center gap-2 text-primary" data-testid="link-prospect-email">
                        <Mail className="h-3.5 w-3.5" /> {prospect.email}
                      </a>
                    )}
                    {(prospect.strasse || prospect.stadt) && (
                      <div className="flex items-center gap-2 text-muted-foreground">
                        <MapPin className="h-3.5 w-3.5" />
                        {[prospect.strasse, prospect.nr].filter(Boolean).join(" ")}
                        {prospect.plz || prospect.stadt ? ", " : ""}
                        {[prospect.plz, prospect.stadt].filter(Boolean).join(" ")}
                      </div>
                    )}
                    {prospect.pflegegrad && (
                      <Badge variant="outline" className="mt-1">Pflegegrad {prospect.pflegegrad}</Badge>
                    )}
                    {prospect.quelle && (
                      <div className="text-xs text-muted-foreground">Quelle: {prospect.quelle}</div>
                    )}
                    <div className="text-xs text-muted-foreground">
                      Erstellt: {format(new Date(prospect.createdAt), "dd.MM.yyyy HH:mm", { locale: de })}
                    </div>
                  </CardContent>
                </Card>

                {prospect.status !== "erstberatung" && prospect.status !== "absage" && prospect.status !== "nicht_interessiert" && (
                  <Card>
                    <CardHeader className="pb-2">
                      <CardTitle className="text-sm">Status ändern</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      <div className="flex flex-wrap gap-2">
                        {prospect.status === "neu" && (
                          <Button size="sm" variant="outline" onClick={() => handleStatusChange("kontaktiert")} data-testid="button-status-kontaktiert">
                            <PhoneCall className="h-3.5 w-3.5 mr-1" /> Kontaktiert
                          </Button>
                        )}
                        <Button size="sm" variant="outline" onClick={() => handleStatusChange("wiedervorlage")} data-testid="button-status-wiedervorlage">
                          <CalendarClock className="h-3.5 w-3.5 mr-1" /> Wiedervorlage
                        </Button>
                        <Button size="sm" variant="outline" className="text-red-600" onClick={() => handleStatusChange("nicht_interessiert")} data-testid="button-status-nicht-interessiert">
                          <XCircle className="h-3.5 w-3.5 mr-1" /> Nicht interessiert
                        </Button>
                      </div>
                      {prospect.status !== "neu" && (
                        <div className="space-y-2">
                          <Input
                            type="date"
                            value={wiedervorlageDate}
                            onChange={(e) => setWiedervorlageDate(e.target.value)}
                            placeholder="Wiedervorlage-Datum"
                            data-testid="input-wiedervorlage-date"
                          />
                          <Input
                            value={statusNotiz}
                            onChange={(e) => setStatusNotiz(e.target.value)}
                            placeholder="Notiz zum Statuswechsel..."
                            data-testid="input-status-notiz"
                          />
                        </div>
                      )}
                      <Button
                        className="w-full"
                        onClick={handleConvertToErstberatung}
                        data-testid="button-convert-erstberatung"
                      >
                        <ArrowRightCircle className="h-4 w-4 mr-2" />
                        In Erstberatung umwandeln
                      </Button>
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
                                  {format(new Date(note.createdAt), "dd.MM.yyyy HH:mm", { locale: de })}
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
    </>
  );
}

export default function AdminProspects() {
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateSheet, setShowCreateSheet] = useState(false);
  const [selectedProspectId, setSelectedProspectId] = useState<number | null>(null);

  const { data: stats } = useProspectStats();
  const { data: prospects, isLoading } = useProspects({
    status: statusFilter === "all" ? undefined : statusFilter,
    search: searchQuery || undefined,
  });

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
        <Button size="sm" onClick={() => setShowCreateSheet(true)} data-testid="button-new-prospect">
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
              className="cursor-pointer hover:shadow-md transition-shadow"
              onClick={() => setSelectedProspectId(prospect.id)}
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
                        <span className="flex items-center gap-1">
                          <Phone className="h-3 w-3" /> {prospect.telefon}
                        </span>
                      )}
                      {prospect.stadt && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" /> {prospect.stadt}
                        </span>
                      )}
                      {prospect.quelle && (
                        <span className="italic">{prospect.quelle}</span>
                      )}
                    </div>
                    {prospect.wiedervorlageDate && prospect.status === "wiedervorlage" && (
                      <div className="flex items-center gap-1 mt-1 text-xs text-purple-600">
                        <CalendarClock className="h-3 w-3" />
                        Wiedervorlage: {format(new Date(prospect.wiedervorlageDate), "dd.MM.yyyy", { locale: de })}
                      </div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap ml-2">
                    {format(new Date(prospect.createdAt), "dd.MM.", { locale: de })}
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

      <CreateProspectSheet open={showCreateSheet} onClose={() => setShowCreateSheet(false)} />
      <ProspectDetailSheet
        prospectId={selectedProspectId}
        open={!!selectedProspectId}
        onClose={() => setSelectedProspectId(null)}
      />
    </Layout>
  );
}
