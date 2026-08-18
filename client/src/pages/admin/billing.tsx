import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
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
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/use-auth";
import { iconSize, componentStyles } from "@/design-system";
import { ArrowLeft, CalendarDays, FileText, Printer, Loader2, Ban } from "lucide-react";
import type { InvoiceItem } from "@shared/api";
import { isBulkActionableDraft, isPflegekasseBatchDraft } from "@shared/domain/billing-drafts";
import { istAktionsfaehigeRechnung } from "@shared/domain/billing-pipeline";
import {
  useBillingInvoices,
  useEligibleCustomers,
  useInvoicePreview,
  useBlockingDrafts,
  usePayers,
  useInvoiceDetail,
  useDeliveryHistory,
  useBillingPipeline,
  useBillingEconomics,
  useBillingTermine,
  useActiveEmployees,
  useBillingMutations,
  useMissingSignaturesByCustomer,
  useSelection,
  BillingFilterBar,
  EconomicsOverviewCard,
  StatusPipelineCard,
  TermineTab,
  InvoiceList,
  PendingInvoicesCard,
  BulkSendDialog,
  GenerateAllDialog,
  NewInvoiceDialog,
  StornoDialog,
  MarkPaidDialog,
  Reduce45bDialog,
  DiscardDraftsDialog,
  type BillingStatusFilter,
  type PipelineStageSelection,
} from "@/features/billing";

// Task #1473: Statusfilter für Rechnungs-Liste + Mutations-Cache-Key. Die neue
// Seite filtert Rechnungen nicht mehr per Status-Dropdown (Cluster in der
// InvoiceList), deshalb fix „alle".
const INVOICE_STATUS_FILTER = "alle";
const NO_DATE = "";

type ActiveTab = "termine" | "rechnungen";

