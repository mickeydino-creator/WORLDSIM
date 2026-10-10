import { expect, test } from '@playwright/test';
import { flyToRegion, gameState, register } from './helpers';

test('register → buy parcel → build → reload → another player sees the same world', async ({ page, browser }) => {
  await register(page);
  const startBalance = await page.getByTestId('balance').innerText();
  expect(startBalance).toContain('50,000');

  // Pick a distinct region per run: the nearby list always offers the closest available parcels.
  await flyToRegion(page, 'Pampas');
  const available = page.getByTestId('nearby-list').locator('button', { hasText: 'Available' }).first();
  const parcelLabel = (await available.locator('span').first().innerText()).replace('#', '');
  await available.click();
  // A name is required before buying.
  await expect(page.getByTestId('buy-parcel')).toBeDisabled();
  await page.getByTestId('parcel-name').fill('Pampas Homestead');
  await expect(page.getByTestId('buy-parcel')).toBeEnabled();
  await page.getByTestId('buy-parcel').click();
  await expect(page.getByText(/“Pampas Homestead” purchased for/)).toBeVisible();
  await expect(page.getByTestId('balance')).not.toHaveText(startBalance);

  // Build: open the parcel in Build, place a small house with keyboard controls at the map centre.
  await page.getByTestId('build-here').click();
  await page.waitForTimeout(2500); // camera flight to the parcel
  await page.getByTestId('place-small_house').click();
  await expect(page.getByTestId('placement-bar')).toBeVisible();
  await expect(page.getByTestId('placement-status')).toContainText('Valid location');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Small house constructed/)).toBeVisible();

  const buildingId = await gameState<string | null>(page, `(s) => s.selection?.kind === 'building' ? s.selection.id : null`);
  expect(buildingId).toBeTruthy();

  // Persisted server-side: verify through the API, then reload the client.
  const api = await page.request.get(`/api/buildings/${buildingId}`);
  expect(api.ok()).toBeTruthy();
  const b = (await api.json()).data;
  expect(b.parcelId).toBe(parcelLabel);
  await page.reload();
  await expect(page.getByTestId('balance')).toBeVisible();
  await expect.poll(() => gameState<boolean>(page, `(s) => [...s.chunks.values()].some((c) => c.buildings.some((x) => x.id === '${buildingId}'))`), { timeout: 30_000 }).toBe(true);
  await expect(page.getByTestId('nearby-list').getByText('Yours').first()).toBeVisible();

  // A second account in a separate browser context sees the same parcel and building.
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const page2 = await other.newPage();
  await register(page2);
  await flyToRegion(page2, 'Pampas');
  await expect.poll(() => gameState<boolean>(page2, `(s) => [...s.chunks.values()].some((c) => c.buildings.some((x) => x.id === '${buildingId}'))`), { timeout: 30_000 }).toBe(true);
  await page2.getByTestId(`parcel-${parcelLabel}`).click();
  await expect(page2.getByText(/Owned by Player/)).toBeVisible();
  await expect(page2.getByText('Pampas Homestead').first()).toBeVisible();

  // Realtime: player 1 builds again while player 2 watches; it appears for player 2 without reloading.
  await page.getByTestId('nav-build').click();
  await page.getByTestId('place-park').click();
  // Nudge 30 m west and 30 m north of the house so the footprints do not overlap.
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowLeft');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowUp');
  await expect(page.getByTestId('placement-status')).toContainText('Valid location');
  await page.keyboard.press('Enter');
  await expect(page.getByText(/Park constructed/)).toBeVisible();
  await expect.poll(() => gameState<number>(page2, `(s) => [...s.chunks.values()].flatMap((c) => c.buildings).filter((x) => x.parcelId === '${parcelLabel}').length`), { timeout: 20_000 }).toBe(2);
  await other.close();
});
