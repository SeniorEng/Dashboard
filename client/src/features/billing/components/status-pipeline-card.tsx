import { Fragment } from "react";
import { Loader2, GitBranch } from "lucide-react";
import { iconSize } from "@/design-system";
import type { BillingPipelineResponse } from "@shared/api";
import type { PipelineStage } from "@shared/domain/billing-pipeline";
import { PIPELINE_CASCADE_ORDER } from "@shared/domain/billing-pipeline";
import { ZAEHLWEISE_UMSATZ_KACHEL } from "@shared/domain/billing-zaehlweise";
import type { BillingTermineStage } from "@shared/api";
import { formatAmount } from "../utils";
import { MONTH_NAMES } from "../constants";
import { CollapsibleCard } from "./collapsible-card";

// Status-Filter der Termine-/Pipeline-Sicht (geteilt mit der Termine-Liste).
export type BillingStatusFilter = "alle" | BillingTermineStage;

export interface PipelineStageSelection {
  tab: "termine" | "rechnungen";
  status: BillingStatusFilter;
}

interface StatusPipelineCardProps {
  pipeline: BillingPipelineResponse | undefined;
  isLoading: boolean;
  selectedMonth: number;
  selectedYear: number;
  activeStatus: BillingStatusFilter;
  onStageSelect: (selection: PipelineStageSelection) => void;
}

// Frühe Stufen (vor Rechnung) → Termine-Tab; späte Stufen → Rechnungen-Tab.
const TERMINE_STAGES: PipelineStage[] = ["offen", "dokumentiert", "unterschrieben"];
// `avis_erhalten` ist als Stufe entfallen: der Avis ist eine
// Zuordnungs-Mechanik, kein Zustand. Bis zur Zahlung steht `versendet`.
const RECHNUNGEN_STAGES: PipelineStage[] = [
  "rechnung_erstellt",
  "versendet",
  "bezahlt",
];

// Pipeline-Stufe → geteilter Status-Filter. „unterschrieben" heißt in der
// Termine-Liste „nachgewiesen" (Leistungsnachweis), sonst identisch.
function stageToStatus(stage: PipelineStage): BillingTermineStage {
  return stage === "unterschrieben" ? "nachgewiesen" : (stage as BillingTermineStage);
}

function selectionForStage(stage: PipelineStage): PipelineStageSelection {
  return {
    tab: TERMINE_STAGES.includes(stage) ? "termine" : "rechnungen",
    status: stageToStatus(stage),
  };
}

