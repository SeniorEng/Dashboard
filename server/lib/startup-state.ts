// ---------------------------------------------------------------------------
// Startup-Readiness-Flag (Task #894)
//
// `runStartupTasks()` (server/index.ts) läuft NACH `httpServer.listen()` als
// fire-and-forget — `/api/health` antwortet also bereits mit `status: ok`,
// während die Seeder (System-Services, Pflegekassen, PKV-Provider,
// Kunden-Dokumenttypen) noch im Hintergrund laufen. Integrationstests, die in
// ihrem `beforeAll` sofort Referenzdaten erwarten (z.B. die Pflicht-Services
// `hauswirtschaft`/`alltagsbegleitung`), liefen dadurch in eine Race-Condition:
// auf einer frischen DB (ephemeral oder CI) war der Seed noch nicht durch.
//
// Dieses Flag wird am ENDE von `runStartupTasks()` gesetzt und unter
// `/api/health → startupComplete` exponiert. Test-Setups (tests/globalSetup.ts,
// scripts/with-ephemeral-db.ts) warten darauf, statt nur auf `status: ok`.
let startupComplete = false;

export function markStartupComplete(): void {
  startupComplete = true;
}

export function isStartupComplete(): boolean {
  return startupComplete;
}
