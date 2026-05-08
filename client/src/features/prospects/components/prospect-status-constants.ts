import { Phone, PhoneCall, Mail, MessageSquare, ArrowRightCircle } from "lucide-react";
import type { ProspectStatus, ProspectNoteType } from "@shared/schema";

export const STATUS_COLORS: Record<ProspectStatus, string> = {
  neu: "bg-blue-100 text-blue-800",
  kontaktiert: "bg-amber-100 text-amber-800",
  wiedervorlage: "bg-purple-100 text-purple-800",
  qualifiziert: "bg-teal-100 text-teal-800",
  disqualifiziert: "bg-red-100 text-red-800",
  erstberatung_vereinbart: "bg-cyan-100 text-cyan-800",
  erstberatung_durchgeführt: "bg-emerald-100 text-emerald-800",
  gewonnen: "bg-green-100 text-green-800",
  nicht_interessiert: "bg-gray-100 text-gray-800",
};

export const NOTE_TYPE_ICONS: Record<ProspectNoteType, typeof Phone> = {
  anruf: PhoneCall,
  email: Mail,
  notiz: MessageSquare,
  statuswechsel: ArrowRightCircle,
};
