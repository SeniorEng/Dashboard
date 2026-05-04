import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth";
import { asyncHandler, badRequest, notFound } from "../lib/errors";
import { requireIntParam } from "../lib/params";
import { formatPhoneForDisplay } from "@shared/utils/phone";
import {
  createInvoiceSchema,
  updateInvoiceStatusSchema,
  appointments,
  appointmentServices as appointmentServicesTable,
  services as servicesTable,
  users,
  userRoles,
  customers as customersTable,
  customerInsuranceHistory,
  insuranceProviders,
  invoices as invoicesTable,
  invoiceLineItems,
  monthlyServiceRecords,
  serviceRecordAppointments,
  customerServicePrices,
  budgetTransactions,
} from "@shared/schema";
import type { Invoice, InvoiceLineItem, CompanySettings, InsertDocumentDelivery } from "@shared/schema";
import type { BillingCustomerItem } from "@shared/api";
import { documentDeliveries } from "@shared/schema";
import { computeDataHash } from "../services/signature-integrity";
import { budgetLedgerStorage } from "../storage/budget-ledger";
import { objectStorageClient } from "../replit_integrations/object_storage/objectStorage";
import { parseObjectPath, getPrivateDir } from "../lib/object-storage-helpers";
import { eq, and, gte, lte, lt, isNull, inArray, ne, notInArray, or, desc } from "drizzle-orm";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { formatDateForDisplay, formatDateISO, todayISO, parseTimestamp } from "@shared/utils/datetime";
import { storage } from "../storage";
import { db } from "../lib/db";
import {
  getNextInvoiceNumberTx,
  createInvoiceTx,
  updateInvoiceStatusTx,
  getInvoiceLineItemsTx,
  getInvoiceForUpdateTx,
} from "../storage/billing-storage";
import { auditService } from "../services/audit";
import { deliveryStorage } from "../storage/deliveries";
import type { InvoicePdfData } from "../lib/pdf-generator";
import { getCachedCompanySettings } from "../services/cache";
import { sendInvoiceCopyByPost } from "../services/document-delivery";

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
  appointmentNotes: string | null;
  serviceDetails: string | null;
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
      eq(monthlyServiceRecords.month, month),
      isNull(monthlyServiceRecords.deletedAt)
    ));
}

async function getAppointmentIdsFromServiceRecords(serviceRecordIds: number[]): Promise<number[]> {
  if (serviceRecordIds.length === 0) return [];
  const rows = await db.select({ appointmentId: serviceRecordAppointments.appointmentId })
    .from(serviceRecordAppointments)
    .where(inArray(serviceRecordAppointments.serviceRecordId, serviceRecordIds));
  return rows.map(r => r.appointmentId);
}

async function buildLineItemsFromAppointments(apptIds: number[], customerId?: number, billingType?: string) {
  if (apptIds.length === 0) return { lineItems: [], totalNetCents: 0, totalVatCents: 0 };
  const isVatExempt = billingType && billingType !== "selbstzahler";

  const appts = await db.select()
    .from(appointments)
    .where(and(inArray(appointments.id, apptIds), isNull(appointments.deletedAt)));

  const serviceBreakdown = await db.select({
    appointmentId: appointmentServicesTable.appointmentId,
    serviceId: appointmentServicesTable.serviceId,
    serviceCode: servicesTable.code,
    serviceName: servicesTable.name,
    plannedDurationMinutes: appointmentServicesTable.plannedDurationMinutes,
    actualDurationMinutes: appointmentServicesTable.actualDurationMinutes,
    defaultPriceCents: servicesTable.defaultPriceCents,
    vatRate: servicesTable.vatRate,
    details: appointmentServicesTable.details,
  })
  .from(appointmentServicesTable)
  .innerJoin(servicesTable, eq(appointmentServicesTable.serviceId, servicesTable.id))
  .where(inArray(appointmentServicesTable.appointmentId, apptIds));

  const resolvedCustomerId = customerId ?? appts[0]?.customerId;
  let allCustomerPrices: { id: number; serviceId: number; priceCents: number; validFrom: Date | null; validTo: Date | null }[] = [];
  if (resolvedCustomerId) {
    allCustomerPrices = await db.select({
      id: customerServicePrices.id,
      serviceId: customerServicePrices.serviceId,
      priceCents: customerServicePrices.priceCents,
      validFrom: customerServicePrices.validFrom,
      validTo: customerServicePrices.validTo,
    })
    .from(customerServicePrices)
    .where(and(
      eq(customerServicePrices.customerId, resolvedCustomerId),
      isNull(customerServicePrices.deletedAt),
    ));
  }

  function toDateStr(d: Date | string | null): string {
    if (!d) return "";
    if (d instanceof Date) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return String(d).substring(0, 10);
  }

  function getCustomerPrice(serviceId: number, appointmentDate: string): number | undefined {
    const matching = allCustomerPrices.filter(p => {
      if (p.serviceId !== serviceId) return false;
      const fromDate = p.validFrom ? toDateStr(p.validFrom) : "0000-01-01";
      const toDate = p.validTo ? toDateStr(p.validTo) : "9999-12-31";
      return appointmentDate >= fromDate && appointmentDate <= toDate;
    });
    if (matching.length === 0) return undefined;
    matching.sort((a, b) => {
      const aFrom = a.validFrom ? new Date(a.validFrom).getTime() : 0;
      const bFrom = b.validFrom ? new Date(b.validFrom).getTime() : 0;
      if (bFrom !== aFrom) return bFrom - aFrom;
      // Tiebreaker für identisches validFrom (Race-Condition / Parallel-Insert):
      // Höchste id (= zuletzt eingefügt) gewinnt deterministisch.
      return b.id - a.id;
    });
    return matching[0].priceCents;
  }

  const employeeIds = [...new Set(appts.map(a => a.assignedEmployeeId || a.performedByEmployeeId).filter((id): id is number => id != null))];
  const employeeMap = new Map<number, { displayName: string }>();
  if (employeeIds.length > 0) {
    const emps = await db.select({ id: users.id, displayName: users.displayName }).from(users).where(inArray(users.id, employeeIds));
    for (const emp of emps) {
      employeeMap.set(emp.id, { displayName: emp.displayName });
    }
  }

  const kmServiceRows = await db.select({
    id: servicesTable.id,
    code: servicesTable.code,
    name: servicesTable.name,
    defaultPriceCents: servicesTable.defaultPriceCents,
    vatRate: servicesTable.vatRate,
  })
  .from(servicesTable)
  .where(inArray(servicesTable.code, ["travel_km", "customer_km"]));
  const kmServiceMap = new Map(kmServiceRows.map(s => [s.code, s]));

  const lineItems: BuildLineItem[] = [];
  let totalNetCents = 0;
  let totalVatCents = 0;

  for (const appt of appts) {
    const apptServices = serviceBreakdown.filter(s => s.appointmentId === appt.id);
    const apptDate = appt.date;

    const employeeId = appt.assignedEmployeeId || appt.performedByEmployeeId;
    const emp = employeeId ? employeeMap.get(employeeId) : undefined;
    const employeeName = emp?.displayName || "";

    for (const svc of apptServices) {
      const durationMinutes = Math.round(svc.actualDurationMinutes ?? svc.plannedDurationMinutes ?? 0);
      const customerPrice = getCustomerPrice(svc.serviceId, apptDate);
      const pricePer60Min = customerPrice ?? svc.defaultPriceCents;
      if (pricePer60Min == null) {
        throw badRequest(`Kein Preis hinterlegt für Dienstleistung "${svc.serviceName || svc.serviceCode}". Bitte prüfen Sie den Dienstleistungskatalog.`);
      }
      const totalCents = Math.round((durationMinutes / 60) * pricePer60Min);
      const vatBasisPoints = isVatExempt ? 0 : (svc.vatRate || 0);
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
        appointmentNotes: appt.notes || null,
        serviceDetails: svc.details || null,
      });

      totalNetCents += totalCents;
      totalVatCents += vatCents;
    }

    const kmEntries: { code: string; km: number }[] = [];
    if (appt.travelKilometers && appt.travelKilometers > 0) {
      kmEntries.push({ code: "travel_km", km: appt.travelKilometers });
    }
    if (appt.customerKilometers && appt.customerKilometers > 0) {
      kmEntries.push({ code: "customer_km", km: appt.customerKilometers });
    }
    for (const kmEntry of kmEntries) {
      const kmSvc = kmServiceMap.get(kmEntry.code);
      if (!kmSvc) continue;
      const kmCustomerPrice = getCustomerPrice(kmSvc.id, apptDate);
      const pricePerKm = kmCustomerPrice ?? kmSvc.defaultPriceCents ?? 35;
      const kmTotalCents = Math.round(kmEntry.km * pricePerKm);
      const kmVatBasisPoints = isVatExempt ? 0 : (kmSvc.vatRate || 0);
      const kmVatCents = Math.round(kmTotalCents * kmVatBasisPoints / 10000);

      lineItems.push({
        appointmentId: appt.id,
        appointmentDate: appt.date,
        serviceDescription: kmSvc.name || (kmEntry.code === "travel_km" ? "Anfahrt" : "Fahrten für/mit Kunde"),
        serviceCode: kmEntry.code,
        startTime: appt.actualStart || appt.scheduledStart,
        endTime: appt.actualEnd || appt.scheduledEnd,
        durationMinutes: Math.round(kmEntry.km),
        unitPriceCents: pricePerKm,
        totalCents: kmTotalCents,
        employeeName,
        appointmentNotes: null,
        serviceDetails: null,
      });

      totalNetCents += kmTotalCents;
      totalVatCents += kmVatCents;
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

router.get("/eligible-customers", asyncHandler("Berechtigte Kunden konnten nicht geladen werden", async (req, res) => {
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  if (!month || !year || month < 1 || month > 12) {
    throw badRequest("Monat und Jahr sind erforderlich.");
  }

  const signedRecords = await db.select({
    customerId: monthlyServiceRecords.customerId,
  })
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.year, year),
      eq(monthlyServiceRecords.month, month),
      or(
        eq(monthlyServiceRecords.status, "completed"),
        eq(monthlyServiceRecords.status, "employee_signed")
      ),
      isNull(monthlyServiceRecords.deletedAt)
    ));

  const uniqueCustomerIds = Array.from(new Set(signedRecords.map(r => r.customerId)));

  if (uniqueCustomerIds.length === 0) {
    return res.json([]);
  }

  const eligibleCustomers: BillingCustomerItem[] = await db.select({
    id: customersTable.id,
    name: customersTable.name,
    vorname: customersTable.vorname,
    nachname: customersTable.nachname,
    billingType: customersTable.billingType,
    status: customersTable.status,
  })
    .from(customersTable)
    .where(inArray(customersTable.id, uniqueCustomerIds));

  res.json(eligibleCustomers);
}));

