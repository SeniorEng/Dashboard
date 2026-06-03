import { formatDateISO, addDaysToDate } from "@shared/utils/datetime";

export function getDefaultDateForMonth(year: number, month: number): string {
  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  if (year === todayYear && month === todayMonth) {
    return formatDateISO(today);
  }
  const firstOfMonth = new Date(year, month - 1, 1);
  const dayOfWeek = firstOfMonth.getDay();
  const offset = dayOfWeek === 0 ? 1 : dayOfWeek === 6 ? 2 : 0;
  const targetDate = addDaysToDate(firstOfMonth, offset);
  return formatDateISO(targetDate);
}
