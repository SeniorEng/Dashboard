import { useState, useMemo } from "react";
import { Layout } from "@/components/layout";
import { Input } from "@/components/ui/input";
import { componentStyles } from "@/design-system";
import {
  Search, ChevronDown, ChevronRight, CalendarPlus, Pencil, Trash2,
  Copy, Repeat, FileText, FileSignature, PenTool,
  HelpCircle
} from "lucide-react";

interface HelpSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  content: React.ReactNode;
}

const helpSections: HelpSection[] = [
  {
    id: "termin-anlegen",
    title: "1. Termin anlegen",
    icon: <CalendarPlus className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So legen Sie einen neuen Kundentermin an:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Tippen Sie auf der Startseite (Terminübersicht) auf den <strong>+ Button</strong> unten rechts oder wählen Sie im Benutzermenü <strong>„+ Termin"</strong>.</li>
          <li>Wählen Sie den Tab <strong>„Kundentermin"</strong> (ist standardmäßig ausgewählt).</li>
          <li>Wählen Sie den <strong>Kunden</strong> aus der Dropdown-Liste. Sie können den Namen eintippen, um zu suchen.</li>
          <li>Falls Sie Admin sind: Wählen Sie den <strong>Mitarbeiter</strong>, der den Termin durchführen soll.</li>
          <li>Wählen Sie das <strong>Datum</strong> über den Kalender. Wochenenden sind gesperrt — wenn Sie ein Wochenende auswählen, erscheint eine Warnung.</li>
          <li>Geben Sie die <strong>Startzeit</strong> ein (z.B. 09:00).</li>
          <li>Fügen Sie mindestens eine <strong>Leistung</strong> hinzu (z.B. „Hauswirtschaft", „Betreuung"). Wählen Sie die Leistung und die geplante Dauer.</li>
          <li>Optional: Fügen Sie <strong>Notizen</strong> hinzu (max. 255 Zeichen).</li>
          <li>Tippen Sie auf <strong>„Kundentermin erstellen"</strong>.</li>
        </ol>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Hinweise:</p>
          <ul className="list-disc list-inside space-y-1 mt-1">
            <li>Die Kostenübersicht zeigt an, ob das Budget des Kunden ausreicht.</li>
            <li>Bei roter Warnung („Budget reicht nicht") kann der Termin nicht erstellt werden.</li>
            <li>Bei gelber Warnung ist das Budget knapp — der Termin kann trotzdem erstellt werden.</li>
            <li>Wenn sich der Termin mit einem bestehenden Termin überschneidet, erhalten Sie eine Warnung.</li>
          </ul>
        </div>

        <p className="font-medium mt-4">Erstberatung anlegen (nur für berechtigte Mitarbeiter):</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Wählen Sie den Tab <strong>„Erstberatung"</strong>.</li>
          <li>Wählen Sie einen vorhandenen Interessenten aus oder geben Sie die Kontaktdaten manuell ein (Vorname, Nachname, Telefon).</li>
          <li>Wählen Sie Datum, Startzeit und Dauer.</li>
          <li>Tippen Sie auf <strong>„Erstberatung erstellen"</strong>.</li>
        </ol>
      </div>
    ),
  },
  {
    id: "termin-bearbeiten",
    title: "2. Termin bearbeiten",
    icon: <Pencil className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So bearbeiten Sie einen bestehenden Termin:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Tippen Sie in der Terminübersicht auf den gewünschten Termin, um die <strong>Detailseite</strong> zu öffnen.</li>
          <li>Tippen Sie auf den <strong>„Bearbeiten"</strong>-Button (Stift-Symbol).</li>
          <li>Ändern Sie die gewünschten Felder: Datum, Uhrzeit, Mitarbeiter, Leistungen oder Notizen.</li>
          <li>Tippen Sie auf <strong>„Änderungen speichern"</strong>.</li>
        </ol>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800">
          <p className="font-medium">Bei Serienterminen:</p>
          <p className="mt-1">Wenn der Termin Teil einer Serie ist, erscheint nach dem Speichern ein Dialog mit drei Optionen:</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li><strong>Nur diesen Termin</strong> — Nur der aktuelle Termin wird geändert.</li>
            <li><strong>Diesen und zukünftige</strong> — Der aktuelle und alle folgenden Termine der Serie werden geändert.</li>
            <li><strong>Alle zukünftigen</strong> — Alle zukünftigen Termine der Serie werden geändert (der aktuelle wird übersprungen).</li>
          </ul>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Wichtig:</p>
          <ul className="list-disc list-inside space-y-1 mt-1">
            <li>Bereits abgeschlossene (dokumentierte) Termine können nicht mehr bearbeitet werden.</li>
            <li>Bei Serienänderungen werden nur zukünftige, nicht-abgeschlossene Termine betroffen.</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    id: "termin-loeschen",
    title: "3. Termin löschen / stornieren",
    icon: <Trash2 className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So löschen oder stornieren Sie einen Termin:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Öffnen Sie die <strong>Termin-Detailseite</strong> durch Tippen auf den Termin.</li>
          <li>Tippen Sie auf den <strong>„Löschen"</strong>-Button (Mülleimer-Symbol, rot).</li>
          <li>Bestätigen Sie die Löschung im Bestätigungsdialog.</li>
        </ol>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800">
          <p className="font-medium">Bei Serienterminen:</p>
          <p className="mt-1">Beim Löschen eines Serientermins erscheint ein Dialog mit folgenden Optionen:</p>
          <ul className="list-disc list-inside space-y-1 mt-2">
            <li><strong>Nur diesen Termin</strong> — Nur der ausgewählte Termin wird storniert.</li>
            <li><strong>Diesen und alle zukünftigen</strong> — Der aktuelle und alle folgenden Termine der Serie werden storniert.</li>
            <li><strong>Alle zukünftigen</strong> — Alle zukünftigen Termine der Serie werden storniert.</li>
          </ul>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Wichtig:</p>
          <ul className="list-disc list-inside space-y-1 mt-1">
            <li>Bereits dokumentierte Termine können nicht gelöscht werden.</li>
            <li>Gelöschte Termine werden als „storniert" markiert und nicht komplett entfernt.</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    id: "termin-kopieren",
    title: "4. Termin kopieren",
    icon: <Copy className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So kopieren Sie einen bestehenden Termin als Vorlage:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Öffnen Sie die <strong>Termin-Detailseite</strong> des Termins, den Sie kopieren möchten.</li>
          <li>Tippen Sie auf den <strong>„Kopieren"</strong>-Button (Kopier-Symbol).</li>
          <li>Sie werden zur Seite „Neuer Termin" weitergeleitet. Die Daten des kopierten Termins sind bereits vorausgefüllt: Kunde, Leistungen und Dauer.</li>
          <li>Passen Sie <strong>Datum</strong> und <strong>Uhrzeit</strong> an.</li>
          <li>Ändern Sie bei Bedarf Leistungen oder Notizen.</li>
          <li>Tippen Sie auf <strong>„Kundentermin erstellen"</strong>.</li>
        </ol>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800">
          <p className="font-medium">Tipp:</p>
          <p className="mt-1">Die Kopierfunktion ist besonders praktisch, wenn Sie regelmäßig ähnliche Termine für denselben Kunden anlegen möchten, ohne jedes Mal alle Leistungen neu auswählen zu müssen.</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Hinweis:</p>
          <p className="mt-1">Beim Kopieren wird kein Serientermin erstellt. Wenn Sie regelmäßige Termine brauchen, nutzen Sie stattdessen die Serientermin-Funktion (siehe Abschnitt 5).</p>
        </div>
      </div>
    ),
  },
  {
    id: "serientermin",
    title: "5. Serientermin erstellen",
    icon: <Repeat className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So erstellen Sie eine Terminserie:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Beginnen Sie wie gewohnt mit <strong>„Neuer Termin"</strong> und füllen Sie Kunde, Datum, Uhrzeit und Leistungen aus.</li>
          <li>Aktivieren Sie den Schalter <strong>„Serientermin"</strong> im unteren Bereich des Formulars.</li>
          <li>Wählen Sie die gewünschten <strong>Wochentage</strong> aus (z.B. Montag, Mittwoch, Freitag).</li>
          <li>Wählen Sie die <strong>Häufigkeit</strong>:
            <ul className="list-disc list-inside ml-4 mt-1">
              <li><strong>Wöchentlich</strong> — Jede Woche an den gewählten Tagen.</li>
              <li><strong>Alle 2 Wochen</strong> — Jede zweite Woche an den gewählten Tagen.</li>
            </ul>
          </li>
          <li>Wählen Sie das <strong>Enddatum</strong> der Serie (maximal 12 Monate in die Zukunft).</li>
          <li>Prüfen Sie die <strong>Vorschau</strong>: Sie zeigt, wie viele Termine erstellt werden und an welchen Daten.</li>
          <li>Tippen Sie auf <strong>„Terminserie erstellen"</strong>.</li>
        </ol>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800">
          <p className="font-medium">Vorschau prüfen:</p>
          <p className="mt-1">In der Vorschau sehen Sie alle geplanten Termine mit Datum. Prüfen Sie, ob Feiertage oder andere Konflikte vorliegen, bevor Sie die Serie erstellen.</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Hinweise:</p>
          <ul className="list-disc list-inside space-y-1 mt-1">
            <li>Jeder Termin der Serie kann einzeln bearbeitet oder storniert werden.</li>
            <li>Änderungen an der Serie können auf „nur diesen", „diesen und zukünftige" oder „alle zukünftigen" angewendet werden.</li>
            <li>Die Kopierfunktion ist für Serientermine nicht verfügbar.</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    id: "termin-dokumentieren",
    title: "6. Termin dokumentieren",
    icon: <FileText className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So dokumentieren Sie einen durchgeführten Termin:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Öffnen Sie die <strong>Termin-Detailseite</strong> des Termins, den Sie dokumentieren möchten.</li>
          <li>Tippen Sie auf den <strong>„Dokumentieren"</strong>-Button.</li>
          <li><strong>Schritt 1 — Leistungen:</strong>
            <ul className="list-disc list-inside ml-4 mt-1">
              <li>Für jede geplante Leistung: Geben Sie die <strong>tatsächliche Dauer</strong> in Minuten ein.</li>
              <li>Optional: Fügen Sie <strong>Details</strong> hinzu (z.B. was konkret gemacht wurde).</li>
              <li>Falls eine zusätzliche Leistung erbracht wurde, tippen Sie auf <strong>„+ Leistung hinzufügen"</strong>.</li>
              <li>Falls ein anderer Mitarbeiter den Termin durchgeführt hat (Vertretung), wählen Sie diesen unter <strong>„Durchgeführt von"</strong> aus.</li>
            </ul>
          </li>
          <li>Tippen Sie auf <strong>„Weiter"</strong>.</li>
          <li><strong>Schritt 2 — Fahrt & Abschluss:</strong>
            <ul className="list-disc list-inside ml-4 mt-1">
              <li>Geben Sie die <strong>tatsächliche Startzeit</strong> und <strong>Endzeit</strong> ein.</li>
              <li>Wählen Sie den <strong>Startpunkt der Fahrt</strong> (von zu Hause oder vom vorherigen Kunden).</li>
              <li>Geben Sie die <strong>Anfahrtskilometer</strong> ein.</li>
              <li>Optional: Geben Sie <strong>Kilometer mit/für den Kunden</strong> ein (z.B. Begleitfahrten).</li>
            </ul>
          </li>
          <li>Tippen Sie auf <strong>„Dokumentation abschließen"</strong>.</li>
        </ol>

        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-800">
          <p className="font-medium">Nach der Dokumentation:</p>
          <p className="mt-1">Der Termin erhält den Status „dokumentiert" und kann in einen Leistungsnachweis aufgenommen werden.</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Korrektur:</p>
          <p className="mt-1">Wenn ein bereits dokumentierter Termin korrigiert werden muss, kann ein Admin die Dokumentation über den Button „Korrektur öffnen" auf der Termin-Detailseite erneut zur Bearbeitung freigeben.</p>
        </div>
      </div>
    ),
  },
  {
    id: "leistungsnachweis-monatlich",
    title: "7. Leistungsnachweis erstellen (monatlich)",
    icon: <FileSignature className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So erstellen Sie einen monatlichen Leistungsnachweis:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Navigieren Sie über das Hauptmenü zu <strong>„Nachweise"</strong>.</li>
          <li>Wählen Sie oben das gewünschte <strong>Jahr</strong> und den <strong>Monat</strong> aus.</li>
          <li>Sie sehen eine Übersicht aller Kunden mit Terminen in diesem Monat:
            <ul className="list-disc list-inside ml-4 mt-1">
              <li><strong>Rot</strong> markierte Kunden haben noch offene (nicht dokumentierte) Termine.</li>
              <li><strong>Grün</strong> markierte Kunden haben alle Termine dokumentiert und sind bereit für den Leistungsnachweis.</li>
            </ul>
          </li>
          <li>Tippen Sie auf einen Kunden, um die Detail-Ansicht zu öffnen.</li>
          <li>Wenn alle Termine dokumentiert sind, erscheint der Button <strong>„Monatlichen Leistungsnachweis erstellen"</strong>.</li>
          <li>Tippen Sie auf den Button. Der Leistungsnachweis wird erstellt und fasst alle dokumentierten Termine des Monats zusammen.</li>
        </ol>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Voraussetzung:</p>
          <p className="mt-1">Alle Termine des Kunden im gewählten Monat müssen dokumentiert sein, bevor ein monatlicher Leistungsnachweis erstellt werden kann. Offene Termine werden angezeigt — tippen Sie auf „Offene Termine anzeigen", um diese zu dokumentieren.</p>
        </div>
      </div>
    ),
  },
  {
    id: "leistungsnachweis-einzeln",
    title: "8. Leistungsnachweis erstellen (einzeln)",
    icon: <FileText className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So erstellen Sie einen Leistungsnachweis für einen einzelnen Termin:</p>
        <ol className="list-decimal list-inside space-y-2 ml-2">
          <li>Öffnen Sie die <strong>Termin-Detailseite</strong> eines bereits dokumentierten Termins (Status „dokumentiert").</li>
          <li>Im Bereich <strong>„Leistungsnachweis"</strong> unten auf der Seite sehen Sie den aktuellen Status.</li>
          <li>Wenn noch kein Leistungsnachweis existiert, erscheint der Button <strong>„Einzeltermin-Leistungsnachweis erstellen"</strong>.</li>
          <li>Tippen Sie auf den Button. Der Leistungsnachweis wird nur für diesen einen Termin erstellt.</li>
        </ol>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800">
          <p className="font-medium">Unterschied zum monatlichen Nachweis:</p>
          <ul className="list-disc list-inside space-y-1 mt-1">
            <li>Der <strong>Einzeltermin-LN</strong> enthält nur einen einzigen Termin.</li>
            <li>Der <strong>monatliche LN</strong> fasst alle dokumentierten Termine eines Monats zusammen.</li>
            <li>Termine, die bereits in einem Einzeltermin-LN enthalten sind, werden im monatlichen LN nicht erneut aufgenommen.</li>
          </ul>
        </div>
      </div>
    ),
  },
  {
    id: "leistungsnachweis-unterschreiben",
    title: "9. Leistungsnachweis unterschreiben",
    icon: <PenTool className="h-5 w-5" />,
    content: (
      <div className="space-y-4 text-sm leading-relaxed">
        <p className="font-medium">So unterschreiben Sie einen Leistungsnachweis:</p>

        <div className="border rounded-lg p-4 space-y-3">
          <p className="font-semibold">Schritt 1: Mitarbeiter unterschreibt</p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li>Öffnen Sie den Leistungsnachweis über <strong>„Nachweise"</strong> im Hauptmenü oder über die Termin-Detailseite.</li>
            <li>Scrollen Sie zum Bereich <strong>„Unterschriften"</strong>.</li>
            <li>Tippen Sie auf <strong>„Unterschreiben"</strong> im Bereich „Mitarbeiter".</li>
            <li>Unterschreiben Sie mit dem Finger oder Stift auf dem Zeichenfeld.</li>
            <li>Tippen Sie auf <strong>„Speichern"</strong>.</li>
          </ol>
        </div>

        <div className="border rounded-lg p-4 space-y-3">
          <p className="font-semibold">Schritt 2: Kunde unterschreibt</p>
          <ol className="list-decimal list-inside space-y-2 ml-2">
            <li>Nachdem der Mitarbeiter unterschrieben hat, wird der Button <strong>„Unterschreiben"</strong> im Bereich „Kunde" aktiv.</li>
            <li>Geben Sie das Gerät dem Kunden.</li>
            <li>Der Kunde unterschreibt mit dem Finger oder Stift auf dem Zeichenfeld.</li>
            <li>Tippen Sie auf <strong>„Speichern"</strong>.</li>
          </ol>
        </div>

        <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-green-800">
          <p className="font-medium">Abgeschlossen:</p>
          <p className="mt-1">Nach beiden Unterschriften ist der Leistungsnachweis abgeschlossen und kann nicht mehr geändert werden. Eine grüne Bestätigung „Leistungsnachweis vollständig abgeschlossen" wird angezeigt.</p>
        </div>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800">
          <p className="font-medium">Reihenfolge beachten:</p>
          <p className="mt-1">Der Mitarbeiter muss immer zuerst unterschreiben. Erst dann wird die Kundenunterschrift freigeschaltet. Diese Reihenfolge kann nicht übersprungen werden.</p>
        </div>

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-800">
          <p className="font-medium">Offene Leistungsnachweise:</p>
          <p className="mt-1">Auf der Nachweise-Seite wird oben ein Banner angezeigt, wenn Leistungsnachweise noch Unterschriften benötigen. Tippen Sie darauf, um direkt zum betroffenen Nachweis zu gelangen.</p>
        </div>
      </div>
    ),
  },
];

