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
} from "@shared/schema";
import { eq, and, gte, lte, isNull, inArray, ne, notInArray } from "drizzle-orm";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { storage } from "../storage";
import { db } from "../lib/db";

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
      ne(invoicesTable.status, "storniert")
    ));
  return rows.map(r => r.appointmentId).filter((id): id is number => id !== null);
}

router.get("/", asyncHandler("Rechnungen konnten nicht geladen werden", async (req, res) => {
  const filters: any = {};
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

  const customerStatus = (customer as any).status;
  if (customerStatus === "erstberatung") {
    throw badRequest("Kunden in Erstberatung können nicht abgerechnet werden.");
  }

  const monthStr = billingMonth.toString().padStart(2, "0");
  const startDate = `${billingYear}-${monthStr}-01`;
  const lastDay = new Date(billingYear, billingMonth, 0).getDate();
  const endDate = `${billingYear}-${monthStr}-${lastDay}`;

  const alreadyInvoicedIds = await getAlreadyInvoicedAppointmentIds(customerId, billingYear, billingMonth);
  const isNachberechnung = alreadyInvoicedIds.length > 0;

  let allCompletedAppts = await db.select()
    .from(appointments)
    .where(and(
      eq(appointments.customerId, customerId),
      gte(appointments.date, startDate),
      lte(appointments.date, endDate),
      eq(appointments.status, "completed"),
      isNull(appointments.deletedAt)
    ));

  const completedAppts = alreadyInvoicedIds.length > 0
    ? allCompletedAppts.filter(a => !alreadyInvoicedIds.includes(a.id))
    : allCompletedAppts;

  if (completedAppts.length === 0) {
    throw badRequest(alreadyInvoicedIds.length > 0
      ? "Alle abgeschlossenen Termine dieses Zeitraums wurden bereits abgerechnet."
      : "Keine abgeschlossenen Termine für diesen Zeitraum gefunden.");
  }

  const apptIds = completedAppts.map(a => a.id);

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

  const lineItems: any[] = [];
  let totalNetCents = 0;
  let totalVatCents = 0;

  for (const appt of completedAppts) {
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
      });

      totalNetCents += totalCents;
      totalVatCents += vatCents;
    }
  }

  const billingType = (customer as any).billingType || "selbstzahler";
  let recipientName = "";
  let recipientAddress = "";
  let insuranceProviderName = "";
  let insuranceIkNummer = "";
  let versichertennummer = "";

  const customerName = (customer as any).vorname && (customer as any).nachname
    ? `${(customer as any).vorname} ${(customer as any).nachname}`
    : (customer as any).name || "Unbekannt";
  const customerAddress = [(customer as any).strasse, (customer as any).nr].filter(Boolean).join(" ") +
    ((customer as any).plz || (customer as any).stadt ? `\n${(customer as any).plz || ""} ${(customer as any).stadt || ""}` : "");

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
    pflegegrad: (customer as any).pflegegrad || null,
    netAmountCents: totalNetCents,
    vatAmountCents: totalVatCents,
    grossAmountCents: totalNetCents + totalVatCents,
    vatRate: 0,
    status: "entwurf",
  };

  const invoice = await storage.createInvoice(invoiceData, lineItems, req.user!.id);
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
  const monthStr = billingMonth.toString().padStart(2, "0");
  const startDate = `${billingYear}-${monthStr}-01`;
  const lastDay = new Date(billingYear, billingMonth, 0).getDate();
  const endDate = `${billingYear}-${monthStr}-${lastDay}`;

  const allCompletedAppts = await db.select({
    customerId: appointments.customerId,
  })
  .from(appointments)
  .where(and(
    gte(appointments.date, startDate),
    lte(appointments.date, endDate),
    eq(appointments.status, "completed"),
    isNull(appointments.deletedAt)
  ));

  const uniqueCustomerIds = [...new Set(allCompletedAppts.map(a => a.customerId))];

  if (uniqueCustomerIds.length === 0) {
    return res.json({ created: 0, skipped: 0, errors: [], message: "Keine abgeschlossenen Termine für diesen Zeitraum gefunden." });
  }

  const results: { created: number; skipped: { customerName: string; reason: string }[]; errors: { customerId: number; customerName: string; reason: string }[] } = {
    created: 0,
    skipped: [],
    errors: [],
  };

  for (const customerId of uniqueCustomerIds) {
    try {
      const customer = await storage.getCustomer(customerId);
      const custName = customer ? ((customer as any).vorname && (customer as any).nachname ? `${(customer as any).vorname} ${(customer as any).nachname}` : (customer as any).name) : `Kunde #${customerId}`;

      if (!customer) {
        results.skipped.push({ customerName: custName, reason: "Kunde nicht gefunden" });
        continue;
      }

      const customerStatus = (customer as any).status;
      if (customerStatus === "erstberatung") {
        results.skipped.push({ customerName: custName, reason: "Erstberatung (nicht abrechenbar)" });
        continue;
      }

      const alreadyInvoicedIds = await getAlreadyInvoicedAppointmentIds(customerId, billingYear, billingMonth);
      const isNachberechnung = alreadyInvoicedIds.length > 0;

      const allCompletedAppts = await db.select()
        .from(appointments)
        .where(and(
          eq(appointments.customerId, customerId),
          gte(appointments.date, startDate),
          lte(appointments.date, endDate),
          eq(appointments.status, "completed"),
          isNull(appointments.deletedAt)
        ));

      const completedAppts = alreadyInvoicedIds.length > 0
        ? allCompletedAppts.filter(a => !alreadyInvoicedIds.includes(a.id))
        : allCompletedAppts;

      if (completedAppts.length === 0) {
        results.skipped.push({ customerName: custName, reason: alreadyInvoicedIds.length > 0 ? "Alle Termine bereits abgerechnet" : "Keine abgeschlossenen Termine" });
        continue;
      }

      const apptIds = completedAppts.map(a => a.id);
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

      const lineItems: any[] = [];
      let totalNetCents = 0;
      let totalVatCents = 0;

      for (const appt of completedAppts) {
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
          });
          totalNetCents += totalCents;
          totalVatCents += vatCents;
        }
      }

      const billingType = (customer as any).billingType || "selbstzahler";
      const customerName = (customer as any).vorname && (customer as any).nachname
        ? `${(customer as any).vorname} ${(customer as any).nachname}`
        : (customer as any).name || "Unbekannt";
      const customerAddress = [(customer as any).strasse, (customer as any).nr].filter(Boolean).join(" ") +
        ((customer as any).plz || (customer as any).stadt ? `\n${(customer as any).plz || ""} ${(customer as any).stadt || ""}` : "");

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
        pflegegrad: (customer as any).pflegegrad || null,
        netAmountCents: totalNetCents,
        vatAmountCents: totalVatCents,
        grossAmountCents: totalNetCents + totalVatCents,
        vatRate: 0,
        status: "entwurf",
      };

      await storage.createInvoice(invoiceData, lineItems, req.user!.id);
      results.created++;
    } catch (err: any) {
      const customer = await storage.getCustomer(customerId);
      const name = customer ? ((customer as any).vorname && (customer as any).nachname ? `${(customer as any).vorname} ${(customer as any).nachname}` : (customer as any).name) : `ID ${customerId}`;
      results.errors.push({ customerId, customerName: name || `ID ${customerId}`, reason: err.message || "Unbekannter Fehler" });
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

    const stornoLineItems = lineItems.map((item: any) => ({
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
    }));

    await storage.createInvoice(stornoData, stornoLineItems, req.user!.id);
  }

  const updated = await storage.updateInvoiceStatus(id, status, req.user!.id);
  res.json(updated);
}));

