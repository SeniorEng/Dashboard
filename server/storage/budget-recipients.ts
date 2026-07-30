/**
 * Task #759 — Variant C: Per-Pot-Empfänger-Resolver.
 *
 * Liefert für ein (Kunde × Budget-Topf)-Paar den Rechnungs-Empfänger.
 *
 * Reihenfolge der Quellen
 * -----------------------
 * 1. `customer_budget_recipients` — expliziter Override mit gültigem
 *    `validFrom/validTo`-Fenster (append-only historisiert).
 * 2. Pot-Default:
 *    - Kasse-Pots (`entlastungsbetrag_45b`/`umwandlung_45a`/
 *      `ersatzpflege_39_42a`): die am Stichtag `asOfISO` gültige
 *      `customer_insurance_history`-Zeile über `resolveCustomerInsuranceAt`
 *      (Empfänger = `insurance_providers.empfaenger` oder Provider-Name).
 *    - `"private"` (Selbstzahler-Pot): Kunden-Stammadresse.
 *
 * Der Resolver gibt **immer** ein Ergebnis zurück (auch nur mit
 * Kundenname als letzte Bastion). Aufrufer müssen `recipientAddress`
 * nicht prüfen — leer/null ist erlaubt, der PDF-Renderer ist tolerant.
 */

import { and, eq, isNull, or, gte, lte, desc } from "drizzle-orm";
import { db } from "../lib/db";
import {
  customerBudgetRecipients,
  customers as customersTable,
} from "@shared/schema";
import { resolveCustomerInsuranceAt } from "./customer-mgmt/insurance";
import type { InvoicePotKey } from "@shared/domain/budget-invoice-split";

export interface BudgetRecipient {
  recipientName: string;
  recipientAddress: string | null;
  insuranceProviderName: string | null;
  ikNummer: string | null;
  versichertennummer: string | null;
}

function buildCustomerName(c: {
  name: string | null;
  vorname: string | null;
  nachname: string | null;
}): string {
  if (c.vorname && c.nachname) return `${c.vorname} ${c.nachname}`;
  return c.name || "Unbekannt";
}

function buildCustomerAddress(c: {
  strasse: string | null;
  nr: string | null;
  plz: string | null;
  stadt: string | null;
}): string | null {
  const line1 = [c.strasse, c.nr].filter(Boolean).join(" ");
  const line2 = [c.plz, c.stadt].filter(Boolean).join(" ").trim();
  const out = [line1, line2].filter((s) => s && s.length > 0).join("\n");
  return out || null;
}

function buildInsuranceAddress(p: {
  empfaengerZeile2: string | null;
  anschrift: string | null;
  strasse: string | null;
  hausnummer: string | null;
  plzOrt: string | null;
  plz: string | null;
  stadt: string | null;
}): string {
  const parts: string[] = [];
  if (p.empfaengerZeile2) parts.push(p.empfaengerZeile2);
  if (p.anschrift) parts.push(p.anschrift);
  else if (p.strasse) parts.push([p.strasse, p.hausnummer].filter(Boolean).join(" "));
  if (p.plzOrt) parts.push(p.plzOrt);
  else if (p.plz || p.stadt) parts.push([p.plz, p.stadt].filter(Boolean).join(" "));
  return parts.join("\n");
}

export async function resolveBudgetRecipient(
  customerId: number,
  potKey: InvoicePotKey,
  asOfISO: string,
): Promise<BudgetRecipient> {
  // 1) Override?
  if (potKey !== "private") {
    const overrideRows = await db
      .select()
      .from(customerBudgetRecipients)
      .where(
        and(
          eq(customerBudgetRecipients.customerId, customerId),
          eq(customerBudgetRecipients.budgetType, potKey),
          lte(customerBudgetRecipients.validFrom, asOfISO),
          or(
            isNull(customerBudgetRecipients.validTo),
            gte(customerBudgetRecipients.validTo, asOfISO),
          ),
        ),
      )
      .orderBy(desc(customerBudgetRecipients.validFrom))
      .limit(1);
    if (overrideRows.length > 0) {
      const o = overrideRows[0];
      return {
        recipientName: o.recipientName,
        recipientAddress: o.recipientAddress ?? null,
        insuranceProviderName: null,
        ikNummer: o.ikNummer ?? null,
        versichertennummer: o.versichertennummer ?? null,
      };
    }
  }

  // Kunden-Stammdaten — Basis für Selbstzahler-Pot und Fallback.
  const custRows = await db
    .select({
      id: customersTable.id,
      name: customersTable.name,
      vorname: customersTable.vorname,
      nachname: customersTable.nachname,
      strasse: customersTable.strasse,
      nr: customersTable.nr,
      plz: customersTable.plz,
      stadt: customersTable.stadt,
    })
    .from(customersTable)
    .where(eq(customersTable.id, customerId))
    .limit(1);
  const cust = custRows[0];
  const customerName = cust ? buildCustomerName(cust) : "Unbekannt";
  const customerAddress = cust ? buildCustomerAddress(cust) : null;

  if (potKey === "private") {
    return {
      recipientName: customerName,
      recipientAddress: customerAddress,
      insuranceProviderName: null,
      ikNummer: null,
      versichertennummer: null,
    };
  }

  // 2) Kasse-Default: die am Stichtag gültige Zuordnung (Task #1893).
  // Vorher `valid_to IS NULL` — der Resolver bekam `asOfISO` zwar übergeben,
  // wandte ihn aber NUR auf den Override (1) an. Damit adressierte eine im Juli
  // erstellte Juni-Rechnung den Juli-Kostenträger.
  const ins = await resolveCustomerInsuranceAt(customerId, asOfISO);

  if (!ins) {
    return {
      recipientName: customerName,
      recipientAddress: customerAddress,
      insuranceProviderName: null,
      ikNummer: null,
      versichertennummer: null,
    };
  }

  return {
    recipientName: ins.provider.empfaenger || ins.provider.name,
    recipientAddress: buildInsuranceAddress(ins.provider),
    insuranceProviderName: ins.provider.name,
    ikNummer: ins.provider.ikNummer ?? null,
    versichertennummer: ins.versichertennummer ?? null,
  };
}
