import { expect, test, type Browser, type Page } from '@playwright/test';

async function enter(browser: Browser, name: string, url?: string): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url ?? '/');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: url ? 'Join room' : 'Start a room' }).click();
  await expect(page).toHaveURL(/\/r\/[2-9A-Z]{6}$/);
  return page;
}

const stream = (page: Page) => page.frameLocator('iframe[title="Shared browser"]');

test('the owner opens the shared browser and both people get it', async ({ browser }) => {
  const nayan = await enter(browser, 'Nayan');
  const riya = await enter(browser, 'Riya', nayan.url());

  // A wrong passphrase is refused and nothing starts.
  await riya.getByRole('button', { name: 'Open browser' }).click();
  await riya.getByLabel('Owner passphrase').fill('not-it');
  await riya.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(riya.getByRole('alert')).toHaveText('That passphrase isn’t right.');
  await expect(nayan.getByText('The shared browser is off')).toBeVisible();

  // The right one starts it for everyone, each with their own address.
  await nayan.getByRole('button', { name: 'Open browser' }).click();
  await nayan.getByLabel('Owner passphrase').fill('e2e-passphrase');
  await nayan.getByRole('button', { name: 'Open', exact: true }).click();
  await expect(stream(nayan).getByText('Stand-in browser')).toBeVisible();
  await expect(stream(riya).getByText('Stand-in browser')).toBeVisible();
  const mine = await stream(nayan).getByTestId('member').textContent();
  const theirs = await stream(riya).getByTestId('member').textContent();
  expect(mine).not.toBe(theirs);
  await expect(riya.getByText('Everyone can control')).toBeVisible();

  // Quality is one setting for the whole room.
  await riya.getByLabel('Stream quality').selectOption('540p');
  await expect(nayan.getByLabel('Stream quality')).toHaveValue('540p');

  // One-driver mode: the friend asks, the host gives, the host takes it back.
  await nayan.getByRole('button', { name: 'Room settings' }).click();
  await nayan.getByRole('radio', { name: 'One driver' }).click();
  await nayan.keyboard.press('Escape');
  await expect(riya.getByText('Nayan is controlling')).toBeVisible();
  await expect(riya.getByLabel('Stream quality')).toBeDisabled();
  await riya.getByRole('button', { name: 'Request control' }).click();
  await nayan.getByRole('button', { name: /Riya wants control/ }).click();
  await expect(riya.getByText('You’re controlling')).toBeVisible();
  await nayan.getByRole('button', { name: 'Take control' }).click();
  await expect(riya.getByText('Nayan is controlling')).toBeVisible();

  // Only the host can close it; the passphrase is remembered for next time.
  await expect(riya.getByRole('button', { name: 'Close browser' })).toHaveCount(0);
  await nayan.getByRole('button', { name: 'Close browser' }).click();
  await expect(riya.getByText('The shared browser is off')).toBeVisible();
  await nayan.getByRole('button', { name: 'Open browser' }).click();
  await expect(stream(riya).getByText('Stand-in browser')).toBeVisible();
  await nayan.getByRole('button', { name: 'Close browser' }).click();
});
