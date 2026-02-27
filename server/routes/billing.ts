import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest, notFound } from "../lib/errors";
import {
  createInvoiceSchema,
  updateInvoiceStatusSchema,
  appointments,
  appointmentServices as appointmentServicesTable,
  services as servicesTable,
  users,
  customerInsuranceHistory,
  insuranceProviders,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  serviceRecordAppointments,
} from "@shared/schema";
import type { Invoice, InvoiceLineItem, CompanySettings } from "@shared/schema";
import { eq, and, gte, lte, isNull, inArray, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { formatDateForDisplay, formatDateISO, todayISO } from "@shared/utils/datetime";
import { storage } from "../storage";
import { db } from "../lib/db";
import { auditService } from "../services/audit";
import type { InvoicePdfData } from "../lib/pdf-generator";

interface BuildLineItem extends Record<string, unknown> {
  appointmentId: number;
  appointmentDate: string;
  serviceDescription: string;
  serviceCode: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  unitPriceCents: number;
  totalCents: number;
  employeeName: string;
  employeeLbnr: string;
  appointmentNotes: string | null;
}

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

async function getAlreadyInvoicedAppointmentIds(customerId: number, billingYear: number, billingMonth: number): Promise<number[]> {
  const rows = await db.select({ appointmentId: invoiceLineItems.appointmentId })
    .from(invoiceLineItems)
    .innerJoin(invoicesTable, eq(invoiceLineItems.invoiceId, invoicesTable.id))
    .where(and(
      eq(invoicesTable.customerId, customerId),
      eq(invoicesTable.billingYear, billingYear),
      eq(invoicesTable.billingMonth, billingMonth),
      ne(invoicesTable.status, "storniert"),
      ne(invoicesTable.invoiceType, "stornorechnung")
    ));
  return rows.map(r => r.appointmentId).filter((id): id is number => id !== null);
}

async function getServiceRecordsForPeriod(customerId: number, year: number, month: number) {
  return db.select()
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.customerId, customerId),
      eq(monthlyServiceRecords.year, year),
      eq(monthlyServiceRecords.month, month)
    ));
}

async function getAppointmentIdsFromServiceRecords(serviceRecordIds: number[]): Promise<number[]> {
  if (serviceRecordIds.length === 0) return [];
  const rows = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(inArray(serviceRecordAppointments.serviceRecordId, serviceRecordIds));
  return rows.map(r => r.appointmentId);
}

async function buildLineItemsFromAppointments(apptIds: number[]) {
  if (apptIds.length === 0) return { lineItems: [], totalNetCents: 0, totalVatCents: 0 };

  const appts = await db.select()
    .from(appointments)
    .where(and(inArray(appointments.id, apptIds), isNull(appointments.deletedAt)));

  const serviceBreakdown = await db.select({
    appointmentId: appointmentServicesTable.appointmentId,
    serviceCode: servicesTable.code,
    serviceName: servicesTable.name,
    plannedDurationMinutes: appointmentServicesTable.plannedDurationMinutes,
    actualDurationMinutes: appointmentServicesTable.actualDurationMinutes,
    defaultPriceCents: servicesTable.defaultPriceCents,
    vatRate: servicesTable.vatRate,
  })
  .from(appointmentServicesTable)
  .innerJoin(servicesTable, eq(appointmentServicesTable.serviceId, servicesTable.id))
  .where(inArray(appointmentServicesTable.appointmentId, apptIds));

  const lineItems: BuildLineItem[] = [];
  let totalNetCents = 0;
  let totalVatCents = 0;

  for (const appt of appts) {
    const apptServices = serviceBreakdown.filter(s => s.appointmentId === appt.id);

    let employeeName = "";
    let employeeLbnr = "";
    const employeeId = appt.assignedEmployeeId || appt.performedByEmployeeId;
    if (employeeId) {
      const [emp] = await db.select({ displayName: users.displayName, lbnr: users.lbnr }).from(users).where(eq(users.id, employeeId));
      if (emp) {
        employeeName = emp.displayName;
        employeeLbnr = emp.lbnr || "";
      }
    }

    for (const svc of apptServices) {
      const durationMinutes = svc.actualDurationMinutes ?? svc.plannedDurationMinutes;
      const pricePer60Min = svc.defaultPriceCents || 0;
      const totalCents = Math.round((durationMinutes / 60) * pricePer60Min);
      const vatBasisPoints = svc.vatRate || 0;
      const vatCents = Math.round(totalCents * vatBasisPoints / 10000);

      lineItems.push({
        appointmentId: appt.id,
        appointmentDate: appt.date,
        serviceDescription: svc.serviceName || svc.serviceCode || "Dienstleistung",
        serviceCode: svc.serviceCode,
        startTime: appt.actualStart || appt.scheduledStart,
        endTime: appt.actualEnd || appt.scheduledEnd,
        durationMinutes,
        unitPriceCents: pricePer60Min,
        totalCents,
        employeeName,
        employeeLbnr,
        appointmentNotes: appt.notes || null,
      });

      totalNetCents += totalCents;
      totalVatCents += vatCents;
    }
  }

  return { lineItems, totalNetCents, totalVatCents };
}

