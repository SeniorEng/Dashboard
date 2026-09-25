// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * Leeres Feld = keine Angabe. Eingetragene 0 = festgestellte Null.
 * (Alrik, 24.09.2026 — Auflösung des Gate-2-Blockers B1 zu #186.)
 *
 * ── Warum diese Tests den HOOK fahren und nicht einen Payload bauen ─────
 * `FN-3` (`45b-festgestellte-null-wizard-vs-route.test.ts`) prüft, dass ein
 * Body OHNE `carryoverAmountCents` keine Zeile erzeugt. Das ist richtig für
 * die Route — aber **der Wizard hat diesen Body nie geschickt**. Gemessen am
 * 24.09.2026 kam er mit leerem Feld gar nicht durch die eigene Validierung:
 *
 *     "Übertrag darf nicht negativ sein"
 *
 * `parseFloat("")` ist `NaN`, und die Prüfung lautete `isNaN(x) || x < 0`.
 * Der Anwender war damit gezwungen, eine `0` zu tippen — und seit `0` eine
 * festgestellte Null ist, entstand daraus eine Zeile, die niemand gemeint hat.
 *
 * Eine Zusage über den Wizard gehört deshalb auf **das, was der Wizard
 * tatsächlich sendet**. Diese Tests fangen den echten Aufruf ab, statt die
 * Payload-Bildung nachzubauen — derselbe Grund, aus dem `antwortVomServer` in
 * den WV-Tests über HTTP geht.
 *
 * ── Die vier Fälle sind die GEMESSENEN ─────────────────────────────────
 * Vor dem Fix (Messung 24.09.2026):
 *   beide leer      -> BLOCKIERT ("darf nicht negativ sein")
 *   nur Startwert   -> BLOCKIERT (dito, wegen des leeren Übertragsfelds)
 *   nur Übertrag    -> carryoverAmountCents 50000, override45bCents undefined
 *   beide 0         -> carryoverAmountCents 0, override45bCents 0
 *   kein Monatsbetrag -> `budgets` FEHLT ganz (Übertrag still verschluckt)
 */

const gesendet: any[] = [];

vi.mock("@/features/customers/hooks/use-customers", async (orig) => {
  const echt = await (orig() as any);
  return {
    ...echt,
    useCreateCustomer: () => ({
      mutate: (payload: any) => { gesendet.push(payload); },
      isPending: false,
      isError: false,
    }),
  };
});
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: (t: any) => { (globalThis as any).__toasts ??= []; (globalThis as any).__toasts.push(t); },
  }),
}));

import { useCustomerWizard } from "@/features/customers/hooks/use-customer-wizard";

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    {children}
  </QueryClientProvider>
);

/** Vollständiges gültiges Formular; nur die §45b-Felder variieren. */
const BASIS: Record<string, string> = {
  billingType: "pflegekasse_gesetzlich",
  vorname: "Mess", nachname: "Wizard", strasse: "Teststr.", nr: "1",
  plz: "10115", stadt: "Berlin", geburtsdatum: "1940-01-15",
  contractDate: "2026-01-10", contractStart: "2026-02-01",
  vereinbarteLeistungen: "Betreuung", contractHours: "4",
  documentDeliveryMethod: "post",
  pflegegrad: "3", pflegegradSeit: "2025-01-01",
};

type Ergebnis =
  | { gesendet: true; budgets: any }
  | { gesendet: false; meldung: string };

async function wizardLauf(felder: Record<string, unknown>): Promise<Ergebnis> {
  const { result } = renderHook(() => useCustomerWizard(), { wrapper });
  gesendet.length = 0;
  (globalThis as any).__toasts = [];
  await act(async () => {
    for (const [k, v] of Object.entries({ ...BASIS, ...felder })) {
      result.current.handleChange(k, v as never);
    }
  });
  await act(async () => { result.current.handleSubmit(); });
  if (gesendet.length > 0) return { gesendet: true, budgets: gesendet[0]?.budgets };
  const t = (globalThis as any).__toasts ?? [];
  return { gesendet: false, meldung: t.length ? String(t[t.length - 1]?.description ?? "") : "ohne Meldung" };
}

