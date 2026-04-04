import type { EmployeeRole } from "../schema";

export interface EmployeeListItem {
  id: number;
  email: string;
  displayName: string;
  vorname: string | null;
  nachname: string | null;
  isActive: boolean;
  isAdmin: boolean;
  roles: EmployeeRole[];
  createdAt: string;
}