router.post("/send-batch", asyncHandler("Stapelversand fehlgeschlagen", async (req, res) => {
  const parsed = z.object({
    invoiceIds: z.array(z.number().int().positive()).min(1).max(50),
  }).safeParse(req.body);

  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }

  const { invoiceIds } = parsed.data;
  const results: { invoiceId: number; invoiceNumber: string; status: string; error?: string; recipientEmail?: string }[] = [];

  const companySettings = await getCachedCompanySettings();
  if (!companySettings) throw badRequest("Firmendaten nicht konfiguriert.");

  const { generateInvoiceHtml, generateLeistungsnachweisHtml, generatePdf } = await import("../lib/pdf-generator");
  const { embedZugferdXml } = await import("../lib/zugferd");
  const { sendEmail, buildEmailLayout } = await import("../services/email-service");
  const { resolveLogoToDataUrl } = await import("../services/logo-resolver");
  const companyName = companySettings.companyName || "SeniorenEngel";
  const resolvedLogo = await resolveLogoToDataUrl(companySettings.logoUrl);

  for (const invoiceId of invoiceIds) {
    try {
      const invoice = await storage.getInvoice(invoiceId);
      if (!invoice) {
        results.push({ invoiceId, invoiceNumber: "", status: "error", error: "Rechnung nicht gefunden" });
        continue;
      }
      if (invoice.status !== "entwurf") {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "skipped", error: `Status: ${invoice.status}` });
        continue;
      }
      if (invoice.billingType !== "pflegekasse_gesetzlich" && invoice.billingType !== "pflegekasse_privat") {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "skipped", error: "Nicht an Pflegekasse" });
        continue;
      }

      const cust = await db.select().from(customersTable).where(eq(customersTable.id, invoice.customerId)).limit(1);
      if (!cust.length) {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "Kunde nicht gefunden" });
        continue;
      }

      const isPrivatBilling = invoice.billingType === "pflegekasse_privat";
      const isBeihilfe = isPrivatBilling && cust[0].beihilfeBerechtigt;

      const insHist = await db.select({
        providerId: customerInsuranceHistory.insuranceProviderId,
        versichertennummer: customerInsuranceHistory.versichertennummer,
      })
        .from(customerInsuranceHistory)
        .where(and(eq(customerInsuranceHistory.customerId, invoice.customerId), isNull(customerInsuranceHistory.validTo)))
        .limit(1);

      if (!insHist.length) {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "Keine Pflegekassenzuordnung" });
        continue;
      }

      const prov = await db.select().from(insuranceProviders).where(eq(insuranceProviders.id, insHist[0].providerId)).limit(1);

      let recipientEmail: string | null = null;
      let recipientName = "";
      let hasParagraph39 = false;

      if (isPrivatBilling) {
        if (!cust[0].email) {
          results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "Keine E-Mail beim Kunden hinterlegt" });
          continue;
        }
        recipientEmail = cust[0].email;
        recipientName = [cust[0].vorname, cust[0].nachname].filter(Boolean).join(" ") || cust[0].name;
      } else {
        if (!prov.length || !prov[0].emailInvoiceEnabled) {
          results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: "E-Mail-Versand nicht aktiviert" });
          continue;
        }

        const lineItemsForCheck = await storage.getInvoiceLineItems(invoiceId);
        const appointmentIds = lineItemsForCheck.map(li => li.appointmentId).filter(Boolean) as number[];
        if (appointmentIds.length > 0) {
          const txns = await db.select({ budgetType: budgetTransactions.budgetType })
            .from(budgetTransactions)
            .where(and(inArray(budgetTransactions.appointmentId, appointmentIds), eq(budgetTransactions.transactionType, "consumption")));
          hasParagraph39 = txns.some(t => t.budgetType === "ersatzpflege_39_42a");
        }

        recipientEmail = hasParagraph39 ? (prov[0].emailVerhinderungspflege || prov[0].email) : prov[0].email;
        recipientName = prov[0].name;
      }

      if (!recipientEmail) {
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: isPrivatBilling ? "Keine E-Mail beim Kunden" : "Keine E-Mail bei Pflegekasse" });
        continue;
      }

      const lineItems = await storage.getInvoiceLineItems(invoiceId);

      const pdfData = buildPdfData(invoice, lineItems, companySettings);
      if (cust[0].geburtsdatum) pdfData.customerGeburtsdatum = cust[0].geburtsdatum;
      if (isBeihilfe) pdfData.beihilfeBerechtigt = true;

      const invoiceHtml = generateInvoiceHtml(pdfData);
      const { buffer: invoicePdf } = await generatePdf(invoiceHtml);
      const zugferdBuffer = await embedZugferdXml(invoicePdf, pdfData);

      const lnHtml = generateLeistungsnachweisHtml(pdfData);
      const { buffer: lnPdf } = await generatePdf(lnHtml);

      let finalInvoicePdf: Buffer = zugferdBuffer;
      let finalLnPdf: Buffer = lnPdf;

      if (isBeihilfe) {
        const { PDFDocument } = await import("pdf-lib");
        const mergedInv = await PDFDocument.create();
        const invDoc = await PDFDocument.load(zugferdBuffer);
        const invPages1 = await mergedInv.copyPages(invDoc, invDoc.getPageIndices());
        invPages1.forEach(p => mergedInv.addPage(p));
        const invPages2 = await mergedInv.copyPages(invDoc, invDoc.getPageIndices());
        invPages2.forEach(p => mergedInv.addPage(p));
        finalInvoicePdf = Buffer.from(await mergedInv.save());

        const mergedLn = await PDFDocument.create();
        const lnDoc = await PDFDocument.load(lnPdf);
        const lnPages1 = await mergedLn.copyPages(lnDoc, lnDoc.getPageIndices());
        lnPages1.forEach(p => mergedLn.addPage(p));
        const lnPages2 = await mergedLn.copyPages(lnDoc, lnDoc.getPageIndices());
        lnPages2.forEach(p => mergedLn.addPage(p));
        finalLnPdf = Buffer.from(await mergedLn.save());
      }

      const monthName = MONTH_NAMES_DE[(invoice.billingMonth - 1)] || String(invoice.billingMonth);
      const customerFullName = [cust[0].vorname, cust[0].nachname].filter(Boolean).join(" ") || cust[0].name;
      const versNr = insHist[0].versichertennummer || invoice.versichertennummer || "";

      const subject = `Rechnung ${invoice.invoiceNumber} — ${customerFullName}${versNr ? ` (${versNr})` : ""} — ${monthName} ${invoice.billingYear} — ${companyName}`;
      let bodyContent = "";
      if (isPrivatBilling) {
        bodyContent = `
          <p>Sehr geehrte/r ${cust[0].vorname || ""} ${cust[0].nachname || ""},</p>
          <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
          für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
          ${isBeihilfe ? `<p><strong>Hinweis:</strong> Anbei erhalten Sie Ihre Rechnung und den Leistungsnachweis in doppelter Ausfertigung — bitte reichen Sie je ein Exemplar bei Ihrer privaten Pflegekasse und Ihrer Beihilfestelle ein.</p>` : ""}
          <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
          <p>Mit freundlichen Grüßen<br/>${companyName}</p>
        `;
      } else {
        bodyContent = `
          <p>Sehr geehrte Damen und Herren,</p>
          <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
          für <strong>${customerFullName}</strong>${versNr ? ` (Versichertennr. ${versNr})` : ""}
          für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
          <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
          <p>Mit freundlichen Grüßen<br/>${companyName}</p>
        `;
      }
      const html = buildEmailLayout(companyName, resolvedLogo, bodyContent);

      const fileNames = `[${invoice.invoiceNumber}] ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;

      try {
        await sendEmail(companySettings, {
          to: recipientEmail,
          subject,
          html,
          attachments: [
            { filename: `${invoice.invoiceNumber}.pdf`, content: finalInvoicePdf, contentType: "application/pdf" },
            { filename: `LN-${invoice.invoiceNumber}.pdf`, content: finalLnPdf, contentType: "application/pdf" },
          ],
        });

        await storage.updateInvoiceStatus(invoiceId, "versendet", req.user!.id);

        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "sent",
          recipientEmail,
          recipientName: recipientName || (prov.length ? prov[0].name : ""),
          documentFileNames: fileNames,
          sentAt: new Date(),
          createdByUserId: req.user!.id,
        });

        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "sent", recipientEmail });
      } catch (sendErr: unknown) {
        const errMsg = sendErr instanceof Error ? sendErr.message : "Unbekannter Fehler";
        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "error",
          recipientEmail,
          recipientName: recipientName || (prov.length ? prov[0].name : ""),
          documentFileNames: fileNames,
          errorMessage: errMsg,
          createdByUserId: req.user!.id,
        });
        results.push({ invoiceId, invoiceNumber: invoice.invoiceNumber, status: "error", error: errMsg });
        continue;
      }

      await auditService.log(req.user!.id, "invoice_sent", "invoice", invoiceId, {
        invoiceNumber: invoice.invoiceNumber, recipientEmail, customerId: invoice.customerId,
        insuranceProviderId: prov.length ? prov[0].id : null, hasParagraph39, batchSend: true, isPrivatBilling, isBeihilfe,
      }, req.ip);

      if (cust[0].receivesMonthlyInvoice) {
        const deliveryMethod = cust[0].documentDeliveryMethod || "email";
        const copyFileNames = `[${invoice.invoiceNumber}] Kopie: ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;
        try {
          if (deliveryMethod === "email" && !cust[0].email) {
            await deliveryStorage.createDelivery({
              customerId: invoice.customerId,
              deliveryMethod: "email",
              status: "error",
              recipientName: customerFullName,
              documentFileNames: copyFileNames,
              errorMessage: "Keine E-Mail-Adresse beim Kunden hinterlegt",
              createdByUserId: req.user!.id,
            });
          } else if (deliveryMethod === "email" && cust[0].email) {
            const customerSubject = `Rechnungskopie ${invoice.invoiceNumber} — ${monthName} ${invoice.billingYear}`;
            const customerBody = `
              <p>Sehr geehrte/r ${cust[0].vorname || ""} ${cust[0].nachname || ""},</p>
              <p>anbei erhalten Sie eine Kopie der Rechnung <strong>${invoice.invoiceNumber}</strong>
              für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>,
              die an Ihre Pflegekasse gesendet wurde.</p>
              <p>Mit freundlichen Grüßen<br/>${companyName}</p>
            `;
            const customerHtml = buildEmailLayout(companyName, resolvedLogo, customerBody);
            await sendEmail(companySettings, {
              to: cust[0].email,
              subject: customerSubject,
              html: customerHtml,
              attachments: [
                { filename: `${invoice.invoiceNumber}.pdf`, content: zugferdBuffer, contentType: "application/pdf" },
                { filename: `LN-${invoice.invoiceNumber}.pdf`, content: lnPdf, contentType: "application/pdf" },
              ],
            });
            await deliveryStorage.createDelivery({
              customerId: invoice.customerId,
              deliveryMethod: "email",
              status: "sent",
              recipientEmail: cust[0].email,
              recipientName: customerFullName,
              documentFileNames: copyFileNames,
              sentAt: new Date(),
              createdByUserId: req.user!.id,
            });
          } else if (deliveryMethod === "post") {
            const customerAddress = [cust[0].strasse, cust[0].nr, cust[0].plz, cust[0].stadt].filter(Boolean).join(", ");
            const { letterId } = await sendInvoiceCopyByPost(companySettings, {
              customer: cust[0],
              invoicePdf: zugferdBuffer,
              leistungsnachweisPdf: lnPdf,
              invoiceNumber: invoice.invoiceNumber,
              monthName,
              year: invoice.billingYear,
            });
            await deliveryStorage.createDelivery({
              customerId: invoice.customerId,
              deliveryMethod: "post",
              status: "sent",
              recipientName: customerFullName,
              recipientAddress: customerAddress,
              documentFileNames: copyFileNames,
              sentAt: new Date(),
              letterxpressLetterId: letterId,
              createdByUserId: req.user!.id,
            });
          }
        } catch (copyErr: unknown) {
          const copyErrMsg = copyErr instanceof Error ? copyErr.message : "Unbekannter Fehler";
          console.error("Kundenkopie fehlgeschlagen:", copyErrMsg);
          await deliveryStorage.createDelivery({
            customerId: invoice.customerId,
            deliveryMethod: deliveryMethod,
            status: "error",
            recipientEmail: cust[0].email || null,
            recipientName: customerFullName,
            documentFileNames: copyFileNames,
            errorMessage: copyErrMsg,
            createdByUserId: req.user!.id,
          }).catch(() => {});
        }
      }
    } catch (error: unknown) {
      const inv = await storage.getInvoice(invoiceId).catch(() => null);
      results.push({ invoiceId, invoiceNumber: inv?.invoiceNumber || "", status: "error", error: error instanceof Error ? error.message : "Unbekannter Fehler" });
    }
  }

  const sentCount = results.filter(r => r.status === "sent").length;
  const errorCount = results.filter(r => r.status === "error").length;
  const skippedCount = results.filter(r => r.status === "skipped").length;

  res.json({
    message: `${sentCount} versendet, ${errorCount} Fehler, ${skippedCount} übersprungen`,
    results,
    summary: { sent: sentCount, errors: errorCount, skipped: skippedCount, total: invoiceIds.length },
  });
}));

