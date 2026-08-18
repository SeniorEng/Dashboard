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

    it("folgt der Deckungs-SSoT: Toleranz und Skonto zaehlen als gedeckt", () => {
      // Die erste Fassung verglich `paidCents < grossAmountCents` und
      // widersprach damit der Restbetrags-Zahl in derselben Zeile, die aus
      // `classifyPaymentDifference` stammt — Badge ohne Zahl.
      //
      // 49.950 auf 50.000: innerhalb der 100-Cent-Toleranz ⇒ gedeckt.
      expect(istTeilweiseBezahlt(mit({ paidCents: 49_950 }))).toBe(false);
      // 45.000 gezahlt + 5.000 Skonto = exakt gedeckt.
      expect(istTeilweiseBezahlt(mit({ paidCents: 45_000, skontoCents: 5_000 }))).toBe(false);
      // Ohne das Skonto waere dieselbe Zahlung eine Teilzahlung — sonst
      // prueft der Fall darueber nur, dass irgendetwas immer `false` ist.
      expect(istTeilweiseBezahlt(mit({ paidCents: 45_000 }))).toBe(true);
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

    it("die Ampel-SCHWELLEN selbst — hartkodiert, unabhaengig von der Implementierung", () => {
      // ── Warum diese Tabelle ausgeschrieben ist ───────────────────────────
      // Der Sweep darunter vergleicht `istUeberfaellig` gegen
      // `resolveAgingBucket` — also gegen dieselbe Funktion, die
      // `istUeberfaellig` intern aufruft. Er beweist damit die KOMPOSITION
      // (richtiger Anker je Empfaenger, keine eigene Frist), aber NICHT die
      // Zahlen: verschoebe jemand eine Schwelle, zoegen beide Seiten mit.
      //
      // Die Zahlen 14/30 (Selbstzahler ab Faelligkeit) und 21/45 (Kasse ab
      // Versand) waren im gesamten Repo an keiner Stelle festgenagelt. Sie
      // entscheiden, ab wann gemahnt wird — das gehoert ausgeschrieben, an den
      // GRENZEN, nicht in der Mitte der Intervalle.
      const faelle: Array<[string, number, boolean]> = [
        // [billingType, Tage seit Anker, erwartet ueberfaellig?]
        ["selbstzahler", -1, false],  // vor Faelligkeit
        ["selbstzahler", 0, false],   // am Faelligkeitstag: noch gruen
        ["selbstzahler", 1, true],    // ab dem Tag danach
        ["selbstzahler", 14, true],
        ["selbstzahler", 15, true],
        ["selbstzahler", 30, true],
        ["selbstzahler", 31, true],
        ["pflegekasse_gesetzlich", 21, false], // Wartefrist laeuft noch
        ["pflegekasse_gesetzlich", 22, true],  // erste Stufe
        ["pflegekasse_gesetzlich", 45, true],
        ["pflegekasse_gesetzlich", 46, true],
      ];

      const ASOF = "2027-01-15";
      for (const [billingType, tage, erwartet] of faelle) {
        const anker = new Date(Date.parse(`${ASOF}T00:00:00Z`) - tage * 86_400_000)
          .toISOString().slice(0, 10);
        const selbstzahler = billingType === "selbstzahler";
        expect(
          istUeberfaellig(mit({
            billingType,
            dueDate: selbstzahler ? anker : null,
            sentAt: selbstzahler ? null : anker,
            asOfIso: ASOF,
          })),
          `${billingType} @ ${tage} Tage`,
        ).toBe(erwartet);
      }
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
      // `toEqual`, nicht `toContain`: ein faelschlich feuerndes
      // `teilweise_bezahlt` auf einer Gutschrift kaeme sonst durch.
      expect(badges).toEqual(["versandt"]);
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
