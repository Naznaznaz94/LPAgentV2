#!/usr/bin/env bash
# Set up the agent on a fresh Ubuntu VPS (22.04 or 24.04). Safe to run again: a second run updates the code,
# reinstalls the packages and restarts the agent if it was running.
#
#   curl -fsSLO https://raw.githubusercontent.com/Naznaznaz94/LPAgentV2/main/deploy/vps-setup.sh && bash vps-setup.sh
#
# It installs Node.js 22, closes every port except SSH, creates a `meridian` system user, puts the code in
# /opt/meridian and adds a systemd service that restarts the agent after a crash or a reboot.
#
# It never starts trading. The first run writes .env with empty keys and DRY_RUN=true, and user-config.json with
# "dryRun": true and sizes for a small (~3 SOL) test wallet. You fill in the keys, and the service only runs once
# you start it. Going live needs both switches set to false by you.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Naznaznaz94/LPAgentV2.git}"
APP_DIR="${APP_DIR:-/opt/meridian}"
APP_USER="${APP_USER:-meridian}"
SERVICE="${SERVICE:-meridian}"
NODE_MAJOR=22

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
say() { printf '\n== %s\n' "$*"; }

say "System packages"
$SUDO apt-get update -y
$SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg git ufw sudo
as_app() { sudo -u "$APP_USER" -H -- "$@"; }

# npm ci needs more than 1 GB of memory on the smallest plans
if [ "$(awk '/MemTotal/ {print $2}' /proc/meminfo)" -lt 1500000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  say "Adding 2 GB swap (small plan)"
  $SUDO fallocate -l 2G /swapfile
  $SUDO chmod 600 /swapfile
  $SUDO mkswap /swapfile >/dev/null
  $SUDO swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' | $SUDO tee -a /etc/fstab >/dev/null
fi

say "Node.js $NODE_MAJOR"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  $SUDO install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | $SUDO gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" \
    | $SUDO tee /etc/apt/sources.list.d/nodesource.list >/dev/null
  $SUDO apt-get update -y
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
echo "node $(node -v), npm $(npm -v)"

say "Firewall: SSH in, nothing else"
$SUDO ufw allow OpenSSH >/dev/null
$SUDO ufw --force enable >/dev/null
$SUDO ufw status | head -n 6

say "User '$APP_USER' and code in $APP_DIR"
id "$APP_USER" >/dev/null 2>&1 || $SUDO useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
if [ -d "$APP_DIR/.git" ]; then
  as_app git -C "$APP_DIR" pull --ff-only
else
  $SUDO install -d -o "$APP_USER" -g "$APP_USER" -m 0755 "$APP_DIR"
  as_app git clone "$REPO_URL" "$APP_DIR"
fi
as_app git -C "$APP_DIR" log -1 --format='code at %h  %s'

say "Packages"
as_app bash -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund"

say "Tests of the safety rules"
as_app bash -c "cd '$APP_DIR' && node --test test/test-guards.js" | tail -n 8

ENV_FILE="$APP_DIR/.env"
if [ ! -f "$ENV_FILE" ]; then
  say "Writing $ENV_FILE (empty keys, dry run on)"
  as_app tee "$ENV_FILE" >/dev/null <<'EOF'
# Fill in with:  sudo -u meridian nano /opt/meridian/.env
# Never paste these into a chat, a screenshot or a git commit.

# A NEW wallet made only for this bot, holding only the test SOL. Base58 private key.
WALLET_PRIVATE_KEY=

# Solana RPC, for example https://mainnet.helius-rpc.com/?api-key=YOUR_KEY (a free Helius key is enough)
RPC_URL=
HELIUS_API_KEY=

# LLM key from https://openrouter.ai (a few dollars of credit)
OPENROUTER_API_KEY=

# Jupiter key from https://portal.jup.ag, used to sell leftover tokens after a close
JUPITER_API_KEY=

# Telegram alerts and control (recommended on a VPS). Bot token from @BotFather. Put your own numeric user id
# (ask @userinfobot) in both TELEGRAM_CHAT_ID and TELEGRAM_ALLOWED_USER_IDS so only you can control the bot.
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
TELEGRAM_ALLOWED_USER_IDS=

# true = nothing is traded. Going live needs this AND "dryRun" in user-config.json set to false.
DRY_RUN=true
EOF
fi
as_app chmod 600 "$ENV_FILE"

CFG="$APP_DIR/user-config.json"
if [ ! -f "$CFG" ]; then
  say "Writing $CFG (dry run, ~3 SOL test sizes)"
  # Sizes: two positions of about 1-1.2 SOL, 0.3 SOL kept for fees and the (refundable) rent of a wide position,
  # and a hard cap of 1.5 SOL per position. Screening window 4h: volume and fee/TVL are measured over the window,
  # so they are scaled (500 / 0.05 per 5m -> 6000 / 0.6 per 4h). On 25 Nov 2026 that let 8 pools through
  # discovery instead of 3. Market cap 150K-10M and bin step 80-125 stay as they are.
  as_app node -e '
    const fs = require("fs");
    const dir = process.argv[1];
    const c = JSON.parse(fs.readFileSync(dir + "/user-config.example.json", "utf8"));
    Object.assign(c, {
      dryRun: true,
      rpcUrl: "",
      deployAmountSol: 1.0,
      maxPositions: 2,
      positionSizePct: 0.45,
      gasReserve: 0.3,
      minSolToOpen: 1.3,
      maxDeployAmount: 1.5,
      timeframe: "4h",
      minVolume: 6000,
      minFeeActiveTvlRatio: 0.6,
    });
    fs.writeFileSync(dir + "/user-config.json", JSON.stringify(c, null, 2) + "\n");
  ' "$APP_DIR"
fi
as_app chmod 600 "$CFG"

say "systemd service '$SERVICE'"
NODE_BIN="$(command -v node)"
$SUDO tee "/etc/systemd/system/$SERVICE.service" >/dev/null <<EOF
[Unit]
Description=Meridian DLMM LP agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
Type=simple
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN index.js
Restart=always
RestartSec=30
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE" >/dev/null 2>&1

if $SUDO systemctl is-active --quiet "$SERVICE"; then
  $SUDO systemctl restart "$SERVICE"
  say "Updated and restarted. Watch it with:  journalctl -u $SERVICE -f"
  exit 0
fi

cat <<EOF

== Done. Nothing is running yet. Next:
  1. Fill in the keys:      sudo -u $APP_USER nano $ENV_FILE
  2. Look at the sizes:     sudo -u $APP_USER nano $CFG
  3. Start in dry run:      sudo systemctl start $SERVICE
  4. Watch it:              journalctl -u $SERVICE -f
  5. Stop it:               sudo systemctl stop $SERVICE
  6. Update later:          sudo bash $APP_DIR/deploy/vps-setup.sh
EOF
