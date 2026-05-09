/**
 * Time Entry Conflict Hook
 *
 * Provides real-time validation for time entries:
 * - Client-side time validation via shared `validateTimeRange`
 * - Server-side conflict checking (overlaps, full-day entries)
 *
 * The query is debounced implicitly by TanStack Query's request dedup +
 * `enabled` gating: it fires only once the inputs are valid and stable,
 * and the form submit goes through the same server validation as the
 * source of truth.
 */

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { FULL_DAY_ENTRY_TYPES, validateTimeRange } from "@shared/domain/time-entries";

export interface TimeEntryFormData {
  entryDate: string;
  entryType: string;
  startTime?: string | null;
  endTime?: string | null;
  isFullDay?: boolean;
  excludeEntryId?: number;
  targetUserId?: number | null;
}

interface ConflictCheckResult {
  conflict: string | null;
}

export interface UseTimeEntryConflictResult {
  timeError: string | null;
  conflict: string | null;
  isChecking: boolean;
  hasError: boolean;
}

export function useTimeEntryConflict(
  formData: TimeEntryFormData | null,
  isDialogOpen: boolean
): UseTimeEntryConflictResult {
  const isFullDayType = formData
    ? (FULL_DAY_ENTRY_TYPES as readonly string[]).includes(formData.entryType)
    : false;
  const effectiveIsFullDay = isFullDayType || (formData?.isFullDay ?? false);

  const rangeCheck = formData && !effectiveIsFullDay
    ? validateTimeRange({ startTime: formData.startTime, endTime: formData.endTime })
    : { ok: true as const };
  const timeError = rangeCheck.ok ? null : rangeCheck.message;

  const hasRequiredFields = !!(formData?.entryDate) && (
    effectiveIsFullDay || (!!formData?.startTime && !!formData?.endTime)
  );
  const enabled = isDialogOpen && hasRequiredFields && !timeError;

  const query = useQuery({
    queryKey: [
      "time-entry-conflict",
      formData?.targetUserId ?? null,
      formData?.entryDate ?? null,
      formData?.startTime ?? null,
      formData?.endTime ?? null,
      effectiveIsFullDay,
      formData?.excludeEntryId ?? null,
    ],
    queryFn: async ({ signal }) => {
      const result = await api.post<ConflictCheckResult>(
        "/time-entries/check-conflicts",
        {
          date: formData!.entryDate,
          startTime: formData!.startTime || null,
          endTime: formData!.endTime || null,
          isFullDay: effectiveIsFullDay,
          excludeEntryId: formData!.excludeEntryId,
          ...(formData!.targetUserId ? { targetUserId: formData!.targetUserId } : {}),
        },
        signal,
      );
      return result.success ? result.data.conflict : null;
    },
    enabled,
    staleTime: 10_000,
    gcTime: 30_000,
    retry: false,
  });

  const conflict = enabled ? (query.data ?? null) : null;
  const hasError = !!(timeError || conflict);

  return {
    timeError,
    conflict,
    isChecking: query.isFetching,
    hasError,
  };
}
