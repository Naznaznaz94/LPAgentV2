import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveDryRun, parseFlag } from "./guards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const u = fs.existsSync(USER_CONFIG_PATH)
  ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
  : {};

// Apply wallet/RPC from user-config if not already in env
if (u.rpcUrl)    process.env.RPC_URL            ||= u.rpcUrl;
if (u.walletKey) process.env.WALLET_PRIVATE_KEY ||= u.walletKey;
if (u.llmModel)  process.env.LLM_MODEL          ||= u.llmModel;
if (u.llmBaseUrl) process.env.LLM_BASE_URL      ||= u.llmBaseUrl;
if (u.llmApiKey)  process.env.LLM_API_KEY       ||= u.llmApiKey;
// Dry run is ON if either .env or user-config asks for it, and every other module reads the canonical
// "true"/"false" written back here. (`DRY_RUN=false` from .env.example used to override `"dryRun": true`.)
const _dryEnv = parseFlag(process.env.DRY_RUN);
const _dryFile = parseFlag(u.dryRun);
process.env.DRY_RUN = resolveDryRun(process.env.DRY_RUN, u.dryRun) ? "true" : "false";
/** Why dry run is on or off, for the startup line: an old `"dryRun": true` left in user-config.json keeps the
 *  agent from trading even with DRY_RUN=false in .env, and that has to be visible. */
export const dryRunInfo = {
  on: process.env.DRY_RUN === "true",
  env: _dryEnv,   // true | false | null (not set)
  file: _dryFile, // true | false | null (not set)
  describe() {
    const f = (v) => (v === null ? "not set" : String(v));
    return `.env DRY_RUN=${f(this.env)}, user-config dryRun=${f(this.file)} — dry run is on if either one says so`;
  },
};

