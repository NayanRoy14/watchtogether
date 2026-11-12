// Helpers for the control check. See README.md in this folder.
const { chromium, devices } = require('@playwright/test');
const SITE = process.env.SITE || 'http://localhost:8787'; // the Watch Together site
const NEKO = process.env.NEKO_API || 'http://127.0.0.1:8080'; // neko's admin API
const TP = 'http://localhost:9000'; // the recording page, as this machine reaches it
const INSIDE = process.env.PAGE_URL || 'http://172.18.0.1:9000'; // the same page, as the shared browser reaches it
const PASSPHRASE = process.env.OWNER_PASSPHRASE || 'real-pass';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let events = [];
const pull = async () => { const fresh = await (await fetch(TP + '/dump?clear=1')).json(); events.push(...fresh); return fresh; };
const reset = async () => { await pull(); events = []; };
/** Wait until the test page has reported an event matching `pred` (since the last reset). */
const saw = async (pred, ms = 6000) => { const end = Date.now() + ms; for (;;) { await pull(); const hit = events.find(pred); if (hit) return hit; if (Date.now() > end) return null; await sleep(200); } };
const results = [];
const check = (who, what, ok, note = '') => { results.push({ who, what, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${who.padEnd(7)} ${what}${note ? '  — ' + note : ''}`); return !!ok; };
const screenSize = { w: 1280, h: 720 };
const frameBox = (p) => p.locator('iframe[title="Shared browser"]').boundingBox();
/** Screen coordinates inside the shared browser → coordinates on this person's page. */
const at = async (p, sx, sy) => { const b = await frameBox(p); return [b.x + (sx / screenSize.w) * b.width, b.y + (sy / screenSize.h) * b.height]; };
const click = async (u, sx, sy) => { const [x, y] = await at(u.p, sx, sy); if (u.touch) await u.p.touchscreen.tap(x, y); else { await u.p.mouse.move(x, y); await u.p.mouse.click(x, y); } await sleep(350); };
const SHIFT = '~!@#$%^&*()_+{}|:"<>?';
/** Type the way a person does: hold Shift for capitals and shifted symbols. */
const type = async (u, text, delay = 55) => { for (const ch of text) { const sh = (ch >= 'A' && ch <= 'Z') || SHIFT.includes(ch); if (sh) await u.p.keyboard.down('Shift'); await u.p.keyboard.press(ch === ' ' ? 'Space' : ch); if (sh) await u.p.keyboard.up('Shift'); await sleep(delay); } await sleep(400); };
const press = async (u, key) => { await u.p.keyboard.press(key); await sleep(300); };
const nekoApi = async (path) => (await fetch(NEKO + path, { headers: { Authorization: 'Bearer ' + process.env.TOKEN } })).json();
const hostName = async () => { const c = await nekoApi('/api/room/control'); if (!c.has_host) return null; const s = await nekoApi('/api/sessions'); return s.find((x) => x.id === c.host_id)?.profile.name ?? c.host_id; };
const launch = () => chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const enter = async (b, name, url, opts = {}) => {
  const ctx = await b.newContext(opts.phone ? { ...devices['Pixel 7'] } : { viewport: { width: 1360, height: 820 } });
  const p = await ctx.newPage();
  await p.goto(url || SITE); await p.getByLabel('Your name').fill(name);
  await p.getByRole('button', { name: url ? 'Join room' : 'Start a room' }).click(); await p.waitForURL(/\/r\//);
  return { name, p, ctx, touch: !!opts.phone };
};
const streaming = async (u) => { const f = u.p.frames().find((x) => x.url().startsWith(process.env.NEKO_URL || NEKO)); if (!f) return null; return f.evaluate(() => { const v = document.querySelector('video'); if (!v) return null; const s = v.srcObject; return { w: v.videoWidth, h: v.videoHeight, t: v.currentTime, audio: s ? s.getAudioTracks().filter((t) => t.readyState === 'live').length : 0 }; }).catch(() => null); };
module.exports = { SITE, TP, INSIDE, NEKO, PASSPHRASE, sleep, pull, reset, saw, check, results, screenSize, frameBox, at, click, type, press, nekoApi, hostName, launch, enter, streaming, events: () => events };
/** Go to a URL through the address bar, as a person would. Returns the page's load report. */
module.exports.nav = async (u, url) => {
  const L = module.exports;
  for (let attempt = 0; attempt < 3; attempt++) {
    await L.reset(); await L.click(u, 640, 420); await L.press(u, 'Escape'); await L.press(u, 'Control+l'); await L.sleep(300);
    await L.type(u, `${url}${url.includes('?') ? '&' : '?'}n=${Date.now() % 100000}`); await L.press(u, 'Enter');
    const hit = await L.saw((e) => e.ev === 'load', 7000); if (hit) return hit;
    console.log(`  (navigation attempt ${attempt + 1} by ${u.name} did not load; host=${await L.hostName()})`);
  }
  return null;
};
