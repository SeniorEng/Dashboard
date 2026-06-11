import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Layout } from "@/components/layout";
import {
  ArrowLeft,
  Loader2,
  ChevronRight,
  ChevronLeft,
  Check,
  ListChecks,
  LayoutList,
} from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import {
  isPflegekasseCustomer,
  PFLEGEGRAD_SELECT_OPTIONS,
} from "@shared/domain/customers";
import { DraftDialog, DuplicateDialog } from "@/features/customers/components/wizard/wizard-dialogs";
import { WizardStepRenderer } from "@/features/customers/components/wizard/wizard-step-renderer";
import { CustomerTypeStep } from "@/features/customers/components/wizard/customer-type-step";
import { PersonalDataStep } from "@/features/customers/components/wizard/personal-data-step";
import { ContactsStep } from "@/features/customers/components/wizard/contacts-step";
import { useCustomerWizard } from "@/features/customers/hooks/use-customer-wizard";

export default function AdminCustomerNew() {
  const wizard = useCustomerWizard();
  // Task #1177 — Minimal-Create ist der Standard. Über den Umschalter wird der
  // vollständige Schritt-für-Schritt-Wizard in derselben Seite sichtbar (hält
  // u.a. den §45b-Anlage-Override + dessen Smoke-Test am Leben).
  const [showAllSteps, setShowAllSteps] = useState(false);

  const isPflegekasse = isPflegekasseCustomer(wizard.formData.billingType);

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

      {showAllSteps ? (
        <>
          <div className="mb-4 flex justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowAllSteps(false)}
              data-testid="button-toggle-minimal"
            >
              <ListChecks className={`${iconSize.sm} mr-2`} />
              Schnellanlage
            </Button>
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
        </>
      ) : (
        <Card className="bg-white">
          <CardContent className="p-6 space-y-8">
            <p className="text-sm text-gray-500" data-testid="text-minimal-hint">
              Lege den Kunden mit den wichtigsten Stammdaten an. Versicherung,
              Vertrag, Budgets, Mitarbeiter-Zuordnung und Dokumente kannst du
              danach jederzeit über die Anlage-Checkliste auf der Kundenseite
              ergänzen.
            </p>

            <CustomerTypeStep
              selectedType={wizard.formData.billingType}
              onChange={wizard.handleBillingTypeChange}
            />

            {isPflegekasse && (
              <div className="space-y-2 max-w-xs">
                <Label htmlFor="pflegegrad-minimal">Pflegegrad *</Label>
                <Select
                  value={wizard.formData.pflegegrad}
                  onValueChange={(value) => wizard.handleChange("pflegegrad", value)}
                >
                  <SelectTrigger
                    id="pflegegrad-minimal"
                    data-testid="select-pflegegrad-minimal"
                  >
                    <SelectValue placeholder="Bitte wählen" />
                  </SelectTrigger>
                  <SelectContent>
                    {PFLEGEGRAD_SELECT_OPTIONS.map((opt) => (
                      <SelectItem key={opt.value} value={opt.value}>
                        {opt.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <PersonalDataStep
              formData={wizard.formData}
              phoneErrors={wizard.phoneErrors}
              onChange={wizard.handleChange}
            />

            <div className="border-t pt-6">
              <h3 className="text-sm font-semibold text-gray-700 mb-3">
                Weitere Kontaktpersonen (optional)
              </h3>
              <ContactsStep
                contacts={wizard.formData.contacts}
                phoneErrors={wizard.phoneErrors}
                onContactChange={wizard.handleContactChange}
                onAddContact={wizard.handleAddContact}
                onRemoveContact={wizard.handleRemoveContact}
              />
            </div>

            <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 pt-4 border-t">
              <Button
                variant="ghost"
                onClick={() => setShowAllSteps(true)}
                data-testid="button-toggle-all-steps"
              >
                <LayoutList className={`${iconSize.sm} mr-2`} />
                Alle Schritte anzeigen
              </Button>

              <Button
                className="bg-teal-600 hover:bg-teal-700"
                onClick={wizard.handleEarlyCreate}
                disabled={!wizard.canCreateEarly || wizard.createMutation.isPending}
                data-testid="button-create-minimal"
              >
                {wizard.createMutation.isPending ? (
                  <>
                    <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
                    Erstellen...
                  </>
                ) : (
                  <>
                    Kunde anlegen
                    <Check className={`${iconSize.sm} ml-2`} />
                  </>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </Layout>
  );
}
