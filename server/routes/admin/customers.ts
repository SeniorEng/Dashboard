import { Router, Request, Response } from "express";
import { ACTIVE_CUSTOMER_LIFECYCLES, type ActiveCustomerLifecycle } from "@shared/domain/customers/lifecycle";
import { storage } from "../../storage";
import { customerManagementStorage } from "../../storage/customer-management";
import { birthdaysCache } from "../../services/cache";
import { auditService } from "../../services/audit";
import { notificationService } from "../../services/notification-service";
import { geocodeCustomer } from "../../services/geocoding";
import { refreshDraftInvoicesForCustomerAddress } from "../../services/invoice-address-refresh";
import { validateGeburtsdatum } from "@shared/utils/datetime";
import { isPflegekasseCustomer, isSelbstzahlerCustomer } from "@shared/domain/customers";
import { validateSelbstzahlerBudget } from "@shared/domain/budget-selbstzahler-validator";
import { validatePflegegradBudget } from "@shared/domain/budget-pflegegrad-validator";
import { validate45aAmount, validate39_42aAmount, hasActiveBudgetPot } from "@shared/domain/budgets";
import { createCustomerRelatedData, buildCustomerInsertData } from "../../lib/customer-creation-helpers";
import { BudgetInitialSetupError } from "../../services/budget-initial-setup";
import { findCustomerDuplicates, findCustomerByVersichertennummer } from "../../lib/duplicate-check";
import { readTestFaults } from "../../lib/test-fault-injector";
import { hashPayload, reserveIdempotencyKey, finalizeIdempotencyReservation, releaseIdempotencyReservation, findRecentDuplicates } from "../../lib/idempotency";
import { 
  versichertennummerSchema,
  customers,
  type InsertCustomer,
  type Customer,
} from "@shared/schema";
import type { CustomerDetail } from "@shared/api";
import { internationalEmailSchema, optionalGermanPhoneSchema, validateVersichertennummerFor } from "@shared/schema/common";
import { asyncHandler } from "../../lib/errors";
import { requireIntParam, parseOptionalIntQuery } from "../../lib/params";
import { z } from "zod";
import { db } from "../../lib/db";
import { eq, and, sql, isNull, desc } from "drizzle-orm";
import { auditLog, users } from "@shared/schema";
import { customerBudgetTypeSettings } from "@shared/schema";

import assignmentsRouter from "./customers/assignments";
import budgetsRouter from "./customers/budgets";
import detailsRouter from "./customers/details";
import contractsRouter from "./customers/contracts";
import workflowsRouter from "./customers/workflows";

const router = Router();

// Task #724 (Option B) — zentrale Berechnung der Budget-Setup-Markierung.
// Wird sowohl beim Erstanlegen (auf Basis des Payloads) als auch beim
// Idempotency-Replay (auf Basis des IST-Zustands in der DB) verwendet,
// damit der Vertrag „erfolgreiche Customer-Create-Response enthält immer
// budgetSetupRequired + requiredBudgetTypes" lückenlos gilt.
const REQUIRED_STATUTORY_BUDGET_TYPES = [
  "entlastungsbetrag_45b",
  "umwandlung_45a",
  "ersatzpflege_39_42a",
] as const;

async function computeBudgetSetupMarkers(customer: Customer): Promise<{
  budgetSetupRequired: boolean;
  requiredBudgetTypes: string[];
}> {
  const isPflegekasse =
    customer.billingType === "pflegekasse_gesetzlich" ||
    customer.billingType === "pflegekasse_privat";
  // Selbstzahler haben keinen Anspruch auf gesetzliche Töpfe ⇒ nie „Setup nötig".
  if (!isPflegekasse) {
    return { budgetSetupRequired: false, requiredBudgetTypes: [] };
  }
  // Task #1828 — Nicht mehr „gibt es eine persistierte DB-Zeile?", sondern die
  // Aktivierungs-SSoT `hasActiveBudgetPot` (effectiveDefaultPots + persistierte
  // Overrides). §45b ist für Pflegekassen-Kunden default-aktiv (ohne Zeile),
  // daher feuert der Banner nur noch, wenn KEIN Topf aktiv ist (z. B. §45b
  // bewusst per offener Zeile deaktiviert). Kein Pflegegrad-Gate: §45b gilt
  // gesetzlich ab PG 1 und ist im Code nur über „Nicht-Selbstzahler" gegatet.
  const persistedRows = await db
    .select({
      budgetType: customerBudgetTypeSettings.budgetType,
      enabled: customerBudgetTypeSettings.enabled,
      validTo: customerBudgetTypeSettings.validTo,
    })
    .from(customerBudgetTypeSettings)
    .where(and(
      eq(customerBudgetTypeSettings.customerId, customer.id),
      isNull(customerBudgetTypeSettings.validTo),
    ));
  const hasActive = hasActiveBudgetPot({
    customer: { billingType: customer.billingType, pflegegrad: customer.pflegegrad },
    persisted: persistedRows,
  });
  if (hasActive) {
    return { budgetSetupRequired: false, requiredBudgetTypes: [] };
  }
  return {
    budgetSetupRequired: true,
    requiredBudgetTypes: [...REQUIRED_STATUTORY_BUDGET_TYPES],
  };
}

router.use("/", assignmentsRouter);
router.use("/", budgetsRouter);
router.use("/", detailsRouter);
router.use("/", contractsRouter);
router.use("/", workflowsRouter);

