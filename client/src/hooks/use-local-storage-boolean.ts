import { useCallback, useState } from "react";

// Leichtgewichtiger, wiederverwendbarer Persistenz-Hook für einen booleschen
// UI-Zustand (z.B. ein-/ausgeklappte Karte). Bewusst minimal: liest beim Mount
// einmal aus `localStorage`, schreibt bei jeder Änderung zurück und schluckt
// Verfügbarkeits-/Quota-Fehler (Private-Mode, gesperrter Storage) still, damit
// die UI nie an einem nicht-verfügbaren Storage scheitert.
export function useLocalStorageBoolean(
  key: string,
  defaultValue: boolean,
): readonly [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultValue;
    try {
      const raw = window.localStorage.getItem(key);
      return raw === null ? defaultValue : raw === "true";
    } catch {
      return defaultValue;
    }
  });

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, next ? "true" : "false");
      } catch {
        // Storage nicht verfügbar (Private-Mode/Quota) — nur In-Memory halten.
      }
    },
    [key],
  );

  return [value, set] as const;
}
