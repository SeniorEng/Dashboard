import { Router, Request, Response } from "express";
import { qualificationStorage } from "../../storage/qualifications";
import { insertQualificationSchema, updateQualificationSchema } from "@shared/schema";
import { asyncHandler } from "../../lib/errors";
import { z } from "zod";

const router = Router();

router.get("/", asyncHandler("Qualifikationen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const activeOnly = req.query.activeOnly !== "false";
  const qualifications = await qualificationStorage.getQualifications(activeOnly);
  res.json(qualifications);
}));

router.post("/", asyncHandler("Qualifikation konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const result = insertQualificationSchema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: "Validierungsfehler", details: result.error.errors });

  const qualification = await qualificationStorage.createQualification(result.data);

  if (req.body.documentTypeIds && Array.isArray(req.body.documentTypeIds)) {
    await qualificationStorage.setQualificationDocuments(qualification.id, req.body.documentTypeIds);
  }

  res.status(201).json(qualification);
}));

router.get("/employee/:employeeId/qualifications", asyncHandler("Mitarbeiter-Qualifikationen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  if (isNaN(employeeId)) return res.status(400).json({ error: "Ungültige ID" });

  const qualifications = await qualificationStorage.getEmployeeQualifications(employeeId);
  res.json(qualifications);
}));

router.post("/employee/:employeeId/assign", asyncHandler("Qualifikation konnte nicht zugewiesen werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  if (isNaN(employeeId)) return res.status(400).json({ error: "Ungültige ID" });

  const schema = z.object({ qualificationId: z.number().int() });
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: "Validierungsfehler" });

  await qualificationStorage.assignQualification(employeeId, result.data.qualificationId, req.user!.id);
  const qualifications = await qualificationStorage.getEmployeeQualifications(employeeId);
  res.json(qualifications);
}));

router.delete("/employee/:employeeId/qualifications/:qualificationId", asyncHandler("Qualifikation konnte nicht entfernt werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  const qualificationId = parseInt(req.params.qualificationId);
  if (isNaN(employeeId) || isNaN(qualificationId)) return res.status(400).json({ error: "Ungültige ID" });

  await qualificationStorage.removeQualification(employeeId, qualificationId);
  res.status(204).send();
}));

router.get("/employee/:employeeId/proofs", asyncHandler("Nachweise konnten nicht geladen werden", async (req: Request, res: Response) => {
  const employeeId = parseInt(req.params.employeeId);
  if (isNaN(employeeId)) return res.status(400).json({ error: "Ungültige ID" });

  const proofs = await qualificationStorage.getEmployeeProofs(employeeId);
  res.json(proofs);
}));

router.get("/proofs/pending-review", asyncHandler("Ausstehende Prüfungen konnten nicht geladen werden", async (req: Request, res: Response) => {
  const proofs = await qualificationStorage.getPendingReviewProofs();
  res.json(proofs);
}));

router.patch("/proofs/:proofId/review", asyncHandler("Prüfung konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const proofId = parseInt(req.params.proofId);
  if (isNaN(proofId)) return res.status(400).json({ error: "Ungültige ID" });

  const existing = await qualificationStorage.getProofById(proofId);
  if (!existing) return res.status(404).json({ error: "Nachweis nicht gefunden" });
  if (existing.status !== "uploaded") return res.status(400).json({ error: "Nachweis ist nicht im Status 'Hochgeladen'" });

  const schema = z.object({
    approved: z.boolean(),
    rejectionReason: z.string().max(500).optional(),
  });
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: "Validierungsfehler" });

  const proof = await qualificationStorage.reviewProof(
    proofId,
    result.data.approved,
    req.user!.id,
    result.data.rejectionReason
  );
  if (!proof) return res.status(404).json({ error: "Nachweis nicht gefunden" });

  res.json(proof);
}));

router.get("/:id", asyncHandler("Qualifikation konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Ungültige ID" });

  const qualification = await qualificationStorage.getQualification(id);
  if (!qualification) return res.status(404).json({ error: "Qualifikation nicht gefunden" });

  const documents = await qualificationStorage.getQualificationDocuments(id);
  res.json({ ...qualification, requiredDocuments: documents });
}));

router.patch("/:id", asyncHandler("Qualifikation konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Ungültige ID" });

  const result = updateQualificationSchema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: "Validierungsfehler", details: result.error.errors });

  const qualification = await qualificationStorage.updateQualification(id, result.data);
  if (!qualification) return res.status(404).json({ error: "Qualifikation nicht gefunden" });

  if (req.body.documentTypeIds && Array.isArray(req.body.documentTypeIds)) {
    await qualificationStorage.setQualificationDocuments(id, req.body.documentTypeIds);
  }

  res.json(qualification);
}));

router.delete("/:id", asyncHandler("Qualifikation konnte nicht gelöscht werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Ungültige ID" });

  const deleted = await qualificationStorage.deleteQualification(id);
  if (!deleted) return res.status(404).json({ error: "Qualifikation nicht gefunden" });

  res.status(204).send();
}));

router.get("/:id/documents", asyncHandler("Nachweisdokumente konnten nicht geladen werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Ungültige ID" });

  const documents = await qualificationStorage.getQualificationDocuments(id);
  res.json(documents);
}));

router.put("/:id/documents", asyncHandler("Nachweisdokumente konnten nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = parseInt(req.params.id);
  if (isNaN(id)) return res.status(400).json({ error: "Ungültige ID" });

  const schema = z.object({ documentTypeIds: z.array(z.number().int()) });
  const result = schema.safeParse(req.body);
  if (!result.success) return res.status(400).json({ error: "Validierungsfehler" });

  await qualificationStorage.setQualificationDocuments(id, result.data.documentTypeIds);
  const documents = await qualificationStorage.getQualificationDocuments(id);
  res.json(documents);
}));

export default router;