router.get("/customers/check-duplicate", asyncHandler("Duplikatprüfung fehlgeschlagen", async (req: Request, res: Response) => {
  const vorname = String(req.query.vorname || "").trim();
  const nachname = String(req.query.nachname || "").trim();
  const geburtsdatum = req.query.geburtsdatum ? String(req.query.geburtsdatum).trim() : null;
  const versichertennummer = req.query.versichertennummer ? String(req.query.versichertennummer).trim() : "";

  // Versichertennummer (Task #403): zusätzlicher Pre-Check vom Insurance-
  // Step. Der Wizard ruft den Endpunkt einmal mit Name (Personal-Step) und
  // einmal nur mit `versichertennummer` auf. Die zwei Treffer-Listen sind
  // bewusst getrennt, damit die UI für jeden Step eine eigene Meldung
  // zeigen kann (Name-Dialog vs. Inline-Hinweis am VNR-Feld).
  const duplicates = vorname && nachname
    ? await findCustomerDuplicates(vorname, nachname, geburtsdatum)
    : [];

  const versichertennummerDuplicates = versichertennummer
    ? await findCustomerByVersichertennummer(versichertennummer)
    : [];

  res.json({ duplicates, versichertennummerDuplicates });
}));

router.get("/customers", asyncHandler("Kunden konnten nicht geladen werden", async (req: Request, res: Response) => {
  const { search, pflegegrad, responsibleEmployeeId, primaryEmployeeId, status, billingType, insuranceProviderId, budgetSetupMissing, hasActiveContract, lifecycle, page, limit, sortBy, sortOrder } = req.query;
  
  const validSortBy = ["name", "contractStart", "createdAt"].includes(sortBy as string)
    ? (sortBy as "name" | "contractStart" | "createdAt")
    : undefined;
  const validSortOrder = ["asc", "desc"].includes(sortOrder as string)
    ? (sortOrder as "asc" | "desc")
    : undefined;

  let resolvedEmployeeId: number | "unassigned" | undefined;
  if ((responsibleEmployeeId as string) === "unassigned") {
    resolvedEmployeeId = "unassigned";
  } else if (responsibleEmployeeId !== undefined) {
    const v = parseOptionalIntQuery(responsibleEmployeeId, res, "responsibleEmployeeId");
    if (v === null) return;
    resolvedEmployeeId = v;
  } else {
    const v = parseOptionalIntQuery(primaryEmployeeId, res, "primaryEmployeeId");
    if (v === null) return;
    resolvedEmployeeId = v;
  }

  const pflegegradNum = parseOptionalIntQuery(pflegegrad, res, "pflegegrad");
  if (pflegegradNum === null) return;
  const insuranceProviderIdNum = parseOptionalIntQuery(insuranceProviderId, res, "insuranceProviderId");
  if (insuranceProviderIdNum === null) return;

  const filters = {
    search: search as string | undefined,
    pflegegrad: pflegegradNum,
    responsibleEmployeeId: resolvedEmployeeId,
    status: status as string | undefined,
    billingType: billingType as string | undefined,
    insuranceProviderId: insuranceProviderIdNum,
    // Task #729 — `?budgetSetupMissing=true` blendet pflegekasse-berechtigte
    // Kunden (PG ≥ 2) ohne aktive Topf-Settings ein. Andere Werte werden
    // ignoriert (kein impliziter Inverse-Filter).
    budgetSetupMissing: budgetSetupMissing === "true" ? true : undefined,
    // Task #1177 — `?hasActiveContract=false` listet Kunden „in Anlage"
    // (aktiv, aber noch ohne aktiven Vertrag); `true` nur mit Vertrag.
    hasActiveContract:
      hasActiveContract === "true" ? true : hasActiveContract === "false" ? false : undefined,
    // Lebenszyklus-Filter aktiver Kunden. Gegen die UNION geprueft, nicht
    // aufgezaehlt: die frueheren zwei Ternaries waren der vierte Ort, an dem
    // die Werte handgeschrieben standen — und der einzige, der beim Hinzufuegen
    // von `pausiert` vergessen wurde. Folge: der neue Chip schickte
    // `lifecycle=pausiert`, die Route machte daraus `undefined`, und die Liste
    // zeigte ALLE aktiven Kunden, waehrend der Chip daneben „Pausiert (3)"
    // behauptete. Der `never`-Guard in der Storage-Schicht konnte das nicht
    // fangen — der Wert verliess die Route nie.
    lifecycle: (ACTIVE_CUSTOMER_LIFECYCLES as readonly string[]).includes(lifecycle as string)
      ? (lifecycle as ActiveCustomerLifecycle)
      : undefined,
    sortBy: validSortBy,
    sortOrder: validSortOrder,
  };

  const pageNumOrNull = parseOptionalIntQuery(page, res, "page");
  if (pageNumOrNull === null) return;
  const limitNumOrNull = parseOptionalIntQuery(limit, res, "limit");
  if (limitNumOrNull === null) return;
  const pageNum = pageNumOrNull ?? 1;
  const limitNum = limitNumOrNull ?? 20;
  
  const result = await customerManagementStorage.getCustomersPaginated(filters, {
    limit: limitNum,
    offset: (pageNum - 1) * limitNum,
  });
  
  res.json({
    ...result,
    page: pageNum,
    totalPages: Math.ceil(result.total / result.limit),
  });
}));

router.get("/customers/unassigned-count", asyncHandler("Zählung konnte nicht geladen werden", async (_req: Request, res: Response) => {
  const count = await customerManagementStorage.getUnassignedActiveCustomerCount();
  res.json({ count });
}));

// Task #729 — Zähler für das „Budget-Einrichtung steht aus"-Banner in der
// Admin-Kundenliste. Spiegelt das Read-only-Audit-Skript
// `scripts/audit-customers-without-budget-init.ts` als HTTP-Endpoint.
router.get("/customers/budget-setup-missing-count", asyncHandler("Zählung konnte nicht geladen werden", async (_req: Request, res: Response) => {
  const result = await customerManagementStorage.getCustomersPaginated(
    { budgetSetupMissing: true, status: "active" },
    { limit: 1, offset: 0 },
  );
  res.json({ count: result.total });
}));

