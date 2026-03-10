import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";

const STORAGE_KEY_ID = "viewAsEmployeeId";
const STORAGE_KEY_NAME = "viewAsEmployeeName";

function getInitialEmployeeId(): number | null {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY_ID);
    return stored ? parseInt(stored, 10) : null;
  } catch { return null; }
}

function getInitialEmployeeName(): string | null {
  try { return sessionStorage.getItem(STORAGE_KEY_NAME); } catch { return null; }
}

interface ViewAsEmployeeContextType {
  viewAsEmployeeId: number | null;
  viewAsEmployeeName: string | null;
  setViewAsEmployee: (id: number | null, name: string | null) => void;
  clearViewAs: () => void;
  isViewingAsEmployee: boolean;
}

const ViewAsEmployeeContext = createContext<ViewAsEmployeeContextType>({
  viewAsEmployeeId: null,
  viewAsEmployeeName: null,
  setViewAsEmployee: () => {},
  clearViewAs: () => {},
  isViewingAsEmployee: false,
});

export function ViewAsEmployeeProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [employeeId, setEmployeeId] = useState<number | null>(getInitialEmployeeId);
  const [employeeName, setEmployeeName] = useState<string | null>(getInitialEmployeeName);

  const setViewAsEmployee = useCallback((id: number | null, name: string | null) => {
    setEmployeeId(id);
    setEmployeeName(name);
    try {
      if (id !== null) {
        sessionStorage.setItem(STORAGE_KEY_ID, String(id));
      } else {
        sessionStorage.removeItem(STORAGE_KEY_ID);
      }
      if (name !== null) {
        sessionStorage.setItem(STORAGE_KEY_NAME, name);
      } else {
        sessionStorage.removeItem(STORAGE_KEY_NAME);
      }
    } catch {}
  }, []);

  const clearViewAs = useCallback(() => {
    setEmployeeId(null);
    setEmployeeName(null);
    try {
      sessionStorage.removeItem(STORAGE_KEY_ID);
      sessionStorage.removeItem(STORAGE_KEY_NAME);
    } catch {}
  }, []);

  const isAdmin = user?.isAdmin ?? false;
  const isViewingAsEmployee = isAdmin && employeeId !== null;

  return (
    <ViewAsEmployeeContext.Provider
      value={{
        viewAsEmployeeId: isAdmin ? employeeId : null,
        viewAsEmployeeName: isAdmin ? employeeName : null,
        setViewAsEmployee,
        clearViewAs,
        isViewingAsEmployee,
      }}
    >
      {children}
    </ViewAsEmployeeContext.Provider>
  );
}

export function useViewAsEmployee() {
  return useContext(ViewAsEmployeeContext);
}