router.get("/deliveries/:invoiceId", asyncHandler("Versandhistorie konnte nicht geladen werden", async (req, res) => {
  const invoiceId = requireIntParam(req.params.invoiceId, res);
  if (invoiceId === null) return;
  const invoice = await storage.getInvoice(invoiceId);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  const prefix = `[${invoice.invoiceNumber}]`;
  const deliveries = await db.select()
    .from(documentDeliveries)
    .where(eq(documentDeliveries.customerId, invoice.customerId))
    .orderBy(desc(documentDeliveries.createdAt));
  const invoiceDeliveries = deliveries.filter(d =>
    d.documentFileNames?.startsWith(prefix)
  );
  res.json(invoiceDeliveries);
}));

router.get("/:id", asyncHandler("Rechnung konnte nicht geladen werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  const lineItems = await storage.getInvoiceLineItems(id);
  res.json({ ...invoice, lineItems });
}));

async function getBudgetSplitForAppointments(customerId: number, apptIds: number[]) {
  if (apptIds.length === 0) return new Map<number, { kasseCents: number; privateCents: number }>();

  const txns = await db.select({
    appointmentId: budgetTransactions.appointmentId,
    budgetType: budgetTransactions.budgetType,
    transactionType: budgetTransactions.transactionType,
    amountCents: budgetTransactions.amountCents,
  })
  .from(budgetTransactions)
  .where(and(
    eq(budgetTransactions.customerId, customerId),
    inArray(budgetTransactions.appointmentId, apptIds),
    eq(budgetTransactions.transactionType, "consumption")
  ));

  const splitMap = new Map<number, { kasseCents: number; privateCents: number }>();

  for (const txn of txns) {
    if (!txn.appointmentId) continue;
    const existing = splitMap.get(txn.appointmentId) || { kasseCents: 0, privateCents: 0 };
    const absCents = Math.abs(txn.amountCents);
    if (txn.budgetType === "private") {
      existing.privateCents += absCents;
    } else {
      existing.kasseCents += absCents;
    }
    splitMap.set(txn.appointmentId, existing);
  }

  return splitMap;
}

function splitLineItemsByBudget(
  lineItems: BuildLineItem[],
  budgetSplit: Map<number, { kasseCents: number; privateCents: number }>
): { kasseItems: BuildLineItem[]; privateItems: BuildLineItem[] } {
  const kasseItems: BuildLineItem[] = [];
  const privateItems: BuildLineItem[] = [];

  const apptGroups = new Map<number, BuildLineItem[]>();
  for (const item of lineItems) {
    const apptId = item.appointmentId;
    const existing = apptGroups.get(apptId) || [];
    existing.push(item);
    apptGroups.set(apptId, existing);
  }

  for (const [apptId, items] of apptGroups) {
    const split = budgetSplit.get(apptId);
    if (!split) {
      kasseItems.push(...items);
      continue;
    }

    if (split.privateCents === 0) {
      kasseItems.push(...items);
      continue;
    }

    if (split.kasseCents === 0) {
      privateItems.push(...items);
      continue;
    }

    const totalApptCents = items.reduce((sum, i) => sum + i.totalCents, 0);
    if (totalApptCents <= 0) {
      kasseItems.push(...items);
      continue;
    }

    const kasseRatio = split.kasseCents / (split.kasseCents + split.privateCents);

    let kasseRemaining = split.kasseCents;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const isLast = i === items.length - 1;

      let kasseShare: number;
      let privateShare: number;

      if (isLast) {
        kasseShare = Math.max(0, kasseRemaining);
        privateShare = item.totalCents - kasseShare;
      } else {
        kasseShare = Math.round(item.totalCents * kasseRatio);
        privateShare = item.totalCents - kasseShare;
        kasseRemaining -= kasseShare;
      }

      if (kasseShare > 0) {
        kasseItems.push({ ...item, totalCents: kasseShare });
      }
      if (privateShare > 0) {
        privateItems.push({ ...item, totalCents: privateShare });
      }
    }
  }

  return { kasseItems, privateItems };
}

async function getInsuranceData(customerId: number) {
  const insuranceData = await db.select({
    providerName: insuranceProviders.name,
    ikNummer: insuranceProviders.ikNummer,
    versichertennummer: customerInsuranceHistory.versichertennummer,
    empfaenger: insuranceProviders.empfaenger,
    empfaengerZeile2: insuranceProviders.empfaengerZeile2,
    anschrift: insuranceProviders.anschrift,
    plzOrt: insuranceProviders.plzOrt,
    strasse: insuranceProviders.strasse,
    hausnummer: insuranceProviders.hausnummer,
    plz: insuranceProviders.plz,
    stadt: insuranceProviders.stadt,
  })
  .from(customerInsuranceHistory)
  .innerJoin(insuranceProviders, eq(customerInsuranceHistory.insuranceProviderId, insuranceProviders.id))
  .where(and(
    eq(customerInsuranceHistory.customerId, customerId),
    isNull(customerInsuranceHistory.validTo)
  ))
  .limit(1);

  return insuranceData.length > 0 ? insuranceData[0] : null;
}

