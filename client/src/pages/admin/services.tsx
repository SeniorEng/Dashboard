import { Link } from "wouter";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Plus, Calculator } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import {
  useServices,
  useServiceForm,
  useBulkPrices,
  ServiceList,
  ServiceFormDialog,
  BulkPricesDialog,
} from "@/features/services";

export default function AdminServices() {
  const { data: services, isLoading } = useServices();

  const {
    dialogOpen,
    setDialogOpen,
    editingService,
    form,
    openCreate,
    openEdit,
    handleChange,
    toggleBudgetPot,
    handleSave,
    isSaving,
    hasServiceChanges,
  } = useServiceForm();

  const {
    bulkOpen,
    setBulkOpen,
    bulkPrices,
    setBulkPrices,
    bulkPercent,
    setBulkPercent,
    bulkSaving,
    openBulkPrices,
    applyBulkPercent,
    handleBulkSave,
    hasBulkChanges,
  } = useBulkPrices(services);

  return (
    <Layout variant="admin">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/admin">
              <Button variant="ghost" size="icon" className="shrink-0" aria-label="Zurück" data-testid="button-back">
                <ArrowLeft className={iconSize.md} />
              </Button>
            </Link>
            <h1 className={componentStyles.pageTitle}>Dienstleistungskatalog</h1>
          </div>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <p className="text-sm text-gray-600">Leistungen und Standardpreise</p>
            <div className="flex items-center gap-2">
              <Button
                onClick={openBulkPrices}
                variant="outline"
                size="sm"
                disabled={!services || services.length === 0}
                data-testid="button-bulk-prices"
              >
                <Calculator className={`${iconSize.sm} mr-1`} />
                Preise anpassen
              </Button>
              <Button onClick={openCreate} className={componentStyles.btnPrimary} size="sm" data-testid="button-add-service">
                <Plus className={`${iconSize.sm} mr-1`} />
                Neue Dienstleistung
              </Button>
            </div>
          </div>
        </div>

        <ServiceList
          services={services}
          isLoading={isLoading}
          onCreate={openCreate}
          onEdit={openEdit}
        />
      </div>

      <ServiceFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingService={editingService}
        form={form}
        onChange={handleChange}
        onToggleBudgetPot={toggleBudgetPot}
        onSave={handleSave}
        isSaving={isSaving}
        hasServiceChanges={hasServiceChanges}
      />

      <BulkPricesDialog
        open={bulkOpen}
        onOpenChange={(open) => { if (!bulkSaving) setBulkOpen(open); }}
        services={services}
        bulkPrices={bulkPrices}
        setBulkPrices={setBulkPrices}
        bulkPercent={bulkPercent}
        setBulkPercent={setBulkPercent}
        bulkSaving={bulkSaving}
        onApplyBulkPercent={applyBulkPercent}
        onSave={handleBulkSave}
        onCancel={() => setBulkOpen(false)}
        hasBulkChanges={hasBulkChanges}
      />
    </Layout>
  );
}