router.get("/", asyncHandler("Rechnungen konnten nicht geladen werden", async (req, res) => {
  const filters: { year?: number; month?: number; customerId?: number; status?: string } = {};
  if (req.query.year) filters.year = Number(req.query.year);
  if (req.query.month) filters.month = Number(req.query.month);
  if (req.query.customerId) filters.customerId = Number(req.query.customerId);
  if (req.query.status) filters.status = String(req.query.status);
  const invoices = await storage.getInvoices(filters);
  res.json(invoices);
}));

router.get("/:id", asyncHandler("Rechnung konnte nicht geladen werden", async (req, res) => {
  const id = Number(req.params.id);
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  const lineItems = await storage.getInvoiceLineItems(id);
  res.json({ ...invoice, lineItems });
}));

router.post("/generate", asyncHandler("Rechnung konnte nicht erstellt werden", async (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }

  const { customerId, billingMonth, billingYear } = parsed.data;

  const customer = await storage.getCustomer(customerId);
  if (!customer) throw notFound("Kunde nicht gefunden");

  if (customer.status === "erstberatung") {
    throw badRequest("Kunden in Erstberatung können nicht abgerechnet werden.");
  }

  const serviceRecords = await getServiceRecordsForPeriod(customerId, billingYear, billingMonth);
  if (serviceRecords.length === 0) {
    throw badRequest("Kein Leistungsnachweis für diesen Zeitraum vorhanden. Bitte erstellen Sie zuerst einen Leistungsnachweis im Bereich 'Nachweise'.");
  }

  const signedRecords = serviceRecords.filter(sr =>
    sr.status === "completed" || sr.status === "employee_signed"
  );
  if (signedRecords.length === 0) {
    throw badRequest("Der Leistungsnachweis wurde noch nicht unterschrieben. Bitte lassen Sie den Leistungsnachweis zuerst vom Mitarbeiter unterschreiben.");
  }

  const serviceRecordIds = signedRecords.map(sr => sr.id);
  const allApptIds = await getAppointmentIdsFromServiceRecords(serviceRecordIds);

  if (allApptIds.length === 0) {
    throw badRequest("Der Leistungsnachweis enthält keine Termine.");
  }

  const alreadyInvoicedIds = await getAlreadyInvoicedAppointmentIds(customerId, billingYear, billingMonth);
  const isNachberechnung = alreadyInvoicedIds.length > 0;

  const apptIds = alreadyInvoicedIds.length > 0
    ? allApptIds.filter(id => !alreadyInvoicedIds.includes(id))
    : allApptIds;

  if (apptIds.length === 0) {
    throw badRequest("Alle Termine aus dem Leistungsnachweis wurden bereits abgerechnet.");
  }

  const { lineItems, totalNetCents, totalVatCents } = await buildLineItemsFromAppointments(apptIds);

  const billingType = customer.billingType || "selbstzahler";
  let recipientName = "";
  let recipientAddress = "";
  let insuranceProviderName = "";
  let insuranceIkNummer = "";
  let versichertennummer = "";

  const customerName = customer.vorname && customer.nachname
    ? `${customer.vorname} ${customer.nachname}`
    : customer.name || "Unbekannt";
  const customerAddress = [customer.strasse, customer.nr].filter(Boolean).join(" ") +
    (customer.plz || customer.stadt ? `\n${customer.plz || ""} ${customer.stadt || ""}` : "");

  if (billingType === "pflegekasse_gesetzlich") {
    const insuranceData = await db.select({
      providerName: insuranceProviders.name,
      ikNummer: insuranceProviders.ikNummer,
      versichertennummer: customerInsuranceHistory.versichertennummer,
    })
    .from(customerInsuranceHistory)
    .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
    .where(and(
      eq(customerInsuranceHistory.customerId, customerId),
      isNull(customerInsuranceHistory.validTo)
    ))
    .limit(1);

    if (insuranceData.length > 0) {
      recipientName = insuranceData[0].providerName;
      insuranceProviderName = insuranceData[0].providerName;
      insuranceIkNummer = insuranceData[0].ikNummer;
      versichertennummer = insuranceData[0].versichertennummer;
    } else {
      recipientName = customerName;
    }
    recipientAddress = "";
  } else {
    recipientName = customerName;
    recipientAddress = customerAddress;

    if (billingType === "pflegekasse_privat") {
      const insuranceData = await db.select({
        providerName: insuranceProviders.name,
        ikNummer: insuranceProviders.ikNummer,
        versichertennummer: customerInsuranceHistory.versichertennummer,
      })
      .from(customerInsuranceHistory)
      .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
      .where(and(
        eq(customerInsuranceHistory.customerId, customerId),
        isNull(customerInsuranceHistory.validTo)
      ))
      .limit(1);

      if (insuranceData.length > 0) {
        insuranceProviderName = insuranceData[0].providerName;
        insuranceIkNummer = insuranceData[0].ikNummer;
        versichertennummer = insuranceData[0].versichertennummer;
      }
    }
  }

  const invoiceNumber = await storage.getNextInvoiceNumber(billingYear);

  const invoiceData = {
    invoiceNumber,
    customerId,
    billingType,
    invoiceType: isNachberechnung ? "nachberechnung" : "rechnung",
    billingMonth,
    billingYear,
    recipientName,
    recipientAddress,
    customerName,
    insuranceProviderName: insuranceProviderName || null,
    insuranceIkNummer: insuranceIkNummer || null,
    versichertennummer: versichertennummer || null,
    pflegegrad: customer.pflegegrad || null,
    netAmountCents: totalNetCents,
    vatAmountCents: totalVatCents,
    grossAmountCents: totalNetCents + totalVatCents,
    vatRate: 0,
    status: "entwurf",
  };

  const invoice = await storage.createInvoice(invoiceData, lineItems as Record<string, unknown>[], req.user!.id);

  await auditService.log(req.user!.id, "invoice_created", "invoice", invoice.id, {
    invoiceNumber,
    customerId,
    billingType,
    invoiceType: isNachberechnung ? "nachberechnung" : "rechnung",
    billingMonth,
    billingYear,
    grossAmountCents: totalNetCents + totalVatCents,
    lineItemCount: lineItems.length,
  }, req.ip);

  res.json(invoice);
}));

