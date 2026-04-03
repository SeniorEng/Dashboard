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
import type { Invoice, InvoiceLineItem, CompanySettings } from "@shared/schema";
import { eq, and, gte, lte, isNull, inArray, ne, notInArray, or } from "drizzle-orm";
import { z } from "zod";
import { fromError } from "zod-validation-error";
import { formatDateForDisplay, formatDateISO, todayISO } from "@shared/utils/datetime";
import { storage } from "../storage";
import { db } from "../lib/db";
import { auditService } from "../services/audit";
import type { InvoicePdfData } from "../lib/pdf-generator";
import { getCachedCompanySettings } from "../services/cache";

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
  let allCustomerPrices: { serviceId: number; priceCents: number; validFrom: Date | null; validTo: Date | null }[] = [];
  if (resolvedCustomerId) {
    allCustomerPrices = await db.select({
      serviceId: customerServicePrices.serviceId,
      priceCents: customerServicePrices.priceCents,
      validFrom: customerServicePrices.validFrom,
      validTo: customerServicePrices.validTo,
    })
    .from(customerServicePrices)
    .where(eq(customerServicePrices.customerId, resolvedCustomerId));
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
      return bFrom - aFrom;
    });
    return matching[0].priceCents;
  }

  const employeeIds = [...new Set(appts.map(a => a.assignedEmployeeId || a.performedByEmployeeId).filter((id): id is number => id != null))];
  const employeeMap = new Map<number, { displayName: string; lbnr: string }>();
  if (employeeIds.length > 0) {
    const emps = await db.select({ id: users.id, displayName: users.displayName, lbnr: users.lbnr }).from(users).where(inArray(users.id, employeeIds));
    for (const emp of emps) {
      employeeMap.set(emp.id, { displayName: emp.displayName, lbnr: emp.lbnr || "" });
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
    const employeeLbnr = emp?.lbnr || "";

    for (const svc of apptServices) {
      const durationMinutes = svc.actualDurationMinutes ?? svc.plannedDurationMinutes;
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
        employeeLbnr,
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
      const kmRounded = Math.round(kmEntry.km);
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
        durationMinutes: kmRounded,
        unitPriceCents: pricePerKm,
        totalCents: kmTotalCents,
        employeeName,
        employeeLbnr,
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

  const eligibleCustomers = await db.select({
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
        kasseShare = kasseRemaining;
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
  const isNachberechnung = alreadyInvoicedIds.length > 0;

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

      if (kasseItems.length > 0) {
        const kasseNetCents = kasseItems.reduce((sum, i) => sum + i.totalCents, 0);
        let kasseRecipientName = "";
        let kasseRecipientAddress = "";
        let insuranceProviderName = "";
        let insuranceIkNummer = "";
        let versichertennummer = "";

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

        const kasseInvoiceNumber = await storage.getNextInvoiceNumber(billingYear);
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
        };

        const kasseInvoice = await storage.createInvoice(kasseInvoiceData, kasseItems as Record<string, unknown>[], req.user!.id);
        createdInvoices.push(kasseInvoice);

        await auditService.log(req.user!.id, "invoice_created", "invoice", kasseInvoice.id, {
          invoiceNumber: kasseInvoiceNumber,
          customerId,
          billingType,
          invoiceType: isNachberechnung ? "nachberechnung" : "rechnung",
          billingMonth,
          billingYear,
          grossAmountCents: kasseNetCents,
          lineItemCount: kasseItems.length,
          splitType: "kasse",
        }, req.ip);
      }

      if (privateItems.length > 0) {
        const privateNetCents = privateItems.reduce((sum, i) => sum + i.totalCents, 0);
        const privateVatCents = Math.round(privateNetCents * 1900 / 10000);
        let insuranceProviderName = "";
        let insuranceIkNummer = "";
        let versichertennummer = "";
        if (insuranceInfo) {
          insuranceProviderName = insuranceInfo.providerName;
          insuranceIkNummer = insuranceInfo.ikNummer;
          versichertennummer = insuranceInfo.versichertennummer;
        }

        const privateInvoiceNumber = await storage.getNextInvoiceNumber(billingYear);
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
        };

        const privateInvoice = await storage.createInvoice(privateInvoiceData, privateItems as Record<string, unknown>[], req.user!.id);
        createdInvoices.push(privateInvoice);

        await auditService.log(req.user!.id, "invoice_created", "invoice", privateInvoice.id, {
          invoiceNumber: privateInvoiceNumber,
          customerId,
          billingType: "selbstzahler",
          invoiceType: isNachberechnung ? "nachberechnung" : "rechnung",
          billingMonth,
          billingYear,
          grossAmountCents: privateNetCents + privateVatCents,
          lineItemCount: privateItems.length,
          splitType: "privat",
        }, req.ip);
      }

      if (createdInvoices.length === 1) {
        res.json(createdInvoices[0]);
      } else {
        res.json({
          splitInvoices: true,
          invoices: createdInvoices,
          message: `${createdInvoices.length} Rechnungen erstellt: Kassenanteil und Privatanteil (Budget-Überschreitung).`,
        });
      }
      return;
    }
  }

  const { lineItems, totalNetCents, totalVatCents } = await buildLineItemsFromAppointments(apptIds, customerId, billingType);
  let recipientName = "";
  let recipientAddress = "";
  let insuranceProviderName = "";
  let insuranceIkNummer = "";
  let versichertennummer = "";

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
    vatRate: billingType === "selbstzahler" ? 1900 : 0,
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
      serviceDetails: item.serviceDetails || null,
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
    companyPhone: formatPhoneForDisplay(companySettings.telefon || ""),
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
      employeeLbnr: item.employeeLbnr ?? null,
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

router.get("/:id/pdf", asyncHandler("PDF konnte nicht generiert werden", async (req, res) => {
  const id = requireIntParam(req.params.id, res);
  if (id === null) return;
  const invoice = await storage.getInvoice(id);
  if (!invoice) throw notFound("Rechnung nicht gefunden");
  
  const lineItems = await storage.getInvoiceLineItems(id);
  const companySettings = await getCachedCompanySettings();
  const { generateInvoiceHtml, generatePdf } = await import("../lib/pdf-generator");
  
  const pdfData = buildPdfData(invoice, lineItems, companySettings);

  const customerForInv = await db.select({ geburtsdatum: customersTable.geburtsdatum })
    .from(customersTable)
    .where(eq(customersTable.id, invoice.customerId))
    .limit(1);
  if (customerForInv.length > 0 && customerForInv[0].geburtsdatum) {
    pdfData.customerGeburtsdatum = customerForInv[0].geburtsdatum;
  }

  const html = generateInvoiceHtml(pdfData);
  const { buffer } = await generatePdf(html);
  
  const { embedZugferdXml } = await import("../lib/zugferd");
  const zugferdBuffer = await embedZugferdXml(buffer, pdfData);
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${invoice.invoiceNumber}.pdf"`);
  res.send(zugferdBuffer);
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
      employeeSignedAt: r.employeeSignedAt ? formatDateForDisplay(formatDateISO(r.employeeSignedAt instanceof Date ? r.employeeSignedAt : new Date(r.employeeSignedAt))) : null,
      employeeName: employeeMap.get(r.employeeId) || null,
      customerSignatureData: r.customerSignatureData,
      customerSignedAt: r.customerSignedAt ? formatDateForDisplay(formatDateISO(r.customerSignedAt instanceof Date ? r.customerSignedAt : new Date(r.customerSignedAt))) : null,
      customerName: invoice.customerName || invoice.recipientName,
      appointmentIds: appointmentsByRecord.get(r.id) ?? [],
      recordType: r.recordType,
    }));
  }

  if (!pdfData.employeeQualifications || pdfData.employeeQualifications.size === 0) {
    const employeeNamesFromItems = Array.from(new Set(lineItems.map(i => i.employeeName).filter(Boolean))) as string[];
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

  const html = generateLeistungsnachweisHtml(pdfData);
  const { buffer } = await generatePdf(html);
  
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="LN-${invoice.invoiceNumber}.pdf"`);
  res.send(buffer);
}));

export default router;
