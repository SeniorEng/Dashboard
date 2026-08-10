import { Router } from "express";
import { z } from "zod";
import { asyncHandler, notFound, badRequest } from "../../lib/errors";
import { auditService } from "../../services/audit";
import { auditLogFilterSchema } from "@shared/schema";
import { storage } from "../../storage";
import { computeDataHash } from "../../services/signature-integrity";
import { db } from "../../lib/db";
import { reopenAppointmentForRedocumentation, type AppointmentReopenFacts } from "../../lib/appointment-reopen";
import { hasActiveInvoiceForAppointments } from "../../lib/appointment-invoiced";
import { timeTrackingStorage } from "../../storage/time-tracking";

const revokeSignatureSchema = z.object({
  reason: z.string().min(3, "Ein Stornierungsgrund mit mindestens 3 Zeichen ist erforderlich.").max(500, "Der Stornierungsgrund darf maximal 500 Zeichen lang sein."),
  signerType: z.string().optional(),
});

const entityTypeParamSchema = z.enum(["appointment", "service_record"], {
  errorMap: () => ({ message: "Ungültiger Entity-Typ. Erlaubt: appointment, service_record" }),
});

const router = Router();

router.get("/audit-log", asyncHandler("Audit-Log konnte nicht geladen werden", async (req, res) => {
  const filter = auditLogFilterSchema.parse({
    entityType: req.query.entityType || undefined,
    entityId: req.query.entityId ? parseInt(req.query.entityId as string) : undefined,
    userId: req.query.userId ? parseInt(req.query.userId as string) : undefined,
    action: req.query.action || undefined,
    batchId: req.query.batchId || undefined,
    from: req.query.from || undefined,
    to: req.query.to || undefined,
    limit: req.query.limit ? parseInt(req.query.limit as string) : 50,
    offset: req.query.offset ? parseInt(req.query.offset as string) : 0,
  });

  const result = await auditService.getEntries(filter);
  res.json(result);
}));

router.get("/verify-signature/:entityType/:entityId", asyncHandler("Integritätsprüfung fehlgeschlagen", async (req, res) => {
  const { entityType, entityId: entityIdStr } = req.params;
  const entityId = parseInt(entityIdStr);
  const signerType = req.query.signerType as string | undefined;

  if (isNaN(entityId)) throw badRequest("Ungültige Entity-ID");

  if (entityType === "appointment") {
    const appointment = await storage.getAppointmentIncludeDeleted(entityId);
    if (!appointment) throw notFound("Termin nicht gefunden");

    if (!appointment.signatureData || !appointment.signatureHash) {
      return res.json({ valid: false, reason: "no_signature", message: "Keine Unterschrift vorhanden" });
    }

    const currentHash = computeDataHash(appointment.signatureData);
    const isValid = currentHash === appointment.signatureHash;

    return res.json({
      valid: isValid,
      signedAt: appointment.signedAt,
      signedByUserId: appointment.signedByUserId,
      storedHash: appointment.signatureHash,
      computedHash: currentHash,
      message: isValid ? "Unterschrift ist unverändert" : "WARNUNG: Unterschrift wurde nach dem Signieren verändert!",
    });
  }

  if (entityType === "service_record") {
    const record = await storage.getServiceRecord(entityId);
    if (!record) throw notFound("Leistungsnachweis nicht gefunden");

    const results: Array<{
      signerType: string;
      valid: boolean;
      signedAt: Date | null;
      signedByUserId: number | null;
      message: string;
    }> = [];

    if (signerType === "employee" || !signerType) {
      if (record.employeeSignatureData && record.employeeSignatureHash) {
        const currentHash = computeDataHash(record.employeeSignatureData);
        const isValid = currentHash === record.employeeSignatureHash;
        results.push({
          signerType: "employee",
          valid: isValid,
          signedAt: record.employeeSignedAt,
          signedByUserId: record.employeeSignedByUserId ?? null,
          message: isValid ? "Mitarbeiter-Unterschrift ist unverändert" : "WARNUNG: Mitarbeiter-Unterschrift wurde verändert!",
        });
      } else {
        results.push({
          signerType: "employee",
          valid: false,
          signedAt: null,
          signedByUserId: null,
          message: "Keine Mitarbeiter-Unterschrift vorhanden",
        });
      }
    }

    if (signerType === "customer" || !signerType) {
      if (record.customerSignatureData && record.customerSignatureHash) {
        const currentHash = computeDataHash(record.customerSignatureData);
        const isValid = currentHash === record.customerSignatureHash;
        results.push({
          signerType: "customer",
          valid: isValid,
          signedAt: record.customerSignedAt,
          signedByUserId: record.customerSignedByUserId ?? null,
          message: isValid ? "Kunden-Unterschrift ist unverändert" : "WARNUNG: Kunden-Unterschrift wurde verändert!",
        });
      } else {
        results.push({
          signerType: "customer",
          valid: false,
          signedAt: null,
          signedByUserId: null,
          message: "Keine Kunden-Unterschrift vorhanden",
        });
      }
    }

    return res.json({ signatures: results });
  }

  throw badRequest("Ungültiger Entity-Typ. Erlaubt: appointment, service_record");
}));

