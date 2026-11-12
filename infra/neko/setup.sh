#!/usr/bin/env bash
# One-time setup of the shared-browser server (Ubuntu on Oracle Cloud). Safe to run again.
#
#   ./setup.sh <hostname> [site-origin]
#   ./setup.sh nayan-watch.duckdns.org
#   ./setup.sh nayan-watch.duckdns.org https://watchtogether.you.workers.dev
#
#   --no-system   only write .env and start the containers
#                 (skips packages, firewall and SSH changes)
set -euo pipefail
cd "$(dirname "$0")"

SYSTEM=1
ARGS=()
for arg in "$@"; do
  if [ "$arg" = "--no-system" ]; then SYSTEM=0; else ARGS+=("$arg"); fi
done
DOMAIN=${ARGS[0]:-}
ORIGIN=${ARGS[1]:-}

say() { printf '\n==> %s\n' "$*"; }

if [ ! -f .env ] && [ -z "$DOMAIN" ]; then
  echo "Usage: ./setup.sh <hostname> [site-origin]   (see README.md, step 4)" >&2
  exit 1
fi

if [ "$SYSTEM" = 1 ]; then
  say "Installing Docker and firewall tools"
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    ca-certificates curl openssl iptables-persistent unattended-upgrades >/dev/null
  if ! command -v docker >/dev/null; then
    curl -fsSL https://get.docker.com | sudo sh >/dev/null
  fi
  sudo usermod -aG docker "$USER"

  say "Opening ports 80, 443 and 52000 in this machine's firewall"
  # Oracle's Ubuntu images end the INPUT chain with a REJECT rule; ours must sit above it.
  open_port() {
    local proto=$1 port=$2
    if sudo iptables -C INPUT -p "$proto" --dport "$port" -j ACCEPT 2>/dev/null; then return; fi
    local at
    at=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
    if [ -n "$at" ]; then
      sudo iptables -I INPUT "$at" -p "$proto" --dport "$port" -j ACCEPT
    else
      sudo iptables -A INPUT -p "$proto" --dport "$port" -j ACCEPT
    fi
  }
  open_port tcp 80
  open_port tcp 443
  open_port tcp 52000
  open_port udp 52000
  sudo netfilter-persistent save >/dev/null

  say "Turning on automatic security updates"
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' |
    sudo tee /etc/apt/apt.conf.d/20auto-upgrades >/dev/null

  say "SSH: keys only"
  if [ -s "$HOME/.ssh/authorized_keys" ]; then
    printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\n' |
      sudo tee /etc/ssh/sshd_config.d/50-watchtogether.conf >/dev/null
    sudo systemctl reload ssh
  else
    echo "    Skipped: no SSH key found for $USER, so password login is left alone."
  fi

  say "Weekly backup of the browser profile (Sundays 03:17)"
  echo "17 3 * * 0 $USER $PWD/backup.sh >/dev/null 2>&1" | sudo tee /etc/cron.d/watchtogether-backup >/dev/null
fi

say "Writing .env"
if [ ! -f .env ]; then
  ip=$(curl -4 -fsS -m 10 https://checkip.amazonaws.com | tr -d '[:space:]') || ip=""
  if [ -z "$ip" ]; then
    echo "Could not detect the public IP. Copy .env.example to .env and fill it in by hand." >&2
    exit 1
  fi
  umask 077
  {
    echo "NEKO_DOMAIN=$DOMAIN"
    echo "PUBLIC_IP=$ip"
    echo "SITE_ORIGIN=${ORIGIN:-https://not-set.invalid}"
    echo "NEKO_API_TOKEN=$(openssl rand -hex 32)"
  } > .env
  echo "    Created (public IP $ip)."
else
  # Keep the existing token; only update what was passed in.
  [ -n "$DOMAIN" ] && sed -i "s|^NEKO_DOMAIN=.*|NEKO_DOMAIN=$DOMAIN|" .env
  [ -n "$ORIGIN" ] && sed -i "s|^SITE_ORIGIN=.*|SITE_ORIGIN=$ORIGIN|" .env
  echo "    Kept the existing file."
fi

say "Preparing data folders"
mkdir -p data/profile data/members
# The browser inside the container runs as user 1000.
if [ "$(stat -c %u data/profile)" != 1000 ]; then sudo chown -R 1000:1000 data; fi

say "Starting the browser"
# shellcheck disable=SC1091
. ./lib.sh
compose pull -q
compose up -d

cat <<DONE

Done. Next:
  ./verify.sh                      check everything is wired up
  ./member.sh add you --admin      make yourself a login
  ./member.sh add friend           and one for a friend
DONE
