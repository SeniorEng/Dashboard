import { expect, type Page, type Response } from "@playwright/test";

export type SaveExpectation = {
  /** URL substring or RegExp the save request must match. */
  url: string | RegExp;
  /** Allowed HTTP methods. Default: ["PATCH", "PUT", "POST"]. */
  methods?: ReadonlyArray<"PATCH" | "PUT" | "POST" | "DELETE">;
};

function matchesSave(res: Response, e: SaveExpectation): boolean {
  const allowed = e.methods ?? ["PATCH", "PUT", "POST"];
  if (!allowed.includes(res.request().method() as never)) return false;
  const url = res.url();
  return typeof e.url === "string" ? url.includes(e.url) : e.url.test(url);
}

export interface RoundTripOptions {
  page: Page;
  /** Path to navigate to before editing (e.g. "/admin/customers/123"). */
  openUrl: string;
  /** `data-testid` of the field to change (input/textarea). */
  fieldTestId: string;
  /** New value to type into the field. */
  newValue: string;
  /**
   * Optional: setup to run after the page is loaded but before editing
   * (e.g. switching tabs or clicking an "Edit" button to reveal the field).
   */
  prepareEdit?: (page: Page) => Promise<void>;
  /**
   * Optional: `data-testid` of the save button. If omitted, the helper picks
   * the first visible button whose testid starts with `button-save` or
   * `button-submit` — keeping the common case to a two-line call.
   */
  saveTestId?: string;
  /**
   * Optional save endpoint matcher (URL substring or RegExp + optional
   * methods). **Strongly recommended** — without it, the helper falls back
   * to "any successful PATCH/PUT/POST", which can produce false positives
   * when background requests fire during the save (e.g. background refetch).
   * Defaults: methods = ["PATCH", "PUT", "POST"].
   */
  expectSave?: SaveExpectation;
  /**
   * Optional re-open step after `page.reload()`. Use this when the field is
   * only visible after pressing an "Edit" button on the freshly reloaded page.
   * If omitted and `expectVisibleAfter` is also omitted, the helper re-runs
   * `prepareEdit` after the reload and asserts the field's value directly.
   */
  reopenAfterReload?: (page: Page) => Promise<void>;
  /**
   * If provided, after the reload we assert this `data-testid` element
   * contains the new value (display-mode assertion).
   */
  expectVisibleAfter?: string;
}

/**
 * Round-trip persistence helper: navigate → edit → save → full reload →
 * assert that the new value survived. Always uses `page.reload()` so that we
 * test real persistence and not just frontend state.
 */
export async function expectFieldPersisted(
  opts: RoundTripOptions,
): Promise<void> {
  const { page } = opts;
  await page.goto(opts.openUrl, { waitUntil: "domcontentloaded" });
  if (opts.prepareEdit) await opts.prepareEdit(page);

  const field = page.locator(`[data-testid='${opts.fieldTestId}']`);
  await expect(field).toBeVisible({ timeout: 10000 });
  await field.fill(opts.newValue);

  await clickSaveAndWait(page, opts.expectSave, opts.saveTestId);

  // Hard reload — kein In-Memory-State.
  await page.reload({ waitUntil: "domcontentloaded" });
  if (opts.reopenAfterReload) {
    await opts.reopenAfterReload(page);
    const fieldAfter = page.locator(`[data-testid='${opts.fieldTestId}']`);
    await expect(fieldAfter).toBeVisible({ timeout: 10000 });
    await expect(fieldAfter).toHaveValue(opts.newValue);
    return;
  }
  if (opts.expectVisibleAfter) {
    const display = page.locator(
      `[data-testid='${opts.expectVisibleAfter}']`,
    );
    await expect(display).toBeVisible({ timeout: 10000 });
    await expect(display).toContainText(opts.newValue);
    return;
  }
  // Default: re-run prepareEdit (re-open the form) and assert the field's value.
  if (opts.prepareEdit) await opts.prepareEdit(page);
  const fieldAfter = page.locator(`[data-testid='${opts.fieldTestId}']`);
  await expect(fieldAfter).toBeVisible({ timeout: 10000 });
  await expect(fieldAfter).toHaveValue(opts.newValue);
}

/**
 * Click the save button (explicit testid, otherwise the first visible button
 * whose testid starts with `button-save` or `button-submit`) and wait for a
 * successful response that matches the form's specific save endpoint — never
 * a generic any-method match.
 */
