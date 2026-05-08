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
import { useProspects, useProspectStats, useProspect, useCreateProspect, useUpdateProspect, useAddProspectNote, useReparseProspect, useDeleteProspect, useQualifyProspect, useProspectOffer } from "@/features/prospects";
import { AddressFields } from "@/features/customers/components/wizard/address-fields";
import { isDachPhone } from "@shared/schema/common";
import { PROSPECT_STATUS_LABELS, PROSPECT_STATUSES, PROSPECT_NOTE_TYPE_LABELS, DISQUALIFICATION_REASON_LABELS, DISQUALIFICATION_REASONS, type ProspectStatus, type ProspectNoteType, type DisqualificationReason } from "@shared/schema";
import { formatDateForDisplay, todayISO } from "@shared/utils/datetime";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import { formatAddress } from "@shared/utils/format";

import { StatusBadge } from "@/features/prospects/components/status-badge";
import { PipelineStats } from "@/features/prospects/components/pipeline-stats";
import { CreateProspectSheet } from "@/features/prospects/components/create-prospect-sheet";
import { ProspectDetailSheet } from "@/features/prospects/components/prospect-detail-sheet";


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

      {stats && <PipelineStats stats={stats} activeStatus={statusFilter} onStatusClick={(status) => setStatusFilter(prev => prev === status ? "all" : status)} />}

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
