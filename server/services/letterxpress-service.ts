import type { CompanySettings } from "@shared/schema";
import { lxHttpRequest } from "./letterxpress-http";

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
  status?: number | string;
  message?: string;
  // GET /balance returns the credit at the top level as `balance.value` (a
  // decimal string, e.g. "91.59").
  balance?: {
    currency?: string;
    value?: string | number;
  };
  // POST /setjob returns the created job id at `data.id` (an integer). Older
  // payloads/wrappers used `letter_id`, which we still accept defensively.
  data?: {
    id?: string | number;
    letter_id?: string | number;
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
    // LetterXpress v2 expects "test" for sandbox and "production" for live sends.
    mode: settings.letterxpressTestMode ? "test" : "production",
  };
}

async function callLetterxpress(
  method: "GET" | "POST",
  path: string,
  payload: Record<string, unknown>,
  timeoutMs: number = LETTERXPRESS_TIMEOUT_MS
): Promise<LetterxpressResponse> {
  const response = await lxHttpRequest({
    url: `${LETTERXPRESS_API_BASE}${path}`,
    method,
    body: JSON.stringify(payload),
    timeoutMs,
  });

  let data: LetterxpressResponse | null = null;
  try {
    data = response.text ? (JSON.parse(response.text) as LetterxpressResponse) : null;
  } catch {
    data = null;
  }

  if (response.status < 200 || response.status >= 300) {
    const msg = data?.message || response.text || "Unbekannter Fehler";
    throw new Error(`LetterXpress-Aufruf fehlgeschlagen (${response.status}): ${msg}`);
  }

  if (!data || (typeof data.status === "number" && data.status >= 400)) {
    throw new Error(`LetterXpress-Aufruf fehlgeschlagen: ${data?.message || "Unbekannter Fehler"}`);
  }

  return data;
}

/**
 * Sends a letter via LetterXpress v2 (POST /setjob).
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

  const result = await callLetterxpress("POST", "/setjob", payload);
  const letterId = result.data?.id ?? result.data?.letter_id;
  if (letterId === undefined || letterId === null || letterId === "") {
    throw new Error("LetterXpress-Briefversand: Keine Letter-ID erhalten");
  }
  return { letterId: String(letterId) };
}

function parseBalance(value: string | number | undefined): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export async function testLetterxpressConnection(
  settings: CompanySettings
): Promise<{ success: boolean; error?: string; balance?: number }> {
  try {
    validateLetterxpressConfig(settings);
    const result = await callLetterxpress("GET", "/balance", { auth: buildAuth(settings) });
    return { success: true, balance: parseBalance(result.balance?.value) };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "Verbindung fehlgeschlagen" };
  }
}

export async function checkLetterxpressHealth(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await lxHttpRequest({
      url: `${LETTERXPRESS_API_BASE}/balance`,
      method: "GET",
      body: JSON.stringify({}),
      timeoutMs: LETTERXPRESS_TIMEOUT_MS,
    });
    // The health check sends no credentials, so 401 ("Unauthorized") is the
    // expected healthy response: it proves the /balance endpoint exists and the
    // server is up. Anything else (404 wrong path, 5xx, network error) means the
    // integration is NOT reachable and the badge must turn red.
    if (response.status === 200 || response.status === 401) {
      return { success: true };
    }
    return { success: false, error: `API nicht erreichbar (${response.status})` };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "API nicht erreichbar" };
  }
}
