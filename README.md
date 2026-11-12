# Watch Together

A room-based site where a few friends share one screen. You start a room, send the
6-character code, and everyone in it sees the same thing with chat alongside. No accounts.

**Status: Phase 1 of 5.** Rooms, people list, chat, host controls and reconnection work.
The shared browser (Phase 2–3), voice call and Direct mode (Phase 4) are not built yet.

## How it is put together

| Part | Where | What it does |
|---|---|---|
| `apps/web` | React + Vite + Tailwind + Zustand | Home, Join and Room screens |
| `apps/worker` | Cloudflare Worker + Durable Objects | `/api/rooms`, `/ws/:code`; one `Room` object per code |
| `packages/shared` | TypeScript + Zod | Every message shape, room codes, control rules |

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

## Room rules

- Codes use 31 unambiguous characters (no `0/O`, `1/I/L`) and are shown as `K7M-2QX`.
- Up to 10 people. Whoever created the room is host; if the host leaves, the person who
  has been there longest takes over.
- The host can lock the room, pass the host seat on, remove someone (they cannot rejoin),
  and choose whether everyone or only the host has control.
- The last 200 chat messages are kept; people joining get the latest 50.
- A room is deleted 24 hours after the last person leaves.
- Creating rooms is limited to 10 per IP address per hour.
