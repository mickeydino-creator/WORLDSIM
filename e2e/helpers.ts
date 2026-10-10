import { expect, type Page, type BrowserContext } from '@playwright/test';

export function uniqueName(prefix = 'e2e') {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`.slice(0, 24);
}

export async function register(page: Page, name = uniqueName()) {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.fill('input[name=username]', name);
  await page.fill('input[name=displayName]', `Player ${name.slice(-4)}`);
  await page.fill('input[name=email]', `${name}@example.com`);
  await page.fill('input[name=password]', 'correct horse battery');
  await page.click('button[type=submit]');
  await page.waitForURL('**/play');
  await expect(page.getByTestId('balance')).toBeVisible();
  return name;
}

/** Reads client game state exposed in development builds. */
export async function gameState<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(${fn})(window.__worldstate.get())`) as Promise<T>;
}

export async function flyToRegion(page: Page, region: string) {
  await page.getByTestId('nav-world').click();
  await page.getByTestId(`region-${region}`).click();
  await expect(page.getByTestId('nearby-list')).toBeVisible();
}

export async function newPlayerContext(context: BrowserContext) {
  const page = await context.newPage();
  return page;
}
