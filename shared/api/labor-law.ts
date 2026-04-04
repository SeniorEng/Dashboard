export interface MissingBreakDay {
  date: string;
  totalWorkMinutes: number;
  requiredBreakMinutes: number;
  documentedBreakMinutes: number;
}

export interface OpenTasksSummary {
  daysWithMissingBreaks: MissingBreakDay[];
}
