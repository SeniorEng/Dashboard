import { Router, Request, Response } from "express";
import { storage } from "../storage";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import { requireAuth } from "../middleware/auth";

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

    let customers = await storage.getCustomers();
    
    if (!user.isAdmin) {
      const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
      customers = customers.filter(c => assignedCustomerIds.includes(c.id));
    }
    
    const matchingCustomers = customers.filter(c => 
      c.name?.toLowerCase().includes(query) ||
      c.vorname?.toLowerCase().includes(query) ||
      c.nachname?.toLowerCase().includes(query)
    ).slice(0, 5);

    for (const customer of matchingCustomers) {
      results.push({
        type: "customer",
        id: customer.id,
        title: customer.name || `${customer.vorname} ${customer.nachname}`,
        subtitle: customer.address || `${customer.strasse} ${customer.nr}, ${customer.plz} ${customer.stadt}`,
        href: `/customer/${customer.id}`
      });
    }

    let allAppointments = await storage.getAppointmentsWithCustomers();
    
    if (!user.isAdmin) {
      const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
      allAppointments = allAppointments.filter(apt => 
        assignedCustomerIds.includes(apt.customerId)
      );
    }
    
    const matchingAppointments = allAppointments.filter(a => 
      a.customer?.name?.toLowerCase().includes(query) ||
      a.customer?.vorname?.toLowerCase().includes(query) ||
      a.customer?.nachname?.toLowerCase().includes(query)
    ).slice(0, 5);

    for (const apt of matchingAppointments) {
      const customerName = apt.customer?.name || `${apt.customer?.vorname} ${apt.customer?.nachname}`;
      const dateFormatted = format(new Date(apt.date), "d. MMM yyyy", { locale: de });
      
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
    console.error("Search error:", error);
    res.status(500).json({ error: "Search failed" });
  }
});
