import { Request, Response, NextFunction } from "express";
import { db } from "../lib/db";
import { eq, or } from "drizzle-orm";
import { customerDocuments, generatedDocuments, employeeDocuments } from "@shared/schema/documents";
import { employeeDocumentProofs } from "@shared/schema";
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

// Resolviert den ursprünglichen, menschenlesbaren Dateinamen (DB-`fileName`) zu
// einem `/objects/...`-Pfad, damit der `/objects/*`-Download-Stream einen
// sprechenden `Content-Disposition`-Namen (statt der UUID aus dem Objektpfad)
// setzen kann. Prüft alle Tabellen, die einen `objectPath` referenzieren.
// Gibt `undefined` zurück, wenn kein Datensatz passt (z.B. Logos) — dann bleibt
// das bisherige Verhalten (Browser leitet den Namen aus dem Pfad ab) erhalten.
export async function resolveObjectFilename(
  objectPath: string,
): Promise<string | undefined> {
  const pathVariants = getPathVariants(objectPath);

  const [empDoc, proofDoc, custDoc, genDoc] = await Promise.all([
    db
      .select({ fileName: employeeDocuments.fileName })
      .from(employeeDocuments)
      .where(orForPaths(employeeDocuments.objectPath, pathVariants))
      .limit(1),
    db
      .select({ fileName: employeeDocumentProofs.fileName })
      .from(employeeDocumentProofs)
      .where(orForPaths(employeeDocumentProofs.objectPath, pathVariants))
      .limit(1),
    db
      .select({ fileName: customerDocuments.fileName })
      .from(customerDocuments)
      .where(orForPaths(customerDocuments.objectPath, pathVariants))
      .limit(1),
    db
      .select({ fileName: generatedDocuments.fileName })
      .from(generatedDocuments)
      .where(orForPaths(generatedDocuments.objectPath, pathVariants))
      .limit(1),
  ]);

  return (
    empDoc[0]?.fileName ??
    proofDoc[0]?.fileName ??
    custDoc[0]?.fileName ??
    genDoc[0]?.fileName ??
    undefined
  );
}

function orForPaths(
  column: Parameters<typeof eq>[0],
  pathVariants: string[],
) {
  const conditions = pathVariants.map((p) => eq(column, p));
  return conditions.length > 1 ? or(...conditions) : conditions[0];
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