// Task #1194 — Aufteilung der aktiven Kunden nach Lebenszyklus
// (gesamt, nicht nur die aktuelle Seite). Spiegelt die reine Klassifikation in
// shared/domain/customers/lifecycle.ts. Speist die Filter-Chips + Split-Badge
// der server-paginierten Admin-Kundenliste.
router.get("/customers/lifecycle-counts", asyncHandler("Zählung konnte nicht geladen werden", async (_req: Request, res: Response) => {
  // Ueber die Union iterieren, nicht aufzaehlen: ein vierter Lebenszyklus-Wert
  // waere sonst in den Chips unsichtbar, obwohl die Klassifikation ihn kennt.
  const werte = ACTIVE_CUSTOMER_LIFECYCLES;
  const ergebnisse = await Promise.all(
    werte.map(w => customerManagementStorage.getCustomersPaginated(
      { status: "aktiv", lifecycle: w },
      { limit: 1, offset: 0 },
    )),
  );
  const zaehlung = Object.fromEntries(
    werte.map((w, i) => [w, ergebnisse[i].total]),
  ) as Record<ActiveCustomerLifecycle, number>;
  res.json(zaehlung);
}));

// Einzelkunden-Lesen läuft über `GET /api/customers/:id` (server/routes/customers.ts,
// SSoT, `storage.getCustomer`). Der frühere Admin-Duplikat-GET wurde entfernt
// (Task #932) — Admin-Konsumenten laden über `/customers/:id/details`.
router.get("/customers/:id/details", asyncHandler("Kunde konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await customerManagementStorage.getCustomerWithDetails(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  
  const response = {
    ...customer,
    currentInsurance: customer.insurance ? {
      id: customer.insurance.id,
      providerName: customer.insurance.provider?.name || "Unbekannt",
      ikNummer: customer.insurance.provider?.ikNummer || undefined,
      versichertennummer: customer.insurance.versichertennummer,
      validFrom: customer.insurance.validFrom,
    } : null,
    needsAssessment: customer.needsAssessment || null,
    currentContract: customer.contract ? {
      id: customer.contract.id,
      contractDate: customer.contract.contractDate,
      contractStart: customer.contract.contractStart,
      contractEnd: customer.contract.contractEnd,
      vereinbarteLeistungen: customer.contract.vereinbarteLeistungen,
      hoursPerPeriod: customer.contract.hoursPerPeriod,
      periodType: customer.contract.periodType,
      status: customer.contract.status,
      notes: customer.contract.notes,
    } : null,
    activeContractCount: customer.contract ? 1 : 0,
  };
  
  res.json(response as unknown as CustomerDetail);
}));

const simpleCreateCustomerSchema = z.object({
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]).default("pflegekasse_gesetzlich"),
  vorname: z.string().min(1, "Vorname ist erforderlich"),
  nachname: z.string().min(1, "Nachname ist erforderlich"),
  geburtsdatum: z.string().optional().nullable(),
  email: internationalEmailSchema.optional().nullable(),
  telefon: optionalGermanPhoneSchema,
  festnetz: optionalGermanPhoneSchema,
  strasse: z.string().min(1, "Straße ist erforderlich"),
  nr: z.string().min(1, "Hausnummer ist erforderlich"),
  plz: z.string().regex(/^\d{5}$/, "Ungültige PLZ (5 Stellen erwartet)"),
  stadt: z.string().min(1, "Stadt ist erforderlich"),
  pflegegrad: z.number().min(1, "Pflegegrad muss zwischen 1 und 5 liegen").max(5, "Pflegegrad muss zwischen 1 und 5 liegen").optional(),
  pflegegradSeit: z.string().optional(),
  vorerkrankungen: z.string().max(2000, "Maximal 2000 Zeichen erlaubt").optional().nullable(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500, "Maximal 500 Zeichen erlaubt").optional().nullable(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  acceptsPrivatePayment: z.boolean().optional(),
  rechnungAnKunde: z.boolean().optional(),
  beihilfeBerechtigt: z.boolean().optional(),
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  receivesMonthlyInvoice: z.boolean().optional(),
  insurance: z.object({
    providerId: z.number(),
    versichertennummer: z.string().min(3).max(20),
    validFrom: z.string(),
  }).optional(),
  contacts: z.array(z.object({
    contactType: z.string(),
    isPrimary: z.boolean(),
    vorname: z.string(),
    nachname: z.string(),
    festnetz: optionalGermanPhoneSchema,
    mobilnummer: optionalGermanPhoneSchema,
    email: z.string().optional(),
    notes: z.string().optional(),
  })).optional(),
  budgets: z.object({
    entlastungsbetrag45b: z.number(),
    verhinderungspflege39: z.number(),
    pflegesachleistungen36: z.number(),
    validFrom: z.string(),
    carryoverAmountCents: z.number().min(0, "Betrag darf nicht negativ sein").optional(),
    // Task #1213 — §45b-Restguthaben-Override (laufendes Jahr) als initial_balance,
    // sowie der zugehörige Stichmonat-Start (`YYYY-MM-01`). Ersetzt den früheren
    // separaten `POST /budget/:id/initial-budget`-Aufruf des Frontends.
    override45bCents: z.number().min(0, "Betrag darf nicht negativ sein").optional(),
    override45bStichmonatStart: z.string().optional().nullable(),
  }).optional(),
  // Task #1213 — Unterschriften + hochgeladene Dokumente fließen in DENSELBEN
  // Anlage-Request; PDFs werden server-seitig innerhalb der Anlage-Transaktion
  // generiert (kein separater Folge-Aufruf mehr).
  signatures: z.array(z.object({
    templateSlug: z.string().min(1),
    customerSignatureData: z.string().regex(/^data:image\/(png|jpeg);base64,/, "Ungültiges Signaturformat"),
  })).optional(),
  signingLocation: z.string().optional().nullable(),
  documents: z.array(z.object({
    documentTypeId: z.number().int(),
    fileName: z.string().min(1),
    objectPath: z.string().min(1),
  })).optional(),
  contract: z.object({
    contractStart: z.string(),
    contractDate: z.string().optional(),
    vereinbarteLeistungen: z.string().optional(),
    hoursPerPeriod: z.number(),
    periodType: z.string(),
    rates: z.array(z.object({
      serviceCategory: z.string(),
      hourlyRateCents: z.number(),
    })).optional(),
  }).optional(),
  skipDuplicateCheck: z.boolean().optional(),
  // Bestätigung des Wizard-Anwenders, dass er trotz Treffer in den
  // letzten 10 Minuten (gleicher Vor-/Nachname/optional Geburtsdatum)
  // wirklich einen weiteren Kunden anlegen will. Wird nur in Verbindung
  // mit `skipDuplicateCheck=true` und einem zusätzlichen 10-Min-Treffer
  // ausgewertet (Task #376).
  acknowledgeRecentDuplicate: z.boolean().optional(),
  primaryEmployeeId: z.number().int().positive().optional().nullable(),
  backupEmployeeId: z.number().int().positive().optional().nullable(),
  backupEmployeeId2: z.number().int().positive().optional().nullable(),
});

