import { useState, useRef, useEffect } from "react";
import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { iconSize, componentStyles } from "@/design-system";
import { ArrowLeft } from "lucide-react";
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
  useBillingMutations,
  BillingFiltersCard,
  InvoiceList,
  BulkSendDialog,
  BulkPrintDialog,
  GenerateAllDialog,
  NewInvoiceDialog,
  StornoDialog,
  MarkPaidDialog,
  DiscardDraftsDialog,
} from "@/features/billing";

export default function AdminBilling() {
  const { toast } = useToast();
  const today = new Date();
  const [selectedMonth, setSelectedMonth] = useState(today.getMonth() + 1);
  const [selectedYear, setSelectedYear] = useState(today.getFullYear());
  const [statusFilter, setStatusFilter] = useState("alle");
  // Task #1317: optionaler von–bis-Datumsbereich (ISO yyyy-mm-dd, leer = ganzer
  // Monat). Wirkt server-seitig auf Liste UND Massenerstellung.
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  // Krankenkassen-Filter: "alle" oder die insuranceProviderId als String.
  // Wirkt server-seitig auf Liste, eligible-customers, generate-all und
  // bestimmt zusätzlich die Sichtbarkeit der Bündel-Download-Buttons.
  const [payerFilter, setPayerFilter] = useState<string>("alle");
  // Task #990: Stornos ausblenden — blendet stornierte Rechnungen (Status
  // "storniert") UND Stornorechnungen (Typ "stornorechnung") aus der Liste.
  // Task #996: Standardmäßig aktiv — der Abrechnungs-Alltag dreht sich um
  // offene/aktive Rechnungen; Storno-Belege blähen die Liste nur auf.
  const [hideStornos, setHideStornos] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [expandedInvoiceId, setExpandedInvoiceId] = useState<number | null>(null);
  const [stornoTarget, setStornoTarget] = useState<InvoiceItem | null>(null);
  // Task #1317: Ziel des „Als bezahlt markieren"-Bestätigungsdialogs.
  const [markPaidTarget, setMarkPaidTarget] = useState<InvoiceItem | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [generateAllOpen, setGenerateAllOpen] = useState(false);
  // Task #762/#790: Fokus-Management für den „Schließen"-Button des
  // Massenerstellung-Dialogs. Der zugehörige useEffect steht unten beim
  // `generateAllMutation` (er braucht dessen `isPending`).
  const generateAllCloseBtnRef = useRef<HTMLButtonElement>(null);
  // Task #534: Bulk-Versand-Dialog (typenübergreifend).
  const [bulkSendOpen, setBulkSendOpen] = useState(false);
  // Task #996: Sammeldruck-Dialog (gebündelter PDF/ZIP-Druck der Entwürfe).
  const [bulkPrintOpen, setBulkPrintOpen] = useState(false);

  const currentYear = today.getFullYear();
  const years = Array.from({ length: 5 }, (_, i) => currentYear - 2 + i);

  const { data: invoices, isLoading: invoicesLoading } = useBillingInvoices(
    selectedYear,
    selectedMonth,
    statusFilter,
    payerFilter,
    dateFrom,
    dateTo,
  );

  // Task #990: Client-seitiger Stornos-Filter — entfernt stornierte Rechnungen
  // und Stornorechnungen aus der angezeigten Liste, ohne Server-Filter/Aktionen
  // zu verändern.
  const visibleInvoices = hideStornos
    ? invoices?.filter(
        (inv) => inv.status !== "storniert" && inv.invoiceType !== "stornorechnung",
      )
    : invoices;

  const { data: customers } = useEligibleCustomers(selectedYear, selectedMonth, payerFilter, dateFrom, dateTo);

  const previewCustomerId = selectedCustomerId ? parseInt(selectedCustomerId, 10) : null;
  const {
    data: invoicePreview,
    isLoading: previewLoading,
    isError: previewError,
    error: previewErrorObj,
  } = useInvoicePreview(previewCustomerId, selectedYear, selectedMonth, dialogOpen, dateFrom, dateTo);

  const { data: blockingDrafts } = useBlockingDrafts(
    previewCustomerId,
    selectedYear,
    selectedMonth,
    dialogOpen && previewError,
  );

  const { data: payers } = usePayers(selectedYear, selectedMonth);

  const activePayer = payerFilter !== "alle"
    ? payers?.find((p) => p.insuranceProviderId.toString() === payerFilter) ?? null
    : null;
  const payerSuffix = activePayer ? ` für ${activePayer.name}` : "";

  const { data: expandedDetail, isLoading: detailLoading } = useInvoiceDetail(expandedInvoiceId);
  const { data: deliveryHistory } = useDeliveryHistory(expandedInvoiceId);

  const {
    generateMutation,
    discardDraftsMutation,
    statusMutation,
    sendInvoiceMutation,
    markSentMutation,
    generateAllMutation,
    batchSendMutation,
    bulkSendMutation,
    bulkPrintMutation,
    sendingInvoiceId,
    batchSending,
    generateAllProgress,
    setGenerateAllProgress,
    bulkSendResult,
    setBulkSendResult,
    bulkPrintResult,
    setBulkPrintResult,
  } = useBillingMutations({
    selectedMonth,
    selectedYear,
    statusFilter,
    payerFilter,
    dateFrom,
    dateTo,
    setStatusFilter,
    onGenerateSuccess: () => {
      setDialogOpen(false);
      setSelectedCustomerId("");
    },
    onDiscardSettled: () => setDiscardConfirmOpen(false),
    onStatusSuccess: () => setStornoTarget(null),
  });

  // Task #762 / #790: Wenn der Confirm-Button nach dem Lauf disabled wird,
  // verliert er den Fokus an das <body> — Escape im DialogContent wirkt dann
  // nicht mehr. Wir verschieben den Fokus aktiv auf den „Schließen"-Button im
  // Footer, sobald das Ergebnis da ist UND die Mutation nicht mehr läuft.
  // WICHTIG (#790-Bugfix): Der Schließen-Button ist `disabled`, solange
  // `generateAllMutation.isPending` true ist — ein `.focus()` auf ein disabled
  // Element ist ein No-Op. Früher hing der Effect nur an `generateAllProgress`/
  // `generateAllOpen`; er feuerte damit, während der Button noch disabled war,
  // und lief nach dem Enable nicht erneut → der Fokus landete nie auf dem
  // Button und Escape schloss den Dialog nicht zuverlässig. Deshalb hängt der
  // Effect jetzt zusätzlich an `isPending` und feuert erst, wenn der Button
  // tatsächlich fokussierbar (enabled) ist.
  useEffect(() => {
    if (generateAllProgress && generateAllOpen && !generateAllMutation.isPending) {
      generateAllCloseBtnRef.current?.focus();
    }
  }, [generateAllProgress, generateAllOpen, generateAllMutation.isPending]);

  // Task #1198: Storno-Belege (invoiceType "stornorechnung") sind Gutschriften
  // und dürfen NICHT in die Massen-Versand-/Druck-Zähler bzw. -Mengen wandern —
  // konsistent mit der standardmäßig ausgeblendeten Liste. Sonst behaupten die
  // Buttons z.B. „29 Rechnungen", obwohl die Liste leer ist, und die Massen-
  // Aktionen würden reale Storno-Belege mitverarbeiten. Die Prädikate liegen
  // zentral in @shared/domain/billing-drafts, damit Zähler und verarbeitete
  // Mengen nicht auseinanderdriften.
  const draftPflegekasseInvoices = invoices?.filter(isPflegekasseBatchDraft) || [];

  // Task #534: Alle Entwürfe, die im typenübergreifenden Bulk-Versand
  // verarbeitet werden — Selbstzahler + beide Pflegekassen-Varianten
  // (ohne Storno-Belege, s.o.).
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

  const handleBulkPrint = (groupByPayer: boolean) => {
    if (draftBulkInvoices.length === 0) return;
    bulkPrintMutation.mutate({ groupByPayer });
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
      // Task #1320: Einzel-Pfad respektiert denselben von–bis-Datumsbereich wie
      // die Massenerstellung — leer = ganzer Monat.
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
    });
  };

  const handleToggleDetail = (invoiceId: number) => {
    setExpandedInvoiceId(expandedInvoiceId === invoiceId ? null : invoiceId);
  };

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
          <p className="text-gray-600">Rechnungen erstellen und verwalten</p>
        </div>
      </div>

      <BillingFiltersCard
        selectedMonth={selectedMonth}
        setSelectedMonth={setSelectedMonth}
        selectedYear={selectedYear}
        setSelectedYear={setSelectedYear}
        years={years}
        statusFilter={statusFilter}
        setStatusFilter={setStatusFilter}
        payerFilter={payerFilter}
        setPayerFilter={setPayerFilter}
        dateFrom={dateFrom}
        setDateFrom={setDateFrom}
        dateTo={dateTo}
        setDateTo={setDateTo}
        hideStornos={hideStornos}
        setHideStornos={setHideStornos}
        payers={payers}
        activePayer={activePayer}
        payerSuffix={payerSuffix}
        draftBulkInvoices={draftBulkInvoices}
        draftPflegekasseInvoices={draftPflegekasseInvoices}
        customers={customers}
        batchSending={batchSending}
        onBatchSend={handleBatchSend}
        onOpenBulkSend={() => { setBulkSendResult(null); setBulkSendOpen(true); }}
        onOpenBulkPrint={() => { setBulkPrintResult(null); setBulkPrintOpen(true); }}
        onOpenGenerateAll={() => { setGenerateAllProgress(null); setGenerateAllOpen(true); }}
        onOpenNewInvoice={() => setDialogOpen(true)}
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
      />

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

      <BulkPrintDialog
        open={bulkPrintOpen}
        setOpen={setBulkPrintOpen}
        bulkPrintResult={bulkPrintResult}
        setBulkPrintResult={setBulkPrintResult}
        bulkPrintMutation={bulkPrintMutation}
        draftBulkInvoices={draftBulkInvoices}
        invoices={invoices}
        onBulkPrint={handleBulkPrint}
        selectedMonth={selectedMonth}
        selectedYear={selectedYear}
        payerSuffix={payerSuffix}
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