export const config = {
  // ─── Risk Limits ─────────────────────────
  risk: {
    maxPositions:    u.maxPositions    ?? 3,
    maxDeployAmount: u.maxDeployAmount ?? 50,
    // SOL-only by default: a two-sided deposit starts half in the token. Set true to allow amount_x / bins_above
    // on deploy and SOL -> token swaps.
    allowTwoSided:         u.allowTwoSided         ?? false,
    // Deploys are only allowed into pools from the latest screening run. Set true to deploy into any pool by hand.
    allowUnscreenedDeploy: u.allowUnscreenedDeploy ?? false,
    // A swap whose quoted price impact is above this is refused (the tokens stay in the wallet and you are told).
    maxSwapPriceImpactPct: u.maxSwapPriceImpactPct ?? 15,
  },

  // ─── Pool Screening Thresholds ───────────
  screening: {
    minFeeActiveTvlRatio: u.minFeeActiveTvlRatio ?? 0.05,
    maxFeeActiveTvlRatio: u.maxFeeActiveTvlRatio ?? null,
    minTvl:            u.minTvl            ?? 10_000,
    maxTvl:            u.maxTvl            ?? 150_000,
    minVolume:         u.minVolume         ?? 500,
    minOrganic:        u.minOrganic        ?? 60,
    minHolders:        u.minHolders        ?? 500,
    minMcap:           u.minMcap           ?? 150_000,
    maxMcap:           u.maxMcap           ?? 10_000_000,
    minBinStep:        u.minBinStep        ?? 80,
    maxBinStep:        u.maxBinStep        ?? 125,
    timeframe:         u.timeframe         ?? "5m",
    category:          u.category          ?? "trending",
    minTokenFeesSol:   u.minTokenFeesSol   ?? 30,  // global fees paid (priority+jito tips). below = bundled/scam
    maxBundlePct:      u.maxBundlePct      ?? 30,  // max bundle holding % (OKX advanced-info)
    maxBotHoldersPct:  u.maxBotHoldersPct  ?? 30,  // max bot holder addresses % (Jupiter audit)
    maxTop10Pct:       u.maxTop10Pct       ?? 60,  // max top 10 holders concentration (enforced in code since the audit)
    requireRenouncedAuthorities: u.requireRenouncedAuthorities ?? true, // drop tokens whose mint or freeze authority is still live
    failClosedOnMissingData:     u.failClosedOnMissingData     ?? true, // no safety data for a token = no entry
    blockedLaunchpads:  u.blockedLaunchpads  ?? [],  // e.g. ["letsbonk.fun", "pump.fun"]
    minTokenAgeHours:   u.minTokenAgeHours   ?? null, // null = no minimum
    maxTokenAgeHours:   u.maxTokenAgeHours   ?? null, // null = no maximum
    athFilterPct:       u.athFilterPct       ?? null, // e.g. -20 = only deploy if price is >= 20% below ATH
    minAthPct:          u.minAthPct          ?? null, // e.g. 70 = only deploy if price is >= 70% of ATH (near-ATH strategy)
    minFeePct:          u.minFeePct          ?? 0.8,  // minimum pool base fee % (e.g. 0.8 = 0.8%)
    avoidPvpSymbols:    u.avoidPvpSymbols    ?? false, // enrich PVP risk data for candidates
    blockPvpSymbols:    u.blockPvpSymbols    ?? false, // hard-block pools flagged as PVP

    // ── Entry timing ──
    // "dip" (default): do not open at the top. Wait until the pool price has pulled back entryDipMinPct–
    // entryDipMaxPct from its recent high and has stopped making new lows (guards.js checkDipEntry; candles from
    // Meteora, OKX's 24h high as the fallback). "momentum": the older rule, price stepping up over the last candles.
    entryMode:             u.entryMode             ?? "dip",
    entryDipMinPct:        u.entryDipMinPct        ?? 20,
    entryDipMaxPct:        u.entryDipMaxPct        ?? 30,
    entryDipLookbackHours: u.entryDipLookbackHours ?? 24,  // the high is the highest candle body in this window
    entrySettleMinutes:    u.entrySettleMinutes    ?? 15,  // no new low for this long…
    entrySettleBouncePct:  u.entrySettleBouncePct  ?? 2,   // …and price at least this far back up off the low
    // Skip a token that is down more than this from its 3-day high: that is a slide, not a pullback. null = off.
    entryMaxFall3dPct:     u.entryMaxFall3dPct !== undefined ? u.entryMaxFall3dPct : 50,
  },

  // ─── Position Management ────────────────
  management: {
    minClaimAmount:        u.minClaimAmount        ?? 5,     // USD; used when solMode is off
    minClaimAmountSol:     u.minClaimAmountSol     ?? 0.05,  // SOL; used when solMode is on (fees are then reported in SOL)
    autoSwapAfterClaim:    u.autoSwapAfterClaim    ?? false,
    poolMaxDeploys:        u.poolMaxDeploys        ?? 4,   // max deploys per pool within rolling window
    poolDeployWindowDays:  u.poolDeployWindowDays  ?? 3,   // rolling window in days
    poolCooldownHours:     u.poolCooldownHours     ?? 36,  // cooldown after hitting limit
    outOfRangeBinsToClose: u.outOfRangeBinsToClose ?? 10,
    outOfRangeWaitMinutes: u.outOfRangeWaitMinutes ?? 30,
    oorCooldownTriggerCount: u.oorCooldownTriggerCount ?? 3,
    oorCooldownHours:       u.oorCooldownHours       ?? 12,
    minVolumeToRebalance:  u.minVolumeToRebalance  ?? 1000,
    stopLossPct:           u.stopLossPct           ?? u.emergencyPriceDropPct ?? -15, // README has always said -15; the code said -50
    // Positions in the wallet that this agent did not open (opened by hand, or by another tool) are reported
    // but never closed or claimed, unless this is switched on. user-config.json only.
    manageUntrackedPositions: u.manageUntrackedPositions ?? false,
    takeProfitFeePct:      u.takeProfitFeePct      ?? 5,
    minFeePerTvl24h:       u.minFeePerTvl24h       ?? 7,
    // Minutes before low yield can close a position. 3 hours: a range opened after a pullback earns nothing until
    // price comes back down into it, and closing it after one idle hour throws the setup away.
    minAgeBeforeYieldCheck: u.minAgeBeforeYieldCheck ?? 180,
    // Price ABOVE the range: the position is all SOL, nothing is at risk, it is only idle. Wait longer than for
    // a break below before closing it and looking for another pool.
    outOfRangeAboveWaitMinutes: u.outOfRangeAboveWaitMinutes ?? 120,
    // "Let it dump, leave on the bounce" (guards.js checkBounceExit): once price has been past
    // bounceExitMinDepthPct of the range, the first bounce of bounceExitPct closes the position; past three
    // quarters of the range a bounce of bounceExitDeepPct is enough.
    bounceExit:            u.bounceExit            ?? true,
    bounceExitMinDepthPct: u.bounceExitMinDepthPct ?? 50,
    bounceExitPct:         u.bounceExitPct         ?? 10,
    bounceExitDeepPct:     u.bounceExitDeepPct     ?? 6,
    minSolToOpen:          u.minSolToOpen          ?? 0.55,
    deployAmountSol:       u.deployAmountSol       ?? 0.5,
    gasReserve:            u.gasReserve            ?? 0.2,
    positionSizePct:       u.positionSizePct       ?? 0.35,
    // Trailing take-profit
    trailingTakeProfit:    u.trailingTakeProfit    ?? true,
    trailingTriggerPct:    u.trailingTriggerPct    ?? 3,    // activate trailing at X% PnL
    trailingDropPct:       u.trailingDropPct       ?? 1.5,  // close when drops X% from peak
    pnlSanityMaxDiffPct:   u.pnlSanityMaxDiffPct   ?? 5,    // max allowed diff between reported and derived pnl % before ignoring a tick
    // SOL mode — positions, PnL, and balances reported in SOL instead of USD
    solMode:               u.solMode               ?? false,
  },

  // ─── Strategy Mapping ───────────────────
  strategy: {
    // Shape of the SOL-only deposit. bid_ask puts most of the SOL in the lower bins: little is bought on a
    // shallow dip, most near the bottom. On a deep range that is the low-risk shape (a 40% fall into a -70%
    // range costs about 3% of the position before fees, against about 9% for spot); spot earns more fees while
    // price chops near the top of the range.
    strategy:  u.strategy  ?? "bid_ask",
    // How the range is sized (guards.js checkDeploy):
    //   "cover" (default): the bottom of the range sits coverMinPct–coverMaxPct below the entry price. Deeper
    //     for volatile pools; always the deep end for a market cap under coverDeepBelowMcap. The number of bins
    //     follows from the pool's bin step (e.g. -65% at bin step 100 = 106 bins).
    //   "bins": the older rule, minBinsBelow–binsBelow bins by volatility.
    rangeMode:   u.rangeMode   ?? "cover",
    coverMinPct: u.coverMinPct ?? 60,
    coverMaxPct: u.coverMaxPct ?? 70,
    coverDeepBelowMcap: u.coverDeepBelowMcap !== undefined ? u.coverDeepBelowMcap : 3_000_000, // USD; null = off
    maxBinsBelow: u.maxBinsBelow ?? 200,   // hard cap on the range, whatever the cover asks for
    binsBelow: u.binsBelow ?? 69,          // rangeMode "bins": widest range, used at volatility 5+
    minBinsBelow: u.minBinsBelow ?? 35,    // rangeMode "bins": narrowest range, used at volatility 0
  },

  // ─── Scheduling ─────────────────────────
  schedule: {
    managementIntervalMin:  u.managementIntervalMin  ?? 10,
    screeningIntervalMin:   u.screeningIntervalMin   ?? 30,
    healthCheckIntervalMin: u.healthCheckIntervalMin ?? 60,
  },

  // ─── LLM Settings ──────────────────────
  llm: {
    temperature: u.temperature ?? 0.373,
    maxTokens:   u.maxTokens   ?? 4096,
    maxSteps:    u.maxSteps    ?? 20,
    managementModel: u.managementModel ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v3.2",
    screeningModel:  u.screeningModel  ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v3.2",
    generalModel:    u.generalModel    ?? process.env.LLM_MODEL ?? "deepseek/deepseek-v3.2",
  },

  // ─── Darwinian Signal Weighting ────────
  darwin: {
    enabled:      u.darwinEnabled      ?? true,
    windowDays:   u.darwinWindowDays   ?? 60,
    recalcEvery:  u.darwinRecalcEvery  ?? 5,
    boostFactor:  u.darwinBoost        ?? 1.05,
    decayFactor:  u.darwinDecay        ?? 0.95,
    weightFloor:  u.darwinFloor        ?? 0.3,
    weightCeiling: u.darwinCeiling     ?? 2.5,
    minSamples:   u.darwinMinSamples   ?? 10,
  },

  // ─── Common Token Mints ────────────────
  tokens: {
    SOL:  "So11111111111111111111111111111111111111112",
    USDC: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    USDT: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
  },
};