function buildPdfData(invoice: any, lineItems: any[], companySettings: any) {
  return {
    companyName: companySettings.companyName || "",
    companyAddress: [
      [companySettings.strasse, companySettings.hausnummer].filter(Boolean).join(" "),
      [companySettings.plz, companySettings.stadt].filter(Boolean).join(" "),
    ].filter(Boolean).join(", "),
    companyPhone: companySettings.telefon || "",
    companyEmail: companySettings.email || "",
    companyWebsite: companySettings.website,
    steuernummer: companySettings.steuernummer,
    ustId: companySettings.ustId,
    iban: companySettings.iban || "",
    bic: companySettings.bic || "",
    bankName: companySettings.bankName || "",
    ikNummer: companySettings.ikNummer,
    anerkennungsnummer45a: companySettings.anerkennungsnummer45a,
    anerkennungsBundesland: companySettings.anerkennungsBundesland,
    geschaeftsfuehrer: companySettings.geschaeftsfuehrer,
    invoiceNumber: invoice.invoiceNumber,
    invoiceDate: invoice.sentAt ? new Date(invoice.sentAt).toLocaleDateString("de-DE") : new Date().toLocaleDateString("de-DE"),
    invoiceType: invoice.invoiceType,
    billingType: invoice.billingType,
    billingMonth: invoice.billingMonth,
    billingYear: invoice.billingYear,
    recipientName: invoice.recipientName,
    recipientAddress: invoice.recipientAddress,
    insuranceProviderName: invoice.insuranceProviderName,
    insuranceIkNummer: invoice.insuranceIkNummer,
    versichertennummer: invoice.versichertennummer,
    pflegegrad: invoice.pflegegrad,
    customerName: invoice.customerName || invoice.recipientName,
    customerAddress: invoice.recipientAddress || "",
    lineItems: lineItems.map((item: any) => ({
      appointmentDate: item.appointmentDate,
      startTime: item.startTime,
      endTime: item.endTime,
      serviceDescription: item.serviceDescription,
      durationMinutes: item.durationMinutes,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
      employeeName: item.employeeName,
      employeeLbnr: item.employeeLbnr,
    })),
    netAmountCents: invoice.netAmountCents,
    vatAmountCents: invoice.vatAmountCents,
    grossAmountCents: invoice.grossAmountCents,
    vatRate: invoice.vatRate || 0,
    notes: invoice.notes,
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
  const html = generateLeistungsnachweisHtml(pdfData);
  const { buffer } = await generatePdf(html);
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="LN-${invoice.invoiceNumber}.pdf"`);
  res.send(buffer);
}));

export default router;
