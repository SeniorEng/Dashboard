import type { TimeEntry } from "@/lib/api/types";
import type { AppointmentWithCustomer } from "@shared/types";

export type TimelineItem =
  | { type: "appointment"; sortTime: string; data: AppointmentWithCustomer }
  | { type: "entry"; sortTime: string; data: TimeEntry };
