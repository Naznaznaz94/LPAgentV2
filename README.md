# Meridian

**Autonomous Meteora DLMM liquidity management agent for Solana, powered by LLMs.**

Meridian runs continuous screening and management cycles, deploying capital into high-quality Meteora DLMM pools and closing positions based on live PnL, yield, and range data. It learns from every position it closes.

---

## What it does

- **Screens pools** — scans Meteora DLMM pools against configurable thresholds (fee/TVL ratio, organic score, holder count, mcap, bin step) and surfaces high-quality opportunities
- **Manages positions** — monitors, claims fees, and closes LP positions autonomously; decides to STAY, CLOSE, or REDEPLOY based on live data
- **Learns from performance** — studies top LPers in target pools, saves structured lessons, and evolves screening thresholds based on closed position history
- **Discord signals** — optional Discord listener watches LP Army channels for Solana token calls and queues them for screening
- **Telegram chat** — full agent chat via Telegram, plus cycle reports and OOR alerts
- **Claude Code integration** — run AI-powered screening and management directly from your terminal using Claude Code slash commands

---

## How it works

Meridian runs a **ReAct agent loop** — each cycle the LLM reasons over live data, calls tools, and acts. Two specialized agents run on independent cron schedules:

| Agent | Default interval | Role |
|---|---|---|
| **Screening Agent** | Every 30 min | Pool screening — finds and deploys into the best candidate |
| **Management Agent** | Every 10 min | Position management — evaluates each open position and acts |

**Data sources:**
- `@meteora-ag/dlmm` SDK — on-chain position data, active bin, deploy/close transactions
- Meteora DLMM data API (`dlmm.datapi.meteora.ag`, free, no key) — open positions, position yield and PnL, and
  the pool's own candles in SOL, which the entry rule is measured on
- OKX OnchainOS — smart money signals, token risk scoring
- Pool screening API — fee/TVL ratios, volume, organic scores, holder counts
- Jupiter API — token audit, mcap, launchpad, price stats

Agents are powered via **OpenRouter** and can be swapped for any compatible model.

### The default setup: wait for the pullback, deep range, leave on the bounce

All three parts are enforced in code (`guards.js`); the model only picks which of the passing pools to enter.

| Step | Rule | Why |
|---|---|---|
| **Entry** | Not at the top. A pool is offered only when its price is **20–30% below its 24h high** and has **stopped making new lows** (no new low for 15 min and at least +2% off the low). A token down more than 50% from its 3-day high is skipped. | A SOL-only range starts buying at the entry price. Opened at the high, the first bins buy the day's most expensive tokens and an ordinary pullback already puts the position under water. Opened after the pullback, it buys from a lower price and a retest of the low lands inside the range. |
| **Range** | SOL only, bottom **60–70% below the entry price**: the deep end for volatile pools and for market caps under $3M. Converted to bins for the pool's bin step (−60% at bin step 100 = 93 bins, −70% = 121). | Entering after a pullback means entering at a lower market cap, where falls are deeper. −65% below a price that is already 25% off the high reaches about −74% from the high. |
| **Shape** | `bid_ask`: most of the SOL sits in the lower bins. | On a deep range it is the low-risk shape: a 40% fall into a −70% range costs about 3% of the position before fees with `bid_ask`, about 9% with `spot`. The price: fewer fees while price chops near the top of the range. |
| **Exit** | Stop loss at −15% PnL (about three quarters of the way down a −70% `bid_ask` range). Trailing take-profit. **Bounce exit**: once price has been past half of the range, the first +10% bounce off the low closes the position (+6% once it has been past three quarters). Price above the range (idle, all SOL): closed after 120 min. | "Let it dump, leave on the bounce." Waiting for a full recovery from deep in the range is where the large losses come from. |

The high is the highest candle *body* in the window, not the wick, and is read from the pool's own candles on
Meteora (SOL per token). If Meteora has no candles for a pool, OKX's 24h high is used instead, with the direction
of the last price step standing in for "has it stopped falling". With neither, the pool is skipped.

To go back to the old behaviour set `"entryMode": "momentum"` and `"rangeMode": "bins"`.

---

## Requirements

