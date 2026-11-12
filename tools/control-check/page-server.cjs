// Serves the input-recording page to the shared browser and collects what it reports.
const http = require('http'); const fs = require('fs');
const clip = fs.readFileSync(process.argv[2] || require('path').join(__dirname, '../../e2e/fixtures/clip.webm')); let log = [];
const page = (title) => `<!doctype html><meta charset=utf-8><title>${title}</title>
<body style="margin:0;font:16px sans-serif;background:#fff;color:#000;height:3000px">
<div style="position:fixed;top:0;left:0;right:0;background:#eee;padding:8px;z-index:2"><b>${title}</b> <span id=last></span></div>
<button id=btn style="position:absolute;left:100px;top:80px;width:200px;height:80px;font-size:24px">BUTTON</button>
<input id=txt style="position:absolute;left:400px;top:90px;width:400px;height:50px;font-size:22px" placeholder="type here">
<video id=vid src="/clip.webm" controls style="position:absolute;left:100px;top:200px;width:480px;height:270px;background:#000"></video>
<a id=lnk href="/page2" style="position:absolute;left:900px;top:100px;font-size:24px">LINK TO PAGE 2</a>
<script>
const send = (e) => { document.getElementById('last').textContent = JSON.stringify(e); fetch('/log', { method: 'POST', body: JSON.stringify({ page: document.title, ...e }) }); };
const off = () => ({ ox: window.screenX + (window.outerWidth - window.innerWidth) / 2, oy: window.screenY + (window.outerHeight - window.innerHeight) });
const layout = () => { const o = off(), r = {}; for (const id of ['btn', 'txt', 'vid', 'lnk']) { const b = document.getElementById(id).getBoundingClientRect(); r[id] = { x: Math.round(o.ox + b.left + b.width / 2), y: Math.round(o.oy + b.top + b.height / 2), w: b.width, h: b.height, left: Math.round(o.ox + b.left), bottom: Math.round(o.oy + b.bottom) }; } return r; };
addEventListener('pageshow', (e) => e.persisted && send({ ev: 'load', restored: true, layout: layout() }));
addEventListener('load', () => send({ ev: 'load', layout: layout(), inner: [innerWidth, innerHeight], screen: [screen.width, screen.height] }));
addEventListener('click', (e) => send({ ev: 'click', sx: e.screenX, sy: e.screenY, target: e.target.id || e.target.tagName }), true);
for (const n of ['pointerdown', 'pointerup', 'touchstart', 'mousedown']) addEventListener(n, (e) => send({ ev: n, type: e.pointerType || '', sx: Math.round(e.screenX ?? e.touches?.[0]?.screenX ?? -1), sy: Math.round(e.screenY ?? e.touches?.[0]?.screenY ?? -1), target: e.target.id || e.target.tagName }), true);
addEventListener('keydown', (e) => send({ ev: 'key', key: e.key, target: e.target.id || e.target.tagName }), true);
document.getElementById('txt').addEventListener('input', (e) => send({ ev: 'input', value: e.target.value }));
let st; addEventListener('scroll', () => { clearTimeout(st); st = setTimeout(() => send({ ev: 'scroll', y: Math.round(scrollY) }), 150); });
const v = document.getElementById('vid'); for (const n of ['play', 'pause', 'seeked']) v.addEventListener(n, () => send({ ev: 'video', what: n, t: +v.currentTime.toFixed(1) }));
</script>`;
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/log' && req.method === 'POST') { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { log.push({ at: Date.now(), ...JSON.parse(b) }); res.end('ok'); }); return; }
  if (u.pathname === '/dump') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(log)); if (u.searchParams.get('clear')) log = []; return; }
  if (u.pathname === '/clip.webm') { const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const s = m ? +m[1] : 0, e = m && m[2] ? +m[2] : clip.length - 1; res.writeHead(m ? 206 : 200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': e - s + 1, ...(m ? { 'content-range': `bytes ${s}-${e}/${clip.length}` } : {}) }); res.end(clip.subarray(s, e + 1)); return; }
  res.setHeader('content-type', 'text/html'); res.end(page(u.pathname === '/page2' ? 'PAGE-TWO' : 'PAGE-ONE'));
}).listen(9000, '0.0.0.0');
