import { test, expect } from '@playwright/test';

// End-to-end through a real browser: hydration over prerendered HTML, SPA
// routing (no full reload, active link), and theming (data-theme toggle).
test('mount → hydrate → router → theme', async ({ page }) => {
  await page.goto('/');

  // ── hydrate ──────────────────────────────────────────────────────────
  // The prerendered hero is there, and the theme package applied a data-theme
  // before paint (proving the no-flash init ran and the app booted).
  await expect(page.locator('h1')).toContainText(/HTML that\s+reacts/i);
  const startTheme = await page.locator('html').getAttribute('data-theme');
  expect(['dark', 'light']).toContain(startTheme);

  // Tag the window; a full page reload would wipe this, letting us prove the
  // navigation below is a client-side route change.
  await page.evaluate(() => {
    window.__sparkNoReload = true;
  });

  // ── router ───────────────────────────────────────────────────────────
  await page.locator('a[href$="/docs"]').first().click();
  await expect(page).toHaveURL(/\/docs$/);
  // content actually swapped (the home <h1> is now the docs <h1>)…
  await expect(page.locator('h1')).toContainText(/Spark documentation/i);
  // …it was an SPA navigation, not a reload…
  expect(await page.evaluate(() => window.__sparkNoReload)).toBe(true);
  // …and the active link is reflected for CSS/a11y.
  await expect(page.locator('a[href$="/docs"][aria-current="page"]').first()).toHaveCount(1);

  // ── theme ────────────────────────────────────────────────────────────
  await page.locator('.logo[title="Toggle theme"]').first().click();
  await expect
    .poll(() => page.locator('html').getAttribute('data-theme'))
    .not.toBe(startTheme);
});
