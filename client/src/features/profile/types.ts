export interface ProfileData {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  telefon: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plz: string | null;
  stadt: string | null;
  geburtsdatum: string | null;
  eintrittsdatum: string | null;
  haustierAkzeptiert: boolean;
  notfallkontaktName: string | null;
  notfallkontaktTelefon: string | null;
  notfallkontaktBeziehung: string | null;
  roles: string[];
}

export interface WhatsAppPrefs {
  enabled: boolean;
  whatsappNumber: string | null;
}

export interface ProofItem {
  id: number;
  qualificationId: number | null;
  documentTypeId: number;
  status: string;
  fileName: string | null;
  objectPath: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  rejectionReason: string | null;
  documentType: { id: number; name: string };
  qualification: { id: number; name: string } | null;
}
