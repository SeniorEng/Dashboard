import { describe, it, expect } from "vitest";
import {
  classifyActiveCustomerLifecycle,
  isGekuendigterAktiverKunde,
  isLaufenderAktiverKunde,
  ACTIVE_CUSTOMER_LIFECYCLE_LABELS,
  ACTIVE_CUSTOMER_LIFECYCLES,
  TERMINATED_CONTRACT_STATUS,
  PAUSED_CONTRACT_STATUS,
  isPausierterAktiverKunde,
} from "@shared/domain/customers";
import { CONTRACT_STATUS } from "@shared/schema/contracts";

/**
 * `customers.status` hat kein Enum im Schema — die Werte stehen als Kommentar
 * an der Spalte (`shared/schema/customers.ts:39`). Hier ausgeschrieben, damit
 * die Tabelle unten wirklich erschoepfend ist; ein vierter Kundenstatus faellt
 * dann hier auf statt still durchzulaufen.
 */
const CUSTOMER_STATUSES = ["aktiv", "inaktiv", "gekuendigt"] as const;

describe("classifyActiveCustomerLifecycle (Task #1194)", () => {
  it("klassifiziert einen aktiven Kunden ohne Vertragsende/Kündigung als 'laufend'", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: null }),
    ).toBe("laufend");
  });

  it("klassifiziert einen aktiven Kunden mit gesetztem Vertragsende als 'gekuendigt'", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: "2026-01-31", contractStatus: null }),
    ).toBe("gekuendigt");
  });

  it("klassifiziert einen aktiven Kunden mit Vertragsstatus 'terminated' als 'gekuendigt'", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: TERMINATED_CONTRACT_STATUS }),
    ).toBe("gekuendigt");
  });

  it("behandelt einen leeren contractEnd-String wie 'kein Vertragsende' (laufend)", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: "   ", contractStatus: null }),
    ).toBe("laufend");
  });

  it("unbekannte Vertragsstatus bleiben 'laufend' — 'paused' ist seit 6hHW39Gx KEINER mehr", () => {
    // ── Was dieser Fall vorher behauptete ────────────────────────────────
    // Er hiess „ignoriert andere Vertragsstatus (z.B. 'paused') und bleibt
    // 'laufend'" und nagelte damit genau die falsche Aussage fest: ein
    // pausierter Vertrag galt als laufend. Der Test war nicht der Schutz gegen
    // den Fehler, er war seine Zementierung — grün, weil er dasselbe glaubte
    // wie der Code.
    //
    // `paused` ist seit 6hHW39Gx ein bekannter Wert mit eigener Einordnung.
    // Was bleibt: ein Wert, den weder Schema noch Klassifikation kennen, faellt
    // auf „laufend" zurueck. Das ist die konservative Richtung — ein
    // Tippfehler-Status blendet niemanden aus der Betreuung aus.
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: "voellig_unbekannt" }),
    ).toBe("laufend");
  });

  it("gibt null zurück, wenn der Kunde nicht aktiv ist", () => {
    expect(
      classifyActiveCustomerLifecycle({ status: "inaktiv", contractEnd: "2026-01-31", contractStatus: TERMINATED_CONTRACT_STATUS }),
    ).toBeNull();
    expect(
      classifyActiveCustomerLifecycle({ status: "gekuendigt", contractEnd: null, contractStatus: null }),
    ).toBeNull();
    expect(
      classifyActiveCustomerLifecycle({ status: null, contractEnd: null, contractStatus: null }),
    ).toBeNull();
    expect(
      classifyActiveCustomerLifecycle({ status: undefined, contractEnd: null, contractStatus: null }),
    ).toBeNull();
  });
});