describe("§45b-Anlage-Assistent — leeres Feld ist keine Angabe", () => {
  it("WL-1 – leeres Übertragsfeld: kommt DURCH und sendet keinen Übertrag", async () => {
    const r = await wizardLauf({ uebertrag45b: "", restguthaben45bOverrideEnabled: false });

    expect(
      r.gesendet,
      r.gesendet ? "" : `der Assistent blockiert ein leeres Feld: „${(r as any).meldung}"`,
    ).toBe(true);
    expect(
      (r as any).budgets?.carryoverAmountCents,
      "aus dem leeren Feld wurde ein Betrag — „keine Angabe\" ist wieder zur Null geworden",
    ).toBeUndefined();
  }, 60_000);

  it("WL-2 – eingetragene 0: kommt durch und sendet die festgestellte Null", async () => {
    /**
     * Die Gegenrichtung, und sie ist der Grund, warum WL-1 nicht einfach
     * „0 nie senden" lauten darf. Alriks Entscheidung vom 22.09.2026 steht:
     * eine EINGETRAGENE 0 ist eine Aussage und wird übertragen.
     */
    const r = await wizardLauf({ uebertrag45b: "0", restguthaben45bOverrideEnabled: false });

    expect(r.gesendet, `blockiert: „${(r as any).meldung}"`).toBe(true);
    expect(
      (r as any).budgets?.carryoverAmountCents,
      "die eingetragene 0 wurde verschluckt — dann ist die festgestellte Null nicht mehr ausdrückbar",
    ).toBe(0);
  }, 60_000);

  it("WL-3 – nur Startwert, Übertragsfeld leer", async () => {
    // Der Fall, den Alrik real eingibt: Kassenauskunft nennt den Restbestand,
    // ein Übertrag wird gar nicht erst erfasst. Vor dem Fix blockiert.
    const r = await wizardLauf({
      uebertrag45b: "",
      restguthaben45bOverrideEnabled: true,
      /**
       * `"184.60"` mit PUNKT, nicht `"184,60"`.
       *
       * Eine erste Fassung schrieb das Komma und bekam `18400` statt `18460` —
       * `parseFloat("184,60")` schneidet dort ab. Das sieht nach einem Fehler
       * im Produkt aus, ist aber einer in der Fixture: das Feld ist
       * `type="number"` (`budgets-contract-step.tsx:338`), und dessen `.value`
       * ist nie ein Komma-String. Der Test hätte einen Wert geprüft, den die
       * Oberfläche gar nicht erzeugen kann.
       */
      restguthaben45b: "184.60",
      restguthaben45bStichmonat: "2026-06",
    });

    expect(r.gesendet, `blockiert: „${(r as any).meldung}"`).toBe(true);
    const b = (r as any).budgets;
    expect(b?.override45bCents, "der Startwert kam nicht an").toBe(18460);
    expect(
      b?.carryoverAmountCents,
      "neben dem Startwert entstand ein Übertrag, den niemand eingegeben hat — "
      + "genau die Kombination, die der Server ablehnt",
    ).toBeUndefined();
  }, 60_000);

  it("WL-4 – ein Übertrag ohne Monatsbetrag wird NICHT verschluckt", async () => {
    /**
     * Gemessener Fall 5: mit `entlastungsbetrag45b = 0` fiel der ganze
     * `budgets`-Block weg, und ein eingetragener Übertrag von 500 € war
     * eingegeben, quittiert und weg — ohne Meldung.
     *
     * Dieselbe Form wie „angenommen, quittiert, verworfen" aus #186, nur eine
     * Schicht früher: der Server bekam den Betrag nie zu sehen.
     */
    const r = await wizardLauf({ entlastungsbetrag45b: "0", uebertrag45b: "500" });

    expect(r.gesendet, `blockiert: „${(r as any).meldung}"`).toBe(true);
    expect(
      (r as any).budgets,
      "der budgets-Block fehlt ganz — der eingetragene Übertrag ist still verschwunden",
    ).toBeTruthy();
    expect((r as any).budgets?.carryoverAmountCents).toBe(50000);
  }, 60_000);
  it("WL-5 – Schalter an, Feld leer: blockiert, und die Meldung sagt warum", async () => {
    /**
     * Das Schwesterfeld zum Übertrag — mit bewusst ANDERER Regel.
     *
     * Beim Übertrag gibt es kein Existenz-Signal außer dem Betrag; ein leeres
     * Feld heißt dort „keine Angabe". Beim Restguthaben IST der Schalter das
     * Signal: ist er an, gehört ein Betrag hinein. Ein leeres Feld bleibt
     * deshalb ein Fehler, und das ist kein Widerspruch, sondern der
     * Unterschied zwischen den beiden Feldern.
     *
     * ── Was dieser Test sichert und was nicht ──────────────────────────────
     * Gesichert ist die SCHRANKE: der Assistent lässt „Schalter an, Feld leer"
     * nicht durch, und die Meldung nennt den Ausweg. Vorher stand dort
     * „Restguthaben darf nicht negativ sein" — ein Text über etwas, das gar
     * nicht vorlag.
     *
     * NICHT gesichert ist die Payload-Seite (`override45bCents` ist jetzt
     * `null` statt `0`, Gate 2 zum B1-Delta S-6). Sie ist hinter dieser
     * Schranke unerreichbar, also kann kein Test sie unabhängig prüfen — der
     * Mutations-Gegencheck hat das bestätigt: die Rücknahme der Payload-Zeile
     * ließ alles grün. Sie bleibt als zweite Lage, und der Gegencheck greift
     * an DIESER Schranke.
     *
     * Das ist der Punkt, den Gate 2 gemacht hat: ein Schutz, der von einer
     * Nachbarregel abhängt, fällt mit ihr. Deshalb steht hier ausdrücklich,
     * welche der beiden Lagen geprüft ist.
     */
    const r = await wizardLauf({
      uebertrag45b: "",
      restguthaben45bOverrideEnabled: true,
      restguthaben45b: "",
      restguthaben45bStichmonat: "2026-06",
    });

    expect(r.gesendet, "Schalter an mit leerem Feld kam durch").toBe(false);
    expect(
      (r as any).meldung,
      "die Meldung spricht von „negativ\" für ein leeres Feld — sie benennt "
      + "nicht, was der Anwender tun soll",
    ).toContain("ausschalten");
  }, 60_000);
});
