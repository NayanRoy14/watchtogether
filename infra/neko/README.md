# The shared browser server

One real Chromium ([neko](https://github.com/m1k1o/neko)) running on a free Oracle Cloud
server and streamed to everyone in a room. This folder is everything that server needs.

At the end of this guide you and a friend can both open one URL, see the same browser,
and either of you can click in it. Connecting it to the Watch Together site is covered in
the [main README](../../README.md#connect-the-shared-browser).

## What you need

- A card for Oracle's identity check (nothing is charged on Always Free)
- An SSH key (`ssh-keygen -t ed25519` if you have none)
- About an hour

## 1. Oracle account

Sign up at <https://www.oracle.com/cloud/free/>. When asked for a **home region**, pick
**India South (Hyderabad)** or **India West (Mumbai)**. It cannot be changed later, and
Always Free servers can only be created there.

## 2. Create the server

Console → **Compute → Instances → Create instance**:

| Setting | Value |
|---|---|
| Image | Canonical Ubuntu 24.04 (the **aarch64** build) |
| Shape | Ampere → **VM.Standard.A1.Flex**, 2 OCPU, 12 GB memory |
| Networking | Create a new VCN and public subnet; **assign a public IPv4 address** |
| SSH keys | Paste your public key |
| Boot volume | Custom size, 100 GB |

If it says **"Out of capacity"**, that is Oracle running short of free Arm machines, not
something you did. Try again at a different hour, or try another availability domain.

Note the instance's **public IP address**.

## 3. Open the ports (Oracle's firewall)

Oracle has its own firewall in front of the server, separate from the one on the machine.
Console → your instance → **Subnet** → **Security List** → **Add Ingress Rules**, source
`0.0.0.0/0` for each:

| Protocol | Port | For |
|---|---|---|
| TCP | 80 | getting the HTTPS certificate |
| TCP | 443 | the browser page |
| UDP | 52000 | video and sound |
| TCP | 52000 | video and sound when UDP is blocked |

Port 22 (SSH) is already open.

## 4. Give it a name

HTTPS needs a hostname. Any free one works; [DuckDNS](https://www.duckdns.org) takes a
minute: sign in, choose a subdomain such as `nayan-watch`, and set its IP to the server's
public IP. You now have `nayan-watch.duckdns.org`. (DigitalPlat and is-a.dev also work:
create an **A record** pointing at the same IP.)

## 5. Install

```bash
ssh ubuntu@YOUR_PUBLIC_IP
```

```bash
git clone https://github.com/NayanRoy14/watchtogether.git
```

```bash
cd watchtogether/infra/neko
```

```bash
./setup.sh nayan-watch.duckdns.org
```

The script installs Docker, opens the same four ports in the machine's own firewall, turns
on automatic security updates, switches SSH to keys only, schedules a weekly backup, writes
`.env` (with a freshly generated admin token) and starts the browser. It is safe to run
again.

Then check it:

```bash
./verify.sh
```

Every line should say `PASS`. Each `FAIL` says what to fix.

## 6. Try it with a friend

Make two logins:

```bash
./member.sh add nayan --admin
```

```bash
./member.sh add riya
```

Each prints a link. Open yours; send the other to a friend **on a different network**
(mobile data is the best test). You should both see the same Chromium. Click on the screen
to take control; open YouTube and play something; check you both hear it.

Then the test that matters for college:

1. Log into your LMS in the shared browser.
2. Restart it: `docker compose restart neko`
3. Reload the page. The LMS tab should come back, still logged in.

When that works, Phase 2 is done. Remove the test logins with `./member.sh rm riya`.

## Keeping it alive

**Idle reclaim.** Oracle may reclaim Always Free servers that sit almost unused for 7
days. The usual fix is to upgrade the account to **Pay As You Go** (Billing → Upgrade and
Manage Payment). It stays free as long as you only use Always Free resources, and upgraded
accounts are not reclaimed.

**Backups.** `backup.sh` runs every Sunday and keeps the last four copies of the browser
profile in `~/neko-backups`. Run it by hand any time. Restore steps are at the top of that
file. The backups contain your logged-in sessions, so treat them like passwords.

**Updates.** `docker compose pull && docker compose up -d` fetches the newest neko and
Chromium. Your logins are on disk in `data/profile`, so they survive.

## What is locked down

- The browser page only loads inside a frame from `SITE_ORIGIN` in `.env` (set it once the
  site is deployed: `./setup.sh --no-system "" https://your-site.workers.dev`).
- There are no standing accounts. Logins exist only while you create them with
  `member.sh`; later the room server creates one per person and deletes it afterwards.
- Inside Chromium, the password manager, autofill, DevTools, downloads, extensions and
  the cookie settings pages are switched off (`policies.json`), so someone with control
  cannot read a saved password or copy your session. They **can** still see and use any
  page you are logged into, so only log into things you are happy to share.
- The admin API is reachable only from the server itself (`127.0.0.1:8080`).

## Bookmarks

Edit `policies.json` → `ManagedBookmarks` and replace the example LMS address with your
college's, then `docker compose restart neko`.

## When something is wrong

| What you see | Likely cause |
|---|---|
| Page loads, screen stays black or "connecting" forever | UDP/TCP 52000 missing from the Oracle security list (step 3), or `PUBLIC_IP` in `.env` is wrong (`verify.sh` checks this) |
| Browser warns about the certificate, or the page will not load | The hostname does not point at the server yet, or port 80/443 is closed. `docker compose logs caddy` shows the reason |
| Logged out after a restart | `data/profile` is not writable: `sudo chown -R 1000:1000 data && docker compose restart neko` |
| Choppy video | Check `docker stats`. If neko is pinned near 200% CPU, pick 540p in the room's quality menu, or lower `NEKO_DESKTOP_SCREEN` in `docker-compose.yml` to `1280x720@24` |
| Netflix / Prime / Hotstar will not play | Expected: DRM does not work in this browser |