export default function HelpPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());

  const toggleSection = (id: string) => {
    setOpenSections((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const expandAll = () => {
    setOpenSections(new Set(helpSections.map((s) => s.id)));
  };

  const collapseAll = () => {
    setOpenSections(new Set());
  };

  const filteredSections = useMemo(() => {
    if (!searchTerm.trim()) return helpSections;
    const term = searchTerm.toLowerCase();
    return helpSections.filter(
      (section) =>
        section.title.toLowerCase().includes(term) ||
        getTextContent(section.content).toLowerCase().includes(term)
    );
  }, [searchTerm]);

  const scrollToSection = (id: string) => {
    setOpenSections((prev) => new Set(prev).add(id));
    setTimeout(() => {
      document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 100);
  };

  return (
    <Layout>
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <HelpCircle className="h-7 w-7 text-primary" />
          <h1 className={componentStyles.pageTitle} data-testid="text-help-title">
            Mitarbeiter-Handbuch
          </h1>
        </div>
        <p className="text-muted-foreground text-sm">
          Schritt-für-Schritt-Anleitungen für die wichtigsten Funktionen der App.
        </p>
      </div>

      <div className="mb-6">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Anleitung durchsuchen..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-9"
            data-testid="input-help-search"
          />
        </div>
      </div>

      {!searchTerm.trim() && (
        <div className="mb-6 p-4 bg-muted/50 rounded-lg border" data-testid="panel-toc">
          <h2 className="text-sm font-semibold mb-3">Inhaltsverzeichnis</h2>
          <nav className="space-y-1.5">
            {helpSections.map((section) => (
              <button
                key={section.id}
                onClick={() => scrollToSection(section.id)}
                className="block w-full text-left text-sm text-primary hover:underline py-0.5"
                data-testid={`toc-link-${section.id}`}
              >
                {section.title}
              </button>
            ))}
          </nav>
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button
          onClick={expandAll}
          className="text-xs text-primary hover:underline"
          data-testid="button-expand-all"
        >
          Alle öffnen
        </button>
        <span className="text-xs text-muted-foreground">|</span>
        <button
          onClick={collapseAll}
          className="text-xs text-primary hover:underline"
          data-testid="button-collapse-all"
        >
          Alle schließen
        </button>
      </div>

      {filteredSections.length === 0 && (
        <div className="text-center py-10 text-muted-foreground" data-testid="text-no-results">
          <Search className="h-8 w-8 mx-auto mb-3 opacity-40" />
          <p>Keine Ergebnisse für „{searchTerm}"</p>
        </div>
      )}

      <div className="space-y-3">
        {filteredSections.map((section) => {
          const isOpen = openSections.has(section.id);
          return (
            <div
              key={section.id}
              id={`section-${section.id}`}
              className="border rounded-lg overflow-hidden"
              data-testid={`section-${section.id}`}
            >
              <button
                onClick={() => toggleSection(section.id)}
                className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/50 transition-colors"
                data-testid={`button-toggle-${section.id}`}
              >
                <span className="text-primary">{section.icon}</span>
                <span className="flex-1 font-medium">{section.title}</span>
                {isOpen ? (
                  <ChevronDown className="h-5 w-5 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-5 w-5 text-muted-foreground" />
                )}
              </button>
              {isOpen && (
                <div className="px-4 pb-4 pt-0 border-t">
                  <div className="pt-4">{section.content}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Layout>
  );
}

function getTextContent(node: React.ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (!node) return "";
  if (Array.isArray(node)) return node.map(getTextContent).join(" ");
  if (typeof node === "object" && "props" in node) {
    const props = (node as React.ReactElement).props as { children?: React.ReactNode };
    return getTextContent(props.children);
  }
  return "";
}