router.post("/generate-batch", asyncHandler("Sammelrechnung konnte nicht erstellt werden", async (req, res) => {
  const schema = z.object({
    billingMonth: z.number().int().min(1).max(12),
    billingYear: z.number().int().min(2020).max(2100),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }

  const { billingMonth, billingYear } = parsed.data;

  const allServiceRecords = await db.select()
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.year, billingYear),
      eq(monthlyServiceRecords.month, billingMonth)
    ));

  const uniqueCustomerIds = Array.from(new Set(allServiceRecords.map(sr => sr.customerId)));

  if (uniqueCustomerIds.length === 0) {
    return res.json({ created: 0, skipped: 0, errors: [], message: "Keine Leistungsnachweise für diesen Zeitraum vorhanden." });
  }

  const results: { created: number; skipped: { customerName: string; reason: string }[]; errors: { customerId: number; customerName: string; reason: string }[] } = {
    created: 0,
    skipped: [],
    errors: [],
  };

  for (const customerId of uniqueCustomerIds) {
    try {
      const customer = await storage.getCustomer(customerId);
      const custName = customer ? (customer.vorname && customer.nachname ? `${customer.vorname} ${customer.nachname}` : customer.name) : `Kunde #${customerId}`;

      if (!customer) {
        results.skipped.push({ customerName: custName, reason: "Kunde nicht gefunden" });
        continue;
      }

      if (customer.status === "erstberatung") {
        results.skipped.push({ customerName: custName, reason: "Erstberatung (nicht abrechenbar)" });
        continue;
      }

      const customerRecords = allServiceRecords.filter(sr => sr.customerId === customerId);
      const signedRecords = customerRecords.filter(sr =>
        sr.status === "completed" || sr.status === "employee_signed"
      );

      if (signedRecords.length === 0) {
        results.skipped.push({ customerName: custName, reason: "Leistungsnachweis nicht unterschrieben" });
        continue;
      }

      const serviceRecordIds = signedRecords.map(sr => sr.id);
      const allApptIds = await getAppointmentIdsFromServiceRecords(serviceRecordIds);

      if (allApptIds.length === 0) {
        results.skipped.push({ customerName: custName, reason: "Leistungsnachweis ohne Termine" });
        continue;
      }

      const alreadyInvoicedIds = await getAlreadyInvoicedAppointmentIds(customerId, billingYear, billingMonth);
      const isNachberechnung = alreadyInvoicedIds.length > 0;

      const apptIds = alreadyInvoicedIds.length > 0
        ? allApptIds.filter(id => !alreadyInvoicedIds.includes(id))
        : allApptIds;

      if (apptIds.length === 0) {
        results.skipped.push({ customerName: custName, reason: alreadyInvoicedIds.length > 0 ? "Alle Termine bereits abgerechnet" : "Keine Termine" });
        continue;
      }

      const { lineItems, totalNetCents, totalVatCents } = await buildLineItemsFromAppointments(apptIds);

      const billingType = customer.billingType || "selbstzahler";
      const customerName = customer.vorname && customer.nachname
        ? `${customer.vorname} ${customer.nachname}`
        : customer.name || "Unbekannt";
      const customerAddress = [customer.strasse, customer.nr].filter(Boolean).join(" ") +
        (customer.plz || customer.stadt ? `\n${customer.plz || ""} ${customer.stadt || ""}` : "");

      let recipientName = customerName;
      let recipientAddress = customerAddress;
      let insuranceProviderName = "";
      let insuranceIkNummer = "";
      let versichertennummer = "";

      if (billingType === "pflegekasse_gesetzlich" || billingType === "pflegekasse_privat") {
        const insuranceData = await db.select({
          providerName: insuranceProviders.name,
          ikNummer: insuranceProviders.ikNummer,
          versichertennummer: customerInsuranceHistory.versichertennummer,
        })
        .from(customerInsuranceHistory)
        .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
        .where(and(
          eq(customerInsuranceHistory.customerId, customerId),
          isNull(customerInsuranceHistory.validTo)
        ))
        .limit(1);

        if (insuranceData.length > 0) {
          insuranceProviderName = insuranceData[0].providerName;
          insuranceIkNummer = insuranceData[0].ikNummer;
          versichertennummer = insuranceData[0].versichertennummer;
          if (billingType === "pflegekasse_gesetzlich") {
            recipientName = insuranceData[0].providerName;
            recipientAddress = "";
          }
        }
      }

      const invoiceNumber = await storage.getNextInvoiceNumber(billingYear);
      const invoiceData = {
        invoiceNumber,
        customerId,
        billingType,
        invoiceType: isNachberechnung ? "nachberechnung" : "rechnung",
        billingMonth,
        billingYear,
        recipientName,
        recipientAddress,
        customerName,
        insuranceProviderName: insuranceProviderName || null,
        insuranceIkNummer: insuranceIkNummer || null,
        versichertennummer: versichertennummer || null,
        pflegegrad: customer.pflegegrad || null,
        netAmountCents: totalNetCents,
        vatAmountCents: totalVatCents,
        grossAmountCents: totalNetCents + totalVatCents,
        vatRate: 0,
        status: "entwurf",
      };

      await storage.createInvoice(invoiceData, lineItems as Record<string, unknown>[], req.user!.id);
      results.created++;
    } catch (err: unknown) {
      const customer = await storage.getCustomer(customerId);
      const name = customer ? (customer.vorname && customer.nachname ? `${customer.vorname} ${customer.nachname}` : customer.name) : `ID ${customerId}`;
      results.errors.push({ customerId, customerName: name || `ID ${customerId}`, reason: err instanceof Error ? err.message : "Unbekannter Fehler" });
    }
  }

  res.json(results);
}));