router.post("/generate", asyncHandler("Rechnung konnte nicht erstellt werden", async (req, res) => {
  const parsed = createInvoiceSchema.safeParse(req.body);
  if (!parsed.success) {
    throw badRequest(fromError(parsed.error).toString());
  }

  const { customerId, billingMonth, billingYear } = parsed.data;

  const customer = await storage.getCustomer(customerId);
  if (!customer) throw notFound("Kunde nicht gefunden");

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

  // T05/K3: Storno-then-rebill — wenn für diesen Zeitraum bereits stornierte
  // Original-Rechnungen existieren, ist die neue Rechnung eine Nachberechnung
  // und muss die Original-IDs zur Nachvollziehbarkeit verlinken.
  const stornoOriginalRows = await db.select({ id: invoicesTable.id })
    .from(invoicesTable)
    .where(and(
      eq(invoicesTable.customerId, customerId),
      eq(invoicesTable.billingYear, billingYear),
      eq(invoicesTable.billingMonth, billingMonth),
      eq(invoicesTable.status, "storniert"),
      ne(invoicesTable.invoiceType, "stornorechnung"),
    ));
  const referencedStornoInvoiceIds = stornoOriginalRows.map((r) => r.id);
  const stornoRefsForInsert: number[] | null =
    referencedStornoInvoiceIds.length > 0 ? referencedStornoInvoiceIds : null;
  const isNachberechnung = alreadyInvoicedIds.length > 0 || referencedStornoInvoiceIds.length > 0;

  const apptIds = alreadyInvoicedIds.length > 0
    ? allApptIds.filter(id => !alreadyInvoicedIds.includes(id))
    : allApptIds;

  if (apptIds.length === 0) {
    throw badRequest("Alle Termine aus dem Leistungsnachweis wurden bereits abgerechnet.");
  }

  const billingType = customer.billingType || "selbstzahler";
  const customerName = customer.vorname && customer.nachname
    ? `${customer.vorname} ${customer.nachname}`
    : customer.name || "Unbekannt";
  const customerAddress = [customer.strasse, customer.nr].filter(Boolean).join(" ") +
    (customer.plz || customer.stadt ? `\n${customer.plz || ""} ${customer.stadt || ""}` : "");

  const insuranceInfo = await getInsuranceData(customerId);
  const needsBudgetSplit = (billingType === "pflegekasse_gesetzlich" || billingType === "pflegekasse_privat")
    && customer.acceptsPrivatePayment;

  if (needsBudgetSplit) {
    const budgetSplit = await getBudgetSplitForAppointments(customerId, apptIds);
    const hasPrivate = Array.from(budgetSplit.values()).some(s => s.privateCents > 0);

    if (hasPrivate) {
      const { lineItems: allLineItems } = await buildLineItemsFromAppointments(apptIds, customerId, billingType);
      const { kasseItems, privateItems } = splitLineItemsByBudget(allLineItems, budgetSplit);

      const createdInvoices: Invoice[] = [];
      type AuditEntry = { invoiceId: number; payload: Record<string, unknown> };
      const pendingAudits: AuditEntry[] = [];

      const splitResult = await db.transaction(async (tx) => {
      if (kasseItems.length > 0) {
        const kasseNetCents = kasseItems.reduce((sum, i) => sum + i.totalCents, 0);
        let kasseRecipientName = "";
        let kasseRecipientAddress = "";
        let insuranceProviderName = "";
        let insuranceIkNummer: string | null = "";
        let versichertennummer: string | null = "";

        if (billingType === "pflegekasse_gesetzlich" && insuranceInfo) {
          kasseRecipientName = insuranceInfo.empfaenger || insuranceInfo.providerName;
          insuranceProviderName = insuranceInfo.providerName;
          insuranceIkNummer = insuranceInfo.ikNummer;
          versichertennummer = insuranceInfo.versichertennummer;
          const addrParts: string[] = [];
          if (insuranceInfo.empfaengerZeile2) addrParts.push(insuranceInfo.empfaengerZeile2);
          if (insuranceInfo.anschrift) {
            addrParts.push(insuranceInfo.anschrift);
          } else if (insuranceInfo.strasse) {
            addrParts.push([insuranceInfo.strasse, insuranceInfo.hausnummer].filter(Boolean).join(" "));
          }
          if (insuranceInfo.plzOrt) {
            addrParts.push(insuranceInfo.plzOrt);
          } else if (insuranceInfo.plz || insuranceInfo.stadt) {
            addrParts.push([insuranceInfo.plz, insuranceInfo.stadt].filter(Boolean).join(" "));
          }
          kasseRecipientAddress = addrParts.join("\n");
        } else {
          kasseRecipientName = customerName;
          kasseRecipientAddress = customerAddress;
          if (insuranceInfo) {
            insuranceProviderName = insuranceInfo.providerName;
            insuranceIkNummer = insuranceInfo.ikNummer;
            versichertennummer = insuranceInfo.versichertennummer;
          }
        }

        const kasseInvoiceNumber = await getNextInvoiceNumberTx(tx, billingYear);
        const kasseInvoiceData = {
          invoiceNumber: kasseInvoiceNumber,
          customerId,
          billingType,
          invoiceType: isNachberechnung ? "nachberechnung" as const : "rechnung" as const,
          billingMonth,
          billingYear,
          recipientName: kasseRecipientName,
          recipientAddress: kasseRecipientAddress,
          customerName,
          insuranceProviderName: insuranceProviderName || null,
          insuranceIkNummer: insuranceIkNummer || null,
          versichertennummer: versichertennummer || null,
          pflegegrad: customer.pflegegrad || null,
          netAmountCents: kasseNetCents,
          vatAmountCents: 0,
          grossAmountCents: kasseNetCents,
          vatRate: 0,
          status: "entwurf",
          notes: "Kassenanteil — Leistungen im Rahmen des verfügbaren Budgets",
          referencedStornoInvoiceIds: stornoRefsForInsert,
        };

        const kasseInvoice = await createInvoiceTx(tx, kasseInvoiceData, kasseItems as Record<string, unknown>[], req.user!.id);
        createdInvoices.push(kasseInvoice);

        pendingAudits.push({
          invoiceId: kasseInvoice.id,
          payload: {
            invoiceNumber: kasseInvoiceNumber,
            customerId,
            billingType,
            invoiceType: isNachberechnung ? "nachberechnung" : "rechnung",
            billingMonth,
            billingYear,
            grossAmountCents: kasseNetCents,
            lineItemCount: kasseItems.length,
            splitType: "kasse",
          },
        });
      }

      if (privateItems.length > 0) {
        const privateNetCents = privateItems.reduce((sum, i) => sum + i.totalCents, 0);
        const privateVatCents = Math.round(privateNetCents * 1900 / 10000);
        let insuranceProviderName = "";
        let insuranceIkNummer: string | null = "";
        let versichertennummer: string | null = "";
        if (insuranceInfo) {
          insuranceProviderName = insuranceInfo.providerName;
          insuranceIkNummer = insuranceInfo.ikNummer;
          versichertennummer = insuranceInfo.versichertennummer;
        }

        const privateInvoiceNumber = await getNextInvoiceNumberTx(tx, billingYear);
        const privateInvoiceData = {
          invoiceNumber: privateInvoiceNumber,
          customerId,
          billingType: "selbstzahler",
          invoiceType: isNachberechnung ? "nachberechnung" as const : "rechnung" as const,
          billingMonth,
          billingYear,
          recipientName: customerName,
          recipientAddress: customerAddress,
          customerName,
          insuranceProviderName: insuranceProviderName || null,
          insuranceIkNummer: insuranceIkNummer || null,
          versichertennummer: versichertennummer || null,
          pflegegrad: customer.pflegegrad || null,
          netAmountCents: privateNetCents,
          vatAmountCents: privateVatCents,
          grossAmountCents: privateNetCents + privateVatCents,
          vatRate: 1900,
          status: "entwurf",
          notes: "Privatzahlung — Budget-Überschreitung gem. Vereinbarung",
          referencedStornoInvoiceIds: stornoRefsForInsert,
        };

        const privateInvoice = await createInvoiceTx(tx, privateInvoiceData, privateItems as Record<string, unknown>[], req.user!.id);
        createdInvoices.push(privateInvoice);

        pendingAudits.push({
          invoiceId: privateInvoice.id,
          payload: {
            invoiceNumber: privateInvoiceNumber,
            customerId,
            billingType: "selbstzahler",
            invoiceType: isNachberechnung ? "nachberechnung" : "rechnung",
            billingMonth,
            billingYear,
            grossAmountCents: privateNetCents + privateVatCents,
            lineItemCount: privateItems.length,
            splitType: "privat",
          },
        });
      }

        return createdInvoices;
      });

      // Audit nach Commit, weil auditService nicht tx-aware ist.
      for (const entry of pendingAudits) {
        await auditService.log(req.user!.id, "invoice_created", "invoice", entry.invoiceId, entry.payload, req.ip);
      }

      // T01/PDF-Hash: PDF deterministisch erzeugen und persistieren, damit
      // die /pdf-Bytes hashstabil ausgeliefert werden.
      const refreshed: Invoice[] = [];
      for (const inv of splitResult) {
        try {
          await persistInvoicePdf(inv.id);
        } catch (pdfErr) {
          console.error(`[billing/generate] PDF-Persistierung für Rechnung ${inv.id} fehlgeschlagen:`, pdfErr);
        }
        const reloaded = await storage.getInvoice(inv.id);
        refreshed.push(reloaded ?? inv);
      }

      if (refreshed.length === 1) {
        res.json(refreshed[0]);
      } else {
        res.json({
          splitInvoices: true,
          invoices: refreshed,
          message: `${refreshed.length} Rechnungen erstellt: Kassenanteil und Privatanteil (Budget-Überschreitung).`,
        });
      }
      return;
    }
  }

  const { lineItems, totalNetCents, totalVatCents } = await buildLineItemsFromAppointments(apptIds, customerId, billingType);
  let recipientName = "";
  let recipientAddress = "";
  let insuranceProviderName = "";
  let insuranceIkNummer: string | null = "";
  let versichertennummer: string | null = "";

  if (billingType === "pflegekasse_gesetzlich") {
    if (insuranceInfo) {
      const ins = insuranceInfo;
      recipientName = ins.empfaenger || ins.providerName;
      insuranceProviderName = ins.providerName;
      insuranceIkNummer = ins.ikNummer;
      versichertennummer = ins.versichertennummer;
      const addrParts: string[] = [];
      if (ins.empfaengerZeile2) addrParts.push(ins.empfaengerZeile2);
      if (ins.anschrift) {
        addrParts.push(ins.anschrift);
      } else if (ins.strasse) {
        addrParts.push([ins.strasse, ins.hausnummer].filter(Boolean).join(" "));
      }
      if (ins.plzOrt) {
        addrParts.push(ins.plzOrt);
      } else if (ins.plz || ins.stadt) {
        addrParts.push([ins.plz, ins.stadt].filter(Boolean).join(" "));
      }
      recipientAddress = addrParts.join("\n");
    } else {
      recipientName = customerName;
    }
  } else {
    recipientName = customerName;
    recipientAddress = customerAddress;

    if (billingType === "pflegekasse_privat" && insuranceInfo) {
      insuranceProviderName = insuranceInfo.providerName;
      insuranceIkNummer = insuranceInfo.ikNummer;
      versichertennummer = insuranceInfo.versichertennummer;
    }
  }

  let invoice: Invoice;
  let invoiceNumber: string;
  try {
    ({ invoice, invoiceNumber } = await db.transaction(async (tx) => {
      const number = await getNextInvoiceNumberTx(tx, billingYear);
      const invoiceData = {
        invoiceNumber: number,
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
        vatRate: billingType === "selbstzahler" ? 1900 : 0,
        status: "entwurf",
        referencedStornoInvoiceIds: stornoRefsForInsert,
      };
      const created = await createInvoiceTx(tx, invoiceData, lineItems as Record<string, unknown>[], req.user!.id);
      return { invoice: created, invoiceNumber: number };
    }));
  } catch (err) {
    console.error("[billing/generate] Invoice insert failed.", {
      customerId,
      billingMonth,
      billingYear,
      lineItemCount: lineItems.length,
      sampleItem: lineItems[0] ? {
        appointmentDate: lineItems[0].appointmentDate,
        durationMinutes: lineItems[0].durationMinutes,
        unitPriceCents: lineItems[0].unitPriceCents,
        totalCents: lineItems[0].totalCents,
        serviceCode: lineItems[0].serviceCode,
      } : null,
    });
    throw err;
  }

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

  // T01/PDF-Hash: PDF deterministisch erzeugen und persistieren.
  try {
    await persistInvoicePdf(invoice.id);
  } catch (pdfErr) {
    console.error(`[billing/generate] PDF-Persistierung für Rechnung ${invoice.id} fehlgeschlagen:`, pdfErr);
  }
  const refreshedInvoice = await storage.getInvoice(invoice.id);
  res.json(refreshedInvoice ?? invoice);
}));


