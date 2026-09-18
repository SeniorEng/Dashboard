import { ZAEHLWEISE, type ZaehlweiseSicht } from "@shared/domain/billing-zaehlweise";

/**
 * Ticket 6hWgVqw2C8442hcG, S-1 (Alrik 18.09.2026) — die vier Ansichten sagen,
 * was sie zählen.
 *
 * ERSETZT die zwei handgeschriebenen `<div>`-Blöcke, die den Hinweis in der
 * Kaskade und in „Noch zu erstellen" einzeln gerendert haben. Mit vier Sichten
 * wären es vier Kopien geworden — und die Frage „steht der Hinweis sichtbar
 * oder im Kleingedruckten?" (Anforderung 3 aus Weg 3) wäre an vier Stellen
 * verschieden beantwortbar gewesen.
 *
 * Der Text kommt aus der SSoT, die Darstellung aus dieser Datei. Beides genau
 * einmal.
 */
export function ZaehlweiseHinweis({
  sicht,
  className = "",
}: {
  sicht: ZaehlweiseSicht;
  className?: string;
}) {
  const hinweis = ZAEHLWEISE[sicht];
  return (
    <div className={`text-xs font-normal leading-snug text-gray-400 ${className}`}>
      <div data-testid={`text-zaehlweise-${sicht}`}>{hinweis.zaehlt}</div>
      {/* Zweite Zeile, nicht zweiter Satz im selben Absatz: der Monatsabschluss
          ist eine andere Frage als die Zählweise. Zusammengezogen läse sich der
          Unterschied zwischen Geld-Sicht und Arbeitsliste wie eine Einschränkung
          derselben Aussage — er ist aber der Grund, warum es beide gibt. */}
      <div data-testid={`text-abschluss-${sicht}`}>{hinweis.nachAbschluss}</div>
    </div>
  );
}
