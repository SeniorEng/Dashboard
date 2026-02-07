/**
 * Time Entry Form Hook
 * 
 * Manages form state for creating/editing time entries with:
 * - Type-specific defaults and constraints
 * - Date range support for vacation/sick leave
 * - Form reset and initialization
 */

import { useState, useCallback } from "react";
import type { TimeEntryType, CreateTimeEntryRequest } from "@/lib/api/types";
import { todayISO } from "@shared/utils/datetime";

export interface TimeEntryFormState {
  id?: number;
  entryType: TimeEntryType;
  entryDate: string;
  endDate?: string;
  startTime?: string | null;
  endTime?: string | null;
  isFullDay: boolean;
  notes?: string | null;
}

const FULL_DAY_TYPES: TimeEntryType[] = ["urlaub", "krankheit"];

function getDefaultFormState(): TimeEntryFormState {
  return {
    entryType: "urlaub",
    entryDate: todayISO(),
    endDate: undefined,
    startTime: undefined,
    endTime: undefined,
    isFullDay: true,
    notes: undefined,
  };
}

export function useTimeEntryForm(initialState?: Partial<TimeEntryFormState>) {
  const [formState, setFormState] = useState<TimeEntryFormState>(() => ({
    ...getDefaultFormState(),
    ...initialState,
  }));

  const updateField = useCallback(<K extends keyof TimeEntryFormState>(
    field: K,
    value: TimeEntryFormState[K]
  ) => {
    setFormState(prev => {
      const updated = { ...prev, [field]: value };

      if (field === "entryType") {
        const newType = value as TimeEntryType;
        const isFullDayType = FULL_DAY_TYPES.includes(newType);
        
        return {
          ...updated,
          isFullDay: isFullDayType ? true : prev.isFullDay,
          endDate: isFullDayType ? prev.endDate : undefined,
        };
      }

      if (field === "entryDate" && prev.endDate && prev.endDate < (value as string)) {
        return { ...updated, endDate: value as string };
      }

      if (field === "startTime" && !FULL_DAY_TYPES.includes(prev.entryType)) {
        return { ...updated, isFullDay: false };
      }

      return updated;
    });
  }, []);

  const reset = useCallback((newState?: Partial<TimeEntryFormState>) => {
    setFormState({ ...getDefaultFormState(), ...newState });
  }, []);

  const setForEdit = useCallback((entry: {
    id: number;
    entryType: string;
    entryDate: string;
    startTime?: string | null;
    endTime?: string | null;
    isFullDay: boolean;
    notes?: string | null;
  }) => {
    setFormState({
      id: entry.id,
      entryType: entry.entryType as TimeEntryType,
      entryDate: entry.entryDate,
      startTime: entry.startTime?.slice(0, 5) || null,
      endTime: entry.endTime?.slice(0, 5) || null,
      isFullDay: entry.isFullDay,
      notes: entry.notes,
    });
  }, []);

  const toCreateRequest = useCallback((): CreateTimeEntryRequest => ({
    entryType: formState.entryType,
    entryDate: formState.entryDate,
    endDate: formState.endDate,
    startTime: formState.isFullDay ? undefined : formState.startTime || undefined,
    endTime: formState.isFullDay ? undefined : formState.endTime || undefined,
    isFullDay: formState.isFullDay,
    notes: formState.notes || undefined,
  }), [formState]);

  const toUpdateRequest = useCallback(() => ({
    entryType: formState.entryType,
    entryDate: formState.entryDate,
    startTime: formState.isFullDay ? null : formState.startTime,
    endTime: formState.isFullDay ? null : formState.endTime,
    isFullDay: formState.isFullDay,
    notes: formState.notes || null,
  }), [formState]);

  const isFullDayType = FULL_DAY_TYPES.includes(formState.entryType);
  const supportsDateRange = isFullDayType;

  return {
    formState,
    updateField,
    reset,
    setForEdit,
    toCreateRequest,
    toUpdateRequest,
    isFullDayType,
    supportsDateRange,
  };
}
