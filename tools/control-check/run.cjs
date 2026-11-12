// Three people (two desktop, one phone-sized with touch) control a real page in the shared browser.
// Usage and requirements: README.md in this folder.
const L = require('./lib.cjs');
const SHIFT = '~!@#$%^&*()_+{}|:"<>?';
const human = async (u, text, delay = 60) => { for (const ch of text) { const sh = (ch >= 'A' && ch <= 'Z') || SHIFT.includes(ch); if (sh) await u.p.keyboard.down('Shift'); await u.p.keyboard.press(ch === ' ' ? 'Space' : ch); if (sh) await u.p.keyboard.up('Shift'); await L.sleep(delay); } await L.sleep(400); };
const lands = async (u, lay, ms = 2500) => { await L.reset(); await L.click(u, lay.btn.x, lay.btn.y); return L.saw((e) => e.ev === 'click' && e.target === 'btn', ms); };
(async () => {
  const b = await L.launch();
  const A = await L.enter(b, 'Nayan'); const B = await L.enter(b, 'Riya', A.p.url()); const C = await L.enter(b, 'Sam', A.p.url(), { phone: true });
  const users = [A, B, C], desk = [A, B];
  await A.p.getByRole('button', { name: 'Open browser' }).click(); await A.p.getByLabel('Owner passphrase').fill(L.PASSPHRASE); await A.p.getByRole('button', { name: 'Open', exact: true }).click();
  try {
    for (const u of users) await u.p.waitForSelector('iframe[title="Shared browser"]', { timeout: 25000 });
    await L.sleep(8000);
    let lay = (await L.nav(A, L.INSIDE + '/')).layout;

    console.log('\n== Everyone mode: each person');
    for (const u of desk) {
      const c = await lands(u, lay); L.check(u.name, 'click lands, accurate', c && Math.abs(c.sx - lay.btn.x) <= 6 && Math.abs(c.sy - lay.btn.y) <= 6, c ? `(${c.sx},${c.sy}) vs (${lay.btn.x},${lay.btn.y})` : 'no click seen');
      await L.reset(); await L.click(u, lay.txt.x, lay.txt.y); await L.press(u, 'Control+a'); const text = `Hi ${u.name}! 2+2=4 @home (A_B) "Q?"`; await human(u, text);
      await L.pull(); const v = L.events().filter((e) => e.ev === 'input').pop()?.value; L.check(u.name, 'types capitals and symbols', v === text, JSON.stringify(v));
      await L.reset(); await L.click(u, lay.lnk.x, lay.lnk.y); L.check(u.name, 'follows a link', await L.saw((e) => e.ev === 'load' && e.page === 'PAGE-TWO', 6000));
      await L.reset(); await L.press(u, 'Alt+ArrowLeft'); L.check(u.name, 'browser Back works', await L.saw((e) => e.ev === 'load' && e.page === 'PAGE-ONE', 6000));
      // video: click toggles play; click on the timeline seeks
      await L.reset(); await L.click(u, lay.vid.x, lay.vid.y); L.check(u.name, 'plays the video by clicking it', await L.saw((e) => e.ev === 'video' && e.what === 'play', 5000));
      await L.sleep(1500); await L.reset(); await L.click(u, lay.vid.left + lay.vid.w * 0.6, lay.vid.bottom - 14);
      const sk = await L.saw((e) => e.ev === 'video' && e.what === 'seeked', 5000); L.check(u.name, 'seeks on the video timeline', sk && sk.t > 5, sk ? `to ${sk.t}s` : '');
      await L.reset(); await L.click(u, lay.vid.x, lay.vid.y - 40); L.check(u.name, 'pauses the video', await L.saw((e) => e.ev === 'video' && e.what === 'pause', 5000));
      // tabs
      await L.reset(); await L.press(u, 'Control+t'); await L.sleep(600); await L.type(u, `${L.INSIDE}/page2?tab=${u.name}`); await L.press(u, 'Enter');
      L.check(u.name, 'opens a new tab and loads a page in it', await L.saw((e) => e.ev === 'load' && e.page === 'PAGE-TWO', 7000));
      await L.reset(); await L.click(u, 130, 18); await L.sleep(500); await L.click(u, lay.btn.x, lay.btn.y);
      const back = await L.saw((e) => e.ev === 'click' && e.target === 'btn', 4000); L.check(u.name, 'switches tabs by clicking the tab strip', back && back.page === 'PAGE-ONE', back ? back.page : 'no click');
      await L.click(u, 380, 18); await L.sleep(400); await L.press(u, 'Control+w'); await L.sleep(600);
    }

    console.log('\n== Phone (touch)');
    lay = (await L.nav(A, L.INSIDE + '/')).layout;
    { const c = await lands(C, lay); L.check('Sam', 'tap lands, accurate', c && Math.abs(c.sx - lay.btn.x) <= 8 && Math.abs(c.sy - lay.btn.y) <= 8, c ? `(${c.sx},${c.sy}) vs (${lay.btn.x},${lay.btn.y})` : 'no click');
      await L.reset(); await L.click(C, lay.vid.left + 24, lay.vid.bottom - 48); let pv = await L.saw((e) => e.ev === 'video' && e.what === 'play', 2500); if (!pv) { await L.click(C, lay.vid.left + 24, lay.vid.bottom - 48); pv = await L.saw((e) => e.ev === 'video' && e.what === 'play', 3000); } L.check('Sam', 'tap on the play button plays the video', pv);
      await L.sleep(1200); await L.reset(); await L.click(C, lay.vid.x, lay.vid.y); await L.sleep(500); await L.click(C, lay.vid.left + 24, lay.vid.bottom - 48); let pp = await L.saw((e) => e.ev === 'video' && e.what === 'pause', 3000); if (!pp) { await L.click(C, lay.vid.left + 24, lay.vid.bottom - 48); pp = await L.saw((e) => e.ev === 'video' && e.what === 'pause', 3000); } L.check('Sam', 'tap on the pause button pauses the video', pp);
      await L.click(C, lay.txt.x, lay.txt.y); const f = C.p.frames().find((x) => x.url().startsWith(process.env.NEKO_URL || L.NEKO)); const kb = f.locator('[data-testid="keyboard-toggle"]');
      L.check('Sam', 'keyboard button appears after taking control', (await kb.count()) === 1);
      if (await kb.count()) { await kb.tap(); await L.sleep(400); await L.reset(); for (const ch of 'hello sam 123') { await C.p.keyboard.insertText(ch); await L.sleep(70); } await L.sleep(900); await L.pull(); const v = L.events().filter((e) => e.ev === 'input').pop()?.value; L.check('Sam', 'on-screen keyboard: lowercase text and digits', v === 'hello sam 123', JSON.stringify(v));
        await L.click(C, lay.txt.x, lay.txt.y); await kb.tap().catch(() => {}); await L.sleep(300); await L.reset(); for (const ch of 'Hello') { await C.p.keyboard.insertText(ch); await L.sleep(70); } await L.sleep(900); await L.pull(); const all = L.events().filter((e) => e.ev === 'input').pop()?.value ?? ''; L.check('Sam', 'on-screen keyboard: capital letters', all.endsWith('Hello'), JSON.stringify(all)); }
      await L.reset(); await L.click(C, lay.lnk.x, lay.lnk.y); L.check('Sam', 'tap follows a link', await L.saw((e) => e.ev === 'load' && e.page === 'PAGE-TWO', 6000)); }

    console.log('\n== Hand-off between people');
    lay = (await L.nav(A, L.INSIDE + '/')).layout;
    L.check('Nayan', 'has control after acting', (await L.hostName()) === 'Nayan');
    L.check('Riya', 'takes over with one click, and it lands', (await lands(B, lay)) && (await L.hostName()) === 'Riya');
    await L.reset(); await human(A, 'zzz'); L.check('Nayan', 'keys ignored once someone else took over', !(await L.saw((e) => e.ev === 'key', 1500)));
    L.check('Sam', 'phone takes over with one tap', (await lands(C, lay)) && (await L.hostName()) === 'Sam');
    L.check('Nayan', 'takes it back', (await lands(A, lay)) && (await L.hostName()) === 'Nayan');

    console.log('\n== One-driver mode');
    await A.p.getByRole('button', { name: 'Room settings' }).click(); await A.p.getByRole('radio', { name: 'One driver' }).click(); await A.p.keyboard.press('Escape'); await L.sleep(1500);
    L.check('Riya', 'click blocked while Nayan drives', !(await lands(B, lay, 1800)));
    L.check('Sam', 'tap blocked while Nayan drives', !(await lands(C, lay, 1800)));
    await L.reset(); await human(B, 'x'); L.check('Riya', 'keys blocked while Nayan drives', !(await L.saw((e) => e.ev === 'key', 1500)));
    L.check('Nayan', 'driver click lands', await lands(A, lay));
    await B.p.getByRole('button', { name: 'Request control' }).click(); await A.p.getByRole('button', { name: /Riya wants control/ }).click(); await L.sleep(1500);
    L.check('Riya', 'after being given control, click lands', await lands(B, lay));
    L.check('Nayan', 'previous driver is now blocked', !(await lands(A, lay, 1800)));
    await A.p.getByRole('button', { name: 'Take control' }).click(); await L.sleep(1500);
    L.check('Nayan', 'host takes control back, click lands', await lands(A, lay));
    L.check('Riya', 'blocked again', !(await lands(B, lay, 1800)));
    await A.p.getByRole('button', { name: 'Room settings' }).click(); await A.p.getByRole('radio', { name: 'Everyone' }).click(); await A.p.keyboard.press('Escape'); await L.sleep(1500);
    L.check('Riya', 'back in Everyone mode, click lands', await lands(B, lay));

    console.log('\n== Robustness');
    await B.p.reload(); await B.p.getByRole('button', { name: 'Join room' }).click(); await B.p.waitForSelector('iframe[title="Shared browser"]', { timeout: 20000 }); await L.sleep(7000);
    const s = await L.streaming(B); L.check('Riya', 'stream returns after reloading her page', s && s.w > 0 && s.t > 0); L.check('Riya', 'can control again after reload', await lands(B, lay));
    // keys typed into the stream must not trigger the room's own shortcuts
    await L.click(B, lay.txt.x, lay.txt.y); await L.reset(); await human(B, 'fc m');
    await L.pull(); const typed = L.events().filter((e) => e.ev === 'input').pop()?.value ?? '';
    L.check('Riya', 'f / c / space typed in the stream reach the website', typed.endsWith('fc m'), JSON.stringify(typed));
    L.check('Riya', '…and do not trigger room shortcuts', (await B.p.getByRole('button', { name: /Copy link/ }).count()) === 1 && !(await B.p.getByLabel('Message').evaluate((el) => el === document.activeElement).catch(() => false)));
    for (const [q, w, h] of [['540p', 960, 540], ['1080p', 1920, 1080], ['720p', 1280, 720]]) {
      await A.p.getByLabel('Stream quality').selectOption(q); await L.sleep(5000); L.screenSize.w = w; L.screenSize.h = h;
      const ld = await L.nav(A, L.INSIDE + '/'); if (!ld) { L.check('Nayan', `${q}: page loads after resize`, false); continue; }
      const c = await lands(B, ld.layout); L.check('Riya', `${q}: click still lands accurately`, c && Math.abs(c.sx - ld.layout.btn.x) <= 8 && Math.abs(c.sy - ld.layout.btn.y) <= 8, c ? `(${c.sx},${c.sy}) vs (${ld.layout.btn.x},${ld.layout.btn.y})` : 'no click');
      const pc = await lands(C, ld.layout); L.check('Sam', `${q}: tap still lands accurately`, pc && Math.abs(pc.sx - ld.layout.btn.x) <= 10 && Math.abs(pc.sy - ld.layout.btn.y) <= 10, pc ? `(${pc.sx},${pc.sy})` : 'no click');
    }
  } finally {
    await A.p.getByRole('button', { name: 'Close browser' }).click().catch(() => {}); await L.sleep(1000); await b.close();
    const bad = L.results.filter((r) => !r.ok); console.log(`\n${L.results.length - bad.length}/${L.results.length} passed`); for (const r of bad) console.log('  FAILED:', r.who, '-', r.what);
  }
})().catch((e) => { console.error('ERROR', String(e.stack || e).slice(0, 900)); process.exit(1); });