const IDEM_HEADER = "idempotency-key";

router.post("/customers", asyncHandler("Kunde konnte nicht erstellt werden", async (req: Request, res: Response) => {
  const data = simpleCreateCustomerSchema.parse(req.body);
  let _idemFinalized = false;
  let _idemReservationToRelease: number | null = null;
  const releaseIfNeeded = async () => {
    if (!_idemFinalized && _idemReservationToRelease !== null) {
      await releaseIdempotencyReservation(_idemReservationToRelease);
      _idemReservationToRelease = null;
    }
  };
  try {

  // Idempotency-Key: gleiche Kombination (Header + Payload-Hash) gibt den
  // bereits angelegten Kunden zurück. Abweichender Payload bei gleichem
  // Key liefert 409 IDEMPOTENCY_KEY_REUSED. TTL 24 h.
  const idempotencyKey = (req.header(IDEM_HEADER) || "").trim() || null;
  const payloadHash = idempotencyKey ? hashPayload({ ...data, _userId: req.user!.id }) : null;
  let idempotencyReservationId: number | null = null;
  if (idempotencyKey && payloadHash) {
    const reservation = await reserveIdempotencyKey(idempotencyKey, payloadHash, req.user!.id);
    if (reservation.status === "conflict") {
      res.status(409).json({
        error: "IDEMPOTENCY_KEY_REUSED",
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "Idempotency-Key wurde bereits mit einem anderen Datensatz verwendet.",
      });
      return;
    }
    if (reservation.status === "in_progress") {
      // Gleicher Key+Payload, aber Erstrequest noch in Bearbeitung.
      // 425 Too Early signalisiert „bitte erneut versuchen". Der Wizard
      // behandelt das wie Netzwerk-/Timeout-Fehler (retry-safe).
      res.status(425).json({
        error: "IDEMPOTENCY_IN_PROGRESS",
        code: "IDEMPOTENCY_IN_PROGRESS",
        message: "Erstanfrage wird noch verarbeitet. Bitte gleich erneut speichern.",
      });
      return;
    }
    if (reservation.status === "hit") {
      const existing = await storage.getCustomer(reservation.customerId);
      if (existing) {
        // Task #724 (Option B) — Markierung auch im Idempotency-Replay
        // konsistent ausliefern. Statt den ursprünglichen Payload neu zu
        // bewerten, lesen wir den IST-Zustand: hat der wiederhergestellte Kunde
        // keinen aktiven Topf, muss der Caller die Töpfe noch einrichten. Hat
        // er die Einrichtung zwischen Erstrequest und Retry abgeschlossen,
        // kippt der Marker korrekterweise auf false.
        //
        // Der Kommentar sagte bis eben „pflegekassenberechtigt (PG ≥ 2) und
        // KEINE aktive Zeile" — die Regel VOR #1828. Die Funktion entscheidet
        // seither über `hasActiveBudgetPot` und kennt kein Pflegegrad-Gate mehr
        // (§45b gilt ab PG 1). Für einen PR, der genau diese Drift beseitigt,
        // darf die letzte Beschreibung davon nicht stehenbleiben.
        const existingMarkers = await computeBudgetSetupMarkers(existing);
        res.status(200).json({ ...existing, idempotent: true, ...existingMarkers });
        return;
      }
    }
    if (reservation.status === "reserved") {
      idempotencyReservationId = reservation.reservationId;
      _idemReservationToRelease = reservation.reservationId;
    }
  }

  if (!data.skipDuplicateCheck) {
    const duplicates = await findCustomerDuplicates(data.vorname, data.nachname, data.geburtsdatum);
    if (duplicates.length > 0) {
      res.status(409).json({
        error: "DUPLICATE_WARNING",
        code: "DUPLICATE_WARNING",
        message: `Es existiert bereits ${duplicates.length === 1 ? "ein Kunde" : `${duplicates.length} Kunden`} mit gleichem Namen. Zum Anlegen "skipDuplicateCheck" setzen.`,
        details: { duplicates },
      });
      return;
    }
  } else if (!data.acknowledgeRecentDuplicate) {
    // Zusätzliche Server-Heuristik: Selbst wenn der Client die
    // Duplicate-Prüfung bewusst überspringt, halten wir bei Treffern in
    // den letzten 10 Minuten an und verlangen `acknowledgeRecentDuplicate`.
    // Schützt gegen Doppelklicks/Double-Submits aus dem Wizard.
    const recents = await findRecentDuplicates(data.vorname, data.nachname, data.geburtsdatum);
    if (recents.length > 0) {
      res.status(409).json({
        error: "RECENT_DUPLICATE_WARNING",
        code: "RECENT_DUPLICATE_WARNING",
        message: `In den letzten 10 Minuten wurde bereits ein Kunde mit gleichem Namen angelegt. Zum erneuten Anlegen "acknowledgeRecentDuplicate" setzen.`,
        details: { duplicates: recents.map(r => ({ id: r.id, vorname: r.vorname, nachname: r.nachname, createdAt: r.createdAt.toISOString(), ageMs: r.ageMs })) },
      });
      return;
    }
  }

  if (data.insurance?.versichertennummer) {
    const vnr = data.insurance.versichertennummer;
    const provider = await customerManagementStorage.getInsuranceProvider(data.insurance.providerId);
    const result = validateVersichertennummerFor(vnr, {
      billingType: data.billingType,
      isPrivateProvider: provider?.isPrivate ?? false,
    });
    if (!result.ok) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: result.message });
      return;
    }

    // Versichertennummer-Kollision (Task #403): Datenintegritätsprüfung —
    // dieselbe aktuelle VNR (validTo IS NULL) darf nicht doppelt vergeben
    // sein. Wenn der Wizard-Anwender bewusst trotz Treffer anlegen will
    // (Sonderfall, z.B. Datenkorrektur eines historischen Eintrags),
    // schaltet `skipDuplicateCheck=true` analog zur Namensprüfung den
    // Block ab — der Inline-Hinweis am VNR-Feld bleibt aber sichtbar.
    if (!data.skipDuplicateCheck) {
      const vnrDuplicates = await findCustomerByVersichertennummer(vnr);
      if (vnrDuplicates.length > 0) {
        res.status(409).json({
          error: "VERSICHERTENNUMMER_DUPLICATE",
          code: "VERSICHERTENNUMMER_DUPLICATE",
          message: `Versichertennummer ist bereits einem aktiven Kunden zugewiesen: ${vnrDuplicates.map(d => `${d.vorname ?? ""} ${d.nachname ?? ""}`.trim()).join(", ")}`,
          details: { versichertennummerDuplicates: vnrDuplicates },
        });
        return;
      }
    }
  }

  if (isPflegekasseCustomer(data.billingType)) {
    if (!data.geburtsdatum) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Geburtsdatum ist erforderlich für Pflegekasse-Kunden" });
      return;
    }
    if (!data.pflegegrad) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "Pflegegrad ist erforderlich für Pflegekasse-Kunden" });
      return;
    }
  }

  if (isSelbstzahlerCustomer(data.billingType)) {
    const effectiveDelivery = data.documentDeliveryMethod || "email";
    if (effectiveDelivery === "email" && (!data.email || !data.email.trim())) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: "E-Mail-Adresse ist erforderlich für den E-Mail-Versand bei Selbstzahlern" });
      return;
    }
  }

  const geburtsdatumError = validateGeburtsdatum(data.geburtsdatum);
  if (geburtsdatumError) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
    return;
  }

  const userId = req.user!.id;

  // Task #705 / #722 / #1168 — Statutorische Budget-Voraussetzungen auch im
  // Kundenanlage-Wizard / Create-Pfad durchsetzen, über dieselben shared
  // Validatoren wie PUT type-settings. Sonst würden ungültige Töpfe hier still
  // angelegt und erst beim ersten Booking-Versuch krachen:
  //  - §45b/§45a/§39-§42a sind Pflegekassenleistungen → für Selbstzahler tabu.
  //  - §45a/§39-§42a setzen Pflegegrad ≥ 2 voraus.
  //  - §45a-Monatslimit ≤ PG-Maximum, §39/§42a-Jahreslimit ≤ 3.539 €.
  // `data.budgets`-Beträge sind bereits in Cent normalisiert.
  if (data.budgets) {
    const pg = data.pflegegrad ?? null;
    // Pro Topf nur prüfen, wenn der Create-Payload ihn wirklich aktiviert
    // (Betrag > 0). amountError ist der pot-spezifische statutorische
    // Obergrenzen-Check (null = kein Betragslimit für diesen Topf).
    const budgetIntents: Array<{ budgetType: string; amountError: string | null }> = [];
    if ((data.budgets.entlastungsbetrag45b ?? 0) > 0) {
      budgetIntents.push({ budgetType: "entlastungsbetrag_45b", amountError: null });
    }
    if ((data.budgets.pflegesachleistungen36 ?? 0) > 0) {
      budgetIntents.push({
        budgetType: "umwandlung_45a",
        amountError: validate45aAmount(data.budgets.pflegesachleistungen36!, pg),
      });
    }
    if ((data.budgets.verhinderungspflege39 ?? 0) > 0) {
      budgetIntents.push({
        budgetType: "ersatzpflege_39_42a",
        amountError: validate39_42aAmount(data.budgets.verhinderungspflege39!),
      });
    }

    for (const intent of budgetIntents) {
      const sz = validateSelbstzahlerBudget({
        billingType: data.billingType,
        intent: { budgetType: intent.budgetType },
      });
      if (!sz.ok) {
        res.status(sz.httpStatus).json({ error: sz.code, code: sz.code, message: sz.message });
        return;
      }
      const pgCheck = validatePflegegradBudget({
        pflegegrad: pg,
        intent: { budgetType: intent.budgetType },
      });
      if (!pgCheck.ok) {
        res.status(pgCheck.httpStatus).json({ error: pgCheck.code, code: pgCheck.code, message: pgCheck.message });
        return;
      }
      if (intent.amountError) {
        res.status(400).json({ error: "VALIDATION_ERROR", message: intent.amountError });
        return;
      }
    }
  }

  const customerData = buildCustomerInsertData(data, userId);
  const testFaults = readTestFaults(req);

  // Atomare Customer-Anlage (Task #267): Pflicht-Cascade (Pflegegrad,
  // Insurance, Budget-Type-Settings, Vertrag/Raten) muss als Einheit
  // committen oder zurückrollen. Andernfalls bleibt der Customer als
  // "Halbleiche" zurück und stört Folge-Workflows (Termin-Anlage,
  // Rechnungslauf, §45b-Buchungen).
  // Task #705 — Bewusst KEINE Auto-Anlage von Budget-Töpfen: Das Wizard-UI
  // führt den Admin nach der Kundenanlage durch einen separaten Budget-
  // Schritt (`POST /api/budget/:customerId/initial-budget` + PUT
  // /type-settings), der die Pflegekassenleistungen (§45a, §45b, §39/§42a)
  // pro Kunde explizit konfiguriert. Wird `data.budgets` weggelassen,
  // bleiben die Töpfe absichtlich leer und müssen im Folgeschritt erfasst
  // werden — `createCustomerRelatedData` legt nichts implizit an.
  let customer: Awaited<ReturnType<typeof customerManagementStorage.createCustomerDirect>>;
  let warnings: string[];
  try {
    const result = await db.transaction(async (tx) => {
      const created = await customerManagementStorage.createCustomerDirect(customerData, tx);
      const w = await createCustomerRelatedData({
        customerId: created.id,
        userId,
        logPrefix: "POST /customers",
        billingType: data.billingType,
        pflegegrad: data.pflegegrad,
        pflegegradSeit: data.pflegegradSeit,
        insurance: data.insurance,
        contacts: data.contacts,
        budgets: data.budgets,
        contract: data.contract,
        customer: created,
        signatures: data.signatures,
        signingLocation: data.signingLocation,
        signingIp: req.ip || req.socket.remoteAddress || null,
        documents: data.documents,
        tx,
        testFaults,
      });
      return { customer: created, warnings: w };
    });
    customer = result.customer;
    warnings = result.warnings;
  } catch (err) {
    // Task #1213 — Typisierte Startbudget-Fehler (Selbstzahler-/Pflegegrad-/
    // §45b-Kappung) ins einheitliche Wire-Format übersetzen. Die Transaktion
    // ist bereits zurückgerollt — kein Orphan-Customer.
    if (err instanceof BudgetInitialSetupError) {
      await releaseIfNeeded();
      res.status(err.httpStatus).json({ error: err.code, code: err.code, message: err.message });
      return;
    }
    throw err;
  }

  // Task #724 (Option B) — Strukturierte Markierung im Response: müssen die
  // statutorischen Töpfe (§45b/§45a/§39-§42a) noch über
  // `POST /api/budget/:customerId/initial-budget` + `PUT .../type-settings`
  // eingerichtet werden? API-Konsumenten (Imports, Skripte, Drittsysteme)
  // sehen das damit eindeutig. Der Wizard triggert die Folge-Calls selbst —
  // die Markierung schadet ihm nicht (Frontend nutzt sie nicht).
  //
  // ERSETZT die frühere Inline-Regel an dieser Stelle
  // (`pflegekasse && pflegegrad >= 2 && !data.budgets`). Sie war eine zweite
  // Antwort auf dieselbe Frage: Task #1828 hat `computeBudgetSetupMarkers` auf
  // die Aktivierungs-SSoT `hasActiveBudgetPot` umgestellt und dabei das
  // Pflegegrad-Gate ausdrücklich entfernt (§45b gilt ab PG 1) — diese Kopie
  // führte es weiter. Folge: derselbe Kunde bekam beim Anlegen (201)
  // `true` und beim idempotenten Replay (200, `:406`) `false`.
  //
  // Der Aufruf steht weiter unten, NACH `finalizeIdempotencyReservation` —
  // Begründung dort.

  birthdaysCache.invalidateAll();

  // Notification an zugewiesene Mitarbeiter feuern, wenn beim Anlegen
  // bereits primary/backup/backup2 gesetzt wurden (G1). Self-Assign-Schutz
  // via actingUserId — wer sich selbst zuweist, bekommt keine Glocke.
  {
    const customerName = `${data.vorname} ${data.nachname}`;
    if (data.primaryEmployeeId) {
      notificationService.notifyCustomerAssigned(customer.id, customerName, data.primaryEmployeeId, "primary", userId);
    }
    if (data.backupEmployeeId) {
      notificationService.notifyCustomerAssigned(customer.id, customerName, data.backupEmployeeId, "backup", userId);
    }
    if (data.backupEmployeeId2) {
      notificationService.notifyCustomerAssigned(customer.id, customerName, data.backupEmployeeId2, "backup2", userId);
    }
  }

  auditService.customerCreated(userId, customer.id, {
    customerName: `${data.vorname} ${data.nachname}`,
    billingType: data.billingType,
  }, req.ip).catch(() => {});

  geocodeCustomer(customer.id).catch(err => console.error("[geocoding] Background geocoding failed:", err));

  import("../../startup/prospect-customer-matching")
    .then(({ matchNewCustomerToProspects }) =>
      matchNewCustomerToProspects(customer.id, data.vorname, data.nachname, data.telefon)
    )
    .catch(err => console.warn("[prospect-matching] Prospect-Abgleich nach Kundenanlage fehlgeschlagen:", err));

  const { generateInfoDocumentPdfs } = await import("../../services/document-pdf");
  generateInfoDocumentPdfs({
    customerId: customer.id,
    billingType: data.billingType,
    generatedByUserId: userId,
  }).catch(err => console.error("[info-docs] Background info doc generation failed:", err));

  if (idempotencyReservationId !== null) {
    await finalizeIdempotencyReservation(idempotencyReservationId, customer.id).catch(err => {
      console.warn("[idempotency] Failed to finalize reservation:", err);
    });
    _idemFinalized = true;
    _idemReservationToRelease = null;
  }

  // Marker erst HIER — nach dem Commit (liest den IST-Zustand, wie der
  // Replay-Pfad) UND nach dem Idempotency-Finalize.
  //
  // Die Reihenfolge ist nicht kosmetisch: Anders als die frühere Inline-Regel
  // ist das hier eine DB-Abfrage, also etwas, das werfen kann. Stünde sie vor
  // dem Finalize und schlüge fehl (DB-Hiccup, Pool erschöpft), gäbe es den
  // Kunden bereits, der Client sähe 500 — und das `finally` würde die
  // Idempotency-Reservierung FREIGEBEN. Ein Retry mit demselben Key wäre dann
  // kein Replay mehr, sondern eine Neuanlage: Doppelkunde.
  //
  // Hinter dem Finalize ist derselbe Fehlerfall harmlos: die Reservierung
  // steht, ein Retry landet im 200-Replay-Pfad (`:406`) und bekommt dort
  // dieselben Marker aus derselben Funktion.
  const { budgetSetupRequired, requiredBudgetTypes } = await computeBudgetSetupMarkers(customer);

  res.status(201).json({
    ...customer,
    warnings: warnings.length > 0 ? warnings : undefined,
    budgetSetupRequired,
    requiredBudgetTypes,
  });
  } finally {
    // Wenn der Handler ohne Finalize endet (z.B. 409 DUPLICATE_WARNING,
    // Validation-Error, Throw nach Reservierung), geben wir den Key wieder
    // frei, damit der Client mit korrigiertem Payload erneut anlegen kann
    // ohne IDEMPOTENCY_KEY_REUSED zu sehen.
    await releaseIfNeeded().catch(() => undefined);
  }
}));

