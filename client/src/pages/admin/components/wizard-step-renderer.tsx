import { isPflegekasseCustomer } from "@shared/domain/customers";
import { CustomerTypeStep } from "./customer-type-step";
import { PersonalDataStep } from "./personal-data-step";
import { InsuranceStep } from "./insurance-step";
import { ContactsStep } from "./contacts-step";
import { BudgetsStep, ContractStep } from "./budgets-contract-step";
import { SignaturesStep, type WizardUploadedDoc } from "./signatures-step";
import { MatchingStep } from "./matching-step";
import { DeliveryStep } from "./delivery-step";
import type { CustomerFormData, ContactFormData, BudgetTypeSettingForm } from "./customer-types";
import type { BudgetType } from "@shared/domain/budgets";
import type { BillingType } from "@shared/domain/customers";

interface WizardStepRendererProps {
  currentStepId: string;
  formData: CustomerFormData;
  phoneErrors: Record<string, string | null>;
  insuranceOptions: Array<{ value: string; label: string; sublabel: string }>;
  insuranceProvidersEmpty: boolean;
  customerSignatures: Record<string, string>;
  uploadedDocuments: WizardUploadedDoc[];
  handleChange: (field: string, value: string | boolean) => void;
  handleBillingTypeChange: (type: BillingType) => void;
  handleInsuranceProviderCreated: (providerId: string) => void;
  handleContactChange: (index: number, field: keyof ContactFormData, value: string | boolean) => void;
  handleAddContact: () => void;
  handleRemoveContact: (index: number) => void;
  handleBudgetTypeToggle: (budgetType: BudgetType, enabled: boolean) => void;
  handleBudgetTypeLimitChange: (budgetType: BudgetType, field: "monthlyLimitCents" | "yearlyLimitCents", value: string) => void;
  handleSignatureChange: (slug: string, signatureData: string, location?: string | null) => void;
  handleUploadedDocumentsChange: (docs: WizardUploadedDoc[]) => void;
}

export function WizardStepRenderer({ currentStepId, formData, phoneErrors, insuranceOptions, insuranceProvidersEmpty, customerSignatures, uploadedDocuments, handleChange, handleBillingTypeChange, handleInsuranceProviderCreated, handleContactChange, handleAddContact, handleRemoveContact, handleBudgetTypeToggle, handleBudgetTypeLimitChange, handleSignatureChange, handleUploadedDocumentsChange }: WizardStepRendererProps) {
  switch (currentStepId) {
    case "customerType":
      return (
        <CustomerTypeStep
          selectedType={formData.billingType}
          onChange={handleBillingTypeChange}
        />
      );
    case "personal":
      return (
        <PersonalDataStep
          formData={formData}
          phoneErrors={phoneErrors}
          onChange={handleChange}
        />
      );
    case "insurance":
      return (
        <InsuranceStep
          formData={formData}
          insuranceOptions={insuranceOptions}
          insuranceProvidersEmpty={insuranceProvidersEmpty}
          onChange={handleChange}
          onInsuranceProviderCreated={handleInsuranceProviderCreated}
        />
      );
    case "contacts":
      return (
        <ContactsStep
          contacts={formData.contacts}
          phoneErrors={phoneErrors}
          onContactChange={handleContactChange}
          onAddContact={handleAddContact}
          onRemoveContact={handleRemoveContact}
        />
      );
    case "budgets":
      return (
        <BudgetsStep
          formData={formData}
          onChange={handleChange}
          onBudgetTypeToggle={handleBudgetTypeToggle}
          onBudgetTypeLimitChange={handleBudgetTypeLimitChange}
          pflegegrad={formData.pflegegrad ? parseInt(formData.pflegegrad) : null}
        />
      );
    case "contract":
      return (
        <ContractStep
          formData={formData}
          onChange={handleChange}
          showGrossPrices={!isPflegekasseCustomer(formData.billingType)}
        />
      );
    case "signatures":
      return (
        <SignaturesStep
          billingType={formData.billingType}
          customerSignatures={customerSignatures}
          onSignatureChange={handleSignatureChange}
          uploadedDocuments={uploadedDocuments}
          onUploadedDocumentsChange={handleUploadedDocumentsChange}
          formData={formData}
        />
      );
    case "delivery":
      return (
        <DeliveryStep
          formData={formData}
          onChange={handleChange}
        />
      );
    case "matching":
      return (
        <MatchingStep
          formData={formData}
          onChange={handleChange}
        />
      );
    default:
      return null;
  }
}