/**
 * Compute the optimal deploy amount for a given wallet balance.
 * Scales position size with wallet growth (compounding).
 *
 * Formula: clamp(deployable × positionSizePct, floor=deployAmountSol, ceil=maxDeployAmount)
 *
 * Examples (defaults: gasReserve=0.2, positionSizePct=0.35, floor=0.5):
 *   0.8 SOL wallet → 0.6 SOL deploy  (floor)
 *   2.0 SOL wallet → 0.63 SOL deploy
 *   3.0 SOL wallet → 0.98 SOL deploy
 *   4.0 SOL wallet → 1.33 SOL deploy
 */
export function computeDeployAmount(walletSol) {
  const reserve  = config.management.gasReserve      ?? 0.2;
  const pct      = config.management.positionSizePct ?? 0.35;
  const floor    = config.management.deployAmountSol;
  const ceil     = config.risk.maxDeployAmount;
  const deployable = Math.max(0, walletSol - reserve);
  const dynamic    = deployable * pct;
  const result     = Math.min(ceil, Math.max(floor, dynamic));
  return parseFloat(result.toFixed(2));
}

/**
 * Reload user-config.json and apply updated screening thresholds to the
 * in-memory config object. Called after threshold evolution so the next
 * agent cycle uses the evolved values without a restart.
 */
