import { describe, expect, it } from "vitest";
import {
  invoiceBadges,
  istTeilweiseBezahlt,
  istUeberfaellig,
  istVersandt,
  type InvoiceBadgeInput,
} from "@shared/domain/invoice-badges";
import {
  agingModelForBillingType,
  resolveAgingBucket,
} from "@shared/domain/billing-pipeline";
import { INVOICE_STATUSES } from "@shared/schema/billing";

/**
 * Die Badge-SSoT (`docs/rechnungsstatus-zielmodell.md`, Abschnitt 1).
 *
 * ── Warum diese Datei existiert ─────────────────────────────────────────
 * Das Badge-Modul ging ohne einen einzigen Test in den Status-Umbau. Zwei
 * Fehler sind genau dadurch bis in den Review durchgerutscht:
 *
 *  1. `istUeberfaellig` kannte die Zahlungsbindung nicht und hätte damit den
 *     Bug aus #1897 wiederholt — „die Abrechnung mahnte Geld an, das auf dem
 *     Konto lag". Sichtbar geworden wäre er als Widerspruch in derselben
 *     Zeile: Cockpit `aging: none`, Liste „Überfällig".
 *  2. `istVersandt` war unerreichbar, weil Badges nur für OFFENE Rechnungen
 *     berechnet wurden — und die schließen Gutschriften per Definition aus.
 *     Das Badge war zugleich die Begründung dafür, den Storno-Versand als
 *     Statuswechsel abzuschaffen. Die Begründung trug also nicht.
 *
 * Beide sind hier festgenagelt, jeweils mit der Gegenrichtung.
 */

const BASIS: InvoiceBadgeInput = {
  status: "versendet",
  invoiceType: "rechnung",
  grossAmountCents: 50_000,
  paidCents: 0,
  hasBoundPayment: false,
  dueDate: "2026-01-10",
  sentAt: "2026-01-10",
  billingType: "selbstzahler",
  asOfIso: "2026-08-18",
};

function mit(over: Partial<InvoiceBadgeInput>): InvoiceBadgeInput {
  return { ...BASIS, ...over };
}

describe("Badges — abgeleitete Sichten, keine Zustände", () => {
  describe("teilweise bezahlt", () => {
    it("gilt genau dann, wenn Geld da ist, aber nicht genug", () => {
      expect(istTeilweiseBezahlt(mit({ paidCents: 30_000 }))).toBe(true);
      // Kein Geld → nichts zu zeigen. Das ist der Unterschied zum früheren
      // STATUS: der ließ sich setzen, ohne dass je eine Zahlung einging.
      expect(istTeilweiseBezahlt(mit({ paidCents: 0 }))).toBe(false);
      // Voll gedeckt → nicht mehr „teilweise".
      expect(istTeilweiseBezahlt(mit({ paidCents: 50_000 }))).toBe(false);
      expect(istTeilweiseBezahlt(mit({ paidCents: 60_000 }))).toBe(false);
    });

    it("erscheint nie auf einer abgeschlossenen oder stornierten Rechnung", () => {
      for (const status of ["bezahlt", "storniert"] as const) {
        expect(
          istTeilweiseBezahlt(mit({ status, paidCents: 30_000 })),
          status,
        ).toBe(false);
      }
    });
  });

  describe("überfällig", () => {
    it("eine gebundene Zahlung stoppt das Altern (#1897)", () => {
      // Selbstzahler, Fälligkeit sieben Monate her: ohne Bindung überfällig.
      const ohne = mit({ dueDate: "2026-01-10", hasBoundPayment: false });
      expect(istUeberfaellig(ohne), "ohne Bindung muss überfällig sein").toBe(true);

      // Dieselbe Rechnung mit gebundener, noch nicht freigegebener Teilzahlung:
      // das Geld ist da. Es anzumahnen war der Bug aus #1897.
      const mitBindung = mit({
        dueDate: "2026-01-10",
        hasBoundPayment: true,
        paidCents: 20_000,
      });
      expect(istUeberfaellig(mitBindung)).toBe(false);
      // Aber die Teilzahlung bleibt sichtbar — sie wird nicht mit unterdrückt.
      expect(istTeilweiseBezahlt(mitBindung)).toBe(true);
    });

    it("führt KEINE eigene Frist, sondern folgt der Aging-Ampel", () => {
      // Der Kern der Ersetzungs-Regel an dieser Stelle: ein früherer Entwurf
      // trug einen `fristTage`-Parameter und damit eine ZWEITE Definition von
      // „überfällig" neben der bestehenden Ampel. Hier nachgerechnet — für
      // beide Empfängertypen und über ein Jahr hinweg.
      for (const billingType of ["selbstzahler", "pflegekasse_gesetzlich"]) {
        const model = agingModelForBillingType(billingType);
        for (let tage = 0; tage <= 370; tage += 7) {
          const anker = new Date(Date.UTC(2026, 0, 10) + tage * 86_400_000)
            .toISOString().slice(0, 10);
          const eingabe = mit({
            billingType,
            dueDate: model === "selbstzahler" ? anker : null,
            sentAt: model === "selbstzahler" ? null : anker,
            asOfIso: "2027-01-15",
          });
          const bucket = resolveAgingBucket(model, anker, "2027-01-15");
          expect(
            istUeberfaellig(eingabe),
            `${billingType} @ ${anker} (Ampel: ${bucket})`,
          ).toBe(bucket !== "green" && bucket !== "none");
        }
      }
    });

    it("gilt nur für wartende Rechnungen und nur bei Unterdeckung", () => {
      for (const status of INVOICE_STATUSES) {
        if (status === "versendet") continue;
        expect(
          istUeberfaellig(mit({ status, dueDate: "2026-01-10" })),
          status,
        ).toBe(false);
      }
      expect(istUeberfaellig(mit({ paidCents: 50_000 }))).toBe(false);
    });
  });

  describe("versandt", () => {
    it("trägt genau am Storno-Dokument, und nur mit Versanddatum", () => {
      // Das Badge, das den entfallenen Statuswechsel ersetzt: dass eine
      // Gutschrift verschickt wurde, ist ein Kennzeichen am Beleg.
      const storno = mit({ invoiceType: "stornorechnung", status: "abgeschlossen" });
      expect(istVersandt({ ...storno, sentAt: "2026-03-01" })).toBe(true);
      expect(istVersandt({ ...storno, sentAt: null })).toBe(false);
    });

    it("erscheint nicht auf normalen Rechnungen — dort sagt der Status es schon", () => {
      for (const typ of ["rechnung", "nachberechnung"]) {
        expect(istVersandt(mit({ invoiceType: typ, sentAt: "2026-03-01" })), typ).toBe(false);
      }
    });

    it("ist über `invoiceBadges` tatsächlich erreichbar", () => {
      // Die Gegenprobe zum zweiten Fehler oben. Ein Badge, das keine erreichbare
      // Eingabe hat, ist toter Code — und hier war es zugleich die Begründung
      // dafür, eine Fähigkeit abzuschaffen.
      const badges = invoiceBadges(mit({
        invoiceType: "stornorechnung",
        status: "abgeschlossen",
        grossAmountCents: -50_000,
        sentAt: "2026-03-01",
      }));
      expect(badges).toContain("versandt");
    });
  });

  it("eine frisch versendete, unbezahlte Rechnung trägt gar kein Badge", () => {
    // Sonst prüften die Fälle oben nur, dass irgendetwas immer feuert.
    expect(invoiceBadges(mit({
      dueDate: "2026-08-18",
      sentAt: "2026-08-18",
    }))).toEqual([]);
  });
});