// ============================================================
// Setup-Pending: Banner & Retry für Wizard-Folgeschritte (Task #376)
// ============================================================

const setupPendingBodySchema = z.object({
  signatures: z.object({
    items: z.array(z.object({
      templateSlug: z.string(),
      customerSignatureData: z.string(),
    })),
    signingLocation: z.string().nullable().optional(),
  }).optional(),
  documents: z.object({
    items: z.array(z.object({
      documentTypeId: z.number(),
      fileName: z.string(),
      objectPath: z.string(),
    })),
  }).optional(),
  budgets: z.object({
    items: z.array(z.object({
      budgetType: z.string(),
      // Task #731 — Alias `currentYearAmountCents` nach Release-Zyklus entfernt.
      currentMonthAmountCents: z.number(),
      carryoverAmountCents: z.number(),
      budgetStartDate: z.string(),
    })),
  }).optional(),
  delivery: z.object({
    method: z.string(),
  }).optional(),
});

router.post("/customers/:id/setup-pending", asyncHandler("Setup-Status konnte nicht gespeichert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const body = setupPendingBodySchema.parse(req.body);

  const existing = await storage.getCustomer(id);
  if (!existing) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  // Berechtigt sind: Admins, der Anlegende sowie zugewiesene Mitarbeiter
  // (primary/backup/backup2). Damit kann z.B. ein Kollege/eine Kollegin den
  // Folgeschritt direkt vom Kundenprofil aus wiederholen, statt am Banner zu
  // hängen, wenn der ursprüngliche Anlegende nicht greifbar ist.
  const uid = req.user!.id;
  const allowed =
    req.user!.isAdmin ||
    existing.createdByUserId === uid ||
    existing.primaryEmployeeId === uid ||
    existing.backupEmployeeId === uid ||
    existing.backupEmployeeId2 === uid;
  if (!allowed) {
    res.status(403).json({ error: "FORBIDDEN", message: "Keine Berechtigung" });
    return;
  }

  await db.update(customers).set({
    setupSignaturesPending: !!body.signatures,
    setupDocumentsPending: !!body.documents,
    setupBudgetsPending: !!body.budgets,
    setupDeliveryPending: !!body.delivery,
    setupPendingPayloads: body as unknown as Record<string, unknown>,
    updatedAt: new Date(),
  }).where(eq(customers.id, id));

  res.json({ success: true });
}));

