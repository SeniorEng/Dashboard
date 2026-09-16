/**
 * Ticket 6hWcjpm3Q4V95Xwp — geteilte Konstante des Deaktivierungs-Guards.
 *
 * Liegt in `shared/`, weil BEIDE Seiten sie brauchen und sie sonst
 * zweimal dastünde: der Server prüft die Mindestlänge
 * (`isValidOverrideReason`), der Client sperrt den Knopf bis sie
 * erreicht ist und schreibt sie ins Label. Eine der beiden Zahlen
 * hochzusetzen und die andere zu vergessen, hieße entweder ein Feld,
 * das der Server nicht annimmt, oder ein Knopf, der zu früh freigibt.
 */
export const DEACTIVATION_OVERRIDE_MIN_LENGTH = 10;