router.patch("/:id/status", asyncHandler("Status konnte nicht aktualisiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
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

  let updated: Invoice;
  if (status === "storniert") {
    if (invoice.invoiceType === "stornorechnung") {
      throw badRequest("Stornorechnungen können nicht erneut storniert werden.");
    }

    const { stornoInvoice, invoiceNumber, updatedOriginal } = await db.transaction(async (tx) => {
      // Re-Read mit FOR UPDATE: serialisiert parallele Stornos derselben
      // Originalrechnung. Ohne Lock würden zwei PATCHs den alten Status sehen
      // und beide eine Stornorechnung erzeugen.
      const locked = await getInvoiceForUpdateTx(tx, id);
      if (!locked) throw notFound("Rechnung nicht gefunden");
      if (locked.status === "storniert") {
        throw badRequest("Diese Rechnung wurde bereits storniert.");
      }
      if (locked.invoiceType === "stornorechnung") {
        throw badRequest("Stornorechnungen können nicht erneut storniert werden.");
      }

      const number = await getNextInvoiceNumberTx(tx, locked.billingYear);
      const lineItems = await getInvoiceLineItemsTx(tx, id);

      const stornoData = {
        invoiceNumber: number,
        customerId: locked.customerId,
        billingType: locked.billingType,
        invoiceType: "stornorechnung",
        billingMonth: locked.billingMonth,
        billingYear: locked.billingYear,
        recipientName: locked.recipientName,
        recipientAddress: locked.recipientAddress,
        customerName: locked.customerName,
        insuranceProviderName: locked.insuranceProviderName,
        insuranceIkNummer: locked.insuranceIkNummer,
        versichertennummer: locked.versichertennummer,
        pflegegrad: locked.pflegegrad,
        netAmountCents: -locked.netAmountCents,
        vatAmountCents: -locked.vatAmountCents,
        grossAmountCents: -locked.grossAmountCents,
        vatRate: locked.vatRate,
        // T10/BL-12: Stornorechnung startet als Entwurf, nicht als versendet —
        // der Versand-Pfad setzt status erst nach erfolgreicher Zustellung.
        status: "entwurf",
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
        appointmentNotes: item.appointmentNotes || null,
        serviceDetails: item.serviceDetails || null,
      }));

      const created = await createInvoiceTx(tx, stornoData, stornoLineItems, req.user!.id);
      const original = await updateInvoiceStatusTx(tx, id, status, req.user!.id);

      // T05/K3: Storno setzt den zugehörigen Leistungsnachweis NUR DANN
      // zurück (soft-delete), wenn im Zeitraum dokumentierte Termine
      // existieren, die im LN noch nicht erfasst sind. Nur dann ist eine
      // Nachberechnung mit erweiterter Termin-Liste sinnvoll. Ohne neue
      // dokumentierte Termine bleibt der LN bestehen, sodass BF-5.3
      // (reine Re-Abrechnung derselben Termine) weiterhin ohne neuen LN
      // erfolgen kann.
      const periodSrRows = await tx.select({
        id: monthlyServiceRecords.id,
      })
        .from(monthlyServiceRecords)
        .where(and(
          eq(monthlyServiceRecords.customerId, locked.customerId),
          eq(monthlyServiceRecords.year, locked.billingYear),
          eq(monthlyServiceRecords.month, locked.billingMonth),
          isNull(monthlyServiceRecords.deletedAt),
        ));
      if (periodSrRows.length > 0) {
        const srIds = periodSrRows.map(r => r.id);
        const linkedAppts = await tx.select({
          appointmentId: serviceRecordAppointments.appointmentId,
        })
          .from(serviceRecordAppointments)
          .where(inArray(serviceRecordAppointments.serviceRecordId, srIds));
        const linkedIds = new Set(linkedAppts.map(r => r.appointmentId));
        const mm = String(locked.billingMonth).padStart(2, '0');
        const periodStartStr = `${locked.billingYear}-${mm}-01`;
        const nextMonth = locked.billingMonth === 12 ? 1 : locked.billingMonth + 1;
        const nextYear = locked.billingMonth === 12 ? locked.billingYear + 1 : locked.billingYear;
        const periodEndStr = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
        const documentedAppts = await tx.select({ id: appointments.id })
          .from(appointments)
          .where(and(
            eq(appointments.customerId, locked.customerId),
            eq(appointments.status, 'completed'),
            isNull(appointments.deletedAt),
            gte(appointments.date, periodStartStr),
            lt(appointments.date, periodEndStr),
          ));
        const hasUnlinkedDoc = documentedAppts.some(a => !linkedIds.has(a.id));
        if (hasUnlinkedDoc) {
          await tx
            .update(monthlyServiceRecords)
            .set({ deletedAt: new Date() })
            .where(inArray(monthlyServiceRecords.id, srIds));
        }
      }

      // T04/K2: Storno-Reversal — alle §45b/Privat-Budget-Transaktionen der
      // Original-Rechnungs-Termine werden in derselben Transaktion zurückgebucht,
      // damit der §45b-Topf wieder als verfügbar angezeigt wird.
      const apptIdsForReversal = Array.from(
        new Set(
          lineItems
            .map((it: InvoiceLineItem) => it.appointmentId)
            .filter((v): v is number => typeof v === "number"),
        ),
      );
      for (const apptId of apptIdsForReversal) {
        const txs = await tx.select()
          .from(budgetTransactions)
          .where(and(
            eq(budgetTransactions.appointmentId, apptId),
            eq(budgetTransactions.transactionType, "consumption"),
          ));
        for (const t of txs) {
          await budgetLedgerStorage.reverseBudgetTransaction(t.id, req.user!.id, tx);
        }
      }

      return { stornoInvoice: created, invoiceNumber: number, updatedOriginal: original };
    });

    // Audit nach Commit, weil auditService nicht tx-aware ist.
    await auditService.log(req.user!.id, "invoice_cancelled", "invoice", id, {
      originalInvoiceNumber: invoice.invoiceNumber,
      stornoInvoiceId: stornoInvoice.id,
      stornoInvoiceNumber: invoiceNumber,
      customerId: invoice.customerId,
      grossAmountCents: invoice.grossAmountCents,
      oldStatus: currentStatus,
      newStatus: status,
    }, req.ip);

    updated = updatedOriginal;
  } else {
    updated = await storage.updateInvoiceStatus(id, status, req.user!.id);
  }

  res.json(updated);
}));