// Wird vom Banner aufgerufen, NACHDEM der jeweilige Folgeschritt
// erfolgreich über die bestehenden Endpunkte (z.B. POST /customers/:id/
// signatures) wiederholt wurde. Entfernt das Pending-Flag und den
// gespeicherten Payload-Block für diesen Schritt. Damit bleibt die
// Retry-Logik vollständig im Frontend (Wiederverwendung der existierenden
// Endpunkte) und der Server muss nur den Status pflegen.
router.post("/customers/:id/setup-pending/:step/clear", asyncHandler("Status konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const step = req.params.step;
  const flagField =
    step === "signatures" ? "setupSignaturesPending" :
    step === "documents" ? "setupDocumentsPending" :
    step === "budgets" ? "setupBudgetsPending" :
    step === "delivery" ? "setupDeliveryPending" :
    null;
  if (!flagField) {
    res.status(400).json({ error: "VALIDATION_ERROR", message: "Unbekannter Schritt" });
    return;
  }
  const existing = await storage.getCustomer(id);
  if (!existing) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }
  // Authz konsistent mit POST /setup-pending: Admins, Anlegende und
  // zugewiesene Mitarbeiter (primary/backup/backup2). Siehe Kommentar oben.
  const uid = req.user!.id;
  const allowed =
    req.user!.isAdmin ||
    existing.createdByUserId === uid ||
    existing.primaryEmployeeId === uid ||
    existing.backupEmployeeId === uid ||
    existing.backupEmployeeId2 === uid;
  if (!allowed) {
    res.status(403).json({ error: "FORBIDDEN", message: "Keine Berechtigung" });
    return;
  }
  const payloads = { ...((existing.setupPendingPayloads || {}) as Record<string, unknown>) };
  delete payloads[step];
  await db.update(customers).set({
    [flagField]: false,
    setupPendingPayloads: Object.keys(payloads).length > 0 ? payloads : null,
    updatedAt: new Date(),
  }).where(eq(customers.id, id));
  res.json({ success: true });
}));