describe("isGekuendigterAktiverKunde / isLaufenderAktiverKunde", () => {
  it("isGekuendigterAktiverKunde ist nur für aktiv + beendet/gekündigt true", () => {
    expect(isGekuendigterAktiverKunde({ status: "aktiv", contractEnd: "2026-01-31" })).toBe(true);
    expect(isGekuendigterAktiverKunde({ status: "aktiv", contractStatus: TERMINATED_CONTRACT_STATUS })).toBe(true);
    expect(isGekuendigterAktiverKunde({ status: "aktiv", contractEnd: null })).toBe(false);
    expect(isGekuendigterAktiverKunde({ status: "inaktiv", contractEnd: "2026-01-31" })).toBe(false);
  });

  it("isLaufenderAktiverKunde ist nur für aktiv + nicht beendet/gekündigt true", () => {
    expect(isLaufenderAktiverKunde({ status: "aktiv", contractEnd: null })).toBe(true);
    expect(isLaufenderAktiverKunde({ status: "aktiv", contractEnd: "2026-01-31" })).toBe(false);
    expect(isLaufenderAktiverKunde({ status: "inaktiv", contractEnd: null })).toBe(false);
  });

  it("laufend und gekuendigt sind NICHT mehr komplementaer — dazwischen liegt pausiert", () => {
    // ── Was dieser Fall vorher behauptete ────────────────────────────────
    // „die beiden Praedikate sind innerhalb der aktiven Kohorte komplementaer"
    // — `isLaufend === !isGekuendigt`. Das galt, solange es zwei Werte gab.
    // Mit `pausiert` ist es falsch, und der Fall blieb nur deshalb gruen, weil
    // seine `inputs`-Liste ausgerechnet `paused` nicht enthielt. Dieselbe
    // Fehlerklasse wie der Fall, den 6hHW39Gx ersetzt hat: ein Test, der die
    // alte Zweiwertigkeit mitglaubt.
    const komplementaer = [
      { status: "aktiv", contractEnd: null, contractStatus: null },
      { status: "aktiv", contractEnd: "2026-01-31", contractStatus: null },
      { status: "aktiv", contractEnd: null, contractStatus: TERMINATED_CONTRACT_STATUS },
    ];
    for (const input of komplementaer) {
      expect(isLaufenderAktiverKunde(input)).toBe(!isGekuendigterAktiverKunde(input));
    }

    // Und die Gegenprobe, die den Fall erst messend macht: pausiert ist WEDER
    // laufend NOCH gekuendigt.
    const pausiert = { status: "aktiv", contractEnd: null, contractStatus: PAUSED_CONTRACT_STATUS };
    expect(isLaufenderAktiverKunde(pausiert)).toBe(false);
    expect(isGekuendigterAktiverKunde(pausiert)).toBe(false);
    expect(isPausierterAktiverKunde(pausiert)).toBe(true);
  });

  // ── Task 6hHW39Gx — „pausiert" als dritter Wert ───────────────────────

  it("klassifiziert einen aktiven Kunden mit pausiertem Vertrag als 'pausiert'", () => {
    // Vorher fiel dieser Fall in den `sonst`-Zweig und wurde „laufend" genannt.
    // Die Kundenlisten behaupteten damit von einem Kunden, dessen Betreuung
    // ruht, sie laufe — keine fehlende Funktion, sondern eine falsche Aussage.
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: PAUSED_CONTRACT_STATUS }),
    ).toBe("pausiert");
    expect(isPausierterAktiverKunde({ status: "aktiv", contractEnd: null, contractStatus: "paused" })).toBe(true);
    // Und er ist damit NICHT mehr „laufend" — das ist die Verhaltensaenderung.
    expect(isLaufenderAktiverKunde({ status: "aktiv", contractEnd: null, contractStatus: "paused" })).toBe(false);
  });

  it("ein beendeter Vertrag schlaegt einen pausierten", () => {
    // Reihenfolge ist Teil der Aussage: wer gekuendigt hat, dessen Betreuung
    // ruht nicht, sie ist vorbei.
    expect(
      classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: "2026-06-30", contractStatus: PAUSED_CONTRACT_STATUS }),
    ).toBe("gekuendigt");
  });

  it("ERSCHOEPFEND: jede Kombination aus Kundenstatus x Vertragsstatus ist zugeordnet", () => {
    // Kein `default`-Schlucker: die Tabelle laeuft ueber die ECHTEN Enums, nicht
    // ueber eine Auswahl. Ein neuer Vertragsstatus faellt hier auf, statt
    // stillschweigend als „laufend" durchzugehen.
    const erwartet: Record<string, string | null> = {
      active: "laufend",
      paused: "pausiert",
      terminated: "gekuendigt",
    };
    for (const kundenStatus of CUSTOMER_STATUSES) {
      for (const vertragsStatus of CONTRACT_STATUS) {
        const ergebnis = classifyActiveCustomerLifecycle({
          status: kundenStatus, contractEnd: null, contractStatus: vertragsStatus,
        });
        // Nur die aktive Kohorte wird klassifiziert; alles andere ist `null`.
        expect(ergebnis, `${kundenStatus} / ${vertragsStatus}`)
          .toBe(kundenStatus === "aktiv" ? erwartet[vertragsStatus] : null);
      }
      // Ohne Vertrag: aktive Kunden laufen (Intake), der Rest ist `null`.
      expect(
        classifyActiveCustomerLifecycle({ status: kundenStatus, contractEnd: null, contractStatus: null }),
        `${kundenStatus} / kein Vertrag`,
      ).toBe(kundenStatus === "aktiv" ? "laufend" : null);
    }
  });

  it("jeder Lebenszyklus-Wert hat ein Label und ist erreichbar", () => {
    // Sonst kann ein Wert existieren, den die Oberflaeche nicht benennen kann.
    for (const wert of ACTIVE_CUSTOMER_LIFECYCLES) {
      expect(ACTIVE_CUSTOMER_LIFECYCLE_LABELS[wert], `Label fuer ${wert}`).toBeTruthy();
    }
    const erreicht = new Set(
      CONTRACT_STATUS.map(cs =>
        classifyActiveCustomerLifecycle({ status: "aktiv", contractEnd: null, contractStatus: cs })),
    );
    expect([...erreicht].sort()).toEqual([...ACTIVE_CUSTOMER_LIFECYCLES].sort());
  });
});

describe("ACTIVE_CUSTOMER_LIFECYCLE_LABELS", () => {
  it("liefert die deutschen UI-Labels", () => {
    expect(ACTIVE_CUSTOMER_LIFECYCLE_LABELS.laufend).toBe("Laufend");
    expect(ACTIVE_CUSTOMER_LIFECYCLE_LABELS.pausiert).toBe("Pausiert");
    expect(ACTIVE_CUSTOMER_LIFECYCLE_LABELS.gekuendigt).toBe("Gekündigt");
  });
});
