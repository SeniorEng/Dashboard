/**
 * Time Entry Conflict Hook
 * 
 * Provides real-time validation for time entries:
 * - Client-side time validation (end time > start time)
 * - Server-side conflict checking (overlaps, full-day entries)
 */

import { useState, useEffect, useMemo } from "react";
import { api } from "@/lib/api";
import { FULL_DAY_ENTRY_TYPES } from "@shared/domain/time-entries";

export interface TimeEntryFormData {
  entryDate: string;
  entryType: string;
  startTime?: string | null;
  endTime?: string | null;
  isFullDay?: boolean;
  excludeEntryId?: number;
  targetUserId?: number;
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
  const [conflict, setConflict] = useState<string | null>(null);
  const [isChecking, setIsChecking] = useState(false);

  // Derive isFullDay from entry type - full-day types always have isFullDay=true
  const isFullDayType = formData ? (FULL_DAY_ENTRY_TYPES as readonly string[]).includes(formData.entryType) : false;
  const effectiveIsFullDay = isFullDayType || (formData?.isFullDay ?? false);

  const timeError = useMemo(() => {
    if (!formData) return null;
    if (effectiveIsFullDay) return null;
    if (!formData.startTime || !formData.endTime) return null;
    if (formData.endTime <= formData.startTime) {
      return "Die Endzeit muss nach der Startzeit liegen";
    }
    return null;
  }, [formData, effectiveIsFullDay]);

  useEffect(() => {
    if (!isDialogOpen || !formData) {
      setConflict(null);
      return;
    }

    if (timeError) {
      setConflict(null);
      return;
    }

    const checkConflict = async () => {
      if (!formData.entryDate) return;

      setIsChecking(true);
      try {
        const result = await api.post<ConflictCheckResult>("/time-entries/check-conflicts", {
          date: formData.entryDate,
          startTime: formData.startTime || null,
          endTime: formData.endTime || null,
          isFullDay: effectiveIsFullDay,
          excludeEntryId: formData.excludeEntryId,
          ...(formData.targetUserId ? { targetUserId: formData.targetUserId } : {}),
        });
        if (result.success) {
          setConflict(result.data.conflict);
        } else {
          setConflict(null);
        }
      } catch {
        setConflict(null);
      } finally {
        setIsChecking(false);
      }
    };

    const delay = formData.startTime && formData.endTime ? 150 : 0;
    const timer = setTimeout(checkConflict, delay);

    return () => clearTimeout(timer);
  }, [
    isDialogOpen,
    formData?.entryDate,
    formData?.startTime,
    formData?.endTime,
    formData?.entryType,
    formData?.isFullDay,
    formData?.excludeEntryId,
    formData?.targetUserId,
    timeError,
    effectiveIsFullDay,
  ]);

  const hasError = !!(timeError || conflict);

  return {
    timeError,
    conflict,
    isChecking,
    hasError,
  };
}
