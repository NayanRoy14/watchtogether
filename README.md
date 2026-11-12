# Watch Together

A room-based site where a few friends share one screen. You start a room, send the
6-character code, and everyone in it sees the same thing with chat alongside. No accounts.

**Status: Phase 4 of 5.** Rooms and chat (Phase 1), the shared-browser server
([`infra/neko`](infra/neko/README.md), Phase 2), the shared browser inside a room (Phase 3),
and now a voice call, emoji reactions and Direct mode (Phase 4). Phase 5 is polish:
quality switch, keyboard shortcuts, installable app, phone layout.

## How it is put together

| Part | Where | What it does |
|---|---|---|
| `apps/web` | React + Vite + Tailwind + Zustand | Home, Join and Room screens |
| `apps/worker` | Cloudflare Worker + Durable Objects | `/api/rooms`, `/ws/:code`; one `Room` object per code |
| `packages/shared` | TypeScript + Zod | Every message shape, room codes, control rules |
| `infra/neko` | Docker Compose + Caddy | The shared Chromium on an Oracle Cloud server |

One Worker serves the built site and the API from the same origin. Each room is a
SQLite-backed Durable Object using hibernating WebSockets, so it costs nothing while idle
and fits the Workers Free plan.

## Run it locally

Needs Node 22+ and pnpm 10.

```bash
pnpm install
```

```bash
pnpm dev
```

To use the "Open browser" button locally, copy `apps/worker/.dev.vars.example` to
`apps/worker/.dev.vars` first. It turns on a stand-in page in place of the real browser,
so no server is needed; the passphrase is `let-me-in`.

Open http://localhost:5173. Vite serves the UI and forwards `/api` and `/ws` to
`wrangler dev` on port 8787. To try it as two people, open the room link in a private
window (a second tab in the same window counts as the same person and takes over the seat).

## Checks

```bash
pnpm lint
```

```bash
pnpm typecheck
```

```bash
pnpm test
```

```bash
pnpm e2e
```

`pnpm test` runs the shared unit tests and the Durable Object tests inside the Workers
runtime. `pnpm e2e` builds the site, starts the Worker and drives two browsers through a
room with Playwright (first run: `pnpm exec playwright install chromium`).

## Deploy

Pushing to `main` runs the checks and then deploys, once these two repository secrets
exist (GitHub → Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — create one in the Cloudflare dashboard with the
  "Edit Cloudflare Workers" template
- `CLOUDFLARE_ACCOUNT_ID` — shown on the Workers overview page

Until they are set, the deploy step skips itself with a warning. To deploy by hand:

```bash
pnpm exec wrangler login
```

```bash
pnpm run deploy
```

The site comes up at `https://watchtogether.<your-subdomain>.workers.dev`.

### Connect the shared browser

After the server from [`infra/neko`](infra/neko/README.md) passes `./verify.sh`, give the
site three secrets (run in `apps/worker`; each command asks for the value):

```bash
pnpm exec wrangler secret put NEKO_URL
```

```bash
pnpm exec wrangler secret put NEKO_ADMIN_TOKEN
```

```bash
pnpm exec wrangler secret put OWNER_PASSPHRASE
```

- `NEKO_URL` — the server's address, e.g. `https://nayan-watch.duckdns.org`
- `NEKO_ADMIN_TOKEN` — the `NEKO_API_TOKEN` line from `infra/neko/.env` on the server
- `OWNER_PASSPHRASE` — any phrase you choose; you type it once per device to open the browser

Then, on the server, allow your site to embed the browser:

```bash
./setup.sh --no-system "" https://watchtogether.<your-subdomain>.workers.dev
```

## The shared browser

- **Opening it** needs the owner passphrase, because the browser keeps the owner's logins.
  Once open, everyone in the room sees and hears it; people who join later are let in
  automatically.
- **One room at a time.** There is a single browser, so a second room that tries to open
  it is told it is in use.
- **Control.** In "Everyone" mode whoever clicks the screen takes over. In "One driver"
  mode one person controls; others press Request control, and the host or current driver
  hands it over. The host can always take it back.
- **Closing.** The host can close it. It also closes itself 2 minutes after the room
  empties. Logins stay saved on the server either way.
- **Private access.** Each person gets their own temporary login to the browser, removed
  when they are kicked, a minute after they leave, or when the browser closes.

## Direct mode

Switch the room from **Browser** to **Direct** in the top bar. Each person then plays the
video on their own device, in full quality, and the room keeps the players in step. It
uses none of the shared browser, so it is the better choice for a long film.

- **What plays:** a YouTube link, a direct video link (`.mp4`, `.webm`, `.m3u8`), or a
  movie file from your device. Anything behind a login belongs in the shared browser.
- **Local files:** nothing is uploaded. Whoever has control picks the file; everyone else
  is asked to pick their own copy. Copies are compared by size and length, and you are
  warned if yours differs.
- **Staying in step:** the room holds one playback state stamped with the server's clock.
  Each player works out where it should be and corrects itself: under 0.3 s off it does
  nothing, up to 1.5 s it plays 5% faster or slower until it catches up, beyond that (and
  always on YouTube) it jumps.
- **Buffering:** if someone's video stalls for more than a second, everyone pauses with
  "Waiting for …" and resumes together. The host can turn this off in room settings.
- **Queue:** add links to "Up next"; the next one starts when a video ends.
- **Who controls:** the same rule as the browser — everyone, or the one driver.

## Voice call

Press **Join call** in the top bar. People in the call connect to each other directly.

- In Browser mode the call starts in **push to talk** (hold the button, or hold `V`), so
  your microphone does not pick up the shared browser's sound. Untick it for an open mic.
  Earphones help either way.
- The camera is off until you turn it on. The call tiles can be dragged out of the way.
- On most networks this needs no setup. For networks that block direct connections, add a
  Cloudflare Realtime TURN key as two more secrets, `TURN_KEY_ID` and `TURN_KEY_TOKEN`
  (`wrangler secret put …` in `apps/worker`). Without them the call simply uses STUN.

## Room rules

- Codes use 31 unambiguous characters (no `0/O`, `1/I/L`) and are shown as `K7M-2QX`.
- Up to 10 people. Whoever created the room is host; if the host leaves, the person who
  has been there longest takes over.
- The host can lock the room, pass the host seat on, remove someone (they cannot rejoin),
  and choose whether everyone or only the host has control.
- The last 200 chat messages are kept; people joining get the latest 50.
- A room is deleted 24 hours after the last person leaves.
- Creating rooms is limited to 10 per IP address per hour.
