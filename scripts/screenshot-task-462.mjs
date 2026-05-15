#!/usr/bin/env node
import { chromium } from "playwright";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:5000";
const EMAIL = process.env.TEST_USER_EMAIL;
const PASSWORD = process.env.TEST_USER_PASSWORD || process.env.TEST_USER_PASSWORD_INTERNAL;
if (!EMAIL || !PASSWORD) {
  console.error("TEST_USER_EMAIL/TEST_USER_PASSWORD_INTERNAL must be set");
  process.exit(1);
}

const t = Date.now();
const r = Math.random().toString(36).slice(2, 7);

async function api(ctx, method, path, body) {
  const headers = { "Content-Type": "application/json" };
  const csrf = (await ctx.storageState()).cookies.find((c) => c.name === "careconnect_csrf");
  if (csrf) headers["x-csrf-token"] = csrf.value;
  const res = await ctx.request.fetch(BASE_URL + path, {
    method,
    headers,
    data: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${text}`);
  return json;
}

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium",
});
const context = await browser.newContext();

await api(context, "POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });

console.log("Logged in. Setting up test data...");

const customer = await api(context, "POST", "/api/admin/customers", {
  vorname: "Screenshot",
  nachname: `T462_${t}_${r}`,
  geburtsdatum: "1940-01-15",
  email: `screenshot-${t}-${r}@test.local`,
  strasse: "Musterstraße",
  nr: "12",
  plz: "10115",
  stadt: "Berlin",
  telefon: "+4917600000000",
  pflegegrad: 3,
  pflegegradSeit: "2024-01-01",
  acceptsPrivatePayment: true,
});

const employee = await api(context, "POST", "/api/admin/users", {
  email: `emp-screenshot-${t}-${r}@test.local`,
  password: "TestPasswort123!",
  vorname: "Anna",
  nachname: `Schmitz_${t}`,
  geburtsdatum: "1990-01-01",
  eintrittsdatum: "2024-01-01",
  isAdmin: false,
  telefon: `+49170${String(t).slice(-9).padStart(9, "0")}`,
});

await api(context, "POST", `/api/admin/customers/${customer.id}/employees`, {
  employeeId: employee.id, isPrimary: true,
});

const services = await api(context, "GET", "/api/services");
const hauswirtschaft = services.find((s) => s.code === "hauswirtschaft" || s.lohnartKategorie === "hauswirtschaft");
const alltagsbegleitung = services.find((s) => s.code === "alltagsbegleitung" || s.lohnartKategorie === "alltagsbegleitung");
if (!hauswirtschaft || !alltagsbegleitung) throw new Error("Service catalog missing hauswirtschaft/alltagsbegleitung");

const nextWeekday = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};
const date = nextWeekday(-5);

const appt = await api(context, "POST", "/api/appointments/kundentermin", {
  customerId: customer.id,
  assignedEmployeeId: employee.id,
  date,
  scheduledStart: "10:00",
  services: [
    { serviceId: hauswirtschaft.id, durationMinutes: 60 },
    { serviceId: alltagsbegleitung.id, durationMinutes: 45 },
  ],
  notes: "",
});

await api(context, "POST", `/api/appointments/${appt.id}/document`, {
  performedByEmployeeId: employee.id,
  actualStart: "10:05",
  travelOriginType: "home",
  travelKilometers: 4.2,
  travelMinutes: null,
  customerKilometers: 0,
  notes: null,
  services: [
    { serviceId: hauswirtschaft.id, actualDurationMinutes: 65, details: "Wohnung gereinigt" },
    { serviceId: alltagsbegleitung.id, actualDurationMinutes: 40, details: "Spaziergang im Park" },
  ],
});

console.log(`Documented appointment id=${appt.id}, customer=${customer.id}`);

const viewports = [
  { w: 375, h: 812 },
  { w: 768, h: 1024 },
  { w: 1280, h: 900 },
];

for (const { w, h } of viewports) {
  const page = await context.newPage();
  await page.setViewportSize({ width: w, height: h });
  // First visit triggers a pre-existing hooks-order error on appointment-detail
  // (out of scope for this diff-hygiene task), but populates the React Query
  // cache. Re-entering via a different route makes the second mount see the
  // appointment as already cached, so isLoading is false from the first render
  // and hook counts stay consistent.
  await page.goto(`${BASE_URL}/appointment/${appt.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.goto(`${BASE_URL}/appointment/${appt.id}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  try {
    await page.waitForSelector('[data-testid="text-total-actual"]', { timeout: 15000 });
  } catch (e) {
    console.log(`  [debug:${w}] URL=${page.url()}`);
    const body = await page.evaluate(() => document.body.innerText);
    console.log(`  body text (first 500):`, body.slice(0, 500));
    throw e;
  }
  await page.waitForSelector('[data-testid="button-create-service-record"], [data-testid="badge-service-record-status"]', { timeout: 15000 });

  // Card 1: "Termin & Leistungen" (the time/services card)
  const servicesCard = page.locator('text=Termin & Leistungen').locator("xpath=ancestor::*[contains(@class,'rounded')][1]").first();
  await servicesCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await servicesCard.screenshot({ path: `attached_assets/screenshots/appointment-detail-services-${w}.png` });

  // Card 2: "Leistungsnachweis"
  const lnCard = page.locator('text=Leistungsnachweis').first().locator("xpath=ancestor::*[contains(@class,'rounded')][1]").first();
  await lnCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await lnCard.screenshot({ path: `attached_assets/screenshots/appointment-detail-leistungsnachweis-${w}.png` });

  console.log(`✓ ${w}px captured`);
  await page.close();
}

await browser.close();
console.log("Done.");