function buildPdfData(invoice: Invoice, lineItems: InvoiceLineItem[], companySettings: CompanySettings): InvoicePdfData {
  return {
    companyName: companySettings.companyName || "",
    companyAddress: [
      [companySettings.strasse, companySettings.hausnummer].filter(Boolean).join(" "),
      [companySettings.plz, companySettings.stadt].filter(Boolean).join(" "),
    ].filter(Boolean).join(", "),
    companyPhone: formatPhoneForDisplay(companySettings.telefon || ""),
    companyEmail: companySettings.email || "",
    companyWebsite: companySettings.website ?? null,
    steuernummer: companySettings.steuernummer ?? null,
    ustId: companySettings.ustId ?? null,
    iban: companySettings.iban || "",
    bic: companySettings.bic || "",
    bankName: companySettings.bankName || "",
    ikNummer: companySettings.ikNummer ?? null,
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
    customerAddress: invoice.recipientAddress || null,
    customerGeburtsdatum: null,
    lineItems: lineItems.map((item: InvoiceLineItem) => ({
      appointmentId: item.appointmentId ?? null,
      appointmentDate: item.appointmentDate,
      startTime: item.startTime ?? null,
      endTime: item.endTime ?? null,
      serviceDescription: item.serviceDescription,
      serviceCode: item.serviceCode || null,
      durationMinutes: item.durationMinutes,
      unitPriceCents: item.unitPriceCents,
      totalCents: item.totalCents,
      employeeName: item.employeeName ?? null,
      appointmentNotes: item.appointmentNotes || null,
      serviceDetails: item.serviceDetails || null,
    })),
    netAmountCents: invoice.netAmountCents,
    vatAmountCents: invoice.vatAmountCents,
    grossAmountCents: invoice.grossAmountCents,
    vatRate: invoice.vatRate || 0,
    notes: invoice.notes ?? null,
  };
}

async function enrichPdfDataWithSignatures(pdfData: InvoicePdfData, invoice: Invoice): Promise<void> {
  const serviceRecords = await db.select({
    id: monthlyServiceRecords.id,
    employeeSignatureData: monthlyServiceRecords.employeeSignatureData,
    employeeSignedAt: monthlyServiceRecords.employeeSignedAt,
    employeeId: monthlyServiceRecords.employeeId,
    customerSignatureData: monthlyServiceRecords.customerSignatureData,
    customerSignedAt: monthlyServiceRecords.customerSignedAt,
    status: monthlyServiceRecords.status,
    recordType: monthlyServiceRecords.recordType,
  })
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.customerId, invoice.customerId),
      eq(monthlyServiceRecords.year, invoice.billingYear),
      eq(monthlyServiceRecords.month, invoice.billingMonth),
      isNull(monthlyServiceRecords.deletedAt)
    ));

  const signedRecords = serviceRecords.filter(r =>
    r.status === "completed" || r.status === "employee_signed"
  );

  if (signedRecords.length > 0) {
    const recordIds = signedRecords.map(r => r.id);
    const employeeIds = Array.from(new Set(signedRecords.map(r => r.employeeId)));

    const [employeeRows, recordAppointments, empRoles] = await Promise.all([
      db.select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.id, employeeIds)),
      db.select({
        serviceRecordId: serviceRecordAppointments.serviceRecordId,
        appointmentId: serviceRecordAppointments.appointmentId,
      })
        .from(serviceRecordAppointments)
        .where(inArray(serviceRecordAppointments.serviceRecordId, recordIds)),
      db.select({ userId: userRoles.userId, role: userRoles.role })
        .from(userRoles)
        .where(inArray(userRoles.userId, employeeIds)),
    ]);

    const employeeMap = new Map(employeeRows.map(e => [e.id, e.displayName]));

    const qualMap = new Map<string, string>();
    for (const emp of employeeRows) {
      const roles = empRoles.filter(r => r.userId === emp.id).map(r => r.role);
      let label = "";
      if (roles.includes("alltagsbegleitung")) {
        label = "Alltagsbegleiter/in";
      } else if (roles.includes("hauswirtschaft")) {
        label = "Hauswirtschafter/in";
      }
      if (label) {
        qualMap.set(emp.displayName, label);
      }
    }
    if (qualMap.size > 0) {
      pdfData.employeeQualifications = qualMap;
    }
    const appointmentsByRecord = new Map<number, number[]>();
    for (const ra of recordAppointments) {
      const existing = appointmentsByRecord.get(ra.serviceRecordId) ?? [];
      existing.push(ra.appointmentId);
      appointmentsByRecord.set(ra.serviceRecordId, existing);
    }

    pdfData.signatures = signedRecords.map(r => ({
      employeeSignatureData: r.employeeSignatureData,
      employeeSignedAt: r.employeeSignedAt ? formatDateForDisplay(formatDateISO(r.employeeSignedAt instanceof Date ? r.employeeSignedAt : parseTimestamp(r.employeeSignedAt))) : null,
      employeeName: employeeMap.get(r.employeeId) || null,
      customerSignatureData: r.customerSignatureData,
      customerSignedAt: r.customerSignedAt ? formatDateForDisplay(formatDateISO(r.customerSignedAt instanceof Date ? r.customerSignedAt : parseTimestamp(r.customerSignedAt))) : null,
      customerName: invoice.customerName || invoice.recipientName,
      appointmentIds: appointmentsByRecord.get(r.id) ?? [],
      recordType: r.recordType,
    }));
  }

  if (!pdfData.employeeQualifications || pdfData.employeeQualifications.size === 0) {
    const employeeNamesFromItems = Array.from(new Set(pdfData.lineItems.map(i => i.employeeName).filter(Boolean))) as string[];
    if (employeeNamesFromItems.length > 0) {
      const empRows = await db.select({ id: users.id, displayName: users.displayName })
        .from(users)
        .where(inArray(users.displayName, employeeNamesFromItems));
      if (empRows.length > 0) {
        const roleRows = await db.select({ userId: userRoles.userId, role: userRoles.role })
          .from(userRoles)
          .where(inArray(userRoles.userId, empRows.map(e => e.id)));
        const qualMap = new Map<string, string>();
        for (const emp of empRows) {
          const roles = roleRows.filter(r => r.userId === emp.id).map(r => r.role);
          let label = "";
          if (roles.includes("alltagsbegleitung")) {
            label = "Alltagsbegleiter/in";
          } else if (roles.includes("hauswirtschaft")) {
            label = "Hauswirtschafter/in";
          }
          if (label) qualMap.set(emp.displayName, label);
        }
        if (qualMap.size > 0) pdfData.employeeQualifications = qualMap;
      }
    }
  }
}

// T01/PDF-Hash: Generiert die PDF-Bytes deterministisch (entspricht /pdf-Output),
// speichert sie in Object Storage und persistiert pdfPath + pdfHash.
// Wird nach jeder /generate-Invoice-Erstellung aufgerufen, damit /pdf später
// hashstabile Bytes ausliefert.
async function buildInvoicePdfBytes(invoice: Invoice, companySettings: CompanySettings): Promise<Buffer> {
  const lineItems = await storage.getInvoiceLineItems(invoice.id);
  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  const customerForInv = await db.select({
    geburtsdatum: customersTable.geburtsdatum,
    beihilfeBerechtigt: customersTable.beihilfeBerechtigt,
  })
    .from(customersTable)
    .where(eq(customersTable.id, invoice.customerId))
    .limit(1);
  if (customerForInv.length > 0) {
    if (customerForInv[0].geburtsdatum) pdfData.customerGeburtsdatum = customerForInv[0].geburtsdatum;
    if (customerForInv[0].beihilfeBerechtigt) pdfData.beihilfeBerechtigt = true;
  }

  const { generateInvoiceHtml, generateLeistungsnachweisHtml, generatePdf } = await import("../lib/pdf-generator");
  const { embedZugferdXml } = await import("../lib/zugferd");

  const html = generateInvoiceHtml(pdfData);
  const { buffer } = await generatePdf(html);
  const zugferdBuffer = await embedZugferdXml(buffer, pdfData);

  if (invoice.billingType === "pflegekasse_privat") {
    await enrichPdfDataWithSignatures(pdfData, invoice);
    const lnHtml = generateLeistungsnachweisHtml(pdfData);
    const { buffer: lnPdf } = await generatePdf(lnHtml);

    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.create();
    const invoiceDoc = await PDFDocument.load(zugferdBuffer);
    const lnDoc = await PDFDocument.load(lnPdf);
    const ip = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
    ip.forEach((p) => merged.addPage(p));
    const lp = await merged.copyPages(lnDoc, lnDoc.getPageIndices());
    lp.forEach((p) => merged.addPage(p));
    if (pdfData.beihilfeBerechtigt) {
      const ip2 = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
      ip2.forEach((p) => merged.addPage(p));
      const lp2 = await merged.copyPages(lnDoc, lnDoc.getPageIndices());
      lp2.forEach((p) => merged.addPage(p));
    }
    return Buffer.from(await merged.save());
  }
  return zugferdBuffer;
}