const VALID_CUSTOMER_STATUSES = ["aktiv", "inaktiv"] as const;

const updateCustomerSchema = z.object({
  vorname: z.string().min(1, "Vorname ist erforderlich").optional(),
  nachname: z.string().min(1, "Nachname ist erforderlich").optional(),
  billingType: z.enum(["pflegekasse_gesetzlich", "pflegekasse_privat", "selbstzahler"]).optional(),
  geburtsdatum: z.string().nullable().optional(),
  email: internationalEmailSchema.nullable().optional(),
  festnetz: optionalGermanPhoneSchema,
  telefon: optionalGermanPhoneSchema,
  strasse: z.string().min(1, "Straße ist erforderlich").optional(),
  nr: z.string().min(1, "Hausnummer ist erforderlich").optional(),
  plz: z.string().regex(/^\d{5}$/, "Ungültige PLZ (5 Stellen erwartet)").optional(),
  stadt: z.string().min(1, "Stadt ist erforderlich").optional(),
  status: z.enum(VALID_CUSTOMER_STATUSES).optional(),
  primaryEmployeeId: z.number().nullable().optional(),
  backupEmployeeId: z.number().nullable().optional(),
  backupEmployeeId2: z.number().nullable().optional(),
  vorerkrankungen: z.string().max(2000, "Maximal 2000 Zeichen erlaubt").nullable().optional(),
  haustierVorhanden: z.boolean().optional(),
  haustierDetails: z.string().max(500, "Maximal 500 Zeichen erlaubt").nullable().optional(),
  personenbefoerderungGewuenscht: z.boolean().optional(),
  documentDeliveryMethod: z.enum(["email", "post"]).optional(),
  receivesMonthlyInvoice: z.boolean().optional(),
  acceptsPrivatePayment: z.boolean().optional(),
  rechnungAnKunde: z.boolean().optional(),
  beihilfeBerechtigt: z.boolean().optional(),
  inaktivAb: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ungültiges Datumsformat (YYYY-MM-DD erwartet)").nullable().optional(),
  deactivationReason: z.string().nullable().optional(),
  deactivationNote: z.string().max(1000, "Maximal 1000 Zeichen erlaubt").nullable().optional(),
  skipDuplicateCheck: z.boolean().optional(),
});