router.post("/revoke-signature/:entityType/:entityId", asyncHandler("Stornierung fehlgeschlagen", async (req, res) => {
  const { entityId: entityIdStr } = req.params;
  const entityType = entityTypeParamSchema.parse(req.params.entityType);
  const entityId = parseInt(entityIdStr);
  const { reason, signerType } = revokeSignatureSchema.parse(req.body);

  if (isNaN(entityId)) throw badRequest("Ungültige Entity-ID");

  const ip = req.ip || req.socket.remoteAddress;
  const userId = (req as any).user!.id;

  if (entityType === "appointment") {
    const appointment = await storage.getAppointmentIncludeDeleted(entityId);
    if (!appointment) throw notFound("Termin nicht gefunden");

    if (!appointment.signatureData) {
      throw badRequest("Dieser Termin hat keine Unterschrift zum Stornieren.");
    }

    // Task #70-FINDING — Dieser Pfad stellte denselben Zustand her wie
    // `POST /api/appointments/:id/reopen` und der LN-Korrekturweg (Signatur
    // weg, Status `documenting`), aber OHNE die Budget-Buchung
    // zurueckzudrehen. Das war die dritte Kopie derselben fachlichen Frage —
    // und die einzige, die dabei Geld liegen liess:
    //
    // Der Verbrauch der alten, stornierten Dokumentation blieb gebucht. Beim
    // erneuten Abschluss uebernimmt der Dokumentations-Pfad eine vorhandene
    // nicht-stornierte Buchung, statt neu zu buchen — eine Aufwaerts-Korrektur
    // (mehr Stunden/km) landete deshalb NIE im Topf. Stille Unterbuchung,
    // geld- und GoBD-relevant, ohne jede Spur im Audit-Log.
    //
    // Laeuft jetzt ueber die SSoT `reopenAppointmentForRedocumentation` —
    // dieselbe Funktion, die die beiden anderen Pfade rufen. Damit ist die
    // Frage „Termin zur Re-Dokumentation zurueckgeben" nur noch EINMAL
    // beantwortet.
    // Monatsabschluss: dieselbe Grenze wie auf den beiden Schwester-Pfaden
    // (`/appointments/:id/reopen` ueber `canOverrideClosedMonth`, LN-Loeschpfad
    // ueber `ensureMonthOpenForRecord`). Vor diesem PR bewegte die Route kein
    // Geld, deshalb war die Luecke folgenlos; jetzt koennte ein Admin mit der
    // `audit_log`-Berechtigung Budget-Buchungen in einem bereits
    // abgeschlossenen Monat zurueckdrehen. Superadmin darf das weiterhin.
    const monthOwnerId = appointment.performedByEmployeeId ?? appointment.assignedEmployeeId;
    if (monthOwnerId && appointment.date && !(req as any).user!.isSuperAdmin) {
      if (await timeTrackingStorage.isMonthClosed(monthOwnerId, appointment.date as string)) {
        throw badRequest("Der Monat dieses Termins ist bereits abgeschlossen. Nur die Geschäftsführung kann ihn noch korrigieren.");
      }
    }

    let facts: AppointmentReopenFacts;
    await db.transaction(async (txClient) => {
      // ERSETZT die vorherige Pruefung ausserhalb jeder Transaktion
      // (check-then-write): `lockAndCheckAppointmentLocked` sperrt Termin- und
      // LN-Zeilen mit FOR UPDATE und wertet den Lock-Status darin erneut aus.
      // Ohne das konnte eine gleichzeitig committende Unterschrift den Nachweis
      // versiegeln, waehrend hier bereits zurueckgesetzt wurde — der Nachweis
      // verwiese danach auf einen un-dokumentierten Termin.
      //
      // Status und Meldung bleiben bewusst unveraendert (400), damit der
      // Vertrag dieser Admin-Route gleich bleibt; neu ist nur, dass die
      // Pruefung nicht mehr rennanfaellig ist.
      if (await storage.lockAndCheckAppointmentLocked(entityId, txClient)) {
        throw badRequest("Dieser Termin ist Teil eines unterschriebenen Leistungsnachweises. Bitte stornieren Sie zuerst den Leistungsnachweis.");
      }

      // GoBD: Storno first. Beide Schwester-Aufrufer der SSoT pruefen das
      // (`DELETE /api/service-records/:id` -> 409 INVOICED,
      // `DELETE /api/appointments/:id` -> findActiveInvoicesForAppointments);
      // hier fehlte es. Solange dieser Pfad nur Status und Signatur zuruecksetzte,
      // war das folgenlos — mit dem Reverse bewegt er Geld und braucht denselben
      // Guard: sonst holt der Topf den Verbrauch zurueck, waehrend die gestellte
      // Rechnung ihn weiter berechnet, und das freigewordene Budget laesst sich
      // ein zweites Mal verbrauchen.
      //
      // Erreichbar wird das erst ueber den Umweg
      // `revoke-signature/service_record/:id` (setzt den LN zurueck, wodurch der
      // Lock-Check oben nicht mehr greift) — genau deshalb reicht der Lock-Check
      // als alleiniger Schutz nicht.
      if (await hasActiveInvoiceForAppointments([entityId], txClient)) {
        throw badRequest("Für diesen Termin existiert eine aktive Rechnung. Bitte stornieren Sie zuerst die Rechnung (GoBD: Storno vor Korrektur).");
      }

      facts = await reopenAppointmentForRedocumentation(appointment, userId, txClient);
    });

    await auditService.appointmentRevoked(
      userId,
      entityId,
      {
        customerId: appointment.customerId!,
        reason,
        previousStatus: facts!.previousStatus,
        // Ohne diese beiden Zahlen bliebe die Rueckbuchung im Audit-Log
        // unsichtbar — der Vorgang waere nicht rekonstruierbar.
        reversedTransactions: facts!.reversedTransactions,
        hadSignature: facts!.clearedDirectSignature,
      },
      ip
    );

    return res.json({ success: true, message: "Unterschrift wurde storniert. Der Termin kann neu dokumentiert werden." });
  }

  if (entityType === "service_record") {
    const record = await storage.getServiceRecord(entityId);
    if (!record) throw notFound("Leistungsnachweis nicht gefunden");

    if (!signerType || !["employee", "customer"].includes(signerType)) {
      throw badRequest("signerType muss 'employee' oder 'customer' sein.");
    }

    const previousStatus = record.status;
    let updateData: Record<string, unknown> = { updatedAt: new Date() };

    if (signerType === "customer") {
      if (!record.customerSignatureData) {
        throw badRequest("Keine Kunden-Unterschrift zum Stornieren vorhanden.");
      }
      updateData = {
        ...updateData,
        customerSignatureData: null,
        customerSignatureHash: null,
        customerSignedAt: null,
        customerSignedByUserId: null,
        status: "employee_signed",
      };
    } else {
      if (!record.employeeSignatureData) {
        throw badRequest("Keine Mitarbeiter-Unterschrift zum Stornieren vorhanden.");
      }
      updateData = {
        ...updateData,
        employeeSignatureData: null,
        employeeSignatureHash: null,
        employeeSignedAt: null,
        employeeSignedByUserId: null,
        customerSignatureData: null,
        customerSignatureHash: null,
        customerSignedAt: null,
        customerSignedByUserId: null,
        status: "pending",
      };
    }

    await storage.updateServiceRecord(entityId, updateData);

    await auditService.serviceRecordRevoked(
      userId,
      entityId,
      { customerId: record.customerId, reason, previousStatus },
      ip
    );

    return res.json({ success: true, message: `Unterschrift(en) wurden storniert. Status: ${updateData.status}` });
  }

  throw badRequest("Ungültiger Entity-Typ. Erlaubt: appointment, service_record");
}));

export default router;
