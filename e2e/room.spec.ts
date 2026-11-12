import { expect, test, type Browser, type Page } from '@playwright/test';

async function person(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  return context.newPage();
}

test('two people share a room: join by link, chat, host handover, reconnect', async ({ browser }) => {
  const nayan = await person(browser);
  await nayan.goto('/');
  await nayan.getByLabel('Your name').fill('Nayan');
  await nayan.getByRole('button', { name: 'Start a room' }).click();
  await expect(nayan).toHaveURL(/\/r\/[2-9A-Z]{6}$/);
  await expect(nayan.getByRole('tab', { name: 'People · 1' })).toBeVisible();

  // The friend opens the shared link and sees the join screen first.
  const riya = await person(browser);
  await riya.goto(nayan.url());
  await expect(riya.getByText('1 person is waiting inside.')).toBeVisible();
  await riya.getByLabel('Your name').fill('Riya');
  await riya.getByRole('button', { name: 'Join room' }).click();
  await expect(nayan.getByRole('tab', { name: 'People · 2' })).toBeVisible();

  // Chat goes both ways.
  await riya.getByLabel('Message').fill('can you see this?');
  await riya.getByLabel('Message').press('Enter');
  await expect(nayan.getByText('can you see this?')).toBeVisible();
  await nayan.getByLabel('Message').fill('yes!');
  await nayan.getByLabel('Message').press('Enter');
  await expect(riya.getByText('yes!')).toBeVisible();

  // Only the host sees host controls.
  await nayan.getByRole('tab', { name: /People/ }).click();
  await riya.getByRole('tab', { name: /People/ }).click();
  await expect(nayan.getByRole('button', { name: 'Make host' })).toBeVisible();
  await expect(riya.getByRole('button', { name: 'Make host' })).toHaveCount(0);

  // A reload reconnects into the same seat and keeps the chat history.
  await riya.reload();
  await riya.getByRole('button', { name: 'Join room' }).click();
  await expect(riya.getByText('can you see this?')).toBeVisible();
  await expect(nayan.getByRole('tab', { name: 'People · 2' })).toBeVisible();

  // When the host leaves, the remaining person becomes host.
  await nayan.getByRole('link', { name: 'Leave room' }).click();
  await riya.getByRole('tab', { name: /People/ }).click();
  await expect(riya.getByRole('tab', { name: 'People · 1' })).toBeVisible();
  await expect(riya.getByText('Host', { exact: true })).toBeVisible();
});

test('an unknown code explains itself', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Your name').fill('Nayan');
  await page.getByLabel('Room code').fill('zzzzzz');
  await page.getByRole('button', { name: 'Join' }).click();
  await expect(page.getByText('No room with that code.')).toBeVisible();

  await page.goto('/r/ZZZZZZ');
  await expect(page.getByRole('heading', { name: 'This room doesn’t exist' })).toBeVisible();
});
