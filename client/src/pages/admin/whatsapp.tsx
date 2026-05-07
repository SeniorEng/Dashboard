import { useState } from "react";
import { Link } from "wouter";
import { formatPhoneAsYouType, validateDachPhone } from "@shared/utils/phone";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Layout } from "@/components/layout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { api, unwrapResult } from "@/lib/api/client";
import { iconSize, componentStyles } from "@/design-system";
import {
  ArrowLeft, Loader2, CheckCircle2, XCircle, Send, MessageSquare,
} from "lucide-react";
import {
  WHATSAPP_EVENT_LABELS,
  WHATSAPP_EVENT_DEEP_LINKS,
  type WhatsAppEventType,
  type WhatsAppNotificationRule,
  type WhatsAppMessageLog,
} from "@shared/schema/whatsapp";

interface WhatsAppConfig {
  whatsappEnabled: boolean;
  whatsappFromOrService: string | null;
  whatsappAccessToken: string | null;
  twilioEnvConfigured: boolean;
  configured: boolean;
}

interface MessageLogResponse {
  entries: (WhatsAppMessageLog & { userName?: string })[];
  total: number;
}

type Tab = "config" | "rules" | "log";

export default function AdminWhatsApp() {
  const [tab, setTab] = useState<Tab>("config");

  const tabs: { id: Tab; label: string }[] = [
    { id: "config", label: "Konfiguration" },
    { id: "rules", label: "Benachrichtigungsregeln" },
    { id: "log", label: "Protokoll" },
  ];

  return (
    <Layout variant="admin">
      <div className="flex items-center gap-4 mb-6">
        <Link href="/admin">
          <Button variant="ghost" size="icon" aria-label="Zurück" data-testid="button-back">
            <ArrowLeft className={iconSize.md} />
          </Button>
        </Link>
        <div>
          <h1 className={componentStyles.pageTitle} data-testid="text-page-title">WhatsApp-Benachrichtigungen</h1>
          <p className="text-sm text-gray-600">Konfiguration, Regeln und Nachrichtenprotokoll</p>
        </div>
      </div>

      <div className="flex gap-1.5 mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`flex-1 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              tab === t.id
                ? "bg-teal-50 text-teal-700 border border-teal-200"
                : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
            }`}
            data-testid={`tab-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "config" && <ConfigTab />}
      {tab === "rules" && <RulesTab />}
      {tab === "log" && <LogTab />}
    </Layout>
  );
}

function ConfigTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery<WhatsAppConfig>({
    queryKey: ["whatsapp", "config"],
    queryFn: async () => unwrapResult(await api.get("/admin/whatsapp/config")),
  });

  const [accessToken, setAccessToken] = useState("");
  const [fromOrService, setFromOrService] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [initialized, setInitialized] = useState(false);

  if (config && !initialized) {
    setFromOrService(config.whatsappFromOrService ?? "");
    setEnabled(config.whatsappEnabled);
    setInitialized(true);
  }

  const [clearAccessToken, setClearAccessToken] = useState(false);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        whatsappFromOrService: fromOrService.trim() || null,
        whatsappEnabled: enabled,
      };
      if (accessToken) {
        payload.whatsappAccessToken = accessToken;
      } else if (clearAccessToken) {
        payload.whatsappAccessToken = null;
      }
      return unwrapResult(await api.put<WhatsAppConfig>("/admin/whatsapp/config", payload));
    },
    onSuccess: (data) => {
      queryClient.setQueryData(["whatsapp", "config"], data);
      setAccessToken("");
      setClearAccessToken(false);
      toast({ title: "WhatsApp-Konfiguration gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: async () => {
      const phoneResult = validateDachPhone(testPhone);
      if (!phoneResult.valid) {
        throw new Error(phoneResult.error);
      }
      return unwrapResult(await api.post<{ success: boolean; error?: string }>("/admin/whatsapp/test", { phoneNumber: phoneResult.normalized }));
    },
    onSuccess: (data) => {
      if (data.success) {
        toast({ title: "Testnachricht gesendet" });
      } else {
        toast({ title: "Testnachricht fehlgeschlagen", description: data.error, variant: "destructive" });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
      </div>
    );
  }

  const configured = config?.configured ?? false;

  return (
    <div className="space-y-4">
      <Card data-testid="card-whatsapp-status">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className={iconSize.sm} />
            Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          {configured ? (
            <div className="flex items-start gap-3 p-4 bg-green-50 border border-green-200 rounded-lg" data-testid="status-configured">
              <CheckCircle2 className={`${iconSize.sm} text-green-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-green-800">Konfiguriert und aktiv</p>
                <p className="text-xs text-green-700 mt-1">WhatsApp-Benachrichtigungen sind einsatzbereit.</p>
              </div>
            </div>
          ) : (
            <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200 rounded-lg" data-testid="status-not-configured">
              <XCircle className={`${iconSize.sm} text-amber-600 shrink-0 mt-0.5`} />
              <div>
                <p className="text-sm font-medium text-amber-800">Nicht konfiguriert</p>
                <p className="text-xs text-amber-700 mt-1">
                  Bitte den Twilio-Sender eintragen, WhatsApp aktivieren und sicherstellen, dass die Twilio-Credentials in den Umgebungsvariablen gesetzt sind.
                </p>
              </div>
            </div>
          )}
          {config && !config.twilioEnvConfigured && (
            <div className="mt-3 flex items-start gap-3 p-3 bg-red-50 border border-red-200 rounded-lg" data-testid="status-env-missing">
              <XCircle className={`${iconSize.sm} text-red-600 shrink-0 mt-0.5`} />
              <p className="text-xs text-red-800">
                <strong>TWILIO_ACCOUNT_SID</strong> und/oder <strong>TWILIO_AUTH_TOKEN</strong> fehlen in den Umgebungsvariablen. Diese werden für den Versand benötigt.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card data-testid="card-whatsapp-credentials">
        <CardHeader>
          <CardTitle className="text-base">Twilio WhatsApp-Konfiguration</CardTitle>
          <CardDescription>
            Versand über Twilio WhatsApp Content API. Die Twilio-Credentials (Account SID, Auth Token) werden global aus den Umgebungsvariablen gelesen.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fromOrService">Twilio-Sender</Label>
            <Input
              id="fromOrService"
              value={fromOrService}
              onChange={(e) => setFromOrService(e.target.value)}
              placeholder="+4915112345678 oder MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
              data-testid="input-from-or-service"
            />
            <p className="text-xs text-gray-500">
              Entweder die in Twilio registrierte WhatsApp-Nummer im E.164-Format (z. B. <code>+4915112345678</code>) oder eine Messaging-Service-SID (<code>MG…</code>).
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="accessToken">Twilio Auth Token (optional, Override)</Label>
            <Input
              id="accessToken"
              type="password"
              value={accessToken}
              onChange={(e) => setAccessToken(e.target.value)}
              placeholder={config?.whatsappAccessToken ? "••••••••" : "Leer lassen für Umgebungsvariable"}
              data-testid="input-access-token"
            />
            <p className="text-xs text-gray-500">
              Nur ausfüllen, wenn ein abweichender Auth Token statt <code>TWILIO_AUTH_TOKEN</code> aus den Umgebungsvariablen verwendet werden soll.
              {config?.whatsappAccessToken && <> Aktuell hinterlegt: {config.whatsappAccessToken}</>}
            </p>
            {config?.whatsappAccessToken && (
              <div className="flex items-center gap-2 pt-1">
                <input
                  id="clearAccessToken"
                  type="checkbox"
                  checked={clearAccessToken}
                  onChange={(e) => setClearAccessToken(e.target.checked)}
                  className="rounded border-gray-300"
                  data-testid="checkbox-clear-access-token"
                />
                <Label htmlFor="clearAccessToken" className="text-xs font-normal cursor-pointer">
                  Hinterlegten Override-Token entfernen und wieder Umgebungsvariable nutzen
                </Label>
              </div>
            )}
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Switch
              id="whatsappEnabled"
              checked={enabled}
              onCheckedChange={setEnabled}
              data-testid="switch-whatsapp-enabled"
            />
            <Label htmlFor="whatsappEnabled">WhatsApp-Benachrichtigungen aktivieren</Label>
          </div>

          <Button
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            className="w-full sm:w-auto"
            data-testid="button-save-config"
          >
            {saveMutation.isPending && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
            Konfiguration speichern
          </Button>
        </CardContent>
      </Card>

      <Card data-testid="card-whatsapp-test">
        <CardHeader>
          <CardTitle className="text-base">Verbindung testen</CardTitle>
          <CardDescription>Senden Sie eine Testnachricht an eine Telefonnummer</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-col sm:flex-row gap-3">
            <Input
              value={testPhone}
              onChange={(e) => setTestPhone(formatPhoneAsYouType(e.target.value))}
              placeholder="+49 170 1234567"
              className="flex-1"
              data-testid="input-test-phone"
            />
            <Button
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending || !testPhone || !configured}
              data-testid="button-send-test"
            >
              {testMutation.isPending ? (
                <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />
              ) : (
                <Send className={`${iconSize.sm} mr-2`} />
              )}
              Verbindung testen
            </Button>
          </div>
          {!configured && (
            <p className="text-xs text-gray-500">Speichern und aktivieren Sie zuerst die Konfiguration.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function RulesTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: rules, isLoading } = useQuery<WhatsAppNotificationRule[]>({
    queryKey: ["whatsapp", "rules"],
    queryFn: async () => unwrapResult(await api.get("/admin/whatsapp/rules")),
  });

  const [localRules, setLocalRules] = useState<Map<number, { enabled: boolean; templateName: string }>>(new Map());
  const [rulesInitialized, setRulesInitialized] = useState(false);

  if (rules && !rulesInitialized) {
    const map = new Map<number, { enabled: boolean; templateName: string }>();
    rules.forEach(r => map.set(r.id, { enabled: r.enabled, templateName: r.templateName }));
    setLocalRules(map);
    setRulesInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: async () => {
      const rulesPayload = Array.from(localRules.entries()).map(([id, val]) => ({
        id,
        enabled: val.enabled,
        templateName: val.templateName,
      }));
      return unwrapResult(await api.put<WhatsAppNotificationRule[]>("/admin/whatsapp/rules", { rules: rulesPayload }));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp", "rules"] });
      setRulesInitialized(false);
      toast({ title: "Benachrichtigungsregeln gespeichert" });
    },
    onError: (error: Error) => {
      toast({ title: "Fehler", description: error.message, variant: "destructive" });
    },
  });

  const updateRule = (id: number, field: "enabled" | "templateName", value: boolean | string) => {
    setLocalRules(prev => {
      const next = new Map(prev);
      const current = next.get(id);
      if (current) {
        next.set(id, { ...current, [field]: value });
      }
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
      </div>
    );
  }

  if (!rules || rules.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-gray-500" data-testid="text-no-rules">
          Keine Benachrichtigungsregeln vorhanden. Die Standardregeln werden beim nächsten Serverstart erstellt.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {rules.map(rule => {
        const local = localRules.get(rule.id);
        const eventType = rule.eventType as WhatsAppEventType;
        const label = WHATSAPP_EVENT_LABELS[eventType] ?? rule.eventType;
        const deepLink = WHATSAPP_EVENT_DEEP_LINKS[eventType] ?? "/";

        return (
          <Card key={rule.id} data-testid={`card-rule-${rule.eventType}`}>
            <CardContent className="p-4">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="flex-1 space-y-3">
                  <div className="flex items-center gap-3">
                    <Switch
                      checked={local?.enabled ?? rule.enabled}
                      onCheckedChange={(v) => updateRule(rule.id, "enabled", v)}
                      data-testid={`switch-rule-${rule.eventType}`}
                    />
                    <div>
                      <p className="text-sm font-medium" data-testid={`text-rule-label-${rule.eventType}`}>{label}</p>
                      {rule.description && (
                        <p className="text-xs text-gray-500">{rule.description}</p>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label className="text-xs text-gray-600">Twilio Content SID</Label>
                    <Input
                      value={local?.templateName ?? rule.templateName}
                      onChange={(e) => updateRule(rule.id, "templateName", e.target.value.trim())}
                      placeholder="HXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                      className="max-w-sm font-mono"
                      data-testid={`input-template-${rule.eventType}`}
                    />
                    <p className="text-xs text-gray-500">
                      Aus der Twilio Console (Content Template Builder). Format: <code>HX</code> + 32 Hex-Zeichen.
                    </p>
                  </div>

                  <div className="text-xs text-gray-500" data-testid={`text-deeplink-${rule.eventType}`}>
                    Deep-Link: <code className="bg-gray-100 px-1.5 py-0.5 rounded">{deepLink}</code>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>
        );
      })}

      <Button
        onClick={() => saveMutation.mutate()}
        disabled={saveMutation.isPending}
        className="w-full sm:w-auto"
        data-testid="button-save-rules"
      >
        {saveMutation.isPending && <Loader2 className={`${iconSize.sm} mr-2 animate-spin`} />}
        Regeln speichern
      </Button>
    </div>
  );
}

function LogTab() {
  const [page, setPage] = useState(0);
  const [statusFilter, setStatusFilter] = useState<"all" | "sent" | "failed">("all");
  const pageSize = 50;

  const { data, isLoading } = useQuery<MessageLogResponse>({
    queryKey: ["whatsapp", "log", page, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({
        limit: String(pageSize),
        offset: String(page * pageSize),
      });
      if (statusFilter !== "all") {
        params.set("status", statusFilter);
      }
      return unwrapResult(await api.get(`/admin/whatsapp/log?${params.toString()}`));
    },
  });

  const entries = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["all", "sent", "failed"] as const).map(status => (
          <button
            key={status}
            onClick={() => { setStatusFilter(status); setPage(0); }}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              statusFilter === status
                ? "bg-teal-50 text-teal-700 border border-teal-200"
                : "bg-gray-50 text-gray-600 border border-gray-200 hover:bg-gray-100"
            }`}
            data-testid={`filter-status-${status}`}
          >
            {status === "all" ? "Alle" : status === "sent" ? "Gesendet" : "Fehlgeschlagen"}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className={`${iconSize.md} animate-spin text-teal-600`} />
        </div>
      ) : entries.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-gray-500" data-testid="text-no-log-entries">
            Keine Einträge vorhanden.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="space-y-2">
            {entries.map(entry => (
              <Card key={entry.id} data-testid={`log-entry-${entry.id}`}>
                <CardContent className="p-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">
                          {WHATSAPP_EVENT_LABELS[entry.eventType as WhatsAppEventType] ?? entry.eventType}
                        </span>
                        <Badge
                          variant="outline"
                          className={
                            entry.status === "sent"
                              ? "bg-green-50 text-green-700 border-green-200 text-xs"
                              : entry.status === "failed"
                              ? "bg-red-50 text-red-700 border-red-200 text-xs"
                              : "bg-amber-50 text-amber-700 border-amber-200 text-xs"
                          }
                          data-testid={`badge-status-${entry.id}`}
                        >
                          {entry.status === "sent" ? "Gesendet" : entry.status === "failed" ? "Fehlgeschlagen" : "Warteschlange"}
                        </Badge>
                        <span className="text-xs text-gray-500">
                          {new Date(entry.createdAt).toLocaleDateString("de-DE", {
                            day: "2-digit", month: "2-digit", year: "numeric",
                          })}{" "}
                          {new Date(entry.createdAt).toLocaleTimeString("de-DE", {
                            hour: "2-digit", minute: "2-digit",
                          })}
                        </span>
                      </div>
                      <p className="text-xs text-gray-600 mt-1">
                        An: {entry.phoneNumber}
                        {entry.userName && <> — {entry.userName}</>}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5 font-mono">
                        Content SID: {entry.templateName || "—"}
                      </p>
                      <p
                        className="text-xs text-gray-500 mt-0.5 font-mono"
                        data-testid={`text-message-sid-${entry.id}`}
                      >
                        Twilio Message-SID: {entry.metaMessageId || "—"}
                      </p>
                      {entry.errorMessage && (
                        <p className="text-xs text-red-600 mt-1" data-testid={`text-error-${entry.id}`}>
                          Fehler: {entry.errorMessage}
                        </p>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-gray-500">{total} Einträge gesamt</p>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage(p => p - 1)}
                  data-testid="button-prev-page"
                >
                  Zurück
                </Button>
                <span className="text-sm text-gray-600 self-center">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage(p => p + 1)}
                  data-testid="button-next-page"
                >
                  Weiter
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
