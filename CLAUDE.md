# Meridian — CLAUDE.md

Autonomous DLMM liquidity provider agent for Meteora pools on Solana.

---

## Architecture Overview

```
index.js            Main entry: REPL + cron orchestration + Telegram bot polling
agent.js            ReAct loop (OpenRouter/OpenAI-compatible): LLM → tool call → repeat
config.js           Runtime config from user-config.json + .env; exposes config object
prompt.js           Builds system prompt per agent role (SCREENER / MANAGER / GENERAL)
state.js            Position registry (state.json): tracks bin ranges, OOR timestamps, notes
lessons.js          Learning engine: records closed-position perf, derives lessons, evolves thresholds
pool-memory.js      Per-pool deploy history + snapshots (pool-memory.json)
strategy-library.js Saved LP strategies (strategy-library.json)
briefing.js         Daily Telegram briefing (HTML)
telegram.js         Telegram bot: polling, notifications (deploy/close/swap/OOR)
hive-mind.js        Optional collective intelligence server sync
smart-wallets.js    KOL/alpha wallet tracker (smart-wallets.json)
token-blacklist.js  Permanent token blacklist (token-blacklist.json)
logger.js           Daily-rotating log files + action audit trail

tools/
  definitions.js    Tool schemas in OpenAI format (what LLM sees)
  executor.js       Tool dispatch: name → fn, safety checks, pre/post hooks
  dlmm.js           Meteora DLMM SDK wrapper (deploy, close, claim, positions, PnL)
  screening.js      Pool discovery from Meteora API, entry rule, token audit
  meteora.js        Meteora data API (dlmm.datapi.meteora.ag): pool candles for the pullback check, pool record
  wallet.js         SOL/token balances (Helius) + Jupiter swap
  token.js          Token info/holders/narrative (Jupiter API)
  study.js          Top LPer study via LPAgent API
```

---

## Agent Roles & Tool Access

Three agent roles filter which tools the LLM can call:

| Role | Purpose | Key Tools |
|------|---------|-----------|
| `SCREENER` | Find and deploy new positions | deploy_position, get_top_candidates, get_token_holders, check_smart_wallets_on_pool |
| `MANAGER` | Manage open positions | close_position, claim_fees, swap_token, get_position_pnl, set_position_note |
| `GENERAL` | Chat / manual commands | All tools |

Sets defined in `agent.js:6-7`. If you add a tool, also add it to the relevant set(s).

---

## Adding a New Tool

1. **`tools/definitions.js`** — Add OpenAI-format schema object to the `tools` array
2. **`tools/executor.js`** — Add `tool_name: functionImpl` to `toolMap`
3. **`agent.js`** — Add tool name to `MANAGER_TOOLS` and/or `SCREENER_TOOLS` if role-restricted
4. If the tool writes on-chain state, add it to `WRITE_TOOLS` in executor.js for safety checks

---

## Config System

`config.js` loads `user-config.json` at startup. Runtime mutations go through `update_config` tool (executor.js) which:
- Updates the live `config` object immediately
- Persists to `user-config.json`
- Restarts cron jobs if intervals changed

**Valid config keys and their sections:**

| Key | Section | Default |
|-----|---------|---------|
| minFeeActiveTvlRatio | screening | 0.05 |
| minTvl / maxTvl | screening | 10k / 150k |
| minVolume | screening | 500 |
| minOrganic | screening | 60 |
| minHolders | screening | 500 |
| minMcap / maxMcap | screening | 150k / 10M |
| minBinStep / maxBinStep | screening | 80 / 125 |
| timeframe | screening | "5m" |
| category | screening | "trending" |
| minTokenFeesSol | screening | 30 |
| maxBundlersPct | screening | 30 |
| maxTop10Pct | screening | 60 |
| blockedLaunchpads | screening | [] |
| deployAmountSol | management | 0.5 |
| maxDeployAmount | risk | 50 |
| maxPositions | risk | 3 |
| gasReserve | management | 0.2 |
| positionSizePct | management | 0.35 |
| minSolToOpen | management | 0.55 |
| outOfRangeWaitMinutes | management | 30 |
| outOfRangeAboveWaitMinutes | management | 120 |
| bounceExit / bounceExitMinDepthPct / bounceExitPct / bounceExitDeepPct | management | true / 50 / 10 / 6 |
| minAgeBeforeYieldCheck | management | 180 |
| entryMode | screening | "dip" |
| entryDipMinPct / entryDipMaxPct / entryDipLookbackHours | screening | 20 / 30 / 24 |
| entrySettleMinutes / entrySettleBouncePct | screening | 15 / 2 |
| entryMaxFall3dPct | screening | 50 |
| rangeMode | strategy | "cover" |
| coverMinPct / coverMaxPct / coverDeepBelowMcap / maxBinsBelow | strategy | 60 / 70 / 3,000,000 / 200 |
| managementIntervalMin | schedule | 10 |
| screeningIntervalMin | schedule | 30 |
| managementModel / screeningModel / generalModel | llm | openrouter/healer-alpha |

