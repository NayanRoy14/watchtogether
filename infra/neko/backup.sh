#!/usr/bin/env bash
# Saves the browser profile (your logins) to ~/neko-backups and keeps the newest 4.
# Restore:  docker compose stop neko
#           sudo tar -xzf ~/neko-backups/<file>.tar.gz -C data
#           docker compose start neko
set -euo pipefail
cd "$(dirname "$0")"

dest="$HOME/neko-backups"
mkdir -p "$dest"
chmod 700 "$dest"
file="$dest/profile-$(date +%Y%m%d-%H%M%S).tar.gz"

# Caches are large and rebuild themselves.
tar -czf "$file" -C data \
  --exclude='Cache' --exclude='Code Cache' --exclude='GPUCache' --exclude='*.tmp' \
  --warning=no-file-changed profile || [ $? = 1 ]
chmod 600 "$file"

ls -1t "$dest"/profile-*.tar.gz | tail -n +5 | xargs -r rm --
echo "Saved $file ($(du -h "$file" | cut -f1))"
