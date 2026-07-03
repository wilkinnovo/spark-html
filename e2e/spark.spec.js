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

// The /tutorials live editor: prerendered shell hydrates, the store-fed
// lesson list renders, the preview mounts a REAL component, lesson switching
// re-mounts, and typing re-runs the source through component()/mount().
test('tutorials: live editor mounts, switches, and re-runs lessons', async ({ page }) => {
  await page.goto('/tutorials');

  // hydration: lesson nav + first lesson mounted for real
  await expect(page.locator('button.lesson')).toHaveCount(15);
  await expect(page.locator('#tut-preview h1')).toContainText('Hello World');

  // switching lessons re-mounts the preview; its handlers are live
  await page.locator('button.lesson', { hasText: '2. Events' }).click();
  await expect(page.locator('#tut-preview button')).toContainText('+1');
  await page.locator('#tut-preview button').click();
  await expect(page.locator('#tut-preview b')).toHaveText('1');

  // editing the source re-runs it (debounced) — the edit is what renders
  await page.fill('.editor', '<h1>E2E {name}</h1>\n<script>\n  let name = "live";\n</script>');
  await expect(page.locator('#tut-preview h1')).toContainText('E2E live');
});
