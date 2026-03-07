import { Router, Request, Response } from "express";
import { storage } from "../../../storage";
import { customerManagementStorage } from "../../../storage/customer-management";
import { authService } from "../../../services/auth";
import { birthdaysCache } from "../../../services/cache";
import { notificationService } from "../../../services/notification-service";
import { asyncHandler } from "../../../lib/errors";
import { z } from "zod";
import { formatDateISO, isChild } from "@shared/utils/datetime";
import {
  users,
  userRoles,
  customers,
  appointments,
} from "@shared/schema";
import { db } from "../../../lib/db";
import { eq, and, sql, gte, isNull, count } from "drizzle-orm";

const router = Router();

const assignCustomerSchema = z.object({
  primaryEmployeeId: z.number().nullable(),
  backupEmployeeId: z.number().nullable(),
  backupEmployeeId2: z.number().nullable(),
});

router.patch("/customers/:id/assign", asyncHandler("Zuordnung konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Kunden-ID",
    });
    return;
  }

  const result = assignCustomerSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Ungültige Daten",
      details: result.error.issues,
    });
    return;
  }

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({
      error: "NOT_FOUND",
      message: "Kunde nicht gefunden",
    });
    return;
  }

  const { primaryEmployeeId, backupEmployeeId, backupEmployeeId2 } = result.data;

  const assignedIds = [primaryEmployeeId, backupEmployeeId, backupEmployeeId2].filter(id => id != null);
  const uniqueIds = new Set(assignedIds);
  if (assignedIds.length !== uniqueIds.size) {
    res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "Hauptansprechpartner, 1. Vertretung und 2. Vertretung müssen unterschiedlich sein",
    });
    return;
  }

  if (primaryEmployeeId) {
    const primaryEmployee = await authService.getUser(primaryEmployeeId);
    if (!primaryEmployee || !primaryEmployee.isActive) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Hauptansprechpartner nicht gefunden oder nicht aktiv",
      });
      return;
    }
  }

  if (backupEmployeeId) {
    const backupEmployee = await authService.getUser(backupEmployeeId);
    if (!backupEmployee || !backupEmployee.isActive) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Vertretung nicht gefunden oder nicht aktiv",
      });
      return;
    }
  }

  if (backupEmployeeId2) {
    const backupEmployee2 = await authService.getUser(backupEmployeeId2);
    if (!backupEmployee2 || !backupEmployee2.isActive) {
      res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "2. Vertretung nicht gefunden oder nicht aktiv",
      });
      return;
    }
  }

  const oldPrimary = customer.primaryEmployeeId;
  const oldBackup = customer.backupEmployeeId;
  const oldBackup2 = customer.backupEmployeeId2;

  const updatedCustomer = await customerManagementStorage.updateCustomerAssignment(id, primaryEmployeeId, backupEmployeeId, req.user?.id, backupEmployeeId2);
  
  birthdaysCache.invalidateAll();

  const customerName = `${customer.vorname} ${customer.nachname}`;
  if (primaryEmployeeId && primaryEmployeeId !== oldPrimary) {
    notificationService.notifyCustomerAssigned(id, customerName, primaryEmployeeId, "primary");
  }
  if (backupEmployeeId && backupEmployeeId !== oldBackup) {
    notificationService.notifyCustomerAssigned(id, customerName, backupEmployeeId, "backup");
  }
  if (backupEmployeeId2 && backupEmployeeId2 !== oldBackup2) {
    notificationService.notifyCustomerAssigned(id, customerName, backupEmployeeId2, "backup2");
  }
  
  res.json(updatedCustomer);
}));

interface MatchCriteria {
  plz: string | null;
  haustierVorhanden: boolean;
  personenbefoerderungGewuenscht: boolean;
  geburtsdatum: string | null;
  needsHauswirtschaft: boolean;
  needsAlltagsbegleitung: boolean;
}

interface MatchResult {
  employeeId: number;
  displayName: string;
  score: number;
  maxScore: number;
  reasons: { label: string; matched: boolean; detail: string }[];
}


function plzDistance(plz1: string | null, plz2: string | null): number | null {
  if (!plz1 || !plz2) return null;
  const n1 = parseInt(plz1);
  const n2 = parseInt(plz2);
  if (isNaN(n1) || isNaN(n2)) return null;
  return Math.abs(n1 - n2);
}