export function StatusPipelineCard({
  pipeline,
  isLoading,
  selectedMonth,
  selectedYear,
  activeStatus,
  onStageSelect,
}: StatusPipelineCardProps) {
  const stageByKey = new Map(
    (pipeline?.stages ?? []).map((s) => [s.stage, s] as const),
  );

  /**
   * „19 Rechnungen" vs. „61 Termine" — die Kaskade mischt beide Seiten der
   * Hybrid-Kante, und ohne die Einheit läse sich eine Zahl wie die andere.
   */
  const einheitFuer = (stage: PipelineStage, n: number): string => {
    const istRechnung = RECHNUNGEN_STAGES.includes(stage);
    if (istRechnung) return n === 1 ? "Rechnung" : "Rechnungen";
    return n === 1 ? "Termin" : "Termine";
  };

  /**
   * „Leistungsnachweis fehlt" gehört in die Kaskade, nicht zu den Verlusten.
   *
   * Der Zustand zählt über `EXPECTED_REVENUE_SIDE_STATES` bereits zum
   * erwarteten Umsatz — er steckt also in der Schlagzeile. Ließe man ihn
   * unten bei den Badges, summierten sich die sichtbaren Stufen NICHT auf die
   * Schlagzeile, und der Selbsttest oben wäre eine Lüge.
   *
   * Er steht als eigene Zeile und nicht in „Nachweis zu erstellen", weil er
   * eine ANDERE Handlung auslöst: dort muss ein Nachweis entstehen, hier fehlt
   * nur noch die Kundenunterschrift auf einem vorhandenen.
   */
  const renderWartetAufUnterschrift = () => {
    const side = (pipeline?.sides ?? []).find(
      (x) => x.state === "wartet_auf_kundenunterschrift",
    );
    if (!side || side.itemCount === 0) return null;
    // Dasselbe Segment-Format wie die Stufen — er steht in der Leiste an der
    // Stelle, an der er fachlich sitzt: der Nachweis ist da, die Unterschrift
    // fehlt, also zwischen „Nachweis zu erstellen" und „abrechnungsreif".
    return (
      <div
        className="flex min-w-[7.5rem] flex-1 flex-col gap-0.5 rounded-md border border-transparent bg-gray-50 px-2.5 py-2"
        data-testid="pipeline-stage-wartet_auf_kundenunterschrift"
      >
        <span className="truncate text-xs text-gray-500" title={side.label}>
          {side.label}
        </span>
        <span className="text-sm font-semibold tabular-nums text-gray-900">
          {formatAmount(side.totalCents)}
        </span>
        <span className="text-xs text-gray-400">
          {side.itemCount} {side.itemCount === 1 ? "Termin" : "Termine"}
        </span>
      </div>
    );
  };

  /**
   * Die Summe der Zeilen, die tatsächlich auf dem Bildschirm stehen — Grundlage
   * des Selbsttests weiter unten. Bewusst aus denselben Quellen gelesen, aus
   * denen `renderStage` und `renderWartetAufUnterschrift` ihre Beträge nehmen:
   * eine Prüfung gegen die Schlagzeile ist nur dann eine, wenn die beiden Seiten
   * unabhängig entstanden sind.
   */
  const sichtbareSummeCents =
    PIPELINE_CASCADE_ORDER.reduce(
      (n, stage) => n + (stageByKey.get(stage)?.totalCents ?? 0),
      0,
    ) +
    // Spiegelt die Abbruchbedingung von `renderWartetAufUnterschrift` mit:
    // eine Zeile, die nicht gerendert wird, darf auch nicht mitsummiert werden,
    // sonst prüfte der Selbsttest etwas anderes als das Sichtbare.
    (((s) => (s && s.itemCount > 0 ? s.totalCents : 0))(
      (pipeline?.sides ?? []).find((x) => x.state === "wartet_auf_kundenunterschrift"),
    ));

  /**
   * Die drei Verlust-Arten in einer Liste — Beträge aus zwei verschiedenen
   * Quellen, weil `cancelled` kein Side-Zustand ist, sondern `excluded`.
   */
  const verlustZeilen: Array<{
    key: string;
    label: string;
    cents: number;
    count: number | null;
    lohnHinweis: string;
  }> = [];
  if (pipeline) {
    if (pipeline.totals.cancelledCents > 0) {
      verlustZeilen.push({
        key: "abgesagt",
        label: "abgesagt",
        cents: pipeline.totals.cancelledCents,
        // `excluded`-Einheiten tragen keine Fall-Zählung durch den Vertrag;
        // die Zahl hier zu erfinden wäre schlimmer als sie wegzulassen.
        count: null,
        lohnHinweis: "kein Lohn",
      });
    }
    for (const side of pipeline.sides) {
      if (side.itemCount === 0) continue;
      if (side.state === "kunde_nicht_angetroffen") {
        verlustZeilen.push({
          key: side.state,
          label: side.label,
          cents: side.totalCents,
          count: side.itemCount,
          lohnHinweis: "Lohn fällt an",
        });
      } else if (side.state === "nicht_abgerechnet") {
        verlustZeilen.push({
          key: side.state,
          label: side.label,
          cents: side.totalCents,
          count: side.itemCount,
          // „kein Lohn", NICHT „Lohn fällt an" — das stand hier zuerst und war
          // für JEDEN Termin falsch, den Weg A in diese Zeile bringt.
          //
          // `deriveAppointmentDisplayStatus` erzeugt `expired_unsigned`
          // ausschliesslich für NICHT-dokumentierte Termine, und die Lohn-SSoT
          // (`payroll-hours.ts`) rechnet über `documentedSqlRaw` = `completed`.
          // Die Menge, die hier landet, ist also genau die, für die kein Lohn
          // anfällt.
          //
          // Folgenlos war das nur, solange die Zeile nie erschien: vor Weg A
          // hatte `expired_unsigned` keinen Produzenten. Sie erscheint jetzt
          // zum ersten Mal — und wäre zu 100 % mit Fällen gefüllt gewesen, für
          // die ihr Hinweis nicht stimmt.
          lohnHinweis: "kein Lohn",
        });
      }
    }
  }

  /**
   * Eine Stufe als SEGMENT einer waagerechten Leiste.
   *
   * ERSETZT die senkrechte Zeile (Beschriftung links, Betrag rechts). Alriks
   * Vorgabe nach dem Prod-Gang: kompakter, und die Leserichtung soll die
   * Bewegung tragen — links „noch geplant", rechts „bezahlt". Die Beträge
   * wandern im Monatsverlauf nach rechts; das muss man dann nicht erklären.
   *
   * Der Betrag steht groß, Beschriftung und Anzahl klein darüber und darunter:
   * waagerecht ist die ZAHL das, was man vergleicht, nicht die Zeile.
   */
  const renderStage = (stage: PipelineStage) => {
    const group = stageByKey.get(stage);
    if (!group) return null;
    const isActive = activeStatus === stageToStatus(stage);
    return (
      <button
        key={stage}
        type="button"
        onClick={() => onStageSelect(selectionForStage(stage))}
        className={`flex min-w-[7.5rem] flex-1 flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors ${
          isActive
            ? "border-teal-400 bg-teal-50"
            : "border-transparent bg-gray-50 hover:bg-gray-100"
        }`}
        data-testid={`pipeline-stage-${stage}`}
      >
        <span className="truncate text-xs text-gray-500" title={group.label}>
          {group.label}
        </span>
        <span
          className={`text-sm font-semibold tabular-nums ${
            group.totalCents < 0 ? "text-rose-700" : "text-gray-900"
          }`}
          data-testid={`pipeline-stage-sum-${stage}`}
        >
          {formatAmount(group.totalCents)}
        </span>
        {/* `itemCount`, NICHT `caseCount`. `caseCount` zählt distinkte FÄLLE —
            auf den frühen Stufen also Kunden, nicht Termine (`pipeline-reader`
            sammelt dort `cust-<id>`). Solange die Zahl ohne Einheit dastand,
            war sie bloß vage; mit „Termine" daneben wird sie falsch: 61 offene
            Termine bei 12 Kunden läsen sich als „12 Termine". */}
        <span className="text-xs text-gray-400">
          {group.itemCount} {einheitFuer(stage, group.itemCount)}
        </span>
        {group.overdueCount > 0 && (
          <span className="text-xs text-rose-700" data-testid={`pipeline-stage-overdue-${stage}`}>
            {group.overdueCount} überfällig
          </span>
        )}
      </button>
    );
  };

  return (
    <CollapsibleCard
      storageKey="pipeline"
      testId="card-billing-pipeline"
      toggleTestId="button-toggle-pipeline"
      icon={<GitBranch className={`${iconSize.md} text-teal-600`} />}
      title={`${MONTH_NAMES[selectedMonth - 1]} ${selectedYear}`}
      headerRight={
        <div className="text-right">
          {/* „(netto)" ist kein Beiwerk, sondern die Basis: die Kaskade rechnet
              durchgehend mit `netAmountCents`, die Zeile „davon eingegangen"
              unten ist auf dieselbe Basis gebracht. Ohne den Zusatz läse man
              eine Netto-Summe als Kontoeingang und wunderte sich bei
              Selbstzahlern über 19 %.

              Der frühere Zusatz war „(Leistungen)" — gemeint als „ohne km".
              Das stimmt nur für die drei TERMIN-Stufen (`unit_type = 'hours'`,
              `pipeline-reader`); sobald abgerechnet ist, trägt die Stufe den
              vollen Rechnungs-Netto INKLUSIVE km-Positionen. Die Kaskade
              wächst beim Übergang `abrechnungsreif → gestellt` also um die km,
              ohne dass jemand mehr verdient hätte. Das ist Altbestand aus
              #1405 und hier NICHT repariert — aber die Kachel darf das
              Gegenteil nicht behaupten (FINDING im PR). */}
          <div className="text-xs text-gray-500">Erwarteter Kontoeingang (netto)</div>
          <div
            className="text-lg font-semibold tabular-nums text-gray-900"
            data-testid="text-pipeline-grand-total"
          >
            {isLoading || !pipeline
              ? "—"
              : formatAmount(pipeline.totals.expectedRevenueTotalCents)}
          </div>
          {/* Weg 3 (Alrik, 17.09.2026): sichtbar machen statt angleichen.
              Der Hinweis steht DORT, wo die Zahl steht — der Moment, in dem
              jemand sie mit der Rechnungsliste vergleicht, ist genau dieser. */}
          <div className="text-xs text-gray-400" data-testid="text-pipeline-zaehlweise">
            {ZAEHLWEISE_UMSATZ_KACHEL}
          </div>
          {!isLoading && pipeline && (
            <div className="text-xs text-gray-500" data-testid="text-pipeline-received">
              davon bereits eingegangen{" "}
              <span className="font-medium tabular-nums text-gray-700">
                {formatAmount(pipeline.totals.receivedCents)}
              </span>
            </div>
          )}
        </div>
      }
    >
      <>
        {isLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500">
            <Loader2 className={`${iconSize.sm} animate-spin text-teal-600`} />
            Pipeline wird geladen …
          </div>
        ) : pipeline ? (
          <div className="mt-3 space-y-3">
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Wo das Geld gerade steht
                </span>
                {/* Der Selbsttest der Darstellung — und zwar einer, der
                    fehlschlagen KANN.

                    Die erste Fassung druckte hier `expectedRevenueTotalCents`,
                    also denselben Wert wie die Schlagzeile darüber. Das sah aus
                    wie eine Prüfung und war keine: die Zahl konnte per
                    Konstruktion nie widersprechen.

                    Der Punkt ist, dass die beiden Seiten aus ZWEI unabhängigen
                    Aggregationen stammen — die Zeilen aus `stages`/`sides`, die
                    Schlagzeile aus `summarizePipelineCents`. Genau deshalb kann
                    ein Auseinanderdriften überhaupt passieren, und genau deshalb
                    muss hier die Summe der GERENDERTEN Zeilen stehen. */}
                <span
                  className={`text-xs tabular-nums ${
                    sichtbareSummeCents === pipeline.totals.expectedRevenueTotalCents
                      ? "text-gray-400"
                      : "font-semibold text-rose-700"
                  }`}
                  data-testid="text-pipeline-selbsttest"
                >
                  {sichtbareSummeCents === pipeline.totals.expectedRevenueTotalCents
                    ? `Summe = ${formatAmount(sichtbareSummeCents)}`
                    : `Summe ${formatAmount(sichtbareSummeCents)} ≠ ${formatAmount(
                        pipeline.totals.expectedRevenueTotalCents,
                      )}`}
                </span>
              </div>
              {/* WAAGERECHT statt senkrecht (Alrik, 17.09.2026). `overflow-x-auto`
                  ist Absicht: auf einem schmalen Fenster scrollt die Leiste in
                  sich, statt die Seite zu sprengen oder umzubrechen — eine
                  umgebrochene Kaskade waere keine Leserichtung mehr.

                  „wartet auf Unterschrift" steht an seiner fachlichen Stelle:
                  der Nachweis ist da, es fehlt die Unterschrift. */}
              <div className="flex gap-1.5 overflow-x-auto pb-1">
                {PIPELINE_CASCADE_ORDER.map((stage) => (
                  <Fragment key={stage}>
                    {renderStage(stage)}
                    {stage === "dokumentiert" && renderWartetAufUnterschrift()}
                  </Fragment>
                ))}
              </div>
              <div className="mt-1 flex justify-between text-xs uppercase tracking-wide text-gray-500">
                <span>← unsicher</span>
                <span>auf dem Konto →</span>
              </div>
            </div>

            {/* „abgesagt / nicht erbracht" — NEBEN der Summe, nicht davon
                abgezogen.

                Das ist der Kern der Kaskaden-Entscheidung: diese € waren NIE
                Teil des erwarteten Kontoeingangs (`assignAppointmentStage`
                gibt `cancelled` als `excluded` zurück, die beiden anderen als
                Side-Zustände ausserhalb von `EXPECTED_REVENUE_SIDE_STATES`).
                Ein Abzug würde sie ein zweites Mal entfernen.

                `wartet_auf_kundenunterschrift` gehört ausdrücklich NICHT
                hierher — es ist erwarteter Umsatz und steht oben in der
                Kaskade. Die Storno-Zustände der Rechnungsseite ebenfalls
                nicht: sie tragen keine Forderung. */}
            {verlustZeilen.length > 0 && (
              <div className="border-t border-gray-100 pt-3">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400">
                  Abgesagt / nicht erbracht
                  <span className="ml-2 font-normal normal-case tracking-normal text-gray-400">
                    nicht oben enthalten
                  </span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {verlustZeilen.map((z) => (
                    <div
                      key={z.key}
                      className="flex items-baseline gap-3 px-3 py-1"
                      data-testid={`pipeline-verlust-${z.key}`}
                    >
                      <span className="w-44 shrink-0 truncate text-xs text-gray-600">
                        {z.label}
                      </span>
                      <span className="w-28 shrink-0 text-right text-sm font-medium tabular-nums text-gray-700">
                        {formatAmount(z.cents)}
                      </span>
                      {z.count != null && (
                        <span className="text-xs text-gray-400">
                          {z.count} {z.count === 1 ? "Termin" : "Termine"}
                        </span>
                      )}
                      {/* Storno kostet den freien Termin, ein nicht
                          angetroffener Kunde kostet zusätzlich den Lohn. Bei
                          9,50 € gegen 1.881 € ist das heute gleichgültig — in
                          einem Monat mit vielen No-Shows ist es die teurere
                          Zeile, und dann darf die Kachel sie nicht als
                          dasselbe zeigen. */}
                      <span className="text-xs text-gray-400">{z.lohnHinweis}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="py-4 text-sm text-gray-500" data-testid="text-pipeline-empty">
            Keine Pipeline-Daten verfügbar.
          </div>
        )}
      </>
    </CollapsibleCard>
  );
}