**Hard bounds:** every key above is type- and range-checked in `guards.js` (`CONFIG_BOUNDS`) before it is applied,
and `update_config` is refused for the autonomous SCREENER / MANAGER cycles (chat sessions only). The safety
switches `allowTwoSided`, `allowUnscreenedDeploy`, `requireRenouncedAuthorities` and `failClosedOnMissingData`
live in `user-config.json` only and are not reachable through `update_config`.

`manageUntrackedPositions` (default `false`, `user-config.json` only): positions the agent did not open are
reported as `WATCH` in the management cycle and never closed or claimed.

**`computeDeployAmount(walletSol)`** — scales position size with wallet balance (compounding). Formula: `clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)`.

---

## Position Lifecycle

1. **Deploy**: `deploy_position` → executor safety checks → `trackPosition()` in state.js → Telegram notify
2. **Monitor**: management cron → `getMyPositions()` → `getPositionPnl()` → OOR detection → pool-memory snapshots
   A failed auto-swap after a close is stored in `state.json` (`pendingSwaps`) and retried by
   `retryPendingSwaps()` at the start of each management cycle (max 12 tries, then a Telegram alert).
3. **Close**: decided by the deterministic rules in `runManagementCycle` and executed in code via `executeTool("close_position", …, { source: "rule" })` (the LLM is only consulted for positions with an owner instruction) → `recordPerformance()` in lessons.js → auto-swap base token to SOL → Telegram notify
4. **Learn**: `evolveThresholds()` runs on performance data → updates config.screening → persists to user-config.json

---

## Screener Safety Checks (executor.js → guards.js `checkDeploy`)

All yes/no logic lives in `guards.js` (pure, unit-tested: `npm run test:guards`). The executor gathers the facts
(open positions, wallet balance, the pool's record from the latest screening run) and applies the verdict.
A positions-API failure is `unknown: true` and blocks the deploy; it is never treated as "no positions".
The pool must be in the latest screening result unless the deploy was typed by the owner at the CLI or
`allowUnscreenedDeploy` is set. `bins_below` is computed in code from volatility. Positions are SOL-only unless
`allowTwoSided` is set.

The token audit (launchpad, bot holders, mint / freeze authority, top-10 holders) is `guards.js checkTokenAudit`,
called from `getTopCandidates()` for every caller; a pool that fails it never enters the screened-pool registry.

Before `deploy_position` executes:
- `bin_step` must be within `[minBinStep, maxBinStep]`
- Position count must be below `maxPositions` (force-fresh scan, no cache)
- No duplicate pool allowed (same pool_address)
- No duplicate base token allowed (same base_mint in another pool)
- If `amount_x > 0`: strip `amount_y` and `amount_sol` (tokenX-only deploy — no SOL needed)
- SOL balance must cover `amount_y + gasReserve` (skipped for tokenX-only)
- `blockedLaunchpads` enforced in `getTopCandidates()` before LLM sees candidates

---

## Entry, range and exit (all in `guards.js`, unit-tested)

**Entry — `checkDipEntry`** (`screening.entryMode: "dip"`, the default). `getTopCandidates()` reads each pool's
candles from Meteora (`tools/meteora.js getDipFacts`: 1h candles of 3 days, plus 5m candles of 3 hours when the pool
is near the zone) and `dipFromCandles` turns them into facts. A pool passes when price is
`entryDipMinPct`–`entryDipMaxPct` below the highest candle body of the last `entryDipLookbackHours`, the last low is
at least `entrySettleMinutes` old, price is `entrySettleBouncePct` off that low, and it is not more than
`entryMaxFall3dPct` below its 3-day high. No Meteora candles → fallback facts from OKX's 24h high and the last step
of the discovery `price_trend`. Neither → dropped (unless `failClosedOnMissingData` is off).
`entryMode: "momentum"` keeps the old up/up filter.

**Range — `checkDeploy`** (`strategy.rangeMode: "cover"`, the default):

```
cover = coverMaxPct                                       if mcap < coverDeepBelowMcap, or mcap / volatility unknown
      = coverMinPct + (min(volatility, 5) / 5) * (coverMaxPct - coverMinPct)   otherwise
bins_below = ceil( ln(1 / (1 - cover/100)) / ln(1 + bin_step/10000) ), capped at maxBinsBelow
```

-60% at bin step 100 = 93 bins, -70% = 121, -70% at bin step 80 = 152. Anything above 69 bins goes through the
wide-range path in `dlmm.js` (`createExtendedEmptyPosition` + `addLiquidityByStrategyChunkable`).
The model's `bins_below` is ignored in the autonomous cycles; a range the owner types (CLI `--bins-below`, or a
Telegram chat request) is kept. `rangeMode: "bins"` is the old `round(35 + (volatility / 5) * 34)` clamp.