async function persistInvoicePdf(invoiceId: number): Promise<void> {
  const invoice = await storage.getInvoice(invoiceId);
  if (!invoice) return;
  const companySettings = await getCachedCompanySettings();
  if (!companySettings) return;

  const pdfBytes = await buildInvoicePdfBytes(invoice, companySettings);
  const pdfHash = computeDataHash(pdfBytes as unknown as string);

  const fileName = `invoices/${invoice.invoiceNumber.replace(/[^a-z0-9_-]/gi, "_")}.pdf`;
  const fullPath = `${getPrivateDir()}/${fileName}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  await objectStorageClient.bucket(bucketName).file(objectName).save(pdfBytes, {
    contentType: "application/pdf",
    metadata: { invoiceNumber: invoice.invoiceNumber, pdfHash },
  });

  await db.update(invoicesTable)
    .set({ pdfPath: `/objects/${fileName}`, pdfHash })
    .where(eq(invoicesTable.id, invoiceId));
}

async function loadInvoicePdfFromStorage(invoice: Invoice): Promise<Buffer | null> {
  if (!invoice.pdfPath) return null;
  let entityId = invoice.pdfPath;
  if (entityId.startsWith("/objects/")) entityId = entityId.slice("/objects/".length);
  let entityDir = getPrivateDir();
  if (!entityDir.endsWith("/")) entityDir = `${entityDir}/`;
  const fullPath = `${entityDir}${entityId}`;
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const file = objectStorageClient.bucket(bucketName).file(objectName);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [contents] = await file.download();
  return Buffer.from(contents);
}

router.get("/:id/pdf", asyncHandler("PDF konnte nicht generiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  // T01/PDF-Hash: Wenn die Rechnung bereits einen persistierten PDF-Pfad hat,
  // liefere die hashstabilen Bytes direkt aus Object Storage aus.
  const cached = await loadInvoicePdfFromStorage(invoice);
  if (cached) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
    res.send(cached);
    return;
  }

  const lineItems = await storage.getInvoiceLineItems(id);
  const companySettings = await getCachedCompanySettings();
  const { generateInvoiceHtml, generatePdf } = await import("../lib/pdf-generator");
  
  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  const customerForInv = await db.select({ geburtsdatum: customersTable.geburtsdatum, beihilfeBerechtigt: customersTable.beihilfeBerechtigt })
    .from(customersTable)
    .where(eq(customersTable.id, invoice.customerId))
    .limit(1);
  if (customerForInv.length > 0) {
    if (customerForInv[0].geburtsdatum) {
      pdfData.customerGeburtsdatum = customerForInv[0].geburtsdatum;
    }
    if (customerForInv[0].beihilfeBerechtigt) {
      pdfData.beihilfeBerechtigt = true;
    }
  }

  const html = generateInvoiceHtml(pdfData);
  const { buffer } = await generatePdf(html);
  
  const { embedZugferdXml } = await import("../lib/zugferd");
  const zugferdBuffer = await embedZugferdXml(buffer, pdfData);

  if (invoice.billingType === "pflegekasse_privat") {
    const { generateLeistungsnachweisHtml } = await import("../lib/pdf-generator");
    await enrichPdfDataWithSignatures(pdfData, invoice);
    const lnHtml = generateLeistungsnachweisHtml(pdfData);
    const { buffer: lnPdf } = await generatePdf(lnHtml);

    const { PDFDocument } = await import("pdf-lib");
    const merged = await PDFDocument.create();
    const invoiceDoc = await PDFDocument.load(zugferdBuffer);
    const lnDoc = await PDFDocument.load(lnPdf);
    const invoicePages = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
    invoicePages.forEach(p => merged.addPage(p));
    const lnPages = await merged.copyPages(lnDoc, lnDoc.getPageIndices());
    lnPages.forEach(p => merged.addPage(p));

    if (pdfData.beihilfeBerechtigt) {
      const invoicePages2 = await merged.copyPages(invoiceDoc, invoiceDoc.getPageIndices());
      invoicePages2.forEach(p => merged.addPage(p));
      const lnPages2 = await merged.copyPages(lnDoc, lnDoc.getPageIndices());
      lnPages2.forEach(p => merged.addPage(p));
    }

    const mergedBytes = await merged.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
    res.send(Buffer.from(mergedBytes));
  } else {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
    res.send(zugferdBuffer);
  }
}));

router.get("/:id/leistungsnachweis", asyncHandler("Leistungsnachweis konnte nicht generiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  
  const lineItems = await storage.getInvoiceLineItems(id);
  const companySettings = await getCachedCompanySettings();
  const { generateLeistungsnachweisHtml, generatePdf } = await import("../lib/pdf-generator");
  
  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  const customerForLN = await db.select({ geburtsdatum: customersTable.geburtsdatum })
    .from(customersTable)
    .where(eq(customersTable.id, invoice.customerId))
    .limit(1);
  if (customerForLN.length > 0 && customerForLN[0].geburtsdatum) {
    pdfData.customerGeburtsdatum = customerForLN[0].geburtsdatum;
  }

  await enrichPdfDataWithSignatures(pdfData, invoice);

  const html = generateLeistungsnachweisHtml(pdfData);
  const { buffer } = await generatePdf(html);
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="LN-${invoice.invoiceNumber}.pdf"`);
  res.send(buffer);
}));

const MONTH_NAMES_DE = [
  "Januar", "Februar", "März", "April", "Mai", "Juni",
  "Juli", "August", "September", "Oktober", "November", "Dezember",
];

