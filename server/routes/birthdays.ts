import { Router, Request, Response } from "express";
import { requireAuth } from "../middleware/auth";
import { handleRouteError } from "../lib/errors";
import { storage } from "../storage";
import { birthdaysCache } from "../services/cache";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { users, customers } from "@shared/schema";
import { sql, and, eq, or, isNotNull } from "drizzle-orm";

const router = Router();

router.use(requireAuth);

interface BirthdayEntry {
  id: number;
  type: "employee" | "customer";
  name: string;
  geburtsdatum: string;
  daysUntil: number;
  age: number;
}

function calculateDaysUntilBirthday(birthDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const birth = new Date(birthDate);
  const thisYearBirthday = new Date(today.getFullYear(), birth.getMonth(), birth.getDate());
  
  if (thisYearBirthday < today) {
    thisYearBirthday.setFullYear(today.getFullYear() + 1);
  }
  
  const diffTime = thisYearBirthday.getTime() - today.getTime();
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function calculateAge(birthDate: string): number {
  const today = new Date();
  const birth = new Date(birthDate);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  
  return age;
}

function calculateUpcomingAge(birthDate: string, daysUntil: number): number {
  const baseAge = calculateAge(birthDate);
  return daysUntil === 0 ? baseAge : baseAge + 1;
}

router.get("/", async (req: Request, res: Response) => {
  try {
    const user = req.user!;
    const horizonDays = parseInt(req.query.days as string) || 30;
    
    // Check cache first
    const cached = birthdaysCache.get(user.id, user.isAdmin, horizonDays);
    if (cached) {
      return res.json(cached);
    }
    
    const dbConnection = neon(process.env.DATABASE_URL!);
    const db = drizzle(dbConnection);
    
    const birthdays: BirthdayEntry[] = [];
    
    if (user.isAdmin) {
      const activeEmployees = await db
        .select({
          id: users.id,
          displayName: users.displayName,
          geburtsdatum: users.geburtsdatum,
        })
        .from(users)
        .where(and(
          eq(users.isActive, true),
          isNotNull(users.geburtsdatum)
        ));
      
      for (const emp of activeEmployees) {
        if (emp.geburtsdatum) {
          const daysUntil = calculateDaysUntilBirthday(emp.geburtsdatum);
          if (daysUntil <= horizonDays) {
            birthdays.push({
              id: emp.id,
              type: "employee",
              name: emp.displayName,
              geburtsdatum: emp.geburtsdatum,
              daysUntil,
              age: calculateUpcomingAge(emp.geburtsdatum, daysUntil),
            });
          }
        }
      }
      
      const allCustomers = await db
        .select({
          id: customers.id,
          name: customers.name,
          geburtsdatum: customers.geburtsdatum,
        })
        .from(customers)
        .where(isNotNull(customers.geburtsdatum));
      
      for (const cust of allCustomers) {
        if (cust.geburtsdatum) {
          const daysUntil = calculateDaysUntilBirthday(cust.geburtsdatum);
          if (daysUntil <= horizonDays) {
            birthdays.push({
              id: cust.id,
              type: "customer",
              name: cust.name,
              geburtsdatum: cust.geburtsdatum,
              daysUntil,
              age: calculateUpcomingAge(cust.geburtsdatum, daysUntil),
            });
          }
        }
      }
    } else {
      const myBirthday = user.geburtsdatum;
      if (myBirthday) {
        const daysUntil = calculateDaysUntilBirthday(myBirthday);
        if (daysUntil <= horizonDays) {
          birthdays.push({
            id: user.id,
            type: "employee",
            name: user.displayName,
            geburtsdatum: myBirthday,
            daysUntil,
            age: calculateUpcomingAge(myBirthday, daysUntil),
          });
        }
      }
      
      const assignedCustomerIds = await storage.getAssignedCustomerIds(user.id);
      
      if (assignedCustomerIds.length > 0) {
        const assignedCustomers = await storage.getCustomersByIds(assignedCustomerIds);
        
        for (const cust of assignedCustomers) {
          if (cust.geburtsdatum) {
            const daysUntil = calculateDaysUntilBirthday(cust.geburtsdatum);
            if (daysUntil <= horizonDays) {
              birthdays.push({
                id: cust.id,
                type: "customer",
                name: cust.name,
                geburtsdatum: cust.geburtsdatum,
                daysUntil,
                age: calculateUpcomingAge(cust.geburtsdatum, daysUntil),
              });
            }
          }
        }
      }
    }
    
    birthdays.sort((a, b) => a.daysUntil - b.daysUntil);
    
    // Store in cache (1 hour TTL)
    birthdaysCache.set(user.id, user.isAdmin, horizonDays, birthdays);
    
    res.json(birthdays);
  } catch (error) {
    handleRouteError(res, error, "Geburtstage konnten nicht geladen werden");
  }
});

export default router;
