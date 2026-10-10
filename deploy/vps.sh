#!/usr/bin/env bash
#
# Installe Edge sur un VPS Ubuntu/Debian 24.04 (le creneau « Always Free » d'Oracle,
# une vieille machine, un Raspberry Pi 4). Le script ne touche qu'a /opt/edge-bot,
# /etc/edge-bot.env et /etc/systemd/system/edge-bot.service.
#
# A savoir : a chaque execution, le code de /opt/edge-bot est remis a plat sur la
# branche choisie (git reset --hard). Ne bricole pas dans /opt/edge-bot : travaille
# dans le repo, pousse, relance ce script.
#
#   sudo bash deploy/vps.sh
#
set -euo pipefail

REPO="${REPO:-https://github.com/Snowoo-2z/edge-bot.git}"
BRANCH="${BRANCH:-main}"
DIR=/opt/edge-bot
USER=edgebot

if [[ $EUID -ne 0 ]]; then echo "Lance-moi en root : sudo bash deploy/vps.sh"; exit 1; fi

echo "▸ Node 22"
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  apt-get update -qq
  apt-get install -yqq ca-certificates curl git
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -yqq nodejs
fi
node -v

echo "▸ utilisateur sans privileges"
id -u "$USER" >/dev/null 2>&1 || adduser --system --group --no-create-home --shell /usr/sbin/nologin "$USER"

echo "▸ code ($BRANCH)"
if [[ -d $DIR/.git ]]; then
  git -C "$DIR" fetch --depth 1 origin "$BRANCH" && git -C "$DIR" reset --hard "origin/$BRANCH"
else
  git clone --depth 1 -b "$BRANCH" "$REPO" "$DIR"
fi
mkdir -p "$DIR/data"

echo "▸ dependances + build"
cd "$DIR"
npm ci --no-audit --no-fund
npm run build

echo "▸ fichier d'environnement"
if [[ ! -f /etc/edge-bot.env ]]; then
  cat > /etc/edge-bot.env <<'ENV'
DISCORD_TOKEN=
DATABASE_URL=
GUILD_ID=1558076024778919946
EDGE_REQUIRE_MESSAGE_CONTENT=true
EDGE_LOG_LEVEL=info
ENV
  chmod 600 /etc/edge-bot.env
  chown root:root /etc/edge-bot.env
  echo "  ⚠  edite /etc/edge-bot.env (token + DATABASE_URL) puis relance ce script"
  echo "     nano /etc/edge-bot.env"
  exit 2
fi
grep -q '^DISCORD_TOKEN=..\+' /etc/edge-bot.env || { echo "  ⚠  DISCORD_TOKEN est vide dans /etc/edge-bot.env"; exit 2; }

echo "▸ systemd"
cp "$DIR/deploy/edge-bot.service" /etc/systemd/system/edge-bot.service
systemctl daemon-reload
systemctl enable --now edge-bot
sleep 3
chown -R "$USER:$USER" "$DIR/data"

echo "▸ etat"
systemctl --no-pager --lines=15 status edge-bot | sed -n '1,20p' || true
echo
echo "Journal en direct :   journalctl -u edge-bot -f"
echo "Redemarrage manuel :  systemctl restart edge-bot"
echo "Mise a jour :         sudo bash deploy/vps.sh   (rebuild + restart)"