router.post("/:id/send", asyncHandler("Rechnung konnte nicht versendet werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;

  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");

  if (invoice.status !== "entwurf") {
    throw badRequest(`Rechnung hat Status "${invoice.status}" — nur Entwürfe können versendet werden.`);
  }

  if (invoice.billingType !== "pflegekasse_gesetzlich" && invoice.billingType !== "pflegekasse_privat") {
    throw badRequest("Nur Rechnungen an Pflegekassen können über diese Funktion versendet werden.");
  }

  // T06/BL-16: Hard-Block — Versand nur möglich, wenn für den
  // Abrechnungs-Zeitraum mindestens ein Leistungsnachweis vollständig
  // (employee + customer) signiert ist. Ohne Signaturen ist die Rechnung
  // gegenüber Kasse/Kunde nicht beweisbar — wir lehnen den Versand ab,
  // statt unsigniert zu versenden.
  const signedSrCount = await db.select({ id: monthlyServiceRecords.id })
    .from(monthlyServiceRecords)
    .where(and(
      eq(monthlyServiceRecords.customerId, invoice.customerId),
      eq(monthlyServiceRecords.year, invoice.billingYear),
      eq(monthlyServiceRecords.month, invoice.billingMonth),
      isNull(monthlyServiceRecords.deletedAt),
      inArray(monthlyServiceRecords.status, ["completed", "employee_signed"]),
    ));
  if (signedSrCount.length === 0) {
    throw badRequest(
      "Versand abgelehnt: Für diesen Abrechnungs-Zeitraum existiert kein vollständig unterschriebener Leistungsnachweis. Bitte zuerst Mitarbeiter- und Kundenunterschrift einholen.",
    );
  }

  const customer = await db.select().from(customersTable).where(eq(customersTable.id, invoice.customerId)).limit(1);
  if (!customer.length) throw notFound("Kunde nicht gefunden");
  const cust = customer[0];

  const isPrivatBilling = invoice.billingType === "pflegekasse_privat";
  const isBeihilfe = isPrivatBilling && cust.beihilfeBerechtigt;

  const insHistory = await db.select({
    providerId: customerInsuranceHistory.insuranceProviderId,
    versichertennummer: customerInsuranceHistory.versichertennummer,
  })
    .from(customerInsuranceHistory)
    .where(and(
      eq(customerInsuranceHistory.customerId, invoice.customerId),
      isNull(customerInsuranceHistory.validTo),
    ))
    .limit(1);

  if (!insHistory.length) throw badRequest("Keine aktive Pflegekassenzuordnung für diesen Kunden.");

  const provider = await db.select().from(insuranceProviders).where(eq(insuranceProviders.id, insHistory[0].providerId)).limit(1);

  let recipientEmail: string | null = null;
  let recipientDisplayName = "";
  let hasParagraph39 = false;

  if (isPrivatBilling) {
    if (!cust.email) throw badRequest("Keine E-Mail-Adresse beim Kunden hinterlegt.");
    recipientEmail = cust.email;
    recipientDisplayName = [cust.vorname, cust.nachname].filter(Boolean).join(" ") || cust.name;
  } else {
    if (!provider.length) throw notFound("Pflegekasse nicht gefunden");
    const ins = provider[0];
    if (!ins.emailInvoiceEnabled) {
      throw badRequest("E-Mail-Versand ist für diese Pflegekasse nicht aktiviert.");
    }

    const lineItemsForCheck = await storage.getInvoiceLineItems(id);
    if (lineItemsForCheck.length > 0) {
      const appointmentIds = lineItemsForCheck.map(li => li.appointmentId).filter(Boolean) as number[];
      if (appointmentIds.length > 0) {
        const txns = await db.select({ budgetType: budgetTransactions.budgetType })
          .from(budgetTransactions)
          .where(and(
            inArray(budgetTransactions.appointmentId, appointmentIds),
            eq(budgetTransactions.transactionType, "consumption"),
          ));
        hasParagraph39 = txns.some(t => t.budgetType === "ersatzpflege_39_42a");
      }
    }

    recipientEmail = hasParagraph39 ? (ins.emailVerhinderungspflege || ins.email) : ins.email;
    recipientDisplayName = ins.name;
  }

  if (!recipientEmail) {
    throw badRequest(isPrivatBilling ? "Keine E-Mail-Adresse beim Kunden hinterlegt." : "Keine E-Mail-Adresse bei der Pflegekasse hinterlegt.");
  }

  const lineItems = await storage.getInvoiceLineItems(id);

  const companySettings = await getCachedCompanySettings();
  if (!companySettings) throw badRequest("Firmendaten nicht konfiguriert.");

  const { generateInvoiceHtml, generateLeistungsnachweisHtml, generatePdf } = await import("../lib/pdf-generator");
  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  if (cust.geburtsdatum) pdfData.customerGeburtsdatum = cust.geburtsdatum;
  if (isBeihilfe) pdfData.beihilfeBerechtigt = true;

  const invoiceHtml = generateInvoiceHtml(pdfData);
  const { buffer: invoicePdf } = await generatePdf(invoiceHtml);

  const { embedZugferdXml } = await import("../lib/zugferd");
  const zugferdBuffer = await embedZugferdXml(invoicePdf, pdfData);

  const lnHtml = generateLeistungsnachweisHtml(pdfData);
  const { buffer: lnPdf } = await generatePdf(lnHtml);

  let finalInvoicePdf: Buffer = zugferdBuffer;
  let finalLnPdf: Buffer = lnPdf;

  if (isBeihilfe) {
    const { PDFDocument } = await import("pdf-lib");
    const mergedInv = await PDFDocument.create();
    const invDoc = await PDFDocument.load(zugferdBuffer);
    const invPages1 = await mergedInv.copyPages(invDoc, invDoc.getPageIndices());
    invPages1.forEach(p => mergedInv.addPage(p));
    const invPages2 = await mergedInv.copyPages(invDoc, invDoc.getPageIndices());
    invPages2.forEach(p => mergedInv.addPage(p));
    finalInvoicePdf = Buffer.from(await mergedInv.save());

    const mergedLn = await PDFDocument.create();
    const lnDoc = await PDFDocument.load(lnPdf);
    const lnPages1 = await mergedLn.copyPages(lnDoc, lnDoc.getPageIndices());
    lnPages1.forEach(p => mergedLn.addPage(p));
    const lnPages2 = await mergedLn.copyPages(lnDoc, lnDoc.getPageIndices());
    lnPages2.forEach(p => mergedLn.addPage(p));
    finalLnPdf = Buffer.from(await mergedLn.save());
  }

  const { sendEmail, buildEmailLayout } = await import("../services/email-service");
  const { resolveLogoToDataUrl } = await import("../services/logo-resolver");
  const companyName = companySettings.companyName || "SeniorenEngel";
  const resolvedLogo = await resolveLogoToDataUrl(companySettings.logoUrl);

  const monthName = MONTH_NAMES_DE[(invoice.billingMonth - 1)] || String(invoice.billingMonth);
  const customerFullName = [cust.vorname, cust.nachname].filter(Boolean).join(" ") || cust.name;
  const versNr = insHistory[0].versichertennummer || invoice.versichertennummer || "";

  const subject = `Rechnung ${invoice.invoiceNumber} — ${customerFullName}${versNr ? ` (${versNr})` : ""} — ${monthName} ${invoice.billingYear} — ${companyName}`;
  let bodyContent = "";
  if (isPrivatBilling) {
    bodyContent = `
      <p>Sehr geehrte/r ${cust.vorname || ""} ${cust.nachname || ""},</p>
      <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
      für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
      ${isBeihilfe ? `<p><strong>Hinweis:</strong> Anbei erhalten Sie Ihre Rechnung und den Leistungsnachweis in doppelter Ausfertigung — bitte reichen Sie je ein Exemplar bei Ihrer privaten Pflegekasse und Ihrer Beihilfestelle ein.</p>` : ""}
      <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
      <p>Mit freundlichen Grüßen<br/>${companyName}</p>
    `;
  } else {
    bodyContent = `
      <p>Sehr geehrte Damen und Herren,</p>
      <p>anbei erhalten Sie die Rechnung <strong>${invoice.invoiceNumber}</strong> sowie den zugehörigen Leistungsnachweis
      für <strong>${customerFullName}</strong>${versNr ? ` (Versichertennr. ${versNr})` : ""} 
      für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>.</p>
      <p>Bei Rückfragen stehen wir Ihnen gerne zur Verfügung.</p>
      <p>Mit freundlichen Grüßen<br/>${companyName}</p>
    `;
  }

  const html = buildEmailLayout(companyName, resolvedLogo, bodyContent);

  const fileNames = `[${invoice.invoiceNumber}] ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;

  try {
    await sendEmail(companySettings, {
      to: recipientEmail,
      subject,
      html,
      attachments: [
        { filename: `${invoice.invoiceNumber}.pdf`, content: finalInvoicePdf, contentType: "application/pdf" },
        { filename: `LN-${invoice.invoiceNumber}.pdf`, content: finalLnPdf, contentType: "application/pdf" },
      ],
    });
  } catch (sendErr: unknown) {
    const errMsg = sendErr instanceof Error ? sendErr.message : "Unbekannter Fehler";
    await deliveryStorage.createDelivery({
      customerId: invoice.customerId,
      deliveryMethod: "email",
      status: "error",
      recipientEmail,
      recipientName: recipientDisplayName,
      documentFileNames: fileNames,
      errorMessage: errMsg,
      createdByUserId: req.user!.id,
    });
    throw sendErr;
  }

  const updated = await storage.updateInvoiceStatus(id, "versendet", req.user!.id);

  await deliveryStorage.createDelivery({
    customerId: invoice.customerId,
    deliveryMethod: "email",
    status: "sent",
    recipientEmail,
    recipientName: recipientDisplayName,
    documentFileNames: fileNames,
    sentAt: new Date(),
    createdByUserId: req.user!.id,
  });

  await auditService.log(req.user!.id, "invoice_sent", "invoice", id, {
    invoiceNumber: invoice.invoiceNumber,
    recipientEmail,
    customerId: invoice.customerId,
    insuranceProviderId: provider.length ? provider[0].id : null,
    insuranceProviderName: recipientDisplayName,
    hasParagraph39, isPrivatBilling, isBeihilfe,
  }, req.ip);

  const results: { invoiceId: number; status: string; recipientEmail: string; customerCopy?: boolean; letterxpressLetterId?: string }[] = [
    { invoiceId: id, status: "sent", recipientEmail },
  ];

  if (cust.receivesMonthlyInvoice) {
    const custDeliveryMethod = cust.documentDeliveryMethod || "email";
    const copyFileNames = `[${invoice.invoiceNumber}] Kopie: ${invoice.invoiceNumber}.pdf, LN-${invoice.invoiceNumber}.pdf`;
    try {
      if (custDeliveryMethod === "email" && !cust.email) {
        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "error",
          recipientName: customerFullName,
          documentFileNames: copyFileNames,
          errorMessage: "Keine E-Mail-Adresse beim Kunden hinterlegt",
          createdByUserId: req.user!.id,
        });
        results.push({ invoiceId: id, status: "error", recipientEmail: "", customerCopy: true });
      } else if (custDeliveryMethod === "email" && cust.email) {
        const customerSubject = `Rechnungskopie ${invoice.invoiceNumber} — ${monthName} ${invoice.billingYear}`;
        const customerBody = `
          <p>Sehr geehrte/r ${cust.vorname || ""} ${cust.nachname || ""},</p>
          <p>anbei erhalten Sie eine Kopie der Rechnung <strong>${invoice.invoiceNumber}</strong> 
          für den Leistungszeitraum <strong>${monthName} ${invoice.billingYear}</strong>, 
          die an Ihre Pflegekasse gesendet wurde.</p>
          <p>Mit freundlichen Grüßen<br/>${companyName}</p>
        `;
        const customerHtml = buildEmailLayout(companyName, resolvedLogo, customerBody);

        await sendEmail(companySettings, {
          to: cust.email,
          subject: customerSubject,
          html: customerHtml,
          attachments: [
            { filename: `${invoice.invoiceNumber}.pdf`, content: zugferdBuffer, contentType: "application/pdf" },
            { filename: `LN-${invoice.invoiceNumber}.pdf`, content: lnPdf, contentType: "application/pdf" },
          ],
        });

        results.push({ invoiceId: id, status: "sent", recipientEmail: cust.email, customerCopy: true });

        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "email",
          status: "sent",
          recipientEmail: cust.email,
          recipientName: customerFullName,
          documentFileNames: copyFileNames,
          sentAt: new Date(),
          createdByUserId: req.user!.id,
        });
      } else if (custDeliveryMethod === "post") {
        const customerAddress = [cust.strasse, cust.nr, cust.plz, cust.stadt].filter(Boolean).join(", ");
        const { letterId } = await sendInvoiceCopyByPost(companySettings, {
          customer: cust,
          invoicePdf: zugferdBuffer,
          leistungsnachweisPdf: lnPdf,
          invoiceNumber: invoice.invoiceNumber,
          monthName,
          year: invoice.billingYear,
        });
        await deliveryStorage.createDelivery({
          customerId: invoice.customerId,
          deliveryMethod: "post",
          status: "sent",
          recipientName: customerFullName,
          recipientAddress: customerAddress,
          documentFileNames: copyFileNames,
          sentAt: new Date(),
          letterxpressLetterId: letterId,
          createdByUserId: req.user!.id,
        });
        results.push({ invoiceId: id, status: "post_sent", recipientEmail: "", customerCopy: true, letterxpressLetterId: letterId });
      }
    } catch (copyError: unknown) {
      const copyErrMsg = copyError instanceof Error ? copyError.message : "Unbekannter Fehler";
      console.error("Kundenkopie konnte nicht gesendet werden:", copyErrMsg);
      await deliveryStorage.createDelivery({
        customerId: invoice.customerId,
        deliveryMethod: custDeliveryMethod,
        status: "error",
        recipientEmail: cust.email || null,
        recipientName: customerFullName,
        documentFileNames: copyFileNames,
        errorMessage: copyErrMsg,
        createdByUserId: req.user!.id,
      }).catch((deliveryLogErr: unknown) => {
        console.error(
          `[billing/send] Delivery-Log für Kundenkopie konnte nicht geschrieben werden (invoice ${id}):`,
          deliveryLogErr instanceof Error ? deliveryLogErr.message : deliveryLogErr,
        );
      });
      results.push({ invoiceId: id, status: "error", recipientEmail: cust.email || "", customerCopy: true });
    }
  }

  res.json({
    message: "Rechnung erfolgreich versendet",
    invoice: updated,
    results,
  });
}));

export default router;
