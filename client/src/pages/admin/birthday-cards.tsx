import { useState, useMemo } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, Loader2, Gift, Check, Cake } from "lucide-react";
import { iconSize, componentStyles } from "@/design-system";
import { api, unwrapResult } from "@/lib/api/client";
import { useToast } from "@/hooks/use-toast";
import type { BirthdayEntry } from "@shared/types";

interface CardRecord {
  id: number;
  personType: string;
  personId: number;
  year: number;
  sent: boolean;
  sentAt: string | null;
  notes: string | null;
}

function getBirthdayYear(entry: BirthdayEntry): number {
  const today = new Date();
  const nextBirthday = new Date(today);
  nextBirthday.setDate(today.getDate() + entry.daysUntil);
  return nextBirthday.getFullYear();
}

export default function AdminBirthdayCards() {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);
  const [filter, setFilter] = useState<"all" | "pending" | "sent">("all");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: birthdays = [], isLoading: loadingBirthdays } = useQuery<BirthdayEntry[]>({
    queryKey: ["birthdays", 365],
    queryFn: async () => {
      const result = await api.get<BirthdayEntry[]>("/birthdays?days=365");
      return unwrapResult(result);
    },
  });

  const { data: cardRecordsCurrent = [], isLoading: loadingCards1 } = useQuery<CardRecord[]>({
    queryKey: ["birthday-cards", currentYear],
    queryFn: async () => {
      const result = await api.get<CardRecord[]>(`/birthday-cards?year=${currentYear}`);
      return unwrapResult(result);
    },
  });

  const { data: cardRecordsNext = [], isLoading: loadingCards2 } = useQuery<CardRecord[]>({
    queryKey: ["birthday-cards", currentYear + 1],
    queryFn: async () => {
      const result = await api.get<CardRecord[]>(`/birthday-cards?year=${currentYear + 1}`);
      return unwrapResult(result);
    },
    enabled: selectedYear === currentYear,
  });

  const { data: cardRecordsSelected = [], isLoading: loadingCards3 } = useQuery<CardRecord[]>({
    queryKey: ["birthday-cards", selectedYear],
    queryFn: async () => {
      const result = await api.get<CardRecord[]>(`/birthday-cards?year=${selectedYear}`);
      return unwrapResult(result);
    },
    enabled: selectedYear !== currentYear && selectedYear !== currentYear + 1,
  });

  const toggleMutation = useMutation({
    mutationFn: async (data: { personType: string; personId: number; year: number; sent: boolean }) => {
      const result = await api.post("/birthday-cards/toggle", data);
      return unwrapResult(result);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["birthday-cards"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Fehler",
        description: error.message || "Ein Fehler ist aufgetreten",
        variant: "destructive",
      });
    },
  });

  const cardStatusMap = useMemo(() => {
    const map = new Map<string, CardRecord>();
    const allRecords = [...cardRecordsCurrent, ...cardRecordsNext, ...cardRecordsSelected];
    for (const r of allRecords) {
      map.set(`${r.personType}_${r.personId}_${r.year}`, r);
    }
    return map;
  }, [cardRecordsCurrent, cardRecordsNext, cardRecordsSelected]);

  const enrichedBirthdays = useMemo(() => {
    return birthdays.map(b => {
      const birthdayYear = getBirthdayYear(b);
      const record = cardStatusMap.get(`${b.type}_${b.id}_${birthdayYear}`);
      return {
        ...b,
        birthdayYear,
        cardSent: record?.sent ?? false,
        cardSentAt: record?.sentAt ?? null,
      };
    })
    .filter(b => b.birthdayYear === selectedYear)
    .sort((a, b) => a.daysUntil - b.daysUntil);
  }, [birthdays, cardStatusMap, selectedYear]);

  const filteredBirthdays = useMemo(() => {
    if (filter === "pending") return enrichedBirthdays.filter(b => !b.cardSent);
    if (filter === "sent") return enrichedBirthdays.filter(b => b.cardSent);
    return enrichedBirthdays;
  }, [enrichedBirthdays, filter]);

  const stats = useMemo(() => {
    const total = enrichedBirthdays.length;
    const sent = enrichedBirthdays.filter(b => b.cardSent).length;
    const upcoming = enrichedBirthdays.filter(b => b.daysUntil <= 30).length;
    const urgent = enrichedBirthdays.filter(b => b.daysUntil <= 7 && !b.cardSent).length;
    return { total, sent, pending: total - sent, upcoming, urgent };
  }, [enrichedBirthdays]);

  const isLoading = loadingBirthdays || loadingCards1 || loadingCards2 || loadingCards3;

  function handleToggle(entry: BirthdayEntry & { cardSent: boolean; birthdayYear: number }) {
    toggleMutation.mutate({
      personType: entry.type,
      personId: entry.id,
      year: entry.birthdayYear,
      sent: !entry.cardSent,
    });
  }

  function formatDate(dateStr: string) {
    const [y, m, d] = dateStr.split("-");
    return `${d}.${m}.${y}`;
  }

  function getDaysLabel(days: number) {
    if (days === 0) return "Heute";
    if (days === 1) return "Morgen";
    return `in ${days} Tagen`;
  }

  function getDaysColor(days: number, cardSent: boolean) {
    if (cardSent) return "text-green-600";
    if (days <= 3) return "text-red-600 font-semibold";
    if (days <= 7) return "text-orange-600 font-medium";
    if (days <= 14) return "text-amber-600";
    return "text-muted-foreground";
  }

  return (
    <Layout variant="admin">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <Link href="/admin" data-testid="link-back-admin">
            <Button variant="ghost" size="sm">
              <ArrowLeft className={iconSize.md} />
            </Button>
          </Link>
          <div>
            <h1 className={`${componentStyles.pageTitle} flex items-center gap-2`} data-testid="text-page-title">
              <Gift className={iconSize.lg} />
              Geburtstagskarten
            </h1>
            <p className="text-sm text-muted-foreground">Versandstatus von Geburtstagskarten verwalten</p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <Card data-testid="stat-upcoming">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-teal-600">{stats.upcoming}</div>
              <div className="text-xs text-muted-foreground">Nächste 30 Tage</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-urgent">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-red-600">{stats.urgent}</div>
              <div className="text-xs text-muted-foreground">Dringend (7 Tage)</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-sent">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-green-600">{stats.sent}</div>
              <div className="text-xs text-muted-foreground">Versendet</div>
            </CardContent>
          </Card>
          <Card data-testid="stat-pending">
            <CardContent className="p-4 text-center">
              <div className="text-2xl font-bold text-amber-600">{stats.pending}</div>
              <div className="text-xs text-muted-foreground">Offen</div>
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-wrap items-center gap-3 mb-4">
          <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
            <SelectTrigger className="w-[120px]" data-testid="select-year">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[currentYear - 1, currentYear, currentYear + 1].map(y => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="flex gap-1">
            {([
              { value: "all", label: "Alle" },
              { value: "pending", label: "Offen" },
              { value: "sent", label: "Versendet" },
            ] as const).map(f => (
              <Button
                key={f.value}
                variant={filter === f.value ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(f.value)}
                data-testid={`filter-${f.value}`}
              >
                {f.label}
              </Button>
            ))}
          </div>

          <span className="text-sm text-muted-foreground ml-auto" data-testid="text-count">
            {filteredBirthdays.length} Einträge
          </span>
        </div>

        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className={`${iconSize.lg} animate-spin text-teal-600`} />
          </div>
        ) : filteredBirthdays.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              {selectedYear < currentYear
                ? `Für ${selectedYear} sind keine Geburtstage im 365-Tage-Fenster verfügbar.`
                : "Keine Geburtstage für den gewählten Filter gefunden."}
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-2">
            {filteredBirthdays.map(entry => (
              <Card
                key={`${entry.type}-${entry.id}`}
                className={`transition-colors ${entry.cardSent ? "bg-green-50/50 border-green-200" : entry.daysUntil <= 7 ? "bg-red-50/30 border-red-200" : ""}`}
                data-testid={`card-${entry.type}-${entry.id}`}
              >
                <CardContent className="p-4 flex items-center gap-4">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${
                    entry.type === "customer" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                  }`}>
                    <Cake className="w-5 h-5" />
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate" data-testid={`name-${entry.type}-${entry.id}`}>
                        {entry.name}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${
                        entry.type === "customer" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
                      }`}>
                        {entry.type === "customer" ? "Kunde" : "Mitarbeiter"}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-sm mt-0.5">
                      <span className="text-muted-foreground">
                        {formatDate(entry.geburtsdatum)} (wird {entry.age})
                      </span>
                      <span className={getDaysColor(entry.daysUntil, entry.cardSent)}>
                        {getDaysLabel(entry.daysUntil)}
                      </span>
                    </div>
                  </div>

                  <Button
                    variant={entry.cardSent ? "outline" : "default"}
                    size="sm"
                    onClick={() => handleToggle(entry)}
                    disabled={toggleMutation.isPending}
                    className={entry.cardSent ? "border-green-300 text-green-700 hover:bg-green-50" : ""}
                    data-testid={`toggle-${entry.type}-${entry.id}`}
                  >
                    {entry.cardSent ? (
                      <>
                        <Check className="w-4 h-4 mr-1" />
                        Versendet
                      </>
                    ) : (
                      "Als versendet markieren"
                    )}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
}
