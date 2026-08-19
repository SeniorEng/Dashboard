/**
 * Identitäts-Kette des Release-Steps (S7/S8).
 *
 * Anlass ist ein realer Vorfall: ein Dry-Run lief gegen `heliumdb` statt
 * `neondb`, weil `helium` in Dev wie Prod derselbe interne Hostname ist. Ein
 * Gate, das eine andere Verbindung prüft als der Push benutzt, ist wertlos.
 */
import { describe, expect, it } from "vitest";
import {
  abweichungsMeldung,
  pruefeInnereIdentitaet,
  vergleicheIdentitaeten,
  type Identitaet,
} from "../../scripts/lib/release-identity-core.ts";

const STIMMIG: Identitaet = {
  punkt: "0a",
  appHost: "helium",
  appDatenbank: "neondb",
  direktHost: "helium",
  direktDatenbank: "neondb",
  drizzleKitApi: "0.31.10",
  drizzleKitCli: "0.31.10",
};

describe("pruefeInnereIdentitaet", () => {
  it("stimmige Erhebung hat keine Abweichung", () => {
    expect(pruefeInnereIdentitaet(STIMMIG)).toEqual([]);
  });

  it("DER Vorfall: gleicher Host, andere Datenbank", () => {
    // Genau so sah der Fehl-Dry-Run aus. Der Host allein haette nichts verraten.
    const abw = pruefeInnereIdentitaet({ ...STIMMIG, direktDatenbank: "heliumdb" });
    expect(abw).toHaveLength(1);
    expect(abw[0].feld).toBe("Datenbank");
    expect(abw[0].bedeutung).toMatch(/NEON_LOCAL_WS_PROXY/);
  });

  it("verschiedene Hosts fallen auf", () => {
    const abw = pruefeInnereIdentitaet({ ...STIMMIG, direktHost: "anderer-host" });
    expect(abw.map((a) => a.feld)).toEqual(["Host"]);
  });

  it("S8: Trockenlauf und Push benutzen verschiedene drizzle-kit-Versionen", () => {
    const abw = pruefeInnereIdentitaet({ ...STIMMIG, drizzleKitCli: "0.31.9" });
    expect(abw).toHaveLength(1);
    expect(abw[0].feld).toBe("drizzle-kit-Version");
  });

  it("mehrere Abweichungen werden alle gemeldet, nicht nur die erste", () => {
    const abw = pruefeInnereIdentitaet({
      ...STIMMIG,
      direktHost: "x",
      direktDatenbank: "y",
      drizzleKitCli: "0.0.1",
    });
    expect(abw).toHaveLength(3);
  });
});

describe("vergleicheIdentitaeten", () => {
  const SPAET: Identitaet = { ...STIMMIG, punkt: "1a" };

  it("unveraendert ⇒ keine Abweichung", () => {
    expect(vergleicheIdentitaeten(STIMMIG, SPAET)).toEqual([]);
  });

  it("Ziel mitten im Release-Step gewechselt ⇒ Abbruch", () => {
    const abw = vergleicheIdentitaeten(STIMMIG, { ...SPAET, appDatenbank: "andere_db" });
    expect(abw).toHaveLength(1);
    expect(abw[0].feld).toBe("Datenbank (App-Weg)");
  });

  it("prueft ALLE sechs Felder, nicht nur die Datenbank", () => {
    const komplettAnders: Identitaet = {
      punkt: "1a",
      appHost: "a",
      appDatenbank: "b",
      direktHost: "c",
      direktDatenbank: "d",
      drizzleKitApi: "1.0.0",
      drizzleKitCli: "2.0.0",
    };
    expect(vergleicheIdentitaeten(STIMMIG, komplettAnders)).toHaveLength(6);
  });
});

describe("abweichungsMeldung", () => {
  it("nennt beide Seiten und die Bedeutung, ohne die URL", () => {
    const meldung = abweichungsMeldung(
      pruefeInnereIdentitaet({ ...STIMMIG, direktDatenbank: "heliumdb" }),
      "Testfall",
    );
    expect(meldung).toContain("RELEASE ABGEBROCHEN");
    expect(meldung).toContain("neondb");
    expect(meldung).toContain("heliumdb");
    expect(meldung).not.toMatch(/postgres(ql)?:\/\//);
  });
});
