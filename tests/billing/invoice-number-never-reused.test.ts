/**
 * #66 — Belegnummern werden nie wiedervergeben.
 *
 * Der Prod-Befund: eine versendete Rechnung ließ sich auf Entwurf
 * zurücksetzen (das leerte `sent_at`), danach griff der Entwurfs-Löschpfad und
 * löschte sie HART. Weil die nächste Nummer als `MAX(...) + 1` über die
 * VERBLIEBENEN Zeilen bestimmt wurde, bekam der nächste Beleg dieselbe Nummer:
 * dieselbe Belegnummer bezeichnete zwei verschiedene Dokumente — ohne Storno,
 * und der neue Beleg konnte höher ausfallen als der gelöschte.
 *
 * Geprüft:
 *   (a) Nummernkreis zählt nur AUFWÄRTS. Nach dem Löschen der zuletzt
 *       vergebenen Nummer bekommt der nächste Beleg NICHT dieselbe.
 *   (b) Die Hochwassermarke wird aus dem Bestand nachgezogen — eine von Hand
 *       höher gesetzte Nummer kann sie nie unterlaufen.
 *   (c) `bulk-delete` fasst eine je ausgegebene Rechnung nie an, auch wenn sie
 *       gerade wieder im Status `entwurf` steht.
 *   (d) `discard-drafts` ebenso.
 *   (d2) Der dritte Löschpfad (Monats-Umwidmung) ebenso — er hatte den Guard
 *       beim ersten Wurf vergessen, weil das Prädikat inline stand statt als
 *       SSoT. Genau der Fall, gegen den CLAUDE.md die SSoT-Regel stellt.
 *   (d3) Der vierte Löschpfad (USt-Korrektur-Skript `reissue-selbstzahler-vat-
 *       invoices.ts`) ebenso. Es ist ein STEHENDES Werkzeug, kein verbrauchtes
 *       Einmal-Skript — Trockenlauf als Default, Detektor-Exit-Code — und
 *       `--apply` läuft ausschliesslich auf PROD.
 *   (f) ZWEITE LAGE, DB-Ebene: der GoBD-Trigger auf `invoices` blockt DELETE
 *       einer je ausgegebenen Rechnung auch im Status `entwurf` — und lässt
 *       UPDATE (Rechnung UND Positionen) weiter zu. Sonst widerspräche er dem
 *       Ventil, das die Rechnung ja gerade bearbeitbar machen soll.
 *   (e) Das Fehlmarkierungs-Ventil verlangt eine Begründung, protokolliert sie
 *       — und lässt die Ausgabe-Marke STEHEN. Es macht die Rechnung wieder
 *       bearbeitbar, nicht löschbar (entschieden 08.08., Alrik). Die erste
 *       Fassung leerte die Marke; damit war die Kette aus dem Prod-Befund
 *       wieder offen, und (c) musste sie von Hand wiederherstellen, um den
 *       Schutz überhaupt prüfen zu können. Genau das war der Beleg für den
 *       Fehler.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "../../server/lib/db";
import { customers, invoices, invoiceLineItems, auditLog } from "@shared/schema";
import { and, eq, inArray, desc, sql } from "drizzle-orm";
import { apiPost, uniqueId } from "../test-utils";
import { withGobdMutation } from "../helpers/gobd";
import { getNextInvoiceNumberTx } from "../../server/storage/billing-storage";
import { discardAndRegenerateDrafts } from "../../server/services/draft-invoice-regen";
import { reissueDraft } from "../../server/scripts/reissue-selbstzahler-vat-invoices";

const YEAR = 2033;
const MONTH = 5;
let customerId = 0;
const created: number[] = [];

/**
 * Zieht eine Nummer über den echten Generator und legt die Zeile an.
 *
 * Bewusst NICHT über die Rechnungserzeugung: die verlangt die volle Kette
 * (Kunde → Termin → Dokumentation → Leistungsnachweis → Signatur → generate)
 * und würde den Nummernkreis hinter viel Beiwerk verstecken. Hier ist der
 * Generator selbst der Prüfgegenstand.
 */
