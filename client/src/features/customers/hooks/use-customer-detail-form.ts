import { useState, useCallback, useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { invalidateRelated } from "@/lib/query-invalidation";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { formatPhoneForDisplay, validateGermanPhone, formatPhoneAsYouType } from "@shared/utils/phone";
import { todayISO } from "@shared/utils/datetime";
import type { Customer, CustomerContact } from "@shared/schema";

interface CustomerDetails {
  contacts: CustomerContact[];
  insurance: {
    providerName: string;
    ikNummer?: string;
    versichertennummer: string;
  } | null;
  contract: {
    vereinbarteLeistungen: string | null;
    contractStart: string;
    status: string;
  } | null;
}

export type EditSection = "contact" | "pflegegrad" | "pet" | "medical" | "services" | "emergencyContacts" | null;

const emptyContactForm = { vorname: "", nachname: "", festnetz: "", mobilnummer: "", email: "", contactType: "sonstige" as string, isPrimary: false, notes: "" };

export type EmergencyContactFormType = typeof emptyContactForm;

export function useCustomerDetailForm(
  customerId: number | null,
  customer: Customer | undefined,
  details: CustomerDetails | undefined,
) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [editingSection, setEditingSection] = useState<EditSection>(null);

  const [contactForm, setContactForm] = useState({
    strasse: "", nr: "", plz: "", stadt: "",
    telefon: "", festnetz: "", email: "",
  });

  const [pflegegradForm, setPflegegradForm] = useState({ pflegegrad: "1", seitDatum: todayISO() });

  const [petForm, setPetForm] = useState({ haustierVorhanden: false, haustierDetails: "" });

  const [medicalForm, setMedicalForm] = useState("");

  const [servicesForm, setServicesForm] = useState("");

  const [editingContactId, setEditingContactId] = useState<number | null>(null);
  const [emergencyContactForm, setEmergencyContactForm] = useState(emptyContactForm);
  const [showAddContact, setShowAddContact] = useState(false);

  const [contactFormErrors, setContactFormErrors] = useState<Record<string, string>>({});
  const [emergencyFormErrors, setEmergencyFormErrors] = useState<Record<string, string>>({});
  const [plzLoading, setPlzLoading] = useState(false);
  const plzTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const validatePhone = useCallback((value: string, field: string): string | null => {
    if (!value || value.trim() === "") return null;
    const result = validateGermanPhone(value);
    return result.valid ? null : result.error;
  }, []);

  const validateEmail = useCallback((value: string): string | null => {
    if (!value || value.trim() === "") return null;
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(value.trim()) ? null : "Ungültige E-Mail-Adresse";
  }, []);

  const validatePlz = useCallback((value: string): string | null => {
    if (!value || value.trim() === "") return null;
    return /^\d{5}$/.test(value) ? null : "PLZ muss 5 Ziffern haben";
  }, []);

  const lastAutoFilledStadt = useRef<string>("");

  useEffect(() => {
    if (editingSection !== "contact") return;
    const plz = contactForm.plz;
    if (!plz || plz.length !== 5 || !/^\d{5}$/.test(plz)) return;
    const currentStadt = contactForm.stadt?.trim() || "";
    if (currentStadt !== "" && currentStadt !== lastAutoFilledStadt.current) return;

    if (plzTimeoutRef.current) clearTimeout(plzTimeoutRef.current);
    plzTimeoutRef.current = setTimeout(async () => {
      setPlzLoading(true);
      try {
        const result = await api.get<{ results: string[] }>(`/public/plz/${plz}`);
        if (result.success && result.data.results?.length === 1) {
          lastAutoFilledStadt.current = result.data.results[0];
          setContactForm(f => ({ ...f, stadt: result.data.results[0] }));
        }
      } catch {}
      setPlzLoading(false);
    }, 400);
    return () => { if (plzTimeoutRef.current) clearTimeout(plzTimeoutRef.current); };
  }, [contactForm.plz, editingSection]);

  const startEditing = useCallback((section: EditSection) => {
    if (!customer) return;
    if (editingSection && editingSection !== section) {
      if (!confirm("Du hast ungespeicherte Änderungen. Trotzdem wechseln?")) return;
    }
    if (section === "contact") {
      setContactForm({
        strasse: customer.strasse || "",
        nr: customer.nr || "",
        plz: customer.plz || "",
        stadt: customer.stadt || "",
        telefon: customer.telefon ? formatPhoneForDisplay(customer.telefon) : "",
        festnetz: customer.festnetz ? formatPhoneForDisplay(customer.festnetz) : "",
        email: customer.email || "",
      });
      setContactFormErrors({});
    } else if (section === "pflegegrad") {
      setPflegegradForm({
        pflegegrad: String(customer.pflegegrad || 1),
        seitDatum: todayISO(),
      });
    } else if (section === "pet") {
      setPetForm({
        haustierVorhanden: customer.haustierVorhanden ?? false,
        haustierDetails: customer.haustierDetails || "",
      });
    } else if (section === "medical") {
      setMedicalForm(customer.vorerkrankungen || "");
    } else if (section === "services") {
      setServicesForm(details?.contract?.vereinbarteLeistungen || "");
    }
    setEditingSection(section);
  }, [customer, details, editingSection]);

  const cancelEditing = useCallback(() => { setEditingSection(null); setContactFormErrors({}); }, []);

  const updateCustomerMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const result = await api.patch(`/customers/${customerId}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      setEditingSection(null);
      toast({ title: "Kundendaten aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateCareLevelMutation = useMutation({
    mutationFn: async (data: { pflegegrad: number; seitDatum: string }) => {
      const result = await api.post(`/customers/${customerId}/care-level`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      setEditingSection(null);
      toast({ title: "Pflegegrad aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateContractMutation = useMutation({
    mutationFn: async (data: { vereinbarteLeistungen: string | null }) => {
      const result = await api.patch(`/customers/${customerId}/contract`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      setEditingSection(null);
      toast({ title: "Vereinbarte Leistungen aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const handleSaveContact = useCallback(() => {
    const errors: Record<string, string> = {};
    const telefonErr = validatePhone(contactForm.telefon, "telefon");
    if (telefonErr) errors.telefon = telefonErr;
    const festnetzErr = validatePhone(contactForm.festnetz, "festnetz");
    if (festnetzErr) errors.festnetz = festnetzErr;
    const emailErr = validateEmail(contactForm.email);
    if (emailErr) errors.email = emailErr;
    const plzErr = validatePlz(contactForm.plz);
    if (plzErr) errors.plz = plzErr;
    if (Object.keys(errors).length > 0) {
      setContactFormErrors(errors);
      return;
    }
    setContactFormErrors({});
    updateCustomerMutation.mutate({
      strasse: contactForm.strasse || undefined,
      nr: contactForm.nr || undefined,
      plz: contactForm.plz || undefined,
      stadt: contactForm.stadt || undefined,
      telefon: contactForm.telefon?.trim() || null,
      festnetz: contactForm.festnetz?.trim() || null,
      email: contactForm.email?.trim() || null,
    });
  }, [contactForm, updateCustomerMutation, validatePhone, validateEmail, validatePlz]);

  const handleSavePflegegrad = useCallback(() => {
    updateCareLevelMutation.mutate({
      pflegegrad: parseInt(pflegegradForm.pflegegrad),
      seitDatum: pflegegradForm.seitDatum,
    });
  }, [pflegegradForm, updateCareLevelMutation]);

  const handleSavePet = useCallback(() => {
    updateCustomerMutation.mutate({
      haustierVorhanden: petForm.haustierVorhanden,
      haustierDetails: petForm.haustierVorhanden ? (petForm.haustierDetails || null) : null,
    });
  }, [petForm, updateCustomerMutation]);

  const handleSaveMedical = useCallback(() => {
    updateCustomerMutation.mutate({ vorerkrankungen: medicalForm || null });
  }, [medicalForm, updateCustomerMutation]);

  const handleSaveServices = useCallback(() => {
    updateContractMutation.mutate({ vereinbarteLeistungen: servicesForm || null });
  }, [servicesForm, updateContractMutation]);

  const addContactMutation = useMutation({
    mutationFn: async (data: Omit<EmergencyContactFormType, 'festnetz' | 'mobilnummer'> & { festnetz: string | null; mobilnummer: string | null }) => {
      const result = await api.post(`/customers/${customerId}/contacts`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      setShowAddContact(false);
      setEmergencyContactForm(emptyContactForm);
      toast({ title: "Notfallkontakt hinzugefügt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateContactMutation = useMutation({
    mutationFn: async ({ contactId, data }: { contactId: number; data: Partial<Omit<EmergencyContactFormType, 'festnetz' | 'mobilnummer'> & { festnetz: string | null; mobilnummer: string | null }> }) => {
      const result = await api.patch(`/customers/${customerId}/contacts/${contactId}`, data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      setEditingContactId(null);
      setEmergencyContactForm(emptyContactForm);
      toast({ title: "Notfallkontakt aktualisiert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const deleteContactMutation = useMutation({
    mutationFn: async (contactId: number) => {
      const result = await api.delete(`/customers/${customerId}/contacts/${contactId}`);
      return unwrapResult(result);
    },
    onSuccess: () => {
      invalidateRelated(queryClient, "customers");
      toast({ title: "Notfallkontakt entfernt" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const startEditContact = useCallback((contact: CustomerContact) => {
    if (editingSection) {
      if (!confirm("Du hast ungespeicherte Änderungen. Trotzdem wechseln?")) return;
      setEditingSection(null);
      setContactFormErrors({});
    }
    setEditingContactId(contact.id);
    setEmergencyContactForm({
      vorname: contact.vorname,
      nachname: contact.nachname,
      festnetz: contact.festnetz ? formatPhoneForDisplay(contact.festnetz) : "",
      mobilnummer: contact.mobilnummer ? formatPhoneForDisplay(contact.mobilnummer) : "",
      email: contact.email || "",
      contactType: contact.contactType,
      isPrimary: contact.isPrimary ?? false,
      notes: contact.notes || "",
    });
    setEmergencyFormErrors({});
    setShowAddContact(false);
  }, [editingSection]);

  const cancelEditContact = useCallback(() => {
    setEditingContactId(null);
    setShowAddContact(false);
    setEmergencyContactForm(emptyContactForm);
    setEmergencyFormErrors({});
  }, []);

  const handleSaveEmergencyContact = useCallback(() => {
    const errors: Record<string, string> = {};
    if (emergencyContactForm.festnetz?.trim()) {
      const festnetzErr = validatePhone(emergencyContactForm.festnetz, "festnetz");
      if (festnetzErr) errors.festnetz = festnetzErr;
    }
    if (emergencyContactForm.mobilnummer?.trim()) {
      const mobilErr = validatePhone(emergencyContactForm.mobilnummer, "mobilnummer");
      if (mobilErr) errors.mobilnummer = mobilErr;
    }
    const emailErr = validateEmail(emergencyContactForm.email);
    if (emailErr) errors.email = emailErr;
    if (Object.keys(errors).length > 0) {
      setEmergencyFormErrors(errors);
      return;
    }
    setEmergencyFormErrors({});
    const payload = {
      ...emergencyContactForm,
      festnetz: emergencyContactForm.festnetz?.trim() || null,
      mobilnummer: emergencyContactForm.mobilnummer?.trim() || null,
      email: emergencyContactForm.email?.trim() || "",
      notes: emergencyContactForm.notes?.trim() || "",
    };
    if (editingContactId) {
      updateContactMutation.mutate({ contactId: editingContactId, data: payload });
    } else {
      addContactMutation.mutate(payload);
    }
  }, [editingContactId, emergencyContactForm, updateContactMutation, addContactMutation, validatePhone, validateEmail]);

  const contactSaving = addContactMutation.isPending || updateContactMutation.isPending || deleteContactMutation.isPending;

  const isSaving = updateCustomerMutation.isPending || updateCareLevelMutation.isPending || updateContractMutation.isPending || contactSaving;

  const handleStartAddContact = useCallback(() => {
    if (editingSection) {
      if (!confirm("Du hast ungespeicherte Änderungen. Trotzdem wechseln?")) return;
      setEditingSection(null);
      setContactFormErrors({});
    }
    setShowAddContact(true);
    setEmergencyContactForm(emptyContactForm);
    setEmergencyFormErrors({});
  }, [editingSection]);

  return {
    editingSection,
    startEditing,
    cancelEditing,

    contactForm,
    setContactForm,
    contactFormErrors,
    setContactFormErrors,
    handleSaveContact,
    plzLoading,

    pflegegradForm,
    setPflegegradForm,
    handleSavePflegegrad,

    petForm,
    setPetForm,
    handleSavePet,

    medicalForm,
    setMedicalForm,
    handleSaveMedical,

    servicesForm,
    setServicesForm,
    handleSaveServices,

    emergencyContactForm,
    setEmergencyContactForm,
    emergencyFormErrors,
    setEmergencyFormErrors,
    editingContactId,
    showAddContact,
    setShowAddContact,
    startEditContact,
    cancelEditContact,
    handleSaveEmergencyContact,
    handleStartAddContact,
    deleteContactMutation,

    isSaving,
    contactSaving,
    validatePhone,
    validateEmail,
  };
}
