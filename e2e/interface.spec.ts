import { expect, test } from '@playwright/test';
import { register } from './helpers';

test('unauthenticated visitors are sent to the sign-in page', async ({ page }) => {
  await page.goto('/play');
  await expect(page).toHaveURL(/\/$/);
  const res = await page.request.post('/api/parcels/1_1/purchase', { headers: { origin: new URL(page.url()).origin, 'idempotency-key': 'abcdefgh123' }, data: {} });
  expect(res.status()).toBe(401);
});

test('registration form validates input', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Create account' }).click();
  await page.fill('input[name=username]', 'x');
  await page.fill('input[name=password]', 'short');
  await page.click('button[type=submit]');
  await expect(page.getByText('3-24 letters, digits or underscores')).toBeVisible();
  await expect(page.getByText('At least 10 characters')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('wrong password shows an error', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('tab', { name: 'Sign in' }).click();
  await page.fill('input[name=username]', 'nobody_here');
  await page.fill('input[name=password]', 'wrong-password');
  await page.click('button[type=submit]');
  await expect(page.getByText('Incorrect username or password')).toBeVisible();
});

test('every navigation panel opens and renders real data', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await register(page);
  for (const p of ['world', 'build', 'economy', 'settlements', 'research', 'profile', 'settings']) {
    await page.getByTestId(`nav-${p}`).click();
    await expect(page.getByTestId(`panel-${p}`)).toBeVisible();
  }
  await page.getByTestId('nav-economy').click();
  await expect(page.getByTestId('wallet-balance')).toContainText('50,000');
  await expect(page.getByTestId('inv-wood')).toContainText('120');
  await page.getByTestId('economy-tab-ledger').click();
  await expect(page.getByTestId('ledger')).toContainText('starting grant');
  await page.getByTestId('economy-tab-market').click();
  await expect(page.getByTestId('order-form')).toBeVisible();
  await page.getByTestId('nav-research').click();
  await expect(page.getByTestId('rp')).toContainText('5 RP');
  // Locked actions are disabled with a stated reason.
  await page.getByTestId('nav-build').click();
  await expect(page.getByTestId('place-apartment_building')).toBeDisabled();
  await expect(page.getByTestId('catalog-apartment_building')).toContainText('Requires level 3');
  expect(errors).toEqual([]);
});

test('market order form validates and places a real escrowed order', async ({ page }) => {
  await register(page);
  await page.getByTestId('nav-economy').click();
  await page.getByTestId('economy-tab-market').click();
  const form = page.getByTestId('order-form');
  await form.getByLabel('Price / unit (CR)').fill('abc');
  await expect(form.getByText('Enter a price like 12.50')).toBeVisible();
  await form.getByLabel('Price / unit (CR)').fill('3.50');
  await form.getByLabel('Quantity').fill('20');
  await form.getByRole('button', { name: /Place sell order/ }).click();
  await expect(page.getByText('Order placed on the book')).toBeVisible();
  await page.getByTestId('economy-tab-overview').click();
  await expect(page.getByTestId('inv-wood')).toContainText('100');
});
