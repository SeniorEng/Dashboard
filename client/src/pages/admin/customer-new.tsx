import { Link } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import {
  ArrowLeft,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Check,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { DraftDialog, DuplicateDialog } from "./components/wizard-dialogs";
import { WizardStepRenderer } from "./components/wizard-step-renderer";
import { useCustomerWizard } from "./hooks/use-customer-wizard";

export default function AdminCustomerNew() {
  const wizard = useCustomerWizard();

  return (
    <Layout variant="admin">
      <DraftDialog
        draftDialog={wizard.draftDialog}
        onRestore={wizard.restoreDraft}
        onDiscard={wizard.discardDraft}
      />

      <DuplicateDialog
        duplicateWarning={wizard.duplicateWarning}
        onContinue={wizard.handleDuplicateContinue}
        onCancel={wizard.handleDuplicateCancel}
      />

      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin/customers">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <h1 className={componentStyles.pageTitle}>Neuen Kunden anlegen</h1>
      </div>

      <div className="mb-6">
        <div className="flex items-center gap-2 mb-3 justify-center">
          <span className="text-sm font-semibold text-teal-700">
            {wizard.steps[wizard.currentStep].title}
          </span>
          <span className="text-xs text-gray-500">
            ({wizard.currentStep + 1}/{wizard.steps.length})
          </span>
        </div>
        <div className="flex items-center justify-center gap-2">
          {wizard.steps.map((step, index) => {
            const isActive = index === wizard.currentStep;
            const isCompleted = index < wizard.currentStep;
            return (
              <div
                key={step.id}
                className={`rounded-full transition-all ${
                  isActive
                    ? "w-8 h-2 bg-teal-600"
                    : isCompleted
                    ? "w-2 h-2 bg-teal-600"
                    : "w-2 h-2 bg-gray-300"
                }`}
                title={step.title}
              />
            );
          })}
        </div>
      </div>

      <Card className="bg-white">
        <CardContent className="p-6">
          <WizardStepRenderer
            currentStepId={wizard.currentStepId}
            formData={wizard.formData}
            phoneErrors={wizard.phoneErrors}
            insuranceOptions={wizard.insuranceOptions}
            insuranceProvidersEmpty={!wizard.insuranceProviders?.length}
            insuranceProviders={wizard.insuranceProviders}
            customerSignatures={wizard.customerSignatures}
            uploadedDocuments={wizard.uploadedDocuments}
            handleChange={wizard.handleChange}
            handleBillingTypeChange={wizard.handleBillingTypeChange}
            handleInsuranceProviderCreated={wizard.handleInsuranceProviderCreated}
            handleContactChange={wizard.handleContactChange}
            handleAddContact={wizard.handleAddContact}
            handleRemoveContact={wizard.handleRemoveContact}
            handleBudgetTypeToggle={wizard.handleBudgetTypeToggle}
            handleBudgetTypeLimitChange={wizard.handleBudgetTypeLimitChange}
            handleSignatureChange={wizard.handleSignatureChange}
            handleUploadedDocumentsChange={wizard.handleUploadedDocumentsChange}
          />

          <div className="flex justify-between mt-8 pt-4 border-t">
            <Button
              variant="outline"
              onClick={wizard.handleBack}
              disabled={wizard.currentStep === 0}
              data-testid="button-step-back"
            >
              <ChevronLeft className={`${iconSize.sm} mr-2`} />
              Zurück
            </Button>

            {wizard.currentStep === wizard.steps.length - 1 ? (
              <Button
                className="bg-teal-600 hover:bg-teal-700"
                onClick={wizard.handleSubmit}
                disabled={wizard.createMutation.isPending}
                data-testid="button-submit"
              >
                {wizard.createMutation.isPending ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Erstellen...
                  </>
                ) : (
                  <>
                    Kunde erstellen
                    <Check className={`${iconSize.sm} ml-2`} />
                  </>
                )}
              </Button>
            ) : (
              <Button
                className="bg-teal-600 hover:bg-teal-700"
                onClick={wizard.handleNext}
                disabled={wizard.duplicateChecking}
                data-testid="button-step-next"
              >
                {wizard.duplicateChecking ? (
                  <>
                    Prüfe...
                    <Loader2 className={`${iconSize.sm} ml-2 animate-spin`} />
                  </>
                ) : (
                  <>
                    Weiter
                    <ChevronRight className={`${iconSize.sm} ml-2`} />
                  </>
                )}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </Layout>
  );
}
