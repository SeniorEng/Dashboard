interface ParsedLead {
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

export function parseLeadEmail(body: string, subject?: string): ParsedLead {
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

  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w{2,}/);
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