**Exit — `checkBounceExit`**, called from `state.js updatePnlAndCheckExits` (30s poller and management cycle).
`state.json` keeps `low_bin`, the lowest active bin seen since the open. depth = (top bin − low bin) / range
width; bounce = `(1 + bin_step/10000)^(active − low) − 1`. depth ≥ `bounceExitMinDepthPct` and bounce ≥
`bounceExitPct` (or `bounceExitDeepPct` once depth ≥ 75%) → `BOUNCE_EXIT`. Order of the exits: stop loss, bounce
exit, trailing TP, out of range (`outOfRangeAboveWaitMinutes` above the range, `outOfRangeWaitMinutes` below),
low yield.

---

## Telegram Commands

Handled directly in `index.js` (bypass LLM):

| Command | Action |
|---------|--------|
| `/positions` | List open positions with progress bar |
| `/close <n>` | Close position by list index |
| `/set <n> <note>` | Set note on position by list index |

Progress bar format: `[████████░░░░░░░░░░░░] 40%` (no bin numbers, no arrows)

---

## Race Condition: Double Deploy

`_screeningLastTriggered` in index.js prevents concurrent screener invocations. Management cycle sets this before triggering screener. Also, `deploy_position` safety check uses `force: true` on `getMyPositions()` for a fresh count.

---

## Bundler Detection (token.js)

Two signals used in `getTokenHolders()`:
- `common_funder` — multiple wallets funded by same source
- `funded_same_window` — multiple wallets funded in same time window

**Thresholds in config**: `maxBundlersPct` (default 30%), `maxTop10Pct` (default 60%)
Jupiter audit API: `botHoldersPercentage` (5–25% is normal for legitimate tokens)

---

## Base Fee Calculation (dlmm.js)

Read from pool object at deploy time:
```js
const baseFactor = pool.lbPair.parameters?.baseFactor ?? 0;
const actualBaseFee = baseFactor > 0
  ? parseFloat((baseFactor * actualBinStep / 1e6 * 100).toFixed(4))
  : null;
```

---

## Model Configuration

- Default model: `process.env.LLM_MODEL` or `openrouter/healer-alpha`
- Fallback on 502/503/529: `stepfun/step-3.5-flash:free` (2nd attempt), then retry
- Per-role models: `managementModel`, `screeningModel`, `generalModel` in user-config.json
- LM Studio: set `LLM_BASE_URL=http://localhost:1234/v1` and `LLM_API_KEY=lm-studio`
- `maxOutputTokens` minimum: 2048 (free models may have lower limits causing empty responses)

---

## Lessons System

`lessons.js` records closed position performance and auto-derives lessons. Key points:
- `getLessonsForPrompt({ agentType })` — injects relevant lessons into system prompt
- `evolveThresholds()` — adjusts screening thresholds based on winners vs losers
- Performance recorded via `recordPerformance()` called from executor.js after `close_position`
- **Known issue**: `evolveThresholds()` references `maxVolatility` and `minFeeTvlRatio` but config.js uses `minFeeActiveTvlRatio` and has no `maxVolatility` key — the evolution of these keys is a no-op

---

## Hive Mind (hive-mind.js)

Optional feature. Enabled by setting `HIVE_MIND_URL` and `HIVE_MIND_API_KEY` in `.env`.
Syncs lessons/deploys to a shared server, queries consensus patterns.
Not required for normal operation.

---

## Environment Variables

| Var | Required | Purpose |
|-----|----------|---------|
| `WALLET_PRIVATE_KEY` | Yes | Base58 or JSON array private key |
| `RPC_URL` | Yes | Solana RPC endpoint |
| `OPENROUTER_API_KEY` | Yes | LLM API key |
| `TELEGRAM_BOT_TOKEN` | No | Telegram notifications |
| `TELEGRAM_CHAT_ID` | No | Telegram chat target |
| `LLM_BASE_URL` | No | Override for local LLM (e.g. LM Studio) |
| `LLM_MODEL` | No | Override default model |
| `DRY_RUN` | No | Skip all on-chain transactions |
| `HIVE_MIND_URL` | No | Collective intelligence server |
| `HIVE_MIND_API_KEY` | No | Hive mind auth token |
| `HELIUS_API_KEY` | No | Enhanced wallet balance data |

---

## Known Issues / Tech Debt

- `lessons.js evolveThresholds()` evolves `maxVolatility` + `minFeeTvlRatio` (wrong key names — should be `minFeeActiveTvlRatio`; `maxVolatility` doesn't exist in config at all). The evolution is a no-op for those keys.
- `get_wallet_positions` tool (dlmm.js) is in definitions.js but not in MANAGER_TOOLS or SCREENER_TOOLS — only available in GENERAL role.
