/**
 * Appearance settings (spec v1.3 §6) in a real browser: a choice in the
 * Settings dialog changes the tokens at once, without a reload, and the
 * next start paints with it before the service answers.
 *
 * `THREADGARDEN_E2E_SHOTS=<dir>` also saves screenshots of a few combinations there.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { openApp, resetTabs, serviceCall } from './helpers';

const DEFAULTS = {
  theme: 'system',
  accent: 'graphite',
  darkStyle: 'default',
  lightStyle: 'default',
  uiFont: 'inter',
  codeFont: null,
};

test.beforeEach(resetTabs);
// The mock service keeps settings between tests: leave the default look behind.
test.afterEach(async () => {
  await serviceCall('settings.set', DEFAULTS);
});

const token = (page: Page, name: string) =>
  page.evaluate((n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(), name);

/** A colour token as the browser computes it (the build minifies how it is written). */
const color = (page: Page, name: string) =>
  page.evaluate((n) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${n})`;
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  }, name);

/** Picks an accent: the radio itself is visually hidden behind its swatch label. */
const pickAccent = async (dialog: Locator, name: string): Promise<void> => {
  await dialog.locator('label').filter({ hasText: name }).click();
  await expect(dialog.getByRole('radio', { name })).toBeChecked();
};

const openSettings = async (page: Page) => {
  await page
    .getByRole('navigation', { name: 'Places' })
    .getByRole('button', { name: 'Settings' })
    .click();
  return page.getByRole('dialog', { name: 'Settings' });
};

test('the default look has no appearance overrides', async ({ page }) => {
  await openApp(page);
  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-accent', 'graphite');
  await expect(root).toHaveAttribute('data-light-style', 'default');
  expect(await color(page, '--primary')).toBe('oklch(0.205 0 0)');
  expect(await color(page, '--background')).toBe('oklch(1 0 0)');
  expect(await root.evaluate((el) => getComputedStyle(el).fontFamily)).toBe(
    '"Inter Variable", sans-serif',
  );
});

test('a saved accent and dark style apply at once and on the next start', async ({ page }) => {
  await openApp(page);
  const dialog = await openSettings(page);
  await dialog.getByLabel('Theme').selectOption('dark');
  await pickAccent(dialog, 'Teal');
  await dialog.getByLabel('Dark style').selectOption('midnight');
  await dialog.getByLabel('Code font').fill('Courier New');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).toBeHidden();

  const root = page.locator('html');
  await expect(root).toHaveAttribute('data-theme', 'dark');
  await expect(root).toHaveAttribute('data-accent', 'teal');
  await expect(root).toHaveAttribute('data-dark-style', 'midnight');
  expect(await color(page, '--background')).toBe('oklch(0 0 0)');
  expect(await color(page, '--primary')).toBe('oklch(0.76 0.12 188)');
  expect(await token(page, '--font-mono')).toMatch(/^"Courier New", ui-monospace/);

  // Next start: the attributes are on <html> before any app code runs.
  await page.goto('/');
  const early = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    accent: document.documentElement.dataset.accent,
  }));
  expect(early).toEqual({ theme: 'dark', accent: 'teal' });
});

const SHOTS = process.env.THREADGARDEN_E2E_SHOTS;
const COMBOS = [
  { theme: 'light', accent: 'graphite', lightStyle: 'default', darkStyle: 'default' },
  { theme: 'light', accent: 'blue', lightStyle: 'warm', darkStyle: 'default' },
  { theme: 'dark', accent: 'graphite', lightStyle: 'default', darkStyle: 'default' },
  { theme: 'dark', accent: 'violet', lightStyle: 'default', darkStyle: 'dim' },
  { theme: 'dark', accent: 'amber', lightStyle: 'default', darkStyle: 'midnight' },
  { theme: 'light', accent: 'rose', lightStyle: 'default', darkStyle: 'default' },
] as const;

test('screenshots of a few combinations', async ({ page }) => {
  test.skip(!SHOTS, 'set THREADGARDEN_E2E_SHOTS to a directory to take them');
  for (const c of COMBOS) {
    await serviceCall('settings.set', { ...DEFAULTS, ...c });
    await openApp(page);
    await page.getByRole('option').first().click();
    await page.screenshot({
      path: `${SHOTS}/app-${c.theme}-${c.accent}-${c[c.theme === 'light' ? 'lightStyle' : 'darkStyle']}.png`,
    });
  }
  await serviceCall('settings.set', { ...DEFAULTS, accent: 'green', uiFont: 'system' });
  await openApp(page);
  const dialog = await openSettings(page);
  await pickAccent(dialog, 'Violet');
  await dialog.getByLabel('Dark style').selectOption('midnight');
  await dialog.getByLabel('Light style').selectOption('warm');
  await dialog.getByRole('group', { name: 'Appearance preview' }).scrollIntoViewIfNeeded();
  await dialog.screenshot({ path: `${SHOTS}/settings-appearance.png` });
});