router.patch("/:id/status", asyncHandler("Status konnte nicht aktualisiert werden", async (req, res) => {
  const id = Number(req.params.id);
  const parsed = updateInvoiceStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }

  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  const { status } = parsed.data;
  const currentStatus = invoice.status;

  const allowedTransitions: Record<string, string[]> = {
    entwurf: ["versendet", "storniert"],
    versendet: ["bezahlt", "storniert"],
    bezahlt: ["storniert"],
    storniert: [],
  };

  if (!allowedTransitions[currentStatus]?.includes(status)) {
    throw badRequest(`Statuswechsel von "${currentStatus}" zu "${status}" ist nicht erlaubt.`);
  }

  if (status === "storniert") {
    if (invoice.invoiceType === "stornorechnung") {
      throw badRequest("Stornorechnungen können nicht erneut storniert werden.");
    }
    const invoiceNumber = await storage.getNextInvoiceNumber(invoice.billingYear);
    const lineItems = await storage.getInvoiceLineItems(id);

    const stornoData = {
      invoiceNumber,
      customerId: invoice.customerId,
      billingType: invoice.billingType,
      invoiceType: "stornorechnung",
      billingMonth: invoice.billingMonth,
      billingYear: invoice.billingYear,
      recipientName: invoice.recipientName,
      recipientAddress: invoice.recipientAddress,
      customerName: invoice.customerName,
      insuranceProviderName: invoice.insuranceProviderName,
      insuranceIkNummer: invoice.insuranceIkNummer,
      versichertennummer: invoice.versichertennummer,
      pflegegrad: invoice.pflegegrad,
      netAmountCents: -invoice.netAmountCents,
      vatAmountCents: -invoice.vatAmountCents,
      grossAmountCents: -invoice.grossAmountCents,
      vatRate: invoice.vatRate,
      status: "versendet",
      stornierteRechnungId: id,
    };

    const stornoLineItems = lineItems.map((item: InvoiceLineItem) => ({
      appointmentId: item.appointmentId,
      appointmentDate: item.appointmentDate,
      serviceDescription: item.serviceDescription,
      serviceCode: item.serviceCode,
      startTime: item.startTime,
      endTime: item.endTime,
      durationMinutes: item.durationMinutes,
      unitPriceCents: item.unitPriceCents,
      totalCents: -item.totalCents,
      employeeName: item.employeeName,
      employeeLbnr: item.employeeLbnr,
      appointmentNotes: item.appointmentNotes || null,
    }));

    const stornoInvoice = await storage.createInvoice(stornoData, stornoLineItems, req.user!.id);

    await auditService.log(req.user!.id, "invoice_cancelled", "invoice", id, {
      originalInvoiceNumber: invoice.invoiceNumber,
      stornoInvoiceId: stornoInvoice.id,
      stornoInvoiceNumber: invoiceNumber,
      customerId: invoice.customerId,
      grossAmountCents: invoice.grossAmountCents,
      oldStatus: currentStatus,
      newStatus: status,
    }, req.ip);
  }

  const updated = await storage.updateInvoiceStatus(id, status, req.user!.id);
  res.json(updated);
}));

