import { expect, test } from '@playwright/test';
import { flyToRegion, register } from './helpers';

test('name land, teleport to it from the top bar, list it, and another player buys it', async ({ page, browser }) => {
  await register(page);
  await flyToRegion(page, 'Canterbury');
  const available = page.getByTestId('nearby-list').locator('button', { hasText: 'Available' }).first();
  await available.click();
  await page.getByTestId('parcel-name').fill('Kiwi Corner');
  await page.getByTestId('buy-parcel').click();
  await expect(page.getByText(/“Kiwi Corner” purchased/)).toBeVisible();

  // Rename it.
  await page.getByTestId('rename-parcel').fill('Kiwi Estate');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Renamed to “Kiwi Estate”')).toBeVisible();

  // Teleport: fly elsewhere, then jump back from the top-bar menu.
  await flyToRegion(page, 'Loire-Valley');
  await page.getByTestId('teleport-menu').click();
  await page.getByRole('dialog', { name: 'Teleport to your land' }).getByText('Kiwi Estate').click();
  await expect(page.getByTestId('location')).toContainText('-43.5', { timeout: 10_000 });
  await expect(page.getByRole('heading', { name: 'Kiwi Estate' })).toBeVisible();

  // List for sale.
  await page.getByTestId('ask-price').fill('3000');
  await page.getByRole('button', { name: 'List for sale' }).click();
  await expect(page.getByText(/Listed for sale at 3,000 CR/)).toBeVisible();

  // Another player finds it under "Land for sale" and buys it with a new name.
  const ctx2 = await browser.newContext({ ignoreHTTPSErrors: true });
  const page2 = await ctx2.newPage();
  await register(page2);
  await page2.getByTestId('land-for-sale').getByText('Kiwi Estate').click();
  await expect(page2.getByTestId('buy-listing')).toBeDisabled();
  await page2.getByLabel('Name your land').fill('Second Owner Farm');
  await page2.getByTestId('buy-listing').click();
  await expect(page2.getByText(/Bought “Second Owner Farm” for 3,000 CR/)).toBeVisible();
  await expect(page2.getByRole('heading', { name: 'Second Owner Farm' })).toBeVisible();

  // The new owner sells it to the land office.
  await page2.getByTestId('sell-to-office').click();
  await page2.getByTestId('confirm-sell').click();
  await expect(page2.getByText(/Sold to the land office for/)).toBeVisible();
  await ctx2.close();
});
