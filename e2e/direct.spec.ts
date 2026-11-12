import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page, type Route } from '@playwright/test';

const CLIP = 'https://media.test/clip.webm';
const clip = readFileSync(fileURLToPath(new URL('./fixtures/clip.webm', import.meta.url)));

/** Serves the clip the way a real video host does, including byte ranges (needed for seeking). */
async function serveClip(route: Route): Promise<void> {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers()['range'] ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range?.[2] ? Number(range[2]) : clip.length - 1;
  await route.fulfill({
    status: range ? 206 : 200,
    body: clip.subarray(start, end + 1),
    headers: {
      'Content-Type': 'video/webm',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${clip.length}` } : {}),
    },
  });
}

async function enter(browser: Browser, name: string, url?: string): Promise<Page> {
  const context = await browser.newContext();
  // The 30-second test clip stands in for a video hosted somewhere on the internet.
  await context.route(`${CLIP}*`, serveClip);
  const page = await context.newPage();
  await page.goto(url ?? '/');
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: url ? 'Join room' : 'Start a room' }).click();
  await expect(page).toHaveURL(/\/r\/[2-9A-Z]{6}$/);
  return page;
}

const video = (page: Page) => page.locator('main video').first();
const at = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.currentTime);
const paused = (page: Page) => video(page).evaluate((v: HTMLVideoElement) => v.paused);

test('Direct mode keeps two players in step through play, seek, pause and a late join', async ({ browser }) => {
  const nayan = await enter(browser, 'Nayan');
  const riya = await enter(browser, 'Riya', nayan.url());

  await nayan.getByRole('radio', { name: 'Direct' }).click();
  await expect(riya.getByText('Nothing is loaded')).toBeVisible(); // the mode switch reached her

  await nayan.getByLabel('Video link').fill('not a link');
  await nayan.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(nayan.getByRole('alert')).toContainText('doesn’t look like');

  await nayan.getByLabel('Video link').fill(CLIP);
  await nayan.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(video(riya)).toBeVisible();
  await expect.poll(() => paused(riya)).toBe(true); // loaded, waiting for someone to press play

  // Riya presses play; both start.
  await riya.getByRole('button', { name: 'Play', exact: true }).first().click();
  await expect.poll(() => paused(nayan)).toBe(false);
  await expect.poll(() => paused(riya)).toBe(false);
  await expect(nayan.getByRole('status').filter({ hasText: 'Riya pressed play' })).toBeVisible();
  await nayan.waitForTimeout(3000);
  expect(Math.abs((await at(nayan)) - (await at(riya)))).toBeLessThan(0.5);

  // Nayan jumps ahead with the arrow keys on the seek bar; Riya follows.
  const seek = nayan.getByLabel('Seek');
  await seek.focus();
  for (let i = 0; i < 12; i++) await seek.press('ArrowRight');
  await expect.poll(() => at(riya), { timeout: 8000 }).toBeGreaterThan(11);
  await nayan.waitForTimeout(2500);
  expect(Math.abs((await at(nayan)) - (await at(riya)))).toBeLessThan(0.5);

  // Someone arriving mid-video lands at the same moment.
  const sam = await enter(browser, 'Sam', nayan.url());
  await expect.poll(() => paused(sam).catch(() => true), { timeout: 8000 }).toBe(false);
  await sam.waitForTimeout(2500);
  expect(Math.abs((await at(sam)) - (await at(nayan)))).toBeLessThan(0.5);

  // A pause from anyone pauses everyone at the same spot.
  await riya.getByRole('button', { name: 'Pause' }).click();
  await expect.poll(() => paused(nayan)).toBe(true);
  await expect.poll(() => paused(sam)).toBe(true);
  await nayan.waitForTimeout(500);
  expect(Math.abs((await at(nayan)) - (await at(sam)))).toBeLessThan(0.3);

  // In one-driver mode only the driver has the controls.
  await nayan.getByRole('button', { name: 'Room settings' }).click();
  await nayan.getByRole('radio', { name: 'One driver' }).click();
  await nayan.keyboard.press('Escape');
  await expect(riya.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(riya.getByLabel('Video link')).toHaveCount(0);
});

test('the queue plays the next video when one ends', async ({ browser }) => {
  const nayan = await enter(browser, 'Nayan');
  await nayan.getByRole('radio', { name: 'Direct' }).click();
  await nayan.getByLabel('Video link').fill(CLIP);
  await nayan.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(video(nayan)).toBeVisible();

  await nayan.getByLabel('Video link').fill(`${CLIP}?second`);
  await nayan.getByRole('button', { name: 'Add to queue' }).click();
  await expect(nayan.getByRole('region', { name: 'Up next' }).getByRole('listitem')).toHaveCount(1);

  // Start near the end and let it run out.
  await nayan.getByRole('button', { name: 'Play', exact: true }).first().click();
  const seek = nayan.getByLabel('Seek');
  await expect(seek).toBeEnabled(); // it unlocks once the video's length is known
  await seek.focus();
  await seek.press('End');
  await expect(nayan.getByRole('region', { name: 'Up next' })).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => video(nayan).evaluate((v: HTMLVideoElement) => v.currentSrc)).toContain('?second');
  await expect.poll(() => paused(nayan)).toBe(false);
});

test('two people join the voice call and connect; reactions reach the other person', async ({ browser }) => {
  const nayan = await enter(browser, 'Nayan');
  const riya = await enter(browser, 'Riya', nayan.url());

  await nayan.getByRole('button', { name: 'Join call' }).click();
  await expect(nayan.getByText('Waiting for someone else to join the call')).toBeVisible();
  await expect(nayan.getByRole('button', { name: /Hold to talk/ })).toBeVisible(); // push-to-talk by default

  await riya.getByRole('button', { name: 'Join call' }).click();
  for (const page of [nayan, riya]) {
    await expect(page.getByTestId('call-peer')).toHaveAttribute('data-connected', 'true', { timeout: 15_000 });
  }

  // Audio really arrives: Riya receives a live audio track from Nayan.
  const receiving = () =>
    riya.getByTestId('call-peer').locator('video').evaluate((v: HTMLVideoElement) => {
      const stream = v.srcObject as MediaStream | null;
      return stream?.getAudioTracks().some((t) => t.readyState === 'live') ?? false;
    });
  await expect.poll(receiving).toBe(true);

  // Camera on → the other side gets a picture.
  await nayan.getByRole('button', { name: 'Turn camera on' }).click();
  await expect
    .poll(() => riya.getByTestId('call-peer').locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 10_000 })
    .toBeGreaterThan(0);

  await riya.getByRole('button', { name: 'React 🔥' }).click();
  await expect(nayan.locator('.float-up')).toHaveText('🔥');

  await riya.getByRole('button', { name: 'Leave call' }).click();
  await expect(nayan.getByTestId('call-peer')).toHaveCount(0);
  await expect(riya.getByRole('button', { name: 'Join call' })).toBeVisible();
});
