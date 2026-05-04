import { db } from "../lib/db";
import { sql } from "drizzle-orm";
import { log } from "../lib/log";
import { normalizePhone } from "@shared/utils/phone";

export async function matchProspectsToCustomers(): Promise<number> {
  const candidates = await db.execute(sql`
    SELECT p.id, p.vorname, p.nachname, p.telefon
    FROM prospects p
    WHERE p.deleted_at IS NULL
      AND p.status NOT IN ('gewonnen', 'nicht_interessiert', 'disqualifiziert')
      AND p.converted_customer_id IS NULL
      AND p.telefon IS NOT NULL
      AND p.telefon != ''
  `);

  const rows = candidates.rows as Array<{
    id: number;
    vorname: string;
    nachname: string;
    telefon: string;
  }>;

  if (rows.length === 0) return 0;

  let matched = 0;

  for (const prospect of rows) {
    const normalizedProspectPhone = normalizePhone(prospect.telefon);
    if (!normalizedProspectPhone) continue;

    const customerMatches = await db.execute(sql`
      SELECT c.id, c.telefon
      FROM customers c
      WHERE c.deleted_at IS NULL
        AND c.is_anonymized = false
        AND LOWER(TRIM(c.vorname)) = LOWER(TRIM(${prospect.vorname}))
        AND LOWER(TRIM(c.nachname)) = LOWER(TRIM(${prospect.nachname}))
        AND c.telefon IS NOT NULL
        AND c.telefon != ''
    `);

    const matchRows = customerMatches.rows as Array<{ id: number; telefon: string }>;

    for (const customer of matchRows) {
      const normalizedCustomerPhone = normalizePhone(customer.telefon);
      if (normalizedCustomerPhone && normalizedCustomerPhone === normalizedProspectPhone) {
        await db.execute(sql`
          UPDATE prospects
          SET status = 'gewonnen',
              converted_customer_id = ${customer.id},
              updated_at = NOW()
          WHERE id = ${prospect.id}
        `);
        matched++;
        break;
      }
    }
  }

  return matched;
}

export async function matchNewCustomerToProspects(
  customerId: number,
  vorname: string,
  nachname: string,
  telefon: string | null | undefined
): Promise<void> {
  if (!telefon) return;

  const normalizedPhone = normalizePhone(telefon);
  if (!normalizedPhone) return;

  const candidates = await db.execute(sql`
    SELECT p.id, p.telefon
    FROM prospects p
    WHERE p.deleted_at IS NULL
      AND p.status NOT IN ('gewonnen', 'nicht_interessiert', 'disqualifiziert')
      AND p.converted_customer_id IS NULL
      AND LOWER(TRIM(p.vorname)) = LOWER(TRIM(${vorname}))
      AND LOWER(TRIM(p.nachname)) = LOWER(TRIM(${nachname}))
      AND p.telefon IS NOT NULL
      AND p.telefon != ''
  `);

  const rows = candidates.rows as Array<{ id: number; telefon: string }>;

  for (const prospect of rows) {
    const normalizedProspectPhone = normalizePhone(prospect.telefon);
    if (normalizedProspectPhone && normalizedProspectPhone === normalizedPhone) {
      await db.execute(sql`
        UPDATE prospects
        SET status = 'gewonnen',
            converted_customer_id = ${customerId},
            updated_at = NOW()
        WHERE id = ${prospect.id}
          AND status NOT IN ('gewonnen', 'nicht_interessiert', 'disqualifiziert')
          AND converted_customer_id IS NULL
      `);
      break;
    }
  }
}