async function createDraft(gross = 10_000): Promise<{ id: number; invoiceNumber: string }> {
  const invoiceNumber = await db.transaction(async (tx) => getNextInvoiceNumberTx(tx as any, YEAR));
  const [row] = await db.insert(invoices).values({
    invoiceNumber,
    customerId,
    billingType: "selbstzahler",
    invoiceType: "rechnung",
    billingMonth: MONTH,
    billingYear: YEAR,
    recipientName: "Test",
    grossAmountCents: gross,
    netAmountCents: gross,
    status: "entwurf",
  } as any).returning({ id: invoices.id });
  created.push(row.id);
  return { id: row.id, invoiceNumber };
}

function numOf(invoiceNumber: string): number {
  const m = invoiceNumber.match(/RE-\d{4}-(\d+)/);
  if (!m) throw new Error(`unerwartetes Nummernformat: ${invoiceNumber}`);
  return Number(m[1]);
}

async function markSent(id: number): Promise<void> {
  const res = await apiPost<any>(`/api/billing/${id}/mark-sent`, {});
  if (res.status !== 200) throw new Error(`mark-sent: ${res.status} ${JSON.stringify(res.data)}`);
}

async function row(id: number) {
  const [r] = await db.select({
    status: invoices.status,
    invoiceNumber: invoices.invoiceNumber,
    sentAt: invoices.sentAt,
    issuedAt: invoices.issuedAt,
  }).from(invoices).where(eq(invoices.id, id));
  return r;
}

beforeAll(async () => {
  const tag = uniqueId();
  const [c] = await db.insert(customers).values({
    name: `NUM66-${tag}`,
    vorname: "Nummern",
    nachname: `Kreis-${tag}`,
    address: "Teststraße 1, 12345 Berlin",
    billingType: "selbstzahler",
    status: "aktiv",
  } as any).returning({ id: customers.id });
  customerId = c.id;
});

afterAll(async () => {
  if (created.length > 0) {
    await withGobdMutation(async (tx) => {
      await tx.delete(invoices).where(inArray(invoices.id, created));
    });
  }
  await db.execute(sql`DELETE FROM invoice_number_sequence WHERE billing_year = ${YEAR}`);
  if (customerId) await db.delete(customers).where(eq(customers.id, customerId));
});

