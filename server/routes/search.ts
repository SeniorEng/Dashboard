import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { requireAuth } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { parseLocalDate } from "@shared/utils/datetime";

interface SearchResult {
  type: "customer" | "appointment";
  id: number;
  title: string;
  subtitle: string;
  href: string;
}

export const searchRouter = Router();

searchRouter.use(requireAuth);

searchRouter.get("/", async (req: Request, res: Response) => {
  try {
    const query = (req.query.q as string || "").toLowerCase().trim();
    const user = req.user!;
    
    if (query.length < 2) {
      return res.json([]);
    }

    const results: SearchResult[] = [];
    
    const assignedCustomerIds = user.isAdmin 
      ? undefined 
      : await storage.getAssignedCustomerIds(user.id);

    const matchingCustomers = await storage.searchCustomers({
      query,
      assignedCustomerIds,
      limit: 5
    });

    for (const customer of matchingCustomers) {
      results.push({
        type: "customer",
        id: customer.id,
        title: customer.name || `${customer.vorname} ${customer.nachname}`,
        subtitle: customer.address || `${customer.strasse} ${customer.nr}, ${customer.plz} ${customer.stadt}`,
        href: `/customer/${customer.id}`
      });
    }

    const matchingAppointments = await storage.searchAppointmentsWithCustomers({
      query,
      assignedCustomerIds,
      limit: 5
    });

    for (const apt of matchingAppointments) {
      const customerName = apt.customer?.name || `${apt.customer?.vorname} ${apt.customer?.nachname}`;
      const dateFormatted = format(parseLocalDate(apt.date), "d. MMM yyyy", { locale: de });
      
      results.push({
        type: "appointment",
        id: apt.id,
        title: customerName,
        subtitle: `${dateFormatted} um ${apt.scheduledStart}`,
        href: `/appointment/${apt.id}`
      });
    }

    res.json(results);
  } catch (error) {
    handleRouteError(res, error, "Suche fehlgeschlagen", "Search error");
  }
});
