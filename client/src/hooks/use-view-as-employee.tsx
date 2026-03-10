import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";

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
  const [employeeId, setEmployeeId] = useState<number | null>(null);
  const [employeeName, setEmployeeName] = useState<string | null>(null);

  const setViewAsEmployee = useCallback((id: number | null, name: string | null) => {
    setEmployeeId(id);
    setEmployeeName(name);
  }, []);

  const clearViewAs = useCallback(() => {
    setEmployeeId(null);
    setEmployeeName(null);
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