describe("#66 — Belegnummernkreis", () => {
  it("(a) nach dem Löschen der letzten Nummer wird sie NICHT erneut vergeben", async () => {
    const erste = await createDraft();
    const zweite = await createDraft();
    expect(numOf(zweite.invoiceNumber)).toBe(numOf(erste.invoiceNumber) + 1);

    // Die zuletzt vergebene Rechnung verschwindet — sie war nie ausgegeben,
    // Löschen ist also erlaubt.
    const del = await apiPost<any>("/api/billing/bulk-delete", { invoiceIds: [zweite.id] });
    expect(del.status).toBe(200);
    expect(del.data.summary.deleted, JSON.stringify(del.data)).toBe(1);

    // DIE Kernaussage: die freigewordene Nummer kommt nicht zurück.
    const dritte = await createDraft();
    expect(
      numOf(dritte.invoiceNumber),
      "die Nummer der gelöschten Rechnung darf nie erneut vergeben werden",
    ).toBeGreaterThan(numOf(zweite.invoiceNumber));
    expect(dritte.invoiceNumber).not.toBe(zweite.invoiceNumber);
  });

  it("(b) eine von Hand höher gesetzte Nummer unterläuft die Marke nicht", async () => {
    const vorher = await createDraft();
    const hoch = numOf(vorher.invoiceNumber) + 500;

    // Bestand mit einer höheren Nummer — etwa aus einem Import.
    const [importiert] = await db.insert(invoices).values({
      invoiceNumber: `RE-${YEAR}-${String(hoch).padStart(4, "0")}`,
      customerId,
      billingType: "selbstzahler",
      invoiceType: "rechnung",
      billingMonth: MONTH,
      billingYear: YEAR,
      recipientName: "Import",
      grossAmountCents: 5_000,
      netAmountCents: 5_000,
      status: "entwurf",
    } as any).returning({ id: invoices.id });
    created.push(importiert.id);

    const danach = await db.transaction(async (tx) => getNextInvoiceNumberTx(tx as any, YEAR));
    expect(
      numOf(danach),
      "der Generator muss über den höchsten Bestand hinausgehen",
    ).toBeGreaterThan(hoch);
  });

  it("(c) bulk-delete fasst eine je ausgegebene Rechnung nicht an", async () => {
    const inv = await createDraft();
    await markSent(inv.id);
    expect((await row(inv.id)).issuedAt).not.toBeNull();

    // Zurück auf Entwurf — über das Ventil, denn der generische Weg ist zu.
    // DAS ist die vollständige Kette aus dem Prod-Befund: markieren →
    // zurücknehmen → löschen. Sie muss am Löschschutz enden.
    const ventil = await apiPost<any>(`/api/billing/${inv.id}/revoke-sent-mark`, {
      reason: "Kontrollfall für den Löschschutz.",
    });
    expect(ventil.status).toBe(200);

    const nachVentil = await row(inv.id);
    expect(nachVentil.status).toBe("entwurf");
    expect(
      nachVentil.issuedAt,
      "das Ventil macht bearbeitbar, NICHT löschbar — die Ausgabe-Marke muss überleben",
    ).not.toBeNull();

    const del = await apiPost<any>("/api/billing/bulk-delete", { invoiceIds: [inv.id] });
    expect(del.status).toBe(200);
    expect(del.data.summary.deleted, "ausgegebene Rechnung darf NICHT gelöscht werden").toBe(0);
    expect(del.data.results[0].status).toBe("skipped");
    expect(del.data.results[0].reason).toMatch(/ausgegeben/i);

    // Und sie ist wirklich noch da.
    expect(await row(inv.id)).toBeTruthy();
  });

  it("(d) discard-drafts fasst eine je ausgegebene Rechnung nicht an", async () => {
    const inv = await createDraft();
    await markSent(inv.id);
    // Direkt in den Entwurfs-Zustand versetzen, Marke bleibt — genau die Lage,
    // die der Prod-Befund erzeugte.
    await db.update(invoices).set({ status: "entwurf", sentAt: null }).where(eq(invoices.id, inv.id));

    const res = await apiPost<any>("/api/billing/discard-drafts", {
      customerId, year: YEAR, month: MONTH,
    });
    // Entweder gibt es nichts zu verwerfen (400) oder es wurde etwas verworfen
    // — in beiden Fällen darf UNSERE Rechnung nicht dabei sein.
    expect([200, 400]).toContain(res.status);
    const nachher = await row(inv.id);
    expect(nachher, "ausgegebene Rechnung darf nicht verworfen werden").toBeTruthy();
    expect(nachher.issuedAt).not.toBeNull();
  });

  it("(d2) der dritte Loeschpfad (Monats-Umwidmung) fasst sie ebenfalls nicht an", async () => {
    // `discardAndRegenerateDrafts` loescht Entwuerfe hart und hatte den
    // Loeschschutz beim ersten Wurf VERGESSEN — er stand als Bedingung inline
    // in den beiden Routen statt als SSoT. Der Fall haelt fest, dass alle drei
    // Pfade dieselbe Funktion lesen.
    const inv = await createDraft();
    await markSent(inv.id);
    // In den Entwurfs-Zustand, Marke bleibt (so verhaelt sich jetzt das Ventil).
    await db.update(invoices).set({ status: "entwurf", sentAt: null }).where(eq(invoices.id, inv.id));

    await discardAndRegenerateDrafts({
      customerId, year: YEAR, month: MONTH, userId: 1, reason: "Test Umwidmung",
    }).catch(() => { /* die Neuerzeugung darf scheitern — geprueft wird das Loeschen */ });

    const nachher = await row(inv.id);
    expect(nachher, "ausgegebene Rechnung darf auch hier nicht geloescht werden").toBeTruthy();
    expect(nachher.issuedAt).not.toBeNull();
  });

  it("(d3) der VIERTE Loeschpfad (USt-Korrektur-Skript) fasst sie ebenfalls nicht an", async () => {
    // `reissueDraft` aus `server/scripts/reissue-selbstzahler-vat-invoices.ts`
    // loescht einen Entwurf HART und stellt ihn neu aus. Das Skript ist ein
    // STEHENDES Werkzeug (Trockenlauf als Default, Detektor-Exit-Code), kein
    // verbrauchtes Einmal-Skript — es kann also jederzeit wieder laufen.
    //
    // Sein Docstring behauptete „Entwuerfe wurden nie versendet". Seit dem
    // Ventil stimmt das nicht mehr: eine ausgegebene Rechnung kann im
    // Entwurfsstatus stehen. Ohne den Guard haette dieses Skript genau den
    // Beleg geloescht, um dessen Schutz es in #66 geht — und zwar auf PROD,
    // denn `--apply` laeuft nur dort.
    const inv = await createDraft();
    await markSent(inv.id);
    await db.update(invoices).set({ status: "entwurf", sentAt: null }).where(eq(invoices.id, inv.id));

    const vorher = await row(inv.id);
    expect(vorher.issuedAt).not.toBeNull();

    let fehler: unknown;
    try {
      await reissueDraft(
        {
          invoiceId: inv.id,
          invoiceNumber: vorher.invoiceNumber,
          customerId,
          status: "entwurf",
          billingType: "selbstzahler",
          budgetType: null,
          billingMonth: MONTH,
          billingYear: YEAR,
          netAmountCents: 10_000,
          storedVatCents: 19,
          correctVatCents: 1_900,
          kind: "draft",
        },
        1,
      );
    } catch (e) {
      fehler = e;
    }

    // ZUERST der Schaden, DANN die Wortwahl. Ohne Guard wird die Zeile
    // geloescht und der Aufruf scheitert trotzdem — nur spaeter, an der
    // Neuerzeugung. Haenge die Aussage an der Fehlermeldung, faengt der Test
    // den Mutanten aus dem schwaecheren Grund und broeckelt, sobald jemand den
    // Text umformuliert.
    const nachher = await row(inv.id);
    expect(nachher, "ausgegebene Rechnung darf auch hier nicht geloescht werden").toBeTruthy();
    expect(nachher.issuedAt).not.toBeNull();
    expect(nachher.invoiceNumber).toBe(vorher.invoiceNumber);

    expect(fehler, "der Loeschpfad muss ablehnen statt still durchzulaufen").toBeInstanceOf(Error);
    expect(
      (fehler as Error).message,
      "die Ablehnung muss den Grund nennen, sonst schickt sie den Bediener in den falschen Pfad",
    ).toMatch(/bereits ausgegeben/i);
  });

  it("(f) DB-Ebene: issued-but-entwurf ist unlöschbar, aber weiterhin BEARBEITBAR", async () => {
    // Die vier App-Guards sind die erste Lage. Diese hier ist die zweite: der
    // GoBD-Trigger auf `invoices`. Vor #66 prüfte er nur `status <> 'entwurf'`
    // — nach dem Ventil steht eine ausgegebene Rechnung wieder auf `entwurf`,
    // und für genau sie fiel das DB-seitige Netz weg. Ein Löschpfad, der an den
    // App-Guards vorbeigeht (rohes SQL, psql, ein künftiger fünfter Pfad),
    // hätte den Beleg entfernt.
    //
    // Bewusst OHNE `withGobdMutation` — der Bypass würde genau das abschalten,
    // was hier geprüft wird.
    const inv = await createDraft();
    await markSent(inv.id);
    await db.update(invoices).set({ status: "entwurf", sentAt: null }).where(eq(invoices.id, inv.id));
    expect((await row(inv.id)).issuedAt).not.toBeNull();

    // 1) LÖSCHEN muss die DB verweigern.
    let dbFehler: unknown;
    try {
      await db.delete(invoices).where(eq(invoices.id, inv.id));
    } catch (e) {
      dbFehler = e;
    }
    expect((await row(inv.id)), "der Trigger muss die Zeile halten").toBeTruthy();
    expect(dbFehler, "DELETE auf DB-Ebene muss scheitern, nicht still durchlaufen").toBeTruthy();

    // drizzle verpackt den Postgres-Fehler; die echte Meldung samt SQLSTATE
    // steckt in `.cause`. Geprüft wird BEIDES — der Code `23001`
    // (`restrict_violation`, das ERRCODE unseres Triggers) UND der Text. Nur
    // der Text wäre bei einer Umformulierung brüchig, nur der Code würde auch
    // bei einem fremden restrict_violation grün.
    const kette: Array<{ code?: string; message?: string }> = [];
    for (let cur: any = dbFehler; cur; cur = cur.cause) {
      kette.push({ code: cur.code, message: String(cur.message ?? "") });
    }
    expect(
      kette.some((g) => g.code === "23001"),
      `erwartet SQLSTATE 23001 (restrict_violation), Kette: ${JSON.stringify(kette)}`,
    ).toBe(true);
    expect(
      kette.some((g) => /bereits ausgegeben|GoBD-Hard-Delete/i.test(g.message ?? "")),
      `erwartet die Trigger-Meldung, Kette: ${JSON.stringify(kette)}`,
    ).toBe(true);

    // 2) BEARBEITEN muss weiter gehen — sonst widerspräche der Trigger dem
    //    Ventil. Es macht die Rechnung absichtlich wieder bearbeitbar; nur der
    //    Beleg selbst darf nicht verschwinden.
    await db.update(invoices)
      .set({ recipientName: "Korrigiert nach Fehlmarkierung" })
      .where(eq(invoices.id, inv.id));
    const [nachEdit] = await db.select({ recipientName: invoices.recipientName })
      .from(invoices).where(eq(invoices.id, inv.id));
    expect(
      nachEdit.recipientName,
      "UPDATE muss erlaubt bleiben — der Trigger haengt nur an DELETE",
    ).toBe("Korrigiert nach Fehlmarkierung");

    // 3) Und die Positionen bleiben ebenfalls bearbeitbar: der Inhalt wird ja
    //    gerade korrigiert. Der Positions-Trigger gated am Eltern-Status und
    //    darf NICHT auf `issued_at` erweitert werden.
    const [pos] = await db.insert(invoiceLineItems).values({
      invoiceId: inv.id,
      appointmentDate: `${YEAR}-0${MONTH}-01`,
      serviceDescription: "Korrektur-Position",
      durationMinutes: 60,
      unitPriceCents: 1_000,
      totalCents: 1_000,
    } as any).returning({ id: invoiceLineItems.id });
    await db.update(invoiceLineItems)
      .set({ serviceDescription: "Korrektur-Position (geaendert)" })
      .where(eq(invoiceLineItems.id, pos.id));
    const [nachPosUpdate] = await db.select({ d: invoiceLineItems.serviceDescription })
      .from(invoiceLineItems).where(eq(invoiceLineItems.id, pos.id));
    expect(nachPosUpdate.d).toBe("Korrektur-Position (geaendert)");

    await db.delete(invoiceLineItems).where(eq(invoiceLineItems.id, pos.id));
    const weg = await db.select({ id: invoiceLineItems.id })
      .from(invoiceLineItems).where(eq(invoiceLineItems.id, pos.id));
    expect(
      weg.length,
      "Positionen muessen loeschbar bleiben — ein still wirkungsloses DELETE waere sonst gruen",
    ).toBe(0);
  });

  it("(e) Ventil: Begründung ist Pflicht und landet mit dem Ausgabe-Zeitpunkt im Audit", async () => {
    const inv = await createDraft();
    await markSent(inv.id);
    const vorher = await row(inv.id);
    expect(vorher.issuedAt).not.toBeNull();

    const ohne = await apiPost<any>(`/api/billing/${inv.id}/revoke-sent-mark`, { reason: "kurz" });
    expect(ohne.status, "zu kurze Begründung muss abgelehnt werden").toBe(400);

    const res = await apiPost<any>(`/api/billing/${inv.id}/revoke-sent-mark`, {
      reason: "Versehentlich markiert — es wurde nichts versandt.",
    });
    expect(res.status, JSON.stringify(res.data)).toBe(200);

    const nachher = await row(inv.id);
    expect(nachher.status).toBe("entwurf");
    expect(nachher.sentAt).toBeNull();
    expect(
      nachher.issuedAt,
      "die Ausgabe-Marke bleibt — sonst wäre die Löschkette wieder offen",
    ).not.toBeNull();

    const [eintrag] = await db.select({ metadata: auditLog.metadata })
      .from(auditLog)
      .where(and(
        eq(auditLog.action, "invoice_sent_mark_revoked"),
        eq(auditLog.entityType, "invoice"),
        eq(auditLog.entityId, inv.id),
      ))
      .orderBy(desc(auditLog.id));
    expect(eintrag, "die Rücknahme MUSS protokolliert sein").toBeTruthy();
    const meta = (eintrag.metadata ?? {}) as Record<string, unknown>;
    expect(meta.reason).toContain("Versehentlich");
    // Der ursprüngliche Ausgabe-Zeitpunkt bleibt im Protokoll, obwohl die
    // Spalte geleert wurde — sonst wäre nicht mehr nachvollziehbar, WANN
    // fälschlich markiert wurde.
    expect(meta.issuedAt, "Ausgabe-Zeitpunkt gehört ins Protokoll").toBeTruthy();
    expect(meta.invoiceNumber).toBe(vorher.invoiceNumber);
  });
});
