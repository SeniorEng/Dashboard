export interface ParsedLead {
  vorname: string;
  nachname: string;
  telefon?: string;
  email?: string;
  strasse?: string;
  nr?: string;
  plz?: string;
  stadt?: string;
  pflegegrad?: number;
  quelle?: string;
  quelleDetails?: string;
  notizen?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|tr|td|th|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#\d+;/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

function extractTableValue(text: string, label: string): string | undefined {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`(?:^|\\n)\\s*${escaped}[\\w]*\\.?\\s*:\\s*(.+?)(?:\\n|$)`, "im"),
    new RegExp(`${escaped}[\\w]*\\.?\\s*:\\s*(.+?)(?:\\n|$)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const val = match?.[1]?.trim();
    if (val && val.length > 0) return val;
  }
  return undefined;
}

function extractSection(text: string, startMarker: string, endMarkers: string[]): string {
  const startIdx = text.indexOf(startMarker);
  if (startIdx === -1) return "";

  const sectionStart = startIdx + startMarker.length;
  let sectionEnd = text.length;

  for (const marker of endMarkers) {
    const idx = text.indexOf(marker, sectionStart);
    if (idx !== -1 && idx < sectionEnd) {
      sectionEnd = idx;
    }
  }

  return text.substring(sectionStart, sectionEnd).trim();
}

function isPflegehilfeEmail(body: string): boolean {
  const lower = body.toLowerCase();
  return lower.includes("kontaktinformationen des interessenten")
    || lower.includes("verbund pflegehilfe")
    || (lower.includes("pflegehilfe") && lower.includes("anfragen-nr"));
}

function parseName(rawName: string): { vorname: string; nachname: string } {
  let name = rawName
    .replace(/^(frau|herr)\s+/i, "")
    .trim();

  const parts = name.split(/\s+/);
  if (parts.length === 0) return { vorname: "Unbekannt", nachname: "Interessent" };
  if (parts.length === 1) return { vorname: parts[0], nachname: "" };

  return {
    vorname: parts.slice(0, -1).join(" "),
    nachname: parts[parts.length - 1],
  };
}

function parseBedarfsort(raw: string): { plz?: string; stadt?: string } {
  const match = raw.match(/(\d{5})\s+([A-Za-zÄÖÜäöüß\s-]+)/);
  if (!match) return {};

  let stadt = match[2].trim();
  stadt = stadt.replace(/-\s*DE$/i, "").trim();

  return { plz: match[1], stadt };
}

function parsePflegehilfeEmail(body: string, subject?: string): ParsedLead {
  const text = stripHtml(body);
  console.log("[email-parser] Pflegehilfe format detected, stripped text length:", text.length);

  const kontaktSection = extractSection(text, "Kontaktinformationen des Interessenten", [
    "Informationen zum Senior",
    "Anfragedetails",
    "Datenschutz",
  ]);

  const seniorSection = extractSection(text, "Informationen zum Senior", [
    "Anfragedetails",
    "Datenschutz",
  ]);

  const anfrageSection = extractSection(text, "Anfragedetails", [
    "Datenschutz",
    "Anfragen-Manager",
  ]);

  let vorname = "";
  let nachname = "";
  const rawName = extractTableValue(kontaktSection, "Name");
  console.log("[email-parser] Sections found - kontakt:", kontaktSection.length, "senior:", seniorSection.length, "anfrage:", anfrageSection.length);
  console.log("[email-parser] Raw name:", rawName);
  if (rawName) {
    const parsed = parseName(rawName);
    vorname = parsed.vorname;
    nachname = parsed.nachname;
  }

  const rawTelefon = extractTableValue(kontaktSection, "Mobil")
    || extractTableValue(kontaktSection, "Telefon")
    || extractTableValue(kontaktSection, "Tel");

  const rawEmail = extractTableValue(kontaktSection, "E-Mail-Adresse")
    || extractTableValue(kontaktSection, "E-Mail")
    || extractTableValue(kontaktSection, "Email");
  let email: string | undefined;
  if (rawEmail) {
    const emailMatch = rawEmail.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
    email = emailMatch ? emailMatch[0] : undefined;
  }

  const erreichbarkeit = extractTableValue(kontaktSection, "Erreichbarkeit");

  const pflegegradRaw = extractTableValue(seniorSection, "Pflegegrad")
    || extractTableValue(anfrageSection, "Pflegegrad");
  let pflegegrad: number | undefined;
  if (pflegegradRaw) {
    const gradeMatch = pflegegradRaw.match(/(\d)/);
    if (gradeMatch) {
      const grade = parseInt(gradeMatch[1]);
      if (grade >= 1 && grade <= 5) pflegegrad = grade;
    }
  }

  const beziehung = extractTableValue(seniorSection, "Beziehung");
  const lebenssituation = extractTableValue(seniorSection, "Lebenssituation");
  const mobilitaet = extractTableValue(seniorSection, "Mobilität")
    || extractTableValue(seniorSection, "Mobilitaet");

  const anfragenNr = extractTableValue(anfrageSection, "Anfragen-Nr");
  const bedarfsortRaw = extractTableValue(anfrageSection, "Bedarfsort");
  const addressParts = bedarfsortRaw ? parseBedarfsort(bedarfsortRaw) : {};

  let aufgaben: string | undefined;
  let woechentlicherUmfang: string | undefined;
  let umfangAmStueck: string | undefined;
  let abrechnungBetEntlastung: string | undefined;
  let pflegedienstVorhanden: string | undefined;
  let bedarf: string | undefined;

  const detailSource = anfrageSection + "\n" + extractSection(text, "Weitere Details", ["Datenschutz", "Anfragen-Manager"]);

  const extractDetail = (key: string): string | undefined => {
    const pattern = new RegExp(`${key}:\\s*(.+?)(?:\\n|$)`, "i");
    const match = detailSource.match(pattern);
    return match?.[1]?.trim() || undefined;
  };

  aufgaben = extractDetail("Aufgaben");
  woechentlicherUmfang = extractDetail("W(?:ö|oe)chentlicher Umfang");
  umfangAmStueck = extractDetail("Umfang am St(?:ü|ue)ck");
  abrechnungBetEntlastung = extractDetail("Abrechnung[^:]*");
  pflegedienstVorhanden = extractDetail("Pflegedienst vorhanden");
  bedarf = extractDetail("Bedarf(?!sort)");

  let anfrageTyp = "";
  if (subject) {
    const typMatch = subject.match(/(?:Neue Anfrage|Anfrage):\s*(.+)/i);
    if (typMatch) anfrageTyp = typMatch[1].trim();
  }

  let quelleDetails = "";
  if (anfragenNr) quelleDetails += `Anfragen-Nr. ${anfragenNr}`;
  if (anfrageTyp) quelleDetails += quelleDetails ? ` | ${anfrageTyp}` : anfrageTyp;

  const notizenParts: string[] = [];
  if (erreichbarkeit) notizenParts.push(`Erreichbarkeit: ${erreichbarkeit}`);
  if (beziehung) notizenParts.push(`Beziehung zum Senior: ${beziehung}`);
  if (lebenssituation) notizenParts.push(`Lebenssituation: ${lebenssituation}`);
  if (mobilitaet) notizenParts.push(`Mobilität: ${mobilitaet}`);
  if (aufgaben) notizenParts.push(`Aufgaben: ${aufgaben}`);
  if (woechentlicherUmfang) notizenParts.push(`Wöchentlicher Umfang: ${woechentlicherUmfang}`);
  if (umfangAmStueck) notizenParts.push(`Umfang am Stück: ${umfangAmStueck}`);
  if (abrechnungBetEntlastung) notizenParts.push(`Abrechnung Entlastungsleistungen: ${abrechnungBetEntlastung}`);
  if (pflegedienstVorhanden) notizenParts.push(`Pflegedienst vorhanden: ${pflegedienstVorhanden}`);
  if (bedarf) notizenParts.push(`Bedarf: ${bedarf}`);
  if (bedarfsortRaw) notizenParts.push(`Bedarfsort: ${bedarfsortRaw}`);

  const result = {
    vorname: vorname || "Unbekannt",
    nachname: nachname || "Interessent",
    telefon: rawTelefon?.replace(/\s+/g, "") || undefined,
    email,
    ...addressParts,
    pflegegrad,
    quelle: "Verbund Pflegehilfe",
    quelleDetails: quelleDetails || undefined,
    notizen: notizenParts.length > 0 ? notizenParts.join("\n") : undefined,
  };
  console.log("[email-parser] Parsed result:", JSON.stringify({ vorname: result.vorname, nachname: result.nachname, telefon: result.telefon, email: result.email, plz: result.plz, stadt: result.stadt, pflegegrad: result.pflegegrad }));
  return result;
}

function extractField(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]?.trim()) {
      return match[1].trim();
    }
  }
  return undefined;
}

function extractPflegegrad(text: string): number | undefined {
  const match = text.match(/pflegegrad\s*:?\s*(\d)/i)
    || text.match(/pflegestufe\s*:?\s*(\d)/i)
    || text.match(/pflege[- ]?grad\s*(\d)/i);
  if (match) {
    const grade = parseInt(match[1]);
    if (grade >= 1 && grade <= 5) return grade;
  }
  return undefined;
}

function splitAddress(addressLine: string): { strasse?: string; nr?: string; plz?: string; stadt?: string } {
  const result: { strasse?: string; nr?: string; plz?: string; stadt?: string } = {};

  const plzStadtMatch = addressLine.match(/(\d{5})\s+(.+)/);
  if (plzStadtMatch) {
    result.plz = plzStadtMatch[1];
    result.stadt = plzStadtMatch[2].trim();
  }

  const strasseNrMatch = addressLine.match(/^([A-Za-zÄÖÜäöüß\s.-]+?)\s*(\d+\s*[a-zA-Z]?)(?:\s*,|\s+\d{5}|$)/);
  if (strasseNrMatch) {
    result.strasse = strasseNrMatch[1].trim();
    result.nr = strasseNrMatch[2].trim();
  }

  return result;
}

function parseGenericEmail(body: string, subject?: string): ParsedLead {
  const text = body.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");

  const namePatterns = [
    /(?:name|kundenname|interessent)\s*:?\s*([A-Za-zÄÖÜäöüß]+)\s+([A-Za-zÄÖÜäöüß]+)/i,
    /(?:vor-?\s*und\s*nachname|vollst[äa]ndiger?\s*name)\s*:?\s*([A-Za-zÄÖÜäöüß]+)\s+([A-Za-zÄÖÜäöüß]+)/i,
  ];

  let vorname = "";
  let nachname = "";

  for (const pattern of namePatterns) {
    const match = text.match(pattern);
    if (match) {
      vorname = match[1];
      nachname = match[2];
      break;
    }
  }

  if (!vorname) {
    const vornameField = extractField(text, [/vorname\s*:?\s*([A-Za-zÄÖÜäöüß-]+)/i]);
    const nachnameField = extractField(text, [/nachname\s*:?\s*([A-Za-zÄÖÜäöüß-]+)/i]);
    if (vornameField) vorname = vornameField;
    if (nachnameField) nachname = nachnameField;
  }

  if (!vorname && !nachname) {
    vorname = "Unbekannt";
    nachname = "Interessent";
  }

  const telefon = extractField(text, [
    /(?:telefon|tel\.?|handy|mobil|rufnummer|phone)\s*:?\s*([\d\s+\-/()]{6,20})/i,
  ]);

  const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w{2,}/);
  const email = emailMatch ? emailMatch[0] : undefined;

  const addressLine = extractField(text, [
    /(?:adresse|anschrift|wohnort|stra[ßs]e)\s*:?\s*(.+?)(?:\n|$|telefon|tel|email|pflegegrad)/i,
  ]);
  const addressParts = addressLine ? splitAddress(addressLine) : {};

  if (!addressParts.plz) {
    const plzMatch = text.match(/(\d{5})\s+([A-Za-zÄÖÜäöüß-]+)/);
    if (plzMatch) {
      addressParts.plz = plzMatch[1];
      addressParts.stadt = plzMatch[2];
    }
  }
  if (!addressParts.stadt) {
    const stadtField = extractField(text, [/(?:stadt|ort|wohnort)\s*:?\s*([A-Za-zÄÖÜäöüß\s-]+)/i]);
    if (stadtField) addressParts.stadt = stadtField;
  }

  const pflegegrad = extractPflegegrad(text);

  let quelle: string | undefined;
  if (subject) {
    const quelleMatch = subject.match(/(?:von|from|quelle|source)\s*:?\s*(.+)/i);
    quelle = quelleMatch ? quelleMatch[1].trim() : subject;
  }

  return {
    vorname,
    nachname,
    telefon: telefon?.replace(/\s+/g, ""),
    email,
    ...addressParts,
    pflegegrad,
    quelle,
  };
}

export function parseLeadEmail(body: string, subject?: string): ParsedLead {
  if (isPflegehilfeEmail(body)) {
    return parsePflegehilfeEmail(body, subject);
  }
  return parseGenericEmail(body, subject);
}