export async function clickSaveAndWait(
  page: Page,
  expectSave?: SaveExpectation,
  saveTestId?: string,
): Promise<void> {
  const saveBtn = saveTestId
    ? page.locator(`[data-testid='${saveTestId}']`)
    : page
        .locator(
          "[data-testid^='button-save'], [data-testid^='button-submit']",
        )
        .filter({ visible: true })
        .first();
  await expect(saveBtn).toBeEnabled({ timeout: 5000 });
  await Promise.all([
    page.waitForResponse(
      (r) => {
        if (!r.ok()) return false;
        if (expectSave) return matchesSave(r, expectSave);
        return ["PATCH", "PUT", "POST"].includes(r.request().method());
      },
      { timeout: 15000 },
    ),
    saveBtn.click(),
  ]);
}

/**
 * Round-trip a Radix `<Select>` (shadcn/ui). The trigger and the option
 * MUST both expose `data-testid`. After save, a hard reload runs and the
 * trigger's text content is asserted to contain `expectVisibleText` (or
 * the option label, if `expectVisibleText` is omitted).
 */
export async function selectAndExpectPersisted(opts: {
  page: Page;
  openUrl: string;
  prepareEdit?: (page: Page) => Promise<void>;
  triggerTestId: string;
  optionTestId: string;
  saveTestId?: string;
  expectSave?: SaveExpectation;
  /** display-mode test-id whose text must contain the saved value after reload */
  expectVisibleAfter: string;
  expectVisibleText: string;
  reopenAfterReload?: (page: Page) => Promise<void>;
}): Promise<void> {
  const { page } = opts;
  await page.goto(opts.openUrl, { waitUntil: "domcontentloaded" });
  if (opts.prepareEdit) await opts.prepareEdit(page);

  const trigger = page.locator(`[data-testid='${opts.triggerTestId}']`);
  await expect(trigger).toBeVisible({ timeout: 10000 });
  await trigger.click();
  await page.locator(`[data-testid='${opts.optionTestId}']`).click();

  await clickSaveAndWait(page, opts.expectSave, opts.saveTestId);

  await page.reload({ waitUntil: "domcontentloaded" });
  if (opts.reopenAfterReload) await opts.reopenAfterReload(page);
  const display = page.locator(`[data-testid='${opts.expectVisibleAfter}']`);
  await expect(display).toBeVisible({ timeout: 10000 });
  await expect(display).toContainText(opts.expectVisibleText);
}

/**
 * Round-trip a toggle/switch/checkbox identified by `toggleTestId`. After
 * the click, the helper saves and asserts that the toggle's
 * `aria-checked`/`data-state` reflects `desiredChecked` after a hard reload.
 */
export async function toggleAndExpectPersisted(opts: {
  page: Page;
  openUrl: string;
  prepareEdit?: (page: Page) => Promise<void>;
  toggleTestId: string;
  desiredChecked: boolean;
  saveTestId?: string;
  expectSave?: SaveExpectation;
  reopenAfterReload?: (page: Page) => Promise<void>;
}): Promise<void> {
  const { page } = opts;
  await page.goto(opts.openUrl, { waitUntil: "domcontentloaded" });
  if (opts.prepareEdit) await opts.prepareEdit(page);

  const toggle = page.locator(`[data-testid='${opts.toggleTestId}']`);
  await expect(toggle).toBeVisible({ timeout: 10000 });
  const currentlyChecked =
    (await toggle.getAttribute("aria-checked")) === "true" ||
    (await toggle.getAttribute("data-state")) === "checked";
  if (currentlyChecked !== opts.desiredChecked) {
    await toggle.click();
  }

  await clickSaveAndWait(page, opts.expectSave, opts.saveTestId);

  await page.reload({ waitUntil: "domcontentloaded" });
  if (opts.reopenAfterReload) await opts.reopenAfterReload(page);
  const after = page.locator(`[data-testid='${opts.toggleTestId}']`);
  await expect(after).toBeVisible({ timeout: 10000 });
  await expect(after).toHaveAttribute(
    "data-state",
    opts.desiredChecked ? "checked" : "unchecked",
  );
}

/**
 * Convenience for date / textarea / multiline `<input>` fields — they all
 * support `.fill()` so this is just `expectFieldPersisted` re-exported under
 * a name that documents the intent at call sites.
 */
export const fillAndExpectPersisted = expectFieldPersisted;
