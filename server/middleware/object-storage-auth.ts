import { Request, Response, NextFunction } from "express";
import { db } from "../lib/db";
import { eq, or } from "drizzle-orm";
import { customerDocuments, generatedDocuments, employeeDocuments } from "@shared/schema/documents";
import { employeeDocumentProofs } from "@shared/schema/qualifications";
import { companySettings } from "@shared/schema/company";
import { storage } from "../storage";

export async function requireObjectAccess(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!req.user) {
    res.status(401).json({
      error: "UNAUTHORIZED",
      message: "Bitte melden Sie sich an",
    });
    return;
  }

  if (req.user.isAdmin) {
    next();
    return;
  }

  const objectPath = req.path;
  const userId = req.user.id;

  try {
    const allowed = await checkObjectAccessForUser(objectPath, userId);
    if (allowed) {
      next();
      return;
    }

    res.status(403).json({
      error: "FORBIDDEN",
      message: "Sie haben keinen Zugriff auf dieses Dokument",
    });
  } catch (error) {
    console.error("Object access check error:", error);
    res.status(500).json({ error: "Fehler bei der Zugriffsprüfung" });
  }
}

function getPathVariants(objectPath: string): string[] {
  const variants = [objectPath];
  if (objectPath.startsWith("/objects/")) {
    variants.push(objectPath.slice("/objects/".length));
  }
  return variants;
}

async function checkObjectAccessForUser(
  objectPath: string,
  userId: number
): Promise<boolean> {
  const pathVariants = getPathVariants(objectPath);

  const [logoResult, empResults, custResults] = await Promise.all([
    checkCompanyLogo(pathVariants),
    checkEmployeeAccess(pathVariants, userId),
    checkCustomerAccess(pathVariants, userId),
  ]);

  return logoResult || empResults || custResults;
}

async function checkCompanyLogo(pathVariants: string[]): Promise<boolean> {
  const [settings] = await db
    .select({ logoUrl: companySettings.logoUrl, pdfLogoUrl: companySettings.pdfLogoUrl })
    .from(companySettings)
    .limit(1);

  if (!settings) return false;

  return pathVariants.some(
    (p) => settings.logoUrl === p || settings.pdfLogoUrl === p
  );
}

async function checkEmployeeAccess(
  pathVariants: string[],
  userId: number
): Promise<boolean> {
  const pathConditions = pathVariants.map((p) => eq(employeeDocuments.objectPath, p));
  const [empDoc] = await db
    .select({ employeeId: employeeDocuments.employeeId })
    .from(employeeDocuments)
    .where(pathConditions.length > 1 ? or(...pathConditions) : pathConditions[0])
    .limit(1);

  if (empDoc && empDoc.employeeId === userId) return true;

  const proofConditions = pathVariants.map((p) => eq(employeeDocumentProofs.objectPath, p));
  const [proofDoc] = await db
    .select({ employeeId: employeeDocumentProofs.employeeId })
    .from(employeeDocumentProofs)
    .where(proofConditions.length > 1 ? or(...proofConditions) : proofConditions[0])
    .limit(1);

  if (proofDoc && proofDoc.employeeId === userId) return true;

  const genConditions = pathVariants.map((p) => eq(generatedDocuments.objectPath, p));
  const [genDoc] = await db
    .select({ employeeId: generatedDocuments.employeeId, customerId: generatedDocuments.customerId })
    .from(generatedDocuments)
    .where(genConditions.length > 1 ? or(...genConditions) : genConditions[0])
    .limit(1);

  if (genDoc && genDoc.employeeId === userId && !genDoc.customerId) {
    return true;
  }

  return false;
}

async function checkCustomerAccess(
  pathVariants: string[],
  userId: number
): Promise<boolean> {
  const assignedCustomerIds = await storage.getAssignedCustomerIds(userId);
  if (assignedCustomerIds.length === 0) return false;

  const custConditions = pathVariants.map((p) => eq(customerDocuments.objectPath, p));
  const [custDoc] = await db
    .select({ customerId: customerDocuments.customerId })
    .from(customerDocuments)
    .where(custConditions.length > 1 ? or(...custConditions) : custConditions[0])
    .limit(1);

  if (custDoc && assignedCustomerIds.includes(custDoc.customerId)) {
    return true;
  }

  const genConditions = pathVariants.map((p) => eq(generatedDocuments.objectPath, p));
  const [genDoc] = await db
    .select({ customerId: generatedDocuments.customerId })
    .from(generatedDocuments)
    .where(genConditions.length > 1 ? or(...genConditions) : genConditions[0])
    .limit(1);

  if (genDoc?.customerId && assignedCustomerIds.includes(genDoc.customerId)) {
    return true;
  }

  return false;
}
