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
import { ArrowLeft, CalendarDays, FileText, Printer } from "lucide-react";
import type { InvoiceItem } from "@shared/api";
import { isBulkActionableDraft, isPflegekasseBatchDraft } from "@shared/domain/billing-drafts";
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
  BillingFilterBar,
  EconomicsOverviewCard,
  StatusPipelineCard,
  TermineTab,
  MissingSignaturesCard,
  InvoiceList,
  PendingInvoicesCard,
  BulkSendDialog,
  GenerateAllDialog,
  NewInvoiceDialog,
  StornoDialog,
  MarkPaidDialog,
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
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [generateAllOpen, setGenerateAllOpen] = useState(false);
  const generateAllCloseBtnRef = useRef<HTMLButtonElement>(null);
  const [bulkSendOpen, setBulkSendOpen] = useState(false);
  // Task #1473: Print-only Sammeldruck-Dialog (kein Statuswechsel).
  const [sammeldruckOpen, setSammeldruckOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
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

  // Storno-Belege bleiben aus der Liste (GoBD-Gutschriften blähen sie nur auf).
  const visibleInvoices = invoices?.filter(
    (inv) => inv.status !== "storniert" && inv.invoiceType !== "stornorechnung",
  );

  const { data: customers, isLoading: customersLoading } = useEligibleCustomers(
    selectedYear,
    selectedMonth,
    payerFilter,
    NO_DATE,
    NO_DATE,
  );

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
    bulkDeleteMutation,
    bulkStatusMutation,
    sendInvoiceMutation,
    markSentMutation,
    generateAllMutation,
    batchSendMutation,
    bulkSendMutation,
    bulkPrintPreviewMutation,
    lexwareExportMutation,
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
    onBulkActionSuccess: () => setSelectedIds(new Set()),
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

  const handleBulkLexwareExport = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      toast({ title: "Keine Rechnungen ausgewählt", variant: "destructive" });
      return;
    }
    lexwareExportMutation.mutate(ids);
  };

  // Task #1630: Print-only Druck der aktuellen Auswahl (Rechnung +
  // Leistungsnachweis), rein lesend — KEIN Statuswechsel. Da der Bündel-Druck
  // nur Entwürfe erzeugt, wird die Auswahl vorab auf druckbare Entwürfe
  // gefiltert; enthält sie keine, gibt es verständliches Feedback statt einer
  // leeren Datei.
  const handleBulkPrintSelection = () => {
    if (selectedIds.size === 0) {
      toast({ title: "Keine Rechnungen ausgewählt", variant: "destructive" });
      return;
    }
    const printableIds = (visibleInvoices ?? [])
      .filter(
        (inv) =>
          selectedIds.has(inv.id) &&
          inv.status === "entwurf" &&
          inv.invoiceType !== "stornorechnung",
      )
      .map((inv) => inv.id);
    if (printableIds.length === 0) {
      toast({
        title: "Keine druckbaren Rechnungen in der Auswahl",
        description:
          "Der Druck ist auf Entwürfe beschränkt (versendete oder stornierte Rechnungen sind ausgeschlossen).",
        variant: "destructive",
      });
      return;
    }
    bulkPrintPreviewMutation.mutate({
      groupByPayer: false,
      includeLeistungsnachweise: true,
      invoiceIds: printableIds,
    });
  };

  const handleGenerate = () => {
    if (!selectedCustomerId) {
      toast({ title: "Bitte Kunden auswählen", variant: "destructive" });
      return;
    }
    generateMutation.mutate({
      customerId: parseInt(selectedCustomerId),
      billingMonth: selectedMonth,
      billingYear: selectedYear,
    });
  };

  const handleCreateForCustomer = (customerId: number) => {
    setSelectedCustomerId(String(customerId));
    setDialogOpen(true);
  };

  const handleToggleDetail = (invoiceId: number) => {
    setExpandedInvoiceId(expandedInvoiceId === invoiceId ? null : invoiceId);
  };

  // Auswahl zurücksetzen, sobald sich der sichtbare Listenumfang ändert.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [selectedMonth, selectedYear, payerFilter]);

  // Task #1473: Pipeline-Chip → passender Tab + geteilter Status-Filter.
  const handleStageSelect = (selection: PipelineStageSelection) => {
    setStatusFilter(selection.status);
    setActiveTab(selection.tab);
  };

  const handleToggleSelect = (invoiceId: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(invoiceId);
      else next.delete(invoiceId);
      return next;
    });
  };

  const handleToggleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(new Set((visibleInvoices ?? []).map((inv) => inv.id)));
    } else {
      setSelectedIds(new Set());
    }
  };

  // Task #1630: „Nach Status auswählen" — alle Rechnungen eines Handlungs-
  // Clusters auf einmal auswählen/abwählen.
  const handleToggleSelectCluster = (ids: number[], checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
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
    entwurf: "Auf Entwurf zurücksetzen",
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

      <MissingSignaturesCard />

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
              onClick={() => { setGenerateAllProgress(null); setGenerateAllOpen(true); }}
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
          </div>

          <PendingInvoicesCard
            customers={customers}
            isLoading={customersLoading}
            onCreateForCustomer={handleCreateForCustomer}
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
            onStorno={setStornoTarget}
            onMarkPaid={setMarkPaidTarget}
            selectedIds={selectedIds}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onToggleSelectCluster={handleToggleSelectCluster}
            onBulkDelete={() => setPendingBulkAction({ type: "delete" })}
            onBulkStatus={(status) => setPendingBulkAction({ type: "status", status })}
            onBulkLexwareExport={handleBulkLexwareExport}
            lexwareExportPending={lexwareExportMutation.isPending}
            onBulkPrintSelection={handleBulkPrintSelection}
            bulkPrintPending={bulkPrintPreviewMutation.isPending}
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
        setOpen={setGenerateAllOpen}
        generateAllProgress={generateAllProgress}
        setGenerateAllProgress={setGenerateAllProgress}
        generateAllMutation={generateAllMutation}
        customers={customers}
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
