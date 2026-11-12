# Control check

Proves that several people can really control websites in the shared browser. Three
people join one room (two desktop, one phone-sized with touch) and each clicks, types,
scrolls, follows links, uses tabs and the address bar, and plays a video on a page that
records every input it receives. It then checks hand-offs, one-driver mode, reloading,
and each stream quality.

It needs a real neko, so it is not part of `pnpm test`.

## Run it locally

1. Start neko from `infra/neko` (for a local trial: `.env` with `NEKO_DOMAIN=localhost`,
   `PUBLIC_IP=127.0.0.1`, then `docker compose up -d`).
2. Start the site against it, from `apps/worker`:

   ```bash
   pnpm exec wrangler dev --port 8787 --var NEKO_URL:http://127.0.0.1:8080 --var NEKO_ADMIN_TOKEN:<NEKO_API_TOKEN from infra/neko/.env> --var OWNER_PASSPHRASE:real-pass --var ROOM_CREATE_LIMIT:1000
   ```

3. Start the recording page:

   ```bash
   node tools/control-check/page-server.cjs
   ```

4. Run the check:

   ```bash
   TOKEN=<NEKO_API_TOKEN> node tools/control-check/run.cjs
   ```

`PAGE_URL` is the address the shared browser uses to reach the recording page; the
default is Docker's bridge gateway, `http://172.18.0.1:9000`.

## Expected result

Everything passes except one line: **"on-screen keyboard: capital letters"**. neko types a
capital letter correctly only when it arrives with a Shift key press, which physical
keyboards send and phone keyboards do not. Lowercase letters and digits from a phone work.