function buildPdfData(invoice: Invoice, lineItems: InvoiceLineItem[], companySettings: CompanySettings): InvoicePdfData {
  return {
    companyName: companySettings.companyName || "",
    companyAddress: [
      [companySettings.strasse, companySettings.hausnummer].filter(Boolean).join(" "),
      [companySettings.plz, companySettings.stadt].filter(Boolean).join(" "),
    ].filter(Boolean).join(", "),
    companyPhone: companySettings.telefon || "",
    companyEmail: companySettings.email || "",
    companyWebsite: companySettings.website ?? null,
    steuernummer: companySettings.steuernummer ?? null,
    ustId: companySettings.ustId ?? null,
    iban: companySettings.iban || "",
    bic: companySettings.bic || "",
    bankName: companySettings.bankName || "",
    ikNummer: companySettings.ikNummer ?? null,
    anerkennungsnummer45a: companySettings.anerkennungsnummer45a ?? null,
    anerkennungsBundesland: companySettings.anerkennungsBundesland ?? null,
    geschaeftsfuehrer: companySettings.geschaeftsfuehrer ?? null,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.sentAt ? formatDateForDisplay(formatDateISO(invoice.sentAt)) : formatDateForDisplay(todayISO()),
    invoiceType: invoice.invoiceType,
    billingType: invoice.billingType,
    billingMonth: invoice.billingMonth,
    billingYear: invoice.billingYear,
    recipientName: invoice.recipientName,
    recipientAddress: invoice.recipientAddress ?? null,
    insuranceProviderName: invoice.insuranceProviderName ?? null,
    insuranceIkNummer: invoice.insuranceIkNummer ?? null,
    versichertennummer: invoice.versichertennummer ?? null,
    pflegegrad: invoice.pflegegrad ?? null,
    customerName: invoice.customerName || invoice.recipientName,
    customerAddress: invoice.recipientAddress || "",
    lineItems: lineItems.map((item: InvoiceLineItem) => ({
      appointmentDate: item.appointmentDate,
      startTime: item.startTime ?? null,
      endTime: item.endTime ?? null,
      serviceDescription: item.serviceDescription,
      serviceCode: item.serviceCode || null,
      durationMinutes: item.durationMinutes,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
      employeeName: item.employeeName ?? null,
      employeeLbnr: item.employeeLbnr ?? null,
      appointmentNotes: item.appointmentNotes || null,
    })),
    netAmountCents: invoice.netAmountCents,
    vatAmountCents: invoice.vatAmountCents,
    grossAmountCents: invoice.grossAmountCents,
    vatRate: invoice.vatRate || 0,
    notes: invoice.notes ?? null,
  };
}

