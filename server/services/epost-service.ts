import type { CompanySettings } from "@shared/schema";

const EPOST_API_BASE = "https://api.epost.docuguide.com";
const EPOST_TIMEOUT_MS = 15000;

interface EpostLoginResponse {
  token: string;
}

interface EpostLetterResponse {
  letterId: string;
}

function validateEpostConfig(settings: CompanySettings): void {
  if (!settings.epostVendorId || !settings.epostEkp || !settings.epostPassword || !settings.epostSecret) {
    throw new Error("E-POST-Konfiguration unvollständig. Bitte in den Einstellungen konfigurieren.");
  }
}

async function loginEpost(settings: CompanySettings): Promise<string> {
  validateEpostConfig(settings);

  const response = await fetch(`${EPOST_API_BASE}/api/Login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      vendorID: settings.epostVendorId,
      ekp: settings.epostEkp,
      password: settings.epostPassword,
      secret: settings.epostSecret,
    }),
    signal: AbortSignal.timeout(EPOST_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unbekannter Fehler");
    throw new Error(`E-POST Login fehlgeschlagen (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as EpostLoginResponse;
  if (!data.token) {
    throw new Error("E-POST Login: Kein Token erhalten");
  }

  return data.token;
}

export async function requestSmsCode(
  vendorId: string,
  ekp: string
): Promise<{ success: boolean; message?: string; error?: string }> {
  try {
    const response = await fetch(`${EPOST_API_BASE}/api/Login/smsRequest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorID: vendorId,
        ekp: ekp,
      }),
      signal: AbortSignal.timeout(EPOST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unbekannter Fehler");
      return { success: false, error: `SMS-Anfrage fehlgeschlagen (${response.status}): ${errorText}` };
    }

    const message = await response.text().catch(() => "");
    return { success: true, message: message || "SMS-Code wurde an die hinterlegte Mobilnummer gesendet." };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "SMS-Anfrage fehlgeschlagen" };
  }
}

export async function setEpostPassword(
  vendorId: string,
  ekp: string,
  newPassword: string,
  smsCode: string
): Promise<{ success: boolean; secret?: string; error?: string }> {
  try {
    const response = await fetch(`${EPOST_API_BASE}/api/Login/setPassword`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendorID: vendorId,
        ekp: ekp,
        newPassword: newPassword,
        smsCode: smsCode,
      }),
      signal: AbortSignal.timeout(EPOST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unbekannter Fehler");
      return { success: false, error: `Passwort setzen fehlgeschlagen (${response.status}): ${errorText}` };
    }

    const secret = await response.text();
    if (!secret) {
      return { success: false, error: "Kein Sicherheitsschlüssel (Secret) vom Server erhalten" };
    }

    return { success: true, secret };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "Passwort setzen fehlgeschlagen" };
  }
}

export async function checkEpostHealthCheck(): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${EPOST_API_BASE}/api/Login/HealthCheck`, {
      method: "GET",
      signal: AbortSignal.timeout(EPOST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unbekannter Fehler");
      return { success: false, error: `API nicht erreichbar (${response.status}): ${errorText}` };
    }

    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "API nicht erreichbar" };
  }
}

export async function sendEpostLetter(
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
  const token = await loginEpost(settings);

  const senderLine =
    options.senderLine ||
    [settings.companyName, settings.strasse, settings.hausnummer, settings.plz, settings.stadt]
      .filter(Boolean)
      .join(", ");

  const letterPayload = {
    recipient: {
      firstName: options.recipientFirstName,
      lastName: options.recipientLastName,
      street: options.recipientStreet,
      houseNumber: options.recipientHouseNumber,
      postalCode: options.recipientPostalCode,
      city: options.recipientCity,
      company: options.recipientCompany || "",
      country: "",
    },
    senderAddress: senderLine,
    printOptions: {
      color: false,
      duplex: true,
    },
    document: options.pdfBuffer.toString("base64"),
  };

  const response = await fetch(`${EPOST_API_BASE}/api/Letter`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(letterPayload),
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unbekannter Fehler");
    throw new Error(`E-POST Briefversand fehlgeschlagen (${response.status}): ${errorText}`);
  }

  const data = (await response.json()) as EpostLetterResponse;
  return { letterId: data.letterId };
}

export async function testEpostConnection(settings: CompanySettings): Promise<{ success: boolean; error?: string }> {
  try {
    validateEpostConfig(settings);
    await loginEpost(settings);
    return { success: true };
  } catch (error: unknown) {
    return { success: false, error: error instanceof Error ? error.message : "Verbindung fehlgeschlagen" };
  }
}
