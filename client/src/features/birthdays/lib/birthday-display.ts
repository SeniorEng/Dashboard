import type { BirthdayEntry } from "@shared/types";

export interface EnrichedBirthday extends BirthdayEntry {
  birthdayYear: number;
  cardSent: boolean;
  cardSentAt: string | null;
}

/**
 * Bestimmt das Kalenderjahr, in dem dieser Geburtstag stattfindet.
 *
 * - Bei `daysUntil >= 0` (Geburtstag heute oder in der Zukunft) wird das Jahr
 *   aus `today + daysUntil` abgeleitet.
 * - Bei `daysUntil < 0` (Geburtstag lag in den letzten Tagen) ist es das
 *   aktuelle Kalenderjahr — der Geburtstag fand bereits in diesem Jahr statt.
 */
export function getBirthdayYear(entry: Pick<BirthdayEntry, "daysUntil">, today: Date = new Date()): number {
  if (entry.daysUntil < 0) {
    return today.getFullYear();
  }
  const target = new Date(today);
  target.setDate(today.getDate() + entry.daysUntil);
  return target.getFullYear();
}

export function getDaysLabel(days: number): string {
  if (days < 0) {
    const ago = -days;
    return ago === 1 ? "vor 1 Tag" : `vor ${ago} Tagen`;
  }
  if (days === 0) return "Heute";
  if (days === 1) return "Morgen";
  return `in ${days} Tagen`;
}

export function getDaysColor(days: number, cardSent: boolean): string {
  if (cardSent) return "text-green-600";
  if (days < 0) return "text-red-700 font-semibold";
  if (days <= 3) return "text-red-600 font-semibold";
  if (days <= 7) return "text-orange-600 font-medium";
  if (days <= 14) return "text-amber-600";
  return "text-muted-foreground";
}

/**
 * Sortier-Schlüssel: Überfällige (negativ) und nicht versendete zuerst,
 * danach nach `daysUntil` aufsteigend, versendete ans Ende.
 */
export function birthdaySortKey(entry: Pick<EnrichedBirthday, "daysUntil" | "cardSent">): number {
  const overdueUnsent = entry.daysUntil < 0 && !entry.cardSent;
  if (overdueUnsent) return -1_000_000 + entry.daysUntil;
  if (entry.cardSent) return 1_000_000 + entry.daysUntil;
  return entry.daysUntil;
}

export function compareBirthdays(
  a: Pick<EnrichedBirthday, "daysUntil" | "cardSent">,
  b: Pick<EnrichedBirthday, "daysUntil" | "cardSent">,
): number {
  return birthdaySortKey(a) - birthdaySortKey(b);
}

export interface BirthdayStats {
  total: number;
  sent: number;
  pending: number;
  upcoming: number;
  urgent: number;
  overdue: number;
}

export function computeBirthdayStats(entries: EnrichedBirthday[]): BirthdayStats {
  const total = entries.length;
  const sent = entries.filter((b) => b.cardSent).length;
  const upcoming = entries.filter((b) => b.daysUntil >= 0 && b.daysUntil <= 30).length;
  const urgent = entries.filter((b) => b.daysUntil >= 0 && b.daysUntil <= 7 && !b.cardSent).length;
  const overdue = entries.filter((b) => b.daysUntil < 0 && !b.cardSent).length;
  return { total, sent, pending: total - sent, upcoming, urgent, overdue };
}
