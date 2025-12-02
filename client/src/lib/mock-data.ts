import { Divide, Home, MapPin, Clock, Calendar, User, CheckCircle, PenTool } from "lucide-react";

export type AppointmentType = "First Visit" | "Customer Appointment" | "Hauswirtschaft" | "Alltagsbegleitung";

export interface Customer {
  id: string;
  name: string;
  address: string;
  avatar: string;
  needs: string[];
}

export interface Appointment {
  id: string;
  customerId: string;
  customer: Customer;
  type: AppointmentType;
  date: string; // ISO date
  time: string; // HH:mm
  durationPromised: number; // minutes
  status: "scheduled" | "in-progress" | "documenting" | "completed";
  notes?: string;
}

export const MOCK_CUSTOMERS: Record<string, Customer> = {
  "c1": {
    id: "c1",
    name: "Gerda Müller",
    address: "Lindenstraße 42, 10969 Berlin",
    avatar: "lady",
    needs: ["Mobility assistance", "Medication reminder"]
  },
  "c2": {
    id: "c2",
    name: "Hans Schmidt",
    address: "Bergmannstraße 12, 10961 Berlin",
    avatar: "man",
    needs: ["Companionship", "Light housekeeping"]
  },
  "c3": {
    id: "c3",
    name: "Elfriede Weber",
    address: "Gneisenaustraße 88, 10961 Berlin",
    avatar: "lady",
    needs: ["Grocery shopping", "Cooking help"]
  }
};

export const MOCK_APPOINTMENTS: Appointment[] = [
  {
    id: "a1",
    customerId: "c1",
    customer: MOCK_CUSTOMERS["c1"],
    type: "Customer Appointment",
    date: new Date().toISOString().split('T')[0],
    time: "09:00",
    durationPromised: 45,
    status: "completed"
  },
  {
    id: "a2",
    customerId: "c2",
    customer: MOCK_CUSTOMERS["c2"],
    type: "Alltagsbegleitung",
    date: new Date().toISOString().split('T')[0],
    time: "11:30",
    durationPromised: 60,
    status: "in-progress"
  },
  {
    id: "a3",
    customerId: "c3",
    customer: MOCK_CUSTOMERS["c3"],
    type: "Hauswirtschaft",
    date: new Date().toISOString().split('T')[0],
    time: "14:00",
    durationPromised: 90,
    status: "scheduled"
  },
  {
    id: "a4",
    customerId: "c1",
    customer: MOCK_CUSTOMERS["c1"],
    type: "First Visit",
    date: new Date().toISOString().split('T')[0],
    time: "16:30",
    durationPromised: 60,
    status: "scheduled"
  }
];
