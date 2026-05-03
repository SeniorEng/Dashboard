import type { CompanySettings } from "@shared/schema";

const LETTERXPRESS_API_BASE = "https://api.letterxpress.de/v2";
const LETTERXPRESS_TIMEOUT_MS = 30000;

export const LETTERXPRESS_SPEC = {
  COLOR_BW: "1" as const,
  COLOR_4C: "4" as const,
  MODE_SIMPLEX: "simplex" as const,
  MODE_DUPLEX: "duplex" as const,
  SHIP_NATIONAL: "national" as const,
  SHIP_INTERNATIONAL: "international" as const,
  PRINT_TEST: "test" as const,
  PRINT_LIVE: "live" as const,
} as const;

interface LetterxpressResponse {
  status: number;
  message?: string;
  data?: {
    letter_id?: string | number;
    balance?: number;
  };
}

function validateLetterxpressConfig(settings: CompanySettings): void {
  if (!settings.letterxpressUsername || !settings.letterxpressApiKey) {
    throw new Error(
      "LetterXpress-Konfiguration unvollständig. Bitte Benutzername und API-Key in den Einstellungen hinterlegen."
    );
  }
}

function buildAuth(settings: CompanySettings) {
  return {
    username: settings.letterxpressUsername,
    apikey: settings.letterxpressApiKey,
  };
}

async function callLetterxpress(
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number = LETTERXPRESS_TIMEOUT_MS
): Promise<LetterxpressResponse> {
  const response = await fetch(`${LETTERXPRESS_API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let data: LetterxpressResponse | null = null;
  try {
    data = text ? (JSON.parse(text) as LetterxpressResponse) : null;
  } catch {
    data = null;
  }

  if (!response.ok) {
    const msg = data?.message || text || "Unbekannter Fehler";
    throw new Error(`LetterXpress-Aufruf fehlgeschlagen (${response.status}): ${msg}`);
  }

  if (!data || (typeof data.status === "number" && data.status >= 400)) {
    throw new Error(`LetterXpress-Aufruf fehlgeschlagen: ${data?.message || "Unbekannter Fehler"}`);
  }

  return data;
}

/**
 * Sends a letter via LetterXpress v2 (POST /setJob).
 *
 * Wichtig zum Adress-Handling: die LetterXpress v2-API nimmt im Body NUR die PDF
 * (base64) plus Spezifikation entgegen — Empfänger- und Absenderadresse werden
 * NICHT als strukturierte Felder übermittelt, sondern aus dem DIN-5008-Adressfenster
 * der eingelieferten PDF gelesen. Aus diesem Grund verlangt diese Funktion die
 * Empfängeradressfelder als Pflicht-Parameter (defensiv validiert), und die
 * Aufrufer (document-delivery.ts → renderCoverLetterPdf) sind dafür
 * verantwortlich, genau diese Felder ins Adressfenster der PDF zu rendern.
 *
 * Spezifikation (siehe LetterXpress API-Doku v2):
 *  - color "1" = Schwarz/Weiß, "4" = Vierfarbig (CMYK)
 *  - mode  "simplex" = einseitig, "duplex" = beidseitig
 *  - ship  "national" oder "international"
 *  - print "test" = Testmodus (kein realer/abrechnungsrelevanter Druck),
 *          "live" = produktiver Versand. Dies IST der dokumentierte Test-Schalter.
 */
export async function sendLetterxpressLetter(
  settings: CompanySettings,
  options: {
    pdfBuffer: Buffer;
    recipientFirstName: string;
    recipientLastName: string;
    recipientStreet: string;
    recipientHouseNumber: string;
    recipientPostalCode: string;
    recipientCity: string;
    recipientCompany?: string;
    senderLine?: string;
  }
): Promise<{ letterId: string }> {
  validateLetterxpressConfig(settings);

  if (!options.recipientPostalCode || !options.recipientCity || !options.recipientStreet) {
    throw new Error(
      "LetterXpress-Briefversand: Empfängeradresse unvollständig (Straße, PLZ, Stadt erforderlich)"
    );
  }
  if (!options.recipientLastName && !options.recipientCompany) {
    throw new Error("LetterXpress-Briefversand: Empfängername fehlt");
  }
  if (!options.pdfBuffer || options.pdfBuffer.length === 0) {
    throw new Error("LetterXpress-Briefversand: Leeres PDF");
  }

  const payload = {
    auth: buildAuth(settings),
    letter: {
      base64_file: options.pdfBuffer.toString("base64"),
      base64_file2: "",
      specification: {
        color: LETTERXPRESS_SPEC.COLOR_BW,
        mode: LETTERXPRESS_SPEC.MODE_DUPLEX,
        ship: LETTERXPRESS_SPEC.SHIP_NATIONAL,
        print: settings.letterxpressTestMode
          ? LETTERXPRESS_SPEC.PRINT_TEST
          : LETTERXPRESS_SPEC.PRINT_LIVE,
      },
    },
  };

  const result = await callLetterxpress("/setJob", payload);
  const letterId = result.data?.letter_id;
  if (letterId === undefined || letterId === null || letterId === "") {
    throw new Error("LetterXpress-Briefversand: Keine Letter-ID erhalten");
  }
  return { letterId: String(letterId) };
}

export async function testLetterxpressConnection(
  settings: CompanySettings
): Promise<{ success: boolean; error?: string; balance?: number }> {
  try {
    validateLetterxpressConfig(settings);
    const result = await callLetterxpress("/getBalance", { auth: buildAuth(settings) });
    return { success: true, balance: result.data?.balance };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "Verbindung fehlgeschlagen" };
  }
}

export async function checkLetterxpressHealth(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${LETTERXPRESS_API_BASE}/getBalance`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(LETTERXPRESS_TIMEOUT_MS),
    });
    if (response.status >= 500) {
      return { success: false, error: `API nicht erreichbar (${response.status})` };
    }
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "API nicht erreichbar" };
  }
}