router.get("/:id/pdf", asyncHandler("PDF konnte nicht generiert werden", async (req, res) => {
  const id = Number(req.params.id);
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  
  const lineItems = await storage.getInvoiceLineItems(id);
  const companySettings = await storage.getCompanySettings();
  const { generateInvoiceHtml, generatePdf } = await import("../lib/pdf-generator");
  
  const pdfData = buildPdfData(invoice, lineItems, companySettings);
  const html = generateInvoiceHtml(pdfData);
  const { buffer } = await generatePdf(html);
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(buffer);
}));

router.get("/:id/leistungsnachweis", asyncHandler("Leistungsnachweis konnte nicht generiert werden", async (req, res) => {
  const id = Number(req.params.id);
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  
  const lineItems = await storage.getInvoiceLineItems(id);
  const companySettings = await storage.getCompanySettings();
  const { generateLeistungsnachweisHtml, generatePdf } = await import("../lib/pdf-generator");
  
  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  const serviceRecords = await db.select({
    employeeSignatureData: monthlyServiceRecords.employeeSignatureData,
    employeeSignedAt: monthlyServiceRecords.employeeSignedAt,
    employeeId: monthlyServiceRecords.employeeId,
    customerSignatureData: monthlyServiceRecords.customerSignatureData,
    customerSignedAt: monthlyServiceRecords.customerSignedAt,
    status: monthlyServiceRecords.status,
  })
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.customerId, invoice.customerId),
      eq(monthlyServiceRecords.year, invoice.billingYear),
      eq(monthlyServiceRecords.month, invoice.billingMonth)
    ));

  const signedRecords = serviceRecords.filter(r =>
    r.status === "completed" || r.status === "employee_signed"
  );

  if (signedRecords.length > 0) {
    const employeeIds = Array.from(new Set(signedRecords.map(r => r.employeeId)));
    const employeeRows = await db.select({ id: users.id, displayName: users.displayName })
      .from(users)
      .where(inArray(users.id, employeeIds));
    const employeeMap = new Map(employeeRows.map(e => [e.id, e.displayName]));

    pdfData.signatures = signedRecords.map(r => ({
      employeeSignatureData: r.employeeSignatureData,
      employeeSignedAt: r.employeeSignedAt ? formatDateForDisplay(formatDateISO(r.employeeSignedAt instanceof Date ? r.employeeSignedAt : new Date(r.employeeSignedAt))) : null,
      employeeName: employeeMap.get(r.employeeId) || null,
      customerSignatureData: r.customerSignatureData,
      customerSignedAt: r.customerSignedAt ? formatDateForDisplay(formatDateISO(r.customerSignedAt instanceof Date ? r.customerSignedAt : new Date(r.customerSignedAt))) : null,
      customerName: invoice.customerName || invoice.recipientName,
    }));
  }

  const html = generateLeistungsnachweisHtml(pdfData);
  const { buffer } = await generatePdf(html);
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="LN-${invoice.invoiceNumber}.pdf"`);
  res.send(buffer);
}));

export default router;
