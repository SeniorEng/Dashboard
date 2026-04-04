export interface BirthdayEntry {
  id: number;
  type: "employee" | "customer";
  name: string;
  geburtsdatum: string;
  daysUntil: number;
  age: number;
  address?: string;
  cardSent?: boolean;
  cardSentAt?: string | null;
}