- Node.js 18+
- [OpenRouter](https://openrouter.ai) API key
- Solana wallet (base58 private key)
- Solana RPC endpoint ([Helius](https://helius.xyz) recommended)
- Telegram bot token (optional)
- [Claude Code](https://claude.ai/code) CLI (optional, for terminal slash commands)

---

## Setup

### 1. Clone & install

```bash
git clone https://github.com/yunus-0x/meridian
cd meridian
npm install
```

### 2. Run the setup wizard

```bash
npm run setup
```

The wizard walks you through creating `.env` (API keys, wallet, RPC, Telegram) and `user-config.json` (risk preset, deploy size, thresholds, models). Takes about 2 minutes.

**Or set up manually:**

Create `.env`:

```env
WALLET_PRIVATE_KEY=your_base58_private_key
RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
OPENROUTER_API_KEY=sk-or-...
HELIUS_API_KEY=your_helius_key          # for wallet balance lookups
JUPITER_API_KEY=your_jupiter_key        # for swaps and prices (no longer hard-coded in the source)
TELEGRAM_BOT_TOKEN=123456:ABC...        # optional — for notifications + chat
TELEGRAM_CHAT_ID=                       # auto-filled on first message
DRY_RUN=true                            # set false for live trading
```

Dry run is **on if either** `DRY_RUN` in `.env` **or** `"dryRun": true` in `user-config.json` asks for it. To go
live, both must say so (`DRY_RUN=false` and `"dryRun": false`, or leave one of them out). Any other value of
`DRY_RUN` (`1`, `True`, a typo) counts as dry run.

> Never put your private key or API keys in `user-config.json` — use `.env` only. Both files are gitignored.

Copy config and edit as needed:

```bash
cp user-config.example.json user-config.json
```

See [Config reference](#config-reference) below.

### 3. Run

```bash
npm run dev    # dry run — no on-chain transactions
npm start      # live mode
```

On startup Meridian fetches your wallet balance, open positions, and top pool candidates, then begins autonomous cycles immediately.

---

## Running modes

### Autonomous agent

```bash
npm start
```

Starts the full autonomous agent with cron-based screening + management cycles and an interactive REPL. The prompt shows a live countdown to the next cycle:

```
[manage: 8m 12s | screen: 24m 3s]
>
```

REPL commands:

| Command | Description |
|---|---|
| `/status` | Wallet balance and open positions |
| `/candidates` | Re-screen and display top pool candidates |
| `/learn` | Study top LPers across all current candidate pools |
| `/learn <pool_address>` | Study top LPers for a specific pool |
| `/thresholds` | Current screening thresholds and performance stats |
| `/evolve` | Trigger threshold evolution from performance data (needs 5+ closed positions) |
| `/stop` | Graceful shutdown |
| `<anything>` | Free-form chat — ask the agent anything, request actions, analyze pools |

---

### Claude Code terminal (recommended)

Install [Claude Code](https://claude.ai/code) and use it from inside the meridian directory. Claude Code has built-in agents and slash commands that use the `meridian` CLI under the hood.

```bash
cd meridian
claude
```

#### Slash commands

| Command | What it does |
|---|---|
| `/screen` | Full AI screening cycle — checks Discord queue, reads config, fetches candidates, runs deep research, and deploys if a winner is found |
| `/manage` | Full AI management cycle — checks all positions, evaluates PnL, claims fees, closes OOR/losing positions |
| `/balance` | Check wallet SOL and token balances |
| `/positions` | List all open DLMM positions with range status |
| `/candidates` | Fetch and enrich top pool candidates (pool metrics + token audit + smart money) |
| `/study-pool` | Study top LPers on a specific pool |
| `/pool-ohlcv` | Fetch price/volume history for a pool |
| `/pool-compare` | Compare all Meteora DLMM pools for a token pair by APR, fee/TVL ratio, and volume |

#### Claude Code agents

Two specialized sub-agents run inside Claude Code:

**`screener`** — pool screening specialist. Invoke when you want to evaluate candidates, analyse token risk, or deploy a position. Has access to OKX smart money signals, full token audit pipeline, and all strategy logic.

**`manager`** — position management specialist. Invoke when reviewing open positions, assessing PnL, claiming fees, or closing positions.

To trigger an agent directly, just describe what you want:
```
> screen for new pools and deploy if you find something good
> review all my positions and close anything out of range
> what do you think of the SOL/BONK pool?
```

#### Loop mode

Run screening or management on a timer inside Claude Code:

```
/loop 30m /screen     # screen every 30 minutes
/loop 10m /manage     # manage every 10 minutes
```

---

### CLI (direct tool invocation)

The `meridian` CLI gives you direct access to every tool with JSON output — useful for scripting, debugging, or piping into other tools.

```bash
npm install -g .   # install globally (once)
meridian <command> [flags]
```

Or run without installing:

```bash
node cli.js <command> [flags]
```

**Positions & PnL**

```bash
meridian positions
meridian pnl <position_address>
meridian wallet-positions --wallet <addr>
```

**Screening**

```bash
meridian candidates --limit 5
meridian pool-detail --pool <addr> [--timeframe 5m]
meridian active-bin --pool <addr>
meridian search-pools --query <name_or_symbol>
meridian study --pool <addr> [--limit 4]
```

**Token research**

```bash
meridian token-info --query <mint_or_symbol>
meridian token-holders --mint <addr> [--limit 20]
meridian token-narrative --mint <addr>
```

**Deploy & manage**

```bash
meridian deploy --pool <addr> --amount <sol> [--bins-below 69] [--bins-above 0] [--strategy bid_ask|spot|curve] [--dry-run]
meridian claim --position <addr>
meridian close --position <addr> [--skip-swap] [--dry-run]
meridian swap --from <mint> --to <mint> --amount <n> [--dry-run]
meridian add-liquidity --position <addr> --pool <addr> [--amount-x <n>] [--amount-y <n>] [--strategy spot]
meridian withdraw-liquidity --position <addr> --pool <addr> [--bps 10000]
```

**Agent cycles**

```bash
meridian screen [--dry-run] [--silent]   # one AI screening cycle
meridian manage [--dry-run] [--silent]   # one AI management cycle
meridian start [--dry-run]               # start autonomous agent with cron jobs
```

**Config**

```bash
meridian config get
meridian config set <key> <value>
```

**Learning & memory**

```bash
meridian lessons
meridian lessons add "your lesson text"
meridian performance [--limit 200]
meridian evolve
meridian pool-memory --pool <addr>
```

**Blacklist**

```bash
meridian blacklist list
meridian blacklist add --mint <addr> --reason "reason"
```

**Discord signals**

```bash
meridian discord-signals
meridian discord-signals clear
```

**Balance**

```bash
meridian balance
```

**Flags**

| Flag | Effect |
|---|---|
| `--dry-run` | Skip all on-chain transactions |
| `--silent` | Suppress Telegram notifications for this run |

---

## Discord listener

The Discord listener watches configured channels (e.g. LP Army) for Solana token calls and queues them as signals for the screener agent.

### Setup

```bash
cd discord-listener
npm install
```

Add to your root `.env`:

```env
DISCORD_USER_TOKEN=your_discord_account_token   # from browser DevTools → Network
DISCORD_GUILD_ID=the_server_id
DISCORD_CHANNEL_IDS=channel1,channel2            # comma-separated
DISCORD_MIN_FEES_SOL=5                           # minimum pool fees to pass pre-check
```

> This uses a selfbot (personal account automation, not a bot token). Use responsibly.

### Run

```bash
cd discord-listener
npm start
```

Or run it in a separate terminal alongside the main agent. Signals are written to `discord-signals.json` and picked up automatically by `/screen` and `node cli.js screen`.

### Signal pipeline

Each incoming token address passes through a pre-check pipeline before being queued:
1. **Dedup** — ignores addresses seen in the last 10 minutes
2. **Blacklist** — rejects blacklisted token mints
3. **Pool resolution** — resolves the address to a Meteora DLMM pool
4. **Rug check** — checks deployer against `deployer-blacklist.json`
5. **Fees check** — rejects pools below `DISCORD_MIN_FEES_SOL`

Signals that pass all checks are queued with status `pending`. The screener picks up pending signals and processes them as priority candidates before running the normal screening cycle.

### Deployer blacklist

Add known rug/farm deployer wallet addresses to `deployer-blacklist.json`:

```json
{
  "_note": "Known farm/rug deployers — add addresses to auto-reject their pools",
  "addresses": [
    "WaLLeTaDDressHere"
  ]
}
```

---

## Telegram

### Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Start the agent, then send any message to your bot — it auto-registers your chat ID

### Notifications

Meridian sends notifications automatically for:
- Management cycle reports (reasoning + decisions)
- Screening cycle reports (what it found, whether it deployed)
- OOR alerts when a position leaves range past `outOfRangeWaitMinutes`
- Deploy: pair, amount, position address, tx hash
- Close: pair and PnL

### Telegram commands

| Command | Action |
|---|---|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set a note on a position |

You can also chat freely via Telegram using the same interface as the REPL.

---

## Config reference

All fields are optional — defaults shown. Edit `user-config.json`.

### Screening

| Field | Default | Description |
|---|---|---|
| `minFeeActiveTvlRatio` | `0.05` | Minimum fee/active-TVL ratio |
| `minTvl` | `10000` | Minimum pool TVL (USD) |
| `maxTvl` | `150000` | Maximum pool TVL (USD) |
| `minVolume` | `500` | Minimum pool volume |
| `minOrganic` | `60` | Minimum organic score (0–100) |
| `minHolders` | `500` | Minimum token holder count |
| `minMcap` | `150000` | Minimum market cap (USD) |
| `maxMcap` | `10000000` | Maximum market cap (USD) |
| `minBinStep` | `80` | Minimum bin step |
| `maxBinStep` | `125` | Maximum bin step |
| `timeframe` | `5m` | Candle timeframe for screening |
| `category` | `trending` | Pool category filter |
| `minTokenFeesSol` | `30` | Minimum all-time fees in SOL |
| `maxBundlersPct` | `30` | Maximum bundler % in top 100 holders |
| `maxTop10Pct` | `60` | Maximum top-10 holder concentration |
| `blockedLaunchpads` | `[]` | Launchpad names to never deploy into |
| `entryMode` | `dip` | `dip` = wait for the pullback (below). `momentum` = the older rule: price stepping up over the last candles |
| `entryDipMinPct` / `entryDipMaxPct` | `20` / `30` | The pullback zone: price must be this far below its recent high |
| `entryDipLookbackHours` | `24` | Window the high is taken from |
| `entrySettleMinutes` | `15` | No new low for this long before entering |
| `entrySettleBouncePct` | `2` | Price must be at least this far back up off the low |
| `entryMaxFall3dPct` | `50` | Skip a token down more than this from its 3-day high. `null` = off |

### Management

| Field | Default | Description |
|---|---|---|
| `deployAmountSol` | `0.5` | Base SOL per new position |
| `positionSizePct` | `0.35` | Fraction of deployable balance to use |
| `maxDeployAmount` | `50` | Maximum SOL cap per position |
| `gasReserve` | `0.2` | Minimum SOL to keep for gas |
| `minSolToOpen` | `0.55` | Minimum wallet SOL before opening |
| `outOfRangeWaitMinutes` | `30` | Minutes out of range **below** before closing |
| `outOfRangeAboveWaitMinutes` | `120` | Minutes out of range **above** (idle, all SOL) before closing |
| `bounceExit` | `true` | Leave on the bounce once price has been deep in the range |
| `bounceExitMinDepthPct` | `50` | How far into the range the low must have gone |
| `bounceExitPct` / `bounceExitDeepPct` | `10` / `6` | Bounce off the low that closes the position; the second applies past 75% of the range |
| `minAgeBeforeYieldCheck` | `180` | Minutes before a low fee yield can close a position |
| `stopLossPct` | `-15` | Close the position when its PnL falls to this % |
| `minClaimAmountSol` | `0.05` | Claim threshold in SOL, used when `solMode` is on (`minClaimAmount` is USD) |
| `strategy` | `bid_ask` | Shape of the deposit: `bid_ask`, `spot` or `curve` |
| `rangeMode` | `cover` | `cover` = range bottom `coverMinPct`–`coverMaxPct` below entry. `bins` = `minBinsBelow`–`binsBelow` bins by volatility |
| `coverMinPct` / `coverMaxPct` | `60` / `70` | How far below the entry price the range reaches (calm pool / volatile pool) |
| `coverDeepBelowMcap` | `3000000` | Market caps under this (USD) always get `coverMaxPct`. `null` = off |
| `maxBinsBelow` | `200` | Hard cap on the number of bins, whatever the cover asks for |
| `minBinsBelow` / `binsBelow` | `35` / `69` | Only for `rangeMode: "bins"`: narrowest and widest range |

### Safety switches

These are read from `user-config.json` only. The agent cannot change them through `update_config`.

| Field | Default | Description |
|---|---|---|
| `allowTwoSided` | `false` | `false` = SOL-only positions: `amount_x`, `bins_above` and SOL → token swaps are refused in code |
| `allowUnscreenedDeploy` | `false` | `false` = the model can only deploy into a pool from the latest screening result. Deploys you type yourself with `node cli.js deploy` may name any pool |
| `maxSwapPriceImpactPct` | `15` | A swap quoted above this price impact is refused; the tokens stay in the wallet and you get a Telegram alert |
| `requireRenouncedAuthorities` | `true` | Drop tokens whose mint or freeze authority is still active |
| `failClosedOnMissingData` | `true` | A token with no audit / OKX risk data / price points is dropped. Set `false` to let "no data" pass, as before |
| `manageUntrackedPositions` | `false` | `false` = positions in the wallet that the agent did not open (opened by hand or by another tool) are shown in reports but never closed or claimed. You get a Telegram note when one of the exit rules would have closed one. Set `true` to put every position in the wallet under the agent's rules |

### What is enforced in code (not by the prompt)

- **Exits.** Stop loss, trailing take-profit, out-of-range and low-yield closes are executed directly by `index.js`.
  The model is only asked about positions that carry your own instruction (`/set <n> <note>`). A model outage
  cannot stop a stop loss; a close that fails raises a Telegram alert and is retried.
- **API failures.** If the positions API fails, the cycle is skipped and reported. It is never read as "no positions".
- **Deploys.** Pool must be screened; bin step and base token come from the screening record and the on-chain
  pool; `bins_below` is computed from volatility; size is capped at `positionSizePct` of the wallet and
  `maxDeployAmount`; one position per token.
- **Config.** `update_config` works in chat sessions only (not in the autonomous cycles) and every value is type-
  and range-checked (`guards.js`, `CONFIG_BOUNDS`).
- **Tools per role.** The screener, manager and health-check roles can only call the tools they are shown.
- **Token audit on every path.** Blocked launchpad, bot holders, mint / freeze authority and top-10 holders are
  checked inside `get_top_candidates`, so a deploy asked for in chat, on Telegram or with `auto` passes the same
  checks as the scheduled cycle.
- **Leftover tokens.** If the swap back to SOL after a close fails (no route, price impact above the limit,
  Jupiter down), the token is remembered and the swap is retried on every management check, up to 12 times.
  After that you get a Telegram alert and the tokens stay in the wallet for you to sell.
- **Data outages.** When OKX or the Jupiter audit has no data for any candidate, nothing can pass the screen. The
  screening report and a Telegram alert say so, so it is not mistaken for a quiet market.
- **Dry run.** A simulated close or deploy sends no "Closed" / "Deployed" message and is repeated at most once
  an hour. The startup line says which of the two switches turned dry run on.

`npm run test:guards` runs the unit tests for these checks (no network, no wallet).

### Schedule

| Field | Default | Description |
|---|---|---|
| `managementIntervalMin` | `10` | Management cycle frequency (minutes) |
| `screeningIntervalMin` | `30` | Screening cycle frequency (minutes) |

### Models

| Field | Default | Description |
|---|---|---|
| `managementModel` | `openai/gpt-oss-20b:free` | LLM for management cycles |
| `screeningModel` | `openai/gpt-oss-20b:free` | LLM for screening cycles |
| `generalModel` | `openai/gpt-oss-20b:free` | LLM for REPL / chat |

<<<<<<< HEAD
> Override model at runtime: `node cli.js config set screeningModel anthropic/claude-opus-4-5`

---

## Telegram

**Setup:**

1. Create a bot via [@BotFather](https://t.me/BotFather) and copy the token
2. Add `TELEGRAM_BOT_TOKEN=<token>` to your `.env`
3. Set the exact Telegram chat and allowed controller user IDs in `.env`

Meridian no longer auto-registers the first chat for safety. You must set:

```env
TELEGRAM_BOT_TOKEN=<token>
TELEGRAM_CHAT_ID=<target chat id>
TELEGRAM_ALLOWED_USER_IDS=<comma-separated Telegram user ids allowed to control the bot>
```

Security notes:
- If `TELEGRAM_CHAT_ID` is not set, inbound Telegram control is ignored.
- If the target chat is a group/supergroup and `TELEGRAM_ALLOWED_USER_IDS` is empty, inbound control is ignored.
- Notifications still go to the configured chat, but command/control is limited to the allowed user IDs.

**Notifications sent:**
- After every management cycle: full agent report (reasoning + decisions)
- After every screening cycle: full agent report (what it found, whether it deployed)
- When a position goes out of range past `outOfRangeWaitMinutes`
- On deploy: pair, amount, position address, tx hash
- On close: pair and PnL

You can also chat with the agent via Telegram using the same free-form interface as the REPL: `"check wallet 7tB8..."`, `"who are the top LPers in pool ABC..."`, `"close all positions"`, etc. Only explicitly allowed Telegram user IDs can issue commands.

---

## How it learns

### Lessons

After every closed position the agent runs `studyTopLPers` on candidate pools, analyzes on-chain behavior of top performers (hold duration, entry/exit timing, win rates), and saves concrete lessons. Lessons are injected into subsequent agent cycles as part of the system context.

Add a lesson manually:
```bash
node cli.js lessons add "Never deploy into pump.fun tokens under 2h old"
```

### Threshold evolution

After 5+ positions have been closed, run:
```bash
node cli.js evolve
```

This analyzes closed position performance (win rate, avg PnL, fee yields) and automatically adjusts screening thresholds in `user-config.json`. Changes take effect immediately.

---

## Hive Mind (optional)

Opt-in collective intelligence — share lessons and pool outcomes, receive crowd wisdom from other Meridian agents.

**What you get:** Pool consensus ("8 agents deployed here, 72% win rate"), strategy rankings, threshold medians.

**What you share:** Lessons, deploy outcomes, screening thresholds. No wallet addresses, private keys, or balances are ever sent.

### Setup

```bash
node -e "import('./hive-mind.js').then(m => m.register('https://meridian-hive-api-production.up.railway.app', 'YOUR_TOKEN'))"
```

Get `YOUR_TOKEN` from the private Telegram discussion. This saves your credentials to `user-config.json` automatically.

### Disable

```json
{
  "hiveMindUrl": "",
  "hiveMindApiKey": ""
}
```

### Self-hosting

See [meridian-hive](https://github.com/fciaf420/meridian-hive) for the server source.

---

## Using a local model (LM Studio)

```env
LLM_BASE_URL=http://localhost:1234/v1
LLM_API_KEY=lm-studio
LLM_MODEL=your-local-model-name
```

Any OpenAI-compatible endpoint works.

---

## Architecture

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop: LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env
prompt.js           System prompt builder (SCREENER / MANAGER / GENERAL roles)
state.js            Position registry (state.json)
lessons.js          Learning engine: records performance, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots
strategy-library.js Saved LP strategies
telegram.js         Telegram bot: polling + notifications
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker
token-blacklist.js  Permanent token blacklist
cli.js              Direct CLI — every tool as a subcommand with JSON output

tools/
  definitions.js    Tool schemas (OpenAI format)
  executor.js       Tool dispatch + safety checks
  dlmm.js           Meteora DLMM SDK wrapper
  screening.js      Pool discovery + entry rule + token audit
  meteora.js        Meteora data API: pool candles (pullback check), pool record
  wallet.js         SOL/token balances + Jupiter swap
  token.js          Token info, holders, narrative
  study.js          Top LPer study via LPAgent API

discord-listener/
  index.js          Selfbot Discord listener
  pre-checks.js     Signal pre-check pipeline

.claude/
  agents/
    screener.md     Claude Code screener sub-agent
    manager.md      Claude Code manager sub-agent
  commands/
    screen.md       /screen slash command
    manage.md       /manage slash command
    balance.md      /balance slash command
    positions.md    /positions slash command
    candidates.md   /candidates slash command
    study-pool.md   /study-pool slash command
    pool-ohlcv.md   /pool-ohlcv slash command
    pool-compare.md /pool-compare slash command
```

---

## Disclaimer

This software is provided as-is, with no warranty. Running an autonomous trading agent carries real financial risk — you can lose funds. Always start with `DRY_RUN=true` to verify behavior before going live. Never deploy more capital than you can afford to lose. This is not financial advice.

The authors are not responsible for any losses incurred through use of this software.
