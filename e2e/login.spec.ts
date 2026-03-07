import { test, expect } from "@playwright/test";

test.describe("Login Page", () => {
  test("shows login form", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("[data-testid='img-login-logo']")).toBeVisible();
    await expect(page.locator("[data-testid='input-email']")).toBeVisible();
    await expect(page.locator("[data-testid='input-password']")).toBeVisible();
    await expect(page.locator("[data-testid='button-login']")).toBeVisible();
  });

  test("shows error on invalid credentials", async ({ page }) => {
    await page.goto("/");
    await page.locator("[data-testid='input-email']").fill("invalid@test.de");
    await page.locator("[data-testid='input-password']").fill("wrongpassword");
    await page.locator("[data-testid='button-login']").click();
    await expect(page.locator("[role='status']")).toBeVisible({ timeout: 5000 });
  });

  test("login with valid credentials", async ({ page }) => {
    const email = process.env.TEST_USER_EMAIL;
    const password = process.env.TEST_USER_PASSWORD_INTERNAL;
    if (!email || !password) {
      test.skip();
      return;
    }
    await page.goto("/");
    await page.locator("[data-testid='input-email']").fill(email);
    await page.locator("[data-testid='input-password']").fill(password);
    await page.locator("[data-testid='button-login']").click();
    await expect(page).toHaveURL(/\/$/, { timeout: 10000 });
  });
});
