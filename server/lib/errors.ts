import { Request, Response, NextFunction } from "express";
import { fromError } from "zod-validation-error";
import { ZodError } from "zod";

export interface ApiError {
  code: string;
  message: string;
  details?: string;
}

export const ErrorCodes = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  FORBIDDEN: "FORBIDDEN",
  CONFLICT: "CONFLICT",
  SERVER_ERROR: "SERVER_ERROR",
  INVALID_REQUEST: "INVALID_REQUEST",
} as const;

export const ErrorMessages = {
  appointmentNotFound: "Termin nicht gefunden",
  customerNotFound: "Kunde nicht gefunden",
  invalidAppointmentId: "Ungültige Termin-ID",
  invalidCustomerId: "Ungültige Kunden-ID",
  timeOverlap: "Es gibt bereits einen Termin zu dieser Zeit",
  unreliableData: (id: number) => `Termin #${id} hat unvollständige Zeitdaten. Bitte vervollständigen Sie die Termindaten bevor Sie neue Termine planen.`,
  completedAppointmentImmutable: "Abgeschlossene Termine können nicht mehr geändert werden.",
  completedAppointmentNotDeletable: "Abgeschlossene Termine können nicht gelöscht werden.",
  invalidStatusTransition: "Der Status kann nur schrittweise vorwärts geändert werden.",
  schedulingFieldsLocked: "Zeit und Datum können nur bei geplanten Terminen geändert werden. Dieser Termin wurde bereits gestartet.",
  notesEditRestriction: "Notizen können nur bei geplanten oder dokumentierten Terminen bearbeitet werden.",
  startVisitRestriction: "Der Besuch kann nur bei einem geplanten Termin gestartet werden.",
  endVisitRestriction: "Der Besuch kann nur bei einem laufenden Termin beendet werden.",
  documentationRestriction: "Kilometer, erledigte Services und Unterschrift können erst nach dem Besuch dokumentiert werden.",
  createAppointmentFailed: "Der Termin konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
  createErstberatungFailed: "Die Erstberatung konnte nicht erstellt werden. Bitte versuchen Sie es erneut.",
  deleteAppointmentFailed: "Termin konnte nicht gelöscht werden",
  fetchAppointmentsFailed: "Fehler beim Laden der Termine",
  fetchAppointmentFailed: "Fehler beim Laden des Termins",
  updateAppointmentFailed: "Fehler beim Aktualisieren des Termins",
} as const;

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public error?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export function notFound(message: string): AppError {
  return new AppError(404, ErrorCodes.NOT_FOUND, message);
}

export function badRequest(message: string): AppError {
  return new AppError(400, ErrorCodes.INVALID_REQUEST, message);
}

export function forbidden(error: string, message: string): AppError {
  return new AppError(403, ErrorCodes.FORBIDDEN, message, error);
}

export function conflict(error: string, message: string): AppError {
  return new AppError(409, ErrorCodes.CONFLICT, message, error);
}

type AsyncRouteHandler = (req: Request, res: Response, next: NextFunction) => Promise<any>;

function extractUserFriendlyDbError(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const dbError = error as { code: string; message?: string; detail?: string; column?: string; where?: string };
    switch (dbError.code) {
      case "22P02": {
        const match = dbError.where?.match(/parameter \$\d+ = '(.+?)'/);
        const value = match?.[1];
        return value
          ? `Ungültiger Wert "${value}" — bitte prüfen Sie Ihre Eingaben (z.B. Dezimalzahlen mit Punkt statt Komma).`
          : "Ungültiger Datentyp — bitte prüfen Sie Ihre Eingaben.";
      }
      case "23505":
        return "Ein Eintrag mit diesen Daten existiert bereits.";
      case "23503":
        return "Ein referenzierter Datensatz wurde nicht gefunden. Bitte laden Sie die Seite neu.";
      case "23502":
        return "Ein Pflichtfeld wurde nicht ausgefüllt.";
      case "22003":
        return "Ein eingegebener Wert ist zu groß oder zu klein.";
      default:
        return null;
    }
  }
  return null;
}

export function asyncHandler(defaultMessage: string, handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res, next).catch((error: unknown) => {
      if (error instanceof AppError) {
        return next(error);
      }
      if (error instanceof ZodError) {
        return next(new AppError(400, ErrorCodes.VALIDATION_ERROR, fromError(error).toString()));
      }
      console.error(`Route error [${req.method} ${req.path}]:`, error);
      const friendlyMessage = extractUserFriendlyDbError(error);
      if (friendlyMessage) {
        return next(new AppError(400, ErrorCodes.VALIDATION_ERROR, friendlyMessage));
      }
      next(new AppError(500, ErrorCodes.SERVER_ERROR, defaultMessage, "Serverfehler"));
    });
  };
}

export function errorMiddleware(err: Error, _req: Request, res: Response, _next: NextFunction): void {
  if (err instanceof AppError) {
    const body: Record<string, string> = {
      code: err.code,
      message: err.message,
    };
    if (err.error) {
      body.error = err.error;
    }
    res.status(err.statusCode).json(body);
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      code: ErrorCodes.VALIDATION_ERROR,
      message: fromError(err).toString(),
    });
    return;
  }

  console.error("Unhandled error:", err);
  res.status(500).json({
    code: ErrorCodes.SERVER_ERROR,
    error: "Serverfehler",
    message: "Ein unerwarteter Fehler ist aufgetreten",
  });
}

export function handleZodError(res: Response, error: ZodError): void {
  res.status(400).json({
    code: ErrorCodes.VALIDATION_ERROR,
    message: fromError(error).toString(),
  });
}

export function sendNotFound(res: Response, message: string): void {
  res.status(404).json({
    code: ErrorCodes.NOT_FOUND,
    message,
  });
}

export function sendForbidden(res: Response, error: string, message: string): void {
  res.status(403).json({
    code: ErrorCodes.FORBIDDEN,
    error,
    message,
  });
}

export function sendConflict(res: Response, error: string, message: string): void {
  res.status(409).json({
    code: ErrorCodes.CONFLICT,
    error,
    message,
  });
}

export function sendBadRequest(res: Response, message: string): void {
  res.status(400).json({
    code: ErrorCodes.INVALID_REQUEST,
    message,
  });
}

export function sendServerError(res: Response, message: string): void {
  res.status(500).json({
    code: ErrorCodes.SERVER_ERROR,
    error: "Serverfehler",
    message,
  });
}

export function handleRouteError(
  res: Response, 
  error: unknown, 
  defaultMessage: string,
  logContext?: string
): void {
  if (error instanceof ZodError) {
    return handleZodError(res, error);
  }
  
  console.error(logContext || "Route error:", error);
  sendServerError(res, defaultMessage);
}