export default function AdminBilling() {
  const { toast } = useToast();
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  // Geteilter Status-Filter zwischen Pipeline-Chips und der Termine-Liste.
  const [statusFilter, setStatusFilter] = useState<BillingStatusFilter>("alle");
  // Mitarbeiter:innen-Filter ("alle" oder employeeId als String).
  const [employeeFilter, setEmployeeFilter] = useState<string>("alle");
  // Krankenkassen-Filter ("alle" oder insuranceProviderId als String).
  const [payerFilter, setPayerFilter] = useState<string>("alle");
  // Pill-Tabs: Termine ⟷ Rechnungen verwalten.
  const [activeTab, setActiveTab] = useState<ActiveTab>("termine");

  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<number | null>(null);
  const [stornoTarget, setStornoTarget] = useState<InvoiceItem | null>(null);
  const [markPaidTarget, setMarkPaidTarget] = useState<InvoiceItem | null>(null);
  // Task #1785 P4: Ziel-Rechnung der §45b-Kürzung (Superadmin), Dialog-State.
  const [reduce45bTarget, setReduce45bTarget] = useState<InvoiceItem | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [generateAllOpen, setGenerateAllOpen] = useState(false);
  // Task #1888 — wenn gesetzt, ist der „Alle erstellen"-Dialog auf die Multi-Select-
  // Auswahl der Erstellungs-Liste verengt (Sammelaktion „Erstellen (N)"); null = der
  // reguläre „Alle erstellen"-Lauf über die ganze berechtigte Menge.
  const [generateAllSelection, setGenerateAllSelection] = useState<number[] | null>(null);
  const generateAllCloseBtnRef = useRef<HTMLButtonElement>(null);
  const [bulkSendOpen, setBulkSendOpen] = useState(false);
  // Task #1473: Print-only Sammeldruck-Dialog (kein Statuswechsel).
  const [sammeldruckOpen, setSammeldruckOpen] = useState(false);
  // Task #1888 — gemeinsame Auswahl-Hülle (#1376) über den geteilten `useSelection`-
  // Hook. Eine Instanz für die Rechnungs-Liste, eine für die Erstellungs-Liste.
  const invoiceSelection = useSelection();
  const selectedIds = invoiceSelection.selectedIds;
  const pendingSelection = useSelection();
  const [pendingBulkAction, setPendingBulkAction] = useState<
    | { type: "delete" }
    | { type: "status"; status: "entwurf" | "versendet" | "avis_erhalten" | "bezahlt" }
    | null
  >(null);

  const currentYear = today.getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

  const { data: invoices, isLoading: invoicesLoading } = useBillingInvoices(
    selectedYear,
    selectedMonth,
    INVOICE_STATUS_FILTER,
    payerFilter,
    NO_DATE,
    NO_DATE,
  );

  // Task #1890: Storno-Belege (stornierte Originale + Gutschriften) sind
  // standardmäßig ausgeblendet (Archiv-Charakter), lassen sich aber über einen
  // Umschalter einblenden — dann füllen sie den bestehenden „Storniert"-Cluster.
  const [showStorno, setShowStorno] = useState(false);
  const visibleInvoices = showStorno
    ? invoices
    : invoices?.filter(
        (inv) => istAktionsfaehigeRechnung({ status: inv.status, invoiceType: inv.invoiceType }),
      );

  const { data: customers, isLoading: customersLoading } = useEligibleCustomers(
    selectedYear,
    selectedMonth,
    payerFilter,
    NO_DATE,
    NO_DATE,
  );

  // Task #1889 — „fehlende Unterschrift nach Abschluss" pro Kunde, direkt in die
  // Abrechnungsliste integriert (ersetzt die separate obere Box).
  const missingSignaturesByCustomer = useMissingSignaturesByCustomer(selectedYear, selectedMonth);

  const previewCustomerId = selectedCustomerId ? parseInt(selectedCustomerId, 10) : null;
  const {
    data: invoicePreview,
    isLoading: previewLoading,
    isError: previewError,
    error: previewErrorObj,
  } = useInvoicePreview(previewCustomerId, selectedYear, selectedMonth, dialogOpen, NO_DATE, NO_DATE);

  const { data: blockingDrafts } = useBlockingDrafts(
    previewCustomerId,
    selectedYear,
    selectedMonth,
    dialogOpen && previewError,
  );

  const { data: payers } = usePayers(selectedYear, selectedMonth);
  const { data: employees } = useActiveEmployees();

  // Status-Pipeline (liest nur den Pipeline-Reader).
  const { data: pipeline, isLoading: pipelineLoading } = useBillingPipeline(selectedYear, selectedMonth);
  // Wirtschaftlicher Überblick (liest nur den Economics-Reader).
  // Task #1512 — Lohn-/Personalkosten pro Mitarbeiter sind Superadmin-only.
  const { user } = useAuth();
  const isSuperAdmin = user?.isSuperAdmin ?? false;
  const { data: economics, isLoading: economicsLoading } = useBillingEconomics(
    selectedYear,
    selectedMonth,
    employeeFilter,
    payerFilter,
    isSuperAdmin,
  );
  // Termine End-to-End (liest nur den Termine-Reader).
  const { data: termine, isLoading: termineLoading } = useBillingTermine(
    selectedYear,
    selectedMonth,
    employeeFilter,
    payerFilter,
  );

  const { data: expandedDetail, isLoading: detailLoading } = useInvoiceDetail(expandedInvoiceId);
  const { data: deliveryHistory } = useDeliveryHistory(expandedInvoiceId);

  const {
    generateMutation,
    discardDraftsMutation,
    statusMutation,
    revokeSentMarkMutation,
    reduce45bMutation,
    bulkDeleteMutation,
    bulkStatusMutation,
    repairPdfsMutation,
    sendInvoiceMutation,
    markSentMutation,
    generateAllMutation,
    batchSendMutation,
    bulkSendMutation,
    bulkPrintPreviewMutation,
    singlePdfExportMutation,
    sendingInvoiceId,
    batchSending,
    generateAllProgress,
    setGenerateAllProgress,
    bulkSendResult,
    setBulkSendResult,
    bulkActionProgress,
  } = useBillingMutations({
    selectedMonth,
    selectedYear,
    statusFilter: INVOICE_STATUS_FILTER,
    payerFilter,
    dateFrom: NO_DATE,
    dateTo: NO_DATE,
    setStatusFilter: () => {},
    onGenerateSuccess: () => {
      setDialogOpen(false);
      setSelectedCustomerId("");
    },
    onDiscardSettled: () => setDiscardConfirmOpen(false),
    onStatusSuccess: () => setStornoTarget(null),
    onBulkActionSuccess: () => invoiceSelection.clear(),
    onReduce45bSuccess: () => setReduce45bTarget(null),
  });

  useEffect(() => {
    if (generateAllProgress && generateAllOpen && !generateAllMutation.isPending) {
      generateAllCloseBtnRef.current?.focus();
    }
  }, [generateAllProgress, generateAllOpen, generateAllMutation.isPending]);

  // Storno-Belege nicht in die Massen-Versand-Zähler/-Mengen aufnehmen.
  const draftPflegekasseInvoices = invoices?.filter(isPflegekasseBatchDraft) || [];
  const draftBulkInvoices = invoices?.filter(isBulkActionableDraft) || [];

  const handleBatchSend = () => {
    if (draftPflegekasseInvoices.length === 0) {
      toast({ title: "Keine Rechnungen zum Versenden", description: "Es gibt keine Entwurfs-Rechnungen an Pflegekassen.", variant: "destructive" });
      return;
    }
    batchSendMutation.mutate(draftPflegekasseInvoices.map((inv) => inv.id));
  };

  const handleBulkSend = () => {
    if (draftBulkInvoices.length === 0) return;
    bulkSendMutation.mutate(draftBulkInvoices.map((inv) => inv.id));
  };

  // Task #1473: Print-only Sammeldruck (kein Statuswechsel). Zwei Optionen:
  // nur Rechnungen oder zusätzlich die Leistungsnachweise.
  const handleSammeldruck = (includeLeistungsnachweise: boolean) => {
    setSammeldruckOpen(false);
    bulkPrintPreviewMutation.mutate({ groupByPayer: false, includeLeistungsnachweise });
  };

  // Task #1695: EIN „Drucken"-Menü für die aktuelle Auswahl, rein lesend — KEIN
  // Statuswechsel. 2×2-Matrix: Zusammengefasst (1 PDF, /bulk-print-preview) vs
  // Einzeln (ZIP, /single-pdf-export), je × Nur Rechnungen vs +
  // Leistungsnachweise. Neben Entwürfen dürfen auch bereits versendete/bezahlte
  // Rechnungen als read-only Nachdruck-/Archiv-Bündel gedruckt werden
  // (versiegelte Bytes, kein Re-Seal); reine Stornorechnungen sind
  // ausgeschlossen. Ersetzt handleBulkLexwareExport + handleBulkPrintSelection.
  const handleBulkPrint = ({
    combine,
    includeLeistungsnachweise,
  }: {
    combine: boolean;
    includeLeistungsnachweise: boolean;
  }) => {
    if (selectedIds.size === 0) {
      toast({ title: "Keine Rechnungen ausgewählt", variant: "destructive" });
      return;
    }
    const printableIds = (visibleInvoices ?? [])
      .filter(
        (inv) =>
          selectedIds.has(inv.id) &&
          inv.invoiceType !== "stornorechnung",
      )
      .map((inv) => inv.id);
    if (printableIds.length === 0) {
      toast({
        title: "Keine druckbaren Rechnungen in der Auswahl",
        description:
          "Reine Stornorechnungen können nicht gedruckt werden.",
        variant: "destructive",
      });
      return;
    }
    if (combine) {
      bulkPrintPreviewMutation.mutate({
        groupByPayer: false,
        includeLeistungsnachweise,
        invoiceIds: printableIds,
      });
    } else {
      singlePdfExportMutation.mutate({
        invoiceIds: printableIds,
        includeLeistungsnachweise,
      });
    }
  };

  const handleGenerate = (opts?: { confirmPartial?: boolean; partialReason?: string }) => {
    if (!selectedCustomerId) {
      toast({ title: "Bitte Kunden auswählen", variant: "destructive" });
      return;
    }
    generateMutation.mutate({
      customerId: parseInt(selectedCustomerId),
      billingMonth: selectedMonth,
      billingYear: selectedYear,
      // Task #1883 — Opt-in fürs bewusste Teil-Abrechnen (Variante B).
      confirmPartial: opts?.confirmPartial,
      partialReason: opts?.partialReason,
    });
  };

  const handleCreateForCustomer = (customerId: number) => {
    setSelectedCustomerId(String(customerId));
    setDialogOpen(true);
  };

  const handleToggleDetail = (invoiceId: number) => {
    setExpandedInvoiceId(expandedInvoiceId === invoiceId ? null : invoiceId);
  };

  // Auswahl zurücksetzen, sobald sich der sichtbare Listenumfang ändert. Task #1888:
  // gilt für BEIDE Auswahl-Hüllen (Rechnungs- und Erstellungs-Liste), damit Zähler/
  // Summen unter Kassen-/Datumsfilter konsistent bleiben. Deps auf die STABILEN
  // `clear`-Callbacks (useCallback []), nicht auf die je Render neu gebildeten
  // Selection-Objekte — sonst liefe der Effekt bei jedem Render.
  const clearInvoiceSelection = invoiceSelection.clear;
  const clearPendingSelection = pendingSelection.clear;
  useEffect(() => {
    clearInvoiceSelection();
    clearPendingSelection();
  }, [selectedMonth, selectedYear, payerFilter, clearInvoiceSelection, clearPendingSelection]);

  // Task #1473: Pipeline-Chip → passender Tab + geteilter Status-Filter.
  const handleStageSelect = (selection: PipelineStageSelection) => {
    setStatusFilter(selection.status);
    setActiveTab(selection.tab);
  };

  const handleToggleSelect = (invoiceId: number, checked: boolean) => {
    invoiceSelection.toggle(invoiceId, checked);
  };

  const handleToggleSelectAll = (checked: boolean) => {
    if (checked) {
      // Task #1890: „Alle auswählen" nimmt bewusst KEINE Storno-Belege auf —
      // für sie gibt es keine Sammelaktion. So bleiben Auswahl-/Versand-Zähler
      // unverändert, auch wenn die Stornos gerade eingeblendet sind.
      invoiceSelection.setAll(
        (visibleInvoices ?? [])
          .filter((inv) => istAktionsfaehigeRechnung({ status: inv.status, invoiceType: inv.invoiceType }))
          .map((inv) => inv.id),
      );
    } else {
      invoiceSelection.clear();
    }
  };

  // Task #1890: Springt zur verknüpften Rechnung (Original ↔ Stornorechnung),
  // klappt deren Detailansicht auf und scrollt sie in den sichtbaren Bereich.
  // Beide Enden liegen im selben (aufgeklappten) „Storniert"-Cluster.
  const handleNavigateToInvoice = (invoiceId: number) => {
    setExpandedInvoiceId(invoiceId);
    requestAnimationFrame(() => {
      document
        .getElementById(`invoice-row-${invoiceId}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  };

  // Task #1630: „Nach Status auswählen" — alle Rechnungen eines Handlungs-
  // Clusters auf einmal auswählen/abwählen.
  const handleToggleSelectCluster = (ids: number[], checked: boolean) => {
    invoiceSelection.toggleMany(ids, checked);
  };

  // Task #1888 — Sammelaktion „Erstellen (N)" der Erstellungs-Liste: öffnet den
  // bestehenden „Alle erstellen"-Dialog auf die Auswahl VERENGT. So teilen Auswahl-
  // und Voll-Lauf denselben #1883-geschützten generate-all-Pfad, dieselbe Skip-/
  // Fehler-/Idempotenz-Logik und dasselbe Fortschritt/Ergebnis-Feedback. Der Server
  // schneidet die Auswahl zusätzlich auf die signierten LNs (nie Erweiterung).
  const handleCreateSelectedPending = () => {
    const ids = Array.from(pendingSelection.selectedIds);
    if (ids.length === 0) return;
    setGenerateAllSelection(ids);
    setGenerateAllProgress(null);
    setGenerateAllOpen(true);
  };

  const bulkActionPending = bulkDeleteMutation.isPending || bulkStatusMutation.isPending;

  const handleConfirmBulkAction = () => {
    if (!pendingBulkAction) return;
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      setPendingBulkAction(null);
      return;
    }
    if (pendingBulkAction.type === "delete") {
      bulkDeleteMutation.mutate(ids);
    } else {
      bulkStatusMutation.mutate({ invoiceIds: ids, status: pendingBulkAction.status });
    }
    setPendingBulkAction(null);
  };

  const STATUS_ACTION_LABELS: Record<"entwurf" | "versendet" | "avis_erhalten" | "bezahlt", string> = {
    entwurf: "Auf Entwurf zurücksetzen",  // #66: nur noch Anzeige-Label für Bestand; als Aktion entfernt
    versendet: "Versendet",
    avis_erhalten: "Avis erhalten",
    bezahlt: "Bezahlt",
  };

  const tabButtonClass = (tab: ActiveTab) =>
    `inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${
      activeTab === tab ? "bg-teal-600 text-white" : "text-gray-600 hover:bg-gray-100"
    }`;

  return (
    <Layout variant="wide">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div>
          <h1 className={componentStyles.pageTitle}>Abrechnung</h1>
          <p className="text-gray-600">Termine und Rechnungen verwalten</p>
        </div>
      </div>

      <BillingFilterBar
        selectedMonth={selectedMonth}
        setSelectedMonth={setSelectedMonth}
        selectedYear={selectedYear}
        setSelectedYear={setSelectedYear}
        years={years}
        employeeFilter={employeeFilter}
        setEmployeeFilter={setEmployeeFilter}
        employees={employees}
        payerFilter={payerFilter}
        setPayerFilter={setPayerFilter}
        payers={payers}
      />

      {isSuperAdmin && (
        <EconomicsOverviewCard
          economics={economics}
          isLoading={economicsLoading}
          selectedMonth={selectedMonth}
          selectedYear={selectedYear}
        />
      )}

      <StatusPipelineCard
        pipeline={pipeline}
        isLoading={pipelineLoading}
        selectedMonth={selectedMonth}
        selectedYear={selectedYear}
        activeStatus={statusFilter}
        onStageSelect={handleStageSelect}
      />

      <div
        className="mb-4 mt-2 inline-flex gap-1 rounded-lg border border-gray-200 bg-white p-1"
        data-testid="tabs-billing"
      >
        <button
          type="button"
          onClick={() => setActiveTab("termine")}
          className={tabButtonClass("termine")}
          data-testid="tab-termine"
        >
          <CalendarDays className={iconSize.sm} />
          Termine
        </button>
        <button
          type="button"
          onClick={() => setActiveTab("rechnungen")}
          className={tabButtonClass("rechnungen")}
          data-testid="tab-rechnungen"
        >
          <FileText className={iconSize.sm} />
          Rechnungen verwalten
        </button>
      </div>

      {activeTab === "termine" ? (
        <TermineTab
          termine={termine}
          isLoading={termineLoading}
          statusFilter={statusFilter}
          setStatusFilter={setStatusFilter}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => { setGenerateAllSelection(null); setGenerateAllProgress(null); setGenerateAllOpen(true); }}
              className={componentStyles.btnPrimary}
              data-testid="button-generate-all"
            >
              Alle erstellen
            </Button>
            <Button
              variant="outline"
              onClick={() => setDialogOpen(true)}
              data-testid="button-new-invoice"
            >
              Einzelrechnung
            </Button>
            <Button
              variant="outline"
              onClick={handleBatchSend}
              disabled={batchSending}
              data-testid="button-batch-send"
            >
              An Kassen senden
            </Button>
            <Button
              variant="outline"
              onClick={() => { setBulkSendResult(null); setBulkSendOpen(true); }}
              data-testid="button-bulk-send"
            >
              Sammelversand
            </Button>
            <Button
              variant="outline"
              onClick={() => setSammeldruckOpen(true)}
              disabled={bulkPrintPreviewMutation.isPending}
              data-testid="button-sammeldruck"
            >
              <Printer className={`${iconSize.sm} mr-1`} />
              Sammeldruck
            </Button>
            {/* Task #1834: Sammel-Reparatur aller „PDF-Fehler"-Rechnungen in
                einem Rutsch (ersetzt das Einzel-Anklicken jeder Rechnung). */}
            <Button
              variant="outline"
              onClick={() => repairPdfsMutation.mutate(undefined)}
              disabled={repairPdfsMutation.isPending}
              data-testid="button-repair-pdfs"
            >
              {repairPdfsMutation.isPending ? (
                <Loader2 className={`${iconSize.sm} mr-1 animate-spin`} />
              ) : (
                <FileText className={`${iconSize.sm} mr-1`} />
              )}
              PDF-Fehler beheben
            </Button>
            {/* Task #1890: Storno-Belege ein-/ausblenden. Standard: aus
                (Archiv). Eingeblendet erscheinen stornierte Originale und ihre
                Gutschriften im „Storniert"-Cluster der Liste. */}
            <Button
              variant={showStorno ? "default" : "outline"}
              onClick={() => setShowStorno((v) => !v)}
              data-testid="button-toggle-storno"
              aria-pressed={showStorno}
            >
              <Ban className={`${iconSize.sm} mr-1`} />
              {showStorno ? "Stornos ausblenden" : "Stornos anzeigen"}
            </Button>
          </div>

          <PendingInvoicesCard
            customers={customers}
            isLoading={customersLoading}
            onCreateForCustomer={handleCreateForCustomer}
            missingSignaturesByCustomer={missingSignaturesByCustomer}
            selection={pendingSelection}
            onCreateSelected={handleCreateSelectedPending}
            createSelectedPending={generateAllMutation.isPending && generateAllSelection !== null}
          />

          <InvoiceList
            invoices={visibleInvoices}
            invoicesLoading={invoicesLoading}
            expandedInvoiceId={expandedInvoiceId}
            onToggleDetail={handleToggleDetail}
            expandedDetail={expandedDetail}
            detailLoading={detailLoading}
            deliveryHistory={deliveryHistory}
            sendingInvoiceId={sendingInvoiceId}
            sendInvoiceMutation={sendInvoiceMutation}
            markSentMutation={markSentMutation}
            statusMutation={statusMutation}
            revokeSentMarkMutation={revokeSentMarkMutation}
            onStorno={setStornoTarget}
            onMarkPaid={setMarkPaidTarget}
            isSuperAdmin={isSuperAdmin}
            onReduce45b={setReduce45bTarget}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onToggleSelectCluster={handleToggleSelectCluster}
            onNavigateToInvoice={handleNavigateToInvoice}
            onBulkDelete={() => setPendingBulkAction({ type: "delete" })}
            onBulkStatus={(status) => setPendingBulkAction({ type: "status", status })}
            onBulkPrint={handleBulkPrint}
            onBulkRepairPdfs={() => repairPdfsMutation.mutate(Array.from(selectedIds))}
            repairPdfsPending={repairPdfsMutation.isPending}
            bulkPrintPending={bulkPrintPreviewMutation.isPending}
            singlePdfExportPending={singlePdfExportMutation.isPending}
            bulkActionPending={bulkActionPending}
            bulkActionProgress={bulkActionProgress}
          />
        </div>
      )}

      <Dialog open={sammeldruckOpen} onOpenChange={setSammeldruckOpen}>
        <DialogContent data-testid="dialog-sammeldruck">
          <DialogHeader>
            <DialogTitle>Sammeldruck</DialogTitle>
            <DialogDescription>
              Erzeugt ein gebündeltes PDF aller Rechnungen des Monats — ohne
              Statuswechsel. Optional inklusive der Leistungsnachweise.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              variant="outline"
              onClick={() => handleSammeldruck(false)}
              disabled={bulkPrintPreviewMutation.isPending}
              data-testid="button-sammeldruck-invoices-only"
            >
              Nur Rechnungen
            </Button>
            <Button
              className={componentStyles.btnPrimary}
              onClick={() => handleSammeldruck(true)}
              disabled={bulkPrintPreviewMutation.isPending}
              data-testid="button-sammeldruck-with-ln"
            >
              + Leistungsnachweise
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={pendingBulkAction !== null}
        onOpenChange={(open) => !open && setPendingBulkAction(null)}
      >
        <AlertDialogContent data-testid="dialog-bulk-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingBulkAction?.type === "delete"
                ? "Rechnungen löschen?"
                : "Status ändern?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pendingBulkAction?.type === "delete" ? (
                <>
                  {selectedIds.size} ausgewählte Rechnung(en). Es werden nur Entwürfe
                  gelöscht — bereits finalisierte Rechnungen werden übersprungen
                  (GoBD). Dieser Schritt kann nicht rückgängig gemacht werden.
                </>
              ) : pendingBulkAction?.type === "status" ? (
                <>
                  {selectedIds.size} ausgewählte Rechnung(en) auf „
                  {STATUS_ACTION_LABELS[pendingBulkAction.status]}" setzen. Ungültige
                  Übergänge und finalisierte Rechnungen werden übersprungen.
                </>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-bulk-confirm-cancel">Abbrechen</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmBulkAction}
              className={pendingBulkAction?.type === "delete" ? "bg-red-600 hover:bg-red-700" : undefined}
              data-testid="button-bulk-confirm"
            >
              {pendingBulkAction?.type === "delete" ? "Löschen" : "Status ändern"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <BulkSendDialog
        open={bulkSendOpen}
        setOpen={setBulkSendOpen}
        bulkSendResult={bulkSendResult}
        setBulkSendResult={setBulkSendResult}
        bulkSendMutation={bulkSendMutation}
        draftBulkInvoices={draftBulkInvoices}
        invoices={invoices}
        onBulkSend={handleBulkSend}
        selectedMonth={selectedMonth}
        selectedYear={selectedYear}
      />

      <GenerateAllDialog
        open={generateAllOpen}
        setOpen={(o) => {
          setGenerateAllOpen(o);
          // Task #1888 — beim Schließen eines Auswahl-Laufs die Auswahl leeren
          // (frisch erstellte Kunden sind ohnehin aus der Liste), damit Zähler/Summe
          // nicht mit veralteten IDs zurückbleiben.
          if (!o && generateAllSelection !== null) {
            pendingSelection.clear();
            setGenerateAllSelection(null);
          }
        }}
        generateAllProgress={generateAllProgress}
        setGenerateAllProgress={setGenerateAllProgress}
        generateAllMutation={generateAllMutation}
        customers={customers}
        selectedCustomerIds={generateAllSelection ?? undefined}
        selectedMonth={selectedMonth}
        selectedYear={selectedYear}
        closeButtonRef={generateAllCloseBtnRef}
      />

      <NewInvoiceDialog
        open={dialogOpen}
        setOpen={setDialogOpen}
        setSelectedCustomerId={setSelectedCustomerId}
        customers={customers}
        selectedCustomerId={selectedCustomerId}
        selectedMonth={selectedMonth}
        selectedYear={selectedYear}
        previewCustomerId={previewCustomerId}
        invoicePreview={invoicePreview}
        previewLoading={previewLoading}
        previewError={previewError}
        previewErrorObj={previewErrorObj}
        blockingDrafts={blockingDrafts}
        onDiscardClick={() => setDiscardConfirmOpen(true)}
        discardDraftsMutation={discardDraftsMutation}
        generateMutation={generateMutation}
        onGenerate={handleGenerate}
      />

      <StornoDialog
        stornoTarget={stornoTarget}
        onOpenChange={(open) => !open && setStornoTarget(null)}
        statusMutation={statusMutation}
      />

      <MarkPaidDialog
        markPaidTarget={markPaidTarget}
        onOpenChange={(open) => !open && setMarkPaidTarget(null)}
        statusMutation={statusMutation}
      />

      <Reduce45bDialog
        target={reduce45bTarget}
        onOpenChange={(open) => !open && setReduce45bTarget(null)}
        mutation={reduce45bMutation}
      />

      <DiscardDraftsDialog
        open={discardConfirmOpen}
        onOpenChange={(open) => !open && setDiscardConfirmOpen(false)}
        blockingDrafts={blockingDrafts}
        previewCustomerId={previewCustomerId}
        selectedMonth={selectedMonth}
        selectedYear={selectedYear}
        discardDraftsMutation={discardDraftsMutation}
      />
    </Layout>
  );
}