router.patch("/customers/:id", asyncHandler("Kunde konnte nicht aktualisiert werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const parsed = updateCustomerSchema.parse(req.body);
  const { skipDuplicateCheck, ...validatedData } = parsed;

  if (validatedData.geburtsdatum !== undefined) {
    const geburtsdatumError = validateGeburtsdatum(validatedData.geburtsdatum);
    if (geburtsdatumError) {
      res.status(400).json({ error: "VALIDATION_ERROR", message: geburtsdatumError });
      return;
    }
  }

  const existingCustomer = await storage.getCustomer(id);
  if (!existingCustomer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const nameChanging = (validatedData.vorname !== undefined && validatedData.vorname !== existingCustomer.vorname)
    || (validatedData.nachname !== undefined && validatedData.nachname !== existingCustomer.nachname);

  if (nameChanging && !skipDuplicateCheck) {
    const checkVorname = validatedData.vorname ?? existingCustomer.vorname ?? "";
    const checkNachname = validatedData.nachname ?? existingCustomer.nachname ?? "";
    const checkGeburtsdatum = validatedData.geburtsdatum !== undefined
      ? validatedData.geburtsdatum
      : existingCustomer.geburtsdatum;
    const duplicates = await findCustomerDuplicates(checkVorname, checkNachname, checkGeburtsdatum, id);
    if (duplicates.length > 0) {
      res.status(409).json({
        error: "DUPLICATE_WARNING",
        code: "DUPLICATE_WARNING",
        message: `Es existiert bereits ${duplicates.length === 1 ? "ein Kunde" : `${duplicates.length} Kunden`} mit gleichem Namen. Zum Speichern "skipDuplicateCheck" setzen.`,
        details: { duplicates },
      });
      return;
    }
  }

  const changedFields: string[] = [];
  const oldValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(validatedData)) {
    const oldVal = (existingCustomer as Record<string, unknown>)[key];
    if (oldVal !== value) {
      changedFields.push(key);
      oldValues[key] = oldVal;
      newValues[key] = value;
    }
  }

  const customer = await customerManagementStorage.updateCustomer(id, validatedData);
  
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  if (changedFields.length > 0) {
    await auditService.customerUpdated(req.user!.id, id, { changedFields, oldValues, newValues }, req.ip);
  }

  const addressChanged = changedFields.some(f => ["strasse", "nr", "plz", "stadt"].includes(f));
  if (addressChanged) {
    geocodeCustomer(id).catch(err => console.error("[geocoding] Background geocoding failed:", err));
    // Task #1030 — Entwurf-Rechnungen tragen die Kunden-Stammadresse (als
    // Rechnungsempfänger bei Selbstzahler/Kostenerstattung bzw. als
    // „Leistungsempfänger" auf dem Leistungsnachweis). Bei einer Adressänderung
    // im Hintergrund neu auflösen + betroffene PDFs neu rendern. Versendete/
    // stornierte Rechnungen bleiben unangetastet (GoBD).
    void refreshDraftInvoicesForCustomerAddress(id).catch(err =>
      console.error(`[billing] Entwurf-Rechnungs-Adressaktualisierung für Kunde ${id} fehlgeschlagen:`, err));
  }
  
  birthdaysCache.invalidateAll();
  
  res.json(customer);
}));

router.get("/customers/:id/timeline", asyncHandler("Timeline konnte nicht geladen werden", async (req: Request, res: Response) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const customer = await storage.getCustomer(id);
  if (!customer) {
    res.status(404).json({ error: "NOT_FOUND", message: "Kunde nicht gefunden" });
    return;
  }

  const { entries: directEntries } = await auditService.getEntries({
    entityType: "customer",
    entityId: id,
    limit: 50,
    offset: 0,
  });

  const relatedEntries = await db
    .select({
      id: auditLog.id,
      action: auditLog.action,
      userName: users.displayName,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .innerJoin(users, eq(auditLog.userId, users.id))
    .where(
      and(
        sql`${auditLog.metadata} @> ${JSON.stringify({ customerId: id })}::jsonb`,
        sql`${auditLog.entityType} != 'customer'`
      )
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(50);

  const directIds = new Set(directEntries.map(e => e.id));
  const merged = [
    ...directEntries.map(entry => ({
      id: entry.id,
      action: entry.action,
      userName: entry.userName,
      metadata: entry.metadata,
      createdAt: entry.createdAt,
    })),
    ...relatedEntries.filter(e => !directIds.has(e.id)),
  ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
   .slice(0, 50);

  res.json(merged);
}));

export default router;