export function reloadScreeningThresholds() {
  if (!fs.existsSync(USER_CONFIG_PATH)) return;
  try {
    const fresh = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
    const s = config.screening;
    if (fresh.minFeeActiveTvlRatio != null) s.minFeeActiveTvlRatio = fresh.minFeeActiveTvlRatio;
    if (fresh.minOrganic     != null) s.minOrganic     = fresh.minOrganic;
    if (fresh.minHolders     != null) s.minHolders     = fresh.minHolders;
    if (fresh.minMcap        != null) s.minMcap        = fresh.minMcap;
    if (fresh.maxMcap        != null) s.maxMcap        = fresh.maxMcap;
    if (fresh.minTvl         != null) s.minTvl         = fresh.minTvl;
    if (fresh.maxTvl         != null) s.maxTvl         = fresh.maxTvl;
    if (fresh.minVolume      != null) s.minVolume      = fresh.minVolume;
    if (fresh.minBinStep     != null) s.minBinStep     = fresh.minBinStep;
    if (fresh.maxBinStep     != null) s.maxBinStep     = fresh.maxBinStep;
    if (fresh.timeframe         != null) s.timeframe         = fresh.timeframe;
    if (fresh.category          != null) s.category          = fresh.category;
    if (fresh.minTokenAgeHours  !== undefined) s.minTokenAgeHours = fresh.minTokenAgeHours;
    if (fresh.maxTokenAgeHours  !== undefined) s.maxTokenAgeHours = fresh.maxTokenAgeHours;
    if (fresh.athFilterPct      !== undefined) s.athFilterPct     = fresh.athFilterPct;
    if (fresh.minAthPct         !== undefined) s.minAthPct        = fresh.minAthPct;
    if (fresh.maxBundlePct          != null)      s.maxBundlePct          = fresh.maxBundlePct;
    if (fresh.maxBotHoldersPct      != null)      s.maxBotHoldersPct      = fresh.maxBotHoldersPct;
    if (fresh.maxTop10Pct           != null)      s.maxTop10Pct           = fresh.maxTop10Pct;
    if (fresh.maxFeeActiveTvlRatio  != null)      s.maxFeeActiveTvlRatio  = fresh.maxFeeActiveTvlRatio;
    if (fresh.minTokenFeesSol       != null)      s.minTokenFeesSol       = fresh.minTokenFeesSol;
    if (fresh.minFeePct             != null)      s.minFeePct             = fresh.minFeePct;
    if (fresh.blockedLaunchpads     !== undefined) s.blockedLaunchpads    = fresh.blockedLaunchpads;
  } catch { /* ignore */ }
}
