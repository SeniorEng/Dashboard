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
import { DraftDialog, DuplicateDialog } from "@/features/customers/components/wizard/wizard-dialogs";
import { WizardStepRenderer } from "@/features/customers/components/wizard/wizard-step-renderer";
import { useCustomerWizard } from "@/features/customers/hooks/use-customer-wizard";

export default function AdminCustomerNew() {
  const wizard = useCustomerWizard();
  const isLastStep = wizard.currentStep === wizard.steps.length - 1;
  // Task #1282 — „Weiter" wird disabled, sobald der aktuelle Schritt
  // Validierungsfehler hat (SSoT `getStepErrors`), statt erst beim Klick einen
  // Toast zu werfen. Die Fehlerliste dient zusätzlich als sichtbares Feedback.
  const stepErrors = isLastStep ? [] : wizard.getStepErrors(wizard.currentStepId);
  const nextDisabled = wizard.duplicateChecking || stepErrors.length > 0;

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
        onOpenExisting={wizard.handleDuplicateOpenExisting}
      />

      <div className="flex items-center gap-4 mb-6">
        <Button
          variant="ghost"
          size="icon"
          aria-label="Zurück"
          data-testid="button-back"
          onClick={wizard.handleCancel}
        >
          <ArrowLeft className={iconSize.md} />
        </Button>
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

            {isLastStep ? (
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
                disabled={nextDisabled}
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

          {!isLastStep && stepErrors.length > 0 && (
            <div
              className="mt-3 text-sm text-red-600"
              role="alert"
              data-testid="text-step-errors"
            >
              <span className="font-medium">
                Bitte vor dem Fortfahren korrigieren:
              </span>
              <ul className="list-disc list-inside mt-1">
                {stepErrors.map((err, i) => (
                  <li key={i} data-testid={`text-step-error-${i}`}>
                    {err}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </CardContent>
      </Card>
    </Layout>
  );
}