async function matchEmployees(criteria: MatchCriteria, excludeEmployeeIds: number[] = []): Promise<MatchResult[]> {
  const threeMonthsAgo = new Date();
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
  const threeMonthsAgoStr = formatDateISO(threeMonthsAgo);

  const [activeEmployees, allRoles, activeCustomerCounts, appointmentCounts] = await Promise.all([
    db.select({
      id: users.id,
      displayName: users.displayName,
      plz: users.plz,
      haustierAkzeptiert: users.haustierAkzeptiert,
    })
    .from(users)
    .where(eq(users.isActive, true)),

    db.select({ userId: userRoles.userId, role: userRoles.role })
    .from(userRoles),

    db.select({
      employeeId: customers.primaryEmployeeId,
      count: count(),
    })
    .from(customers)
    .where(and(
      eq(customers.status, "aktiv"),
      isNull(customers.deletedAt),
      sql`${customers.primaryEmployeeId} IS NOT NULL`
    ))
    .groupBy(customers.primaryEmployeeId),

    db.select({
      employeeId: appointments.assignedEmployeeId,
      count: count(),
    })
    .from(appointments)
    .where(and(
      gte(appointments.date, threeMonthsAgoStr),
      sql`${appointments.assignedEmployeeId} IS NOT NULL`
    ))
    .groupBy(appointments.assignedEmployeeId),
  ]);

  const rolesByUser = new Map<number, string[]>();
  for (const r of allRoles) {
    if (!rolesByUser.has(r.userId)) rolesByUser.set(r.userId, []);
    rolesByUser.get(r.userId)!.push(r.role);
  }

  const customerCountMap = new Map<number, number>();
  for (const c of activeCustomerCounts) {
    if (c.employeeId) customerCountMap.set(c.employeeId, Number(c.count));
  }

  const appointmentCountMap = new Map<number, number>();
  for (const a of appointmentCounts) {
    if (a.employeeId) appointmentCountMap.set(a.employeeId, Number(a.count));
  }

  const maxCustomers = Math.max(...Array.from(customerCountMap.values()), 1);
  const maxAppointments = Math.max(...Array.from(appointmentCountMap.values()), 1);
  const customerIsChild = isChild(criteria.geburtsdatum);

  const results: MatchResult[] = [];

  for (const emp of activeEmployees) {
    if (excludeEmployeeIds.includes(emp.id)) continue;

    const roles = rolesByUser.get(emp.id) || [];
    const reasons: MatchResult["reasons"] = [];
    let score = 0;
    let maxScore = 0;

    if (criteria.haustierVorhanden && !emp.haustierAkzeptiert) {
      continue;
    }
    maxScore += 30;
    if (criteria.haustierVorhanden) {
      score += 30;
      reasons.push({ label: "Haustiere", matched: true, detail: "Akzeptiert Haustiere" });
    } else {
      score += 30;
      reasons.push({ label: "Haustiere", matched: true, detail: "Kein Haustier beim Kunden" });
    }

    maxScore += 25;
    const dist = plzDistance(criteria.plz, emp.plz);
    if (dist !== null) {
      const plzScore = Math.max(0, 25 - Math.floor(dist / 400));
      score += plzScore;
      if (dist === 0) {
        reasons.push({ label: "Entfernung", matched: true, detail: "Gleiche PLZ" });
      } else if (dist <= 2000) {
        reasons.push({ label: "Entfernung", matched: true, detail: `PLZ-Differenz: ${dist}` });
      } else {
        reasons.push({ label: "Entfernung", matched: false, detail: `PLZ-Differenz: ${dist} (weit entfernt)` });
      }
    } else {
      reasons.push({ label: "Entfernung", matched: false, detail: "PLZ nicht verfügbar" });
    }

    maxScore += 20;
    let serviceMatches = 0;
    let serviceTotal = 0;
    if (criteria.needsHauswirtschaft) {
      serviceTotal++;
      if (roles.includes("hauswirtschaft")) serviceMatches++;
    }
    if (criteria.needsAlltagsbegleitung) {
      serviceTotal++;
      if (roles.includes("alltagsbegleitung")) serviceMatches++;
    }
    if (serviceTotal > 0) {
      const serviceScore = Math.round((serviceMatches / serviceTotal) * 20);
      score += serviceScore;
      const matched = serviceMatches === serviceTotal;
      reasons.push({
        label: "Leistungen",
        matched,
        detail: matched
          ? `Alle Leistungen abgedeckt (${serviceMatches}/${serviceTotal})`
          : `${serviceMatches}/${serviceTotal} Leistungen abgedeckt`,
      });
    } else {
      score += 20;
      reasons.push({ label: "Leistungen", matched: true, detail: "Keine spezifischen Leistungen gefordert" });
    }

    maxScore += 10;
    if (criteria.personenbefoerderungGewuenscht) {
      if (roles.includes("personenbefoerderung")) {
        score += 10;
        reasons.push({ label: "Personenbeförderung", matched: true, detail: "Kann Personenbeförderung" });
      } else {
        reasons.push({ label: "Personenbeförderung", matched: false, detail: "Keine Personenbeförderung" });
      }
    } else {
      score += 10;
      reasons.push({ label: "Personenbeförderung", matched: true, detail: "Nicht benötigt" });
    }

    maxScore += 10;
    if (customerIsChild) {
      if (roles.includes("kinderbetreuung")) {
        score += 10;
        reasons.push({ label: "Kinderbetreuung", matched: true, detail: "Qualifiziert für Kinderbetreuung" });
      } else {
        reasons.push({ label: "Kinderbetreuung", matched: false, detail: "Keine Kinderbetreuung-Qualifikation" });
      }
    } else {
      score += 10;
      reasons.push({ label: "Kinderbetreuung", matched: true, detail: "Kein Kind" });
    }

    maxScore += 5;
    const empCustomers = customerCountMap.get(emp.id) || 0;
    const empAppointments = appointmentCountMap.get(emp.id) || 0;
    const loadRatio = (empCustomers / maxCustomers + empAppointments / maxAppointments) / 2;
    const capacityScore = Math.round((1 - loadRatio) * 5);
    score += Math.max(0, capacityScore);
    reasons.push({
      label: "Kapazität",
      matched: capacityScore >= 3,
      detail: `${empCustomers} Kunden, ${empAppointments} Termine (3 Mon.)`,
    });

    results.push({
      employeeId: emp.id,
      displayName: emp.displayName,
      score,
      maxScore,
      reasons,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, 3);
}

router.get("/customers/:id/match-employees", asyncHandler("Matching konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Ungültige Kunden-ID" });
    return;
  }

  const customer = await db
    .select()
    .from(customers)
    .where(eq(customers.id, id))
    .then(r => r[0]);

  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const needsAssessment = await customerManagementStorage.getCustomerNeedsAssessment(id);

  const needsHauswirtschaft = needsAssessment
    ? !!(needsAssessment.serviceHaushaltHilfe || needsAssessment.serviceMahlzeiten || needsAssessment.serviceReinigung || needsAssessment.serviceWaeschePflege || needsAssessment.serviceEinkauf)
    : false;
  const needsAlltagsbegleitung = needsAssessment
    ? !!(needsAssessment.serviceTagesablauf || needsAssessment.serviceAlltagsverrichtungen || needsAssessment.serviceTerminbegleitung || needsAssessment.serviceBotengaenge || needsAssessment.serviceFreizeitbegleitung || needsAssessment.serviceDemenzbetreuung || needsAssessment.serviceGesellschaft || needsAssessment.serviceSozialeKontakte)
    : false;

  const excludeIds: number[] = [];
  if (customer.primaryEmployeeId) excludeIds.push(customer.primaryEmployeeId);
  if (customer.backupEmployeeId) excludeIds.push(customer.backupEmployeeId);
  if (customer.backupEmployeeId2) excludeIds.push(customer.backupEmployeeId2);

  const results = await matchEmployees({
    plz: customer.plz,
    haustierVorhanden: customer.haustierVorhanden,
    personenbefoerderungGewuenscht: customer.personenbefoerderungGewuenscht,
    geburtsdatum: customer.geburtsdatum,
    needsHauswirtschaft,
    needsAlltagsbegleitung,
  }, excludeIds);

  res.json(results);
}));

const matchInlineSchema = z.object({
  plz: z.string().nullable().optional(),
  haustierVorhanden: z.boolean().optional(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  geburtsdatum: z.string().nullable().optional(),
  needsHauswirtschaft: z.boolean().optional(),
  needsAlltagsbegleitung: z.boolean().optional(),
  excludeEmployeeIds: z.array(z.number()).optional(),
});

router.post("/customers/match-employees", asyncHandler("Matching konnte nicht durchgeführt werden", async (req: Request, res: Response) => {
  const data = matchInlineSchema.parse(req.body);

  const results = await matchEmployees({
    plz: data.plz || null,
    haustierVorhanden: data.haustierVorhanden || false,
    personenbefoerderungGewuenscht: data.personenbefoerderungGewuenscht || false,
    geburtsdatum: data.geburtsdatum || null,
    needsHauswirtschaft: data.needsHauswirtschaft || false,
    needsAlltagsbegleitung: data.needsAlltagsbegleitung || false,
  }, data.excludeEmployeeIds || []);

  res.json(results);
}));

export default router;
