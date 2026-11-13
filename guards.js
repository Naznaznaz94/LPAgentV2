/**
 * guards.js — pure, dependency-free checks. The LLM proposes; these decide.
 *
 * Nothing here talks to the network, reads the wallet or touches disk, so every rule can be unit-tested
 * (test/test-guards.js, `npm run test:guards`). The executor, the agent loop and config.js call into it.
 */

// ─── Dry run ───────────────────────────────────────────────────

const TRUE_WORDS  = new Set(["true", "1", "yes", "on", "y"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off", "n"]);

/** true | false | null (unset). A value that is not a recognised "off" counts as true: dry run is the safe side. */
export function parseFlag(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (s === "") return null;
  if (FALSE_WORDS.has(s)) return false;
  if (TRUE_WORDS.has(s)) return true;
  return true;
}

/**
 * Dry run is ON if either the environment or user-config asks for it.
 * (Before: `DRY_RUN=false` copied from .env.example silently overrode `"dryRun": true` in user-config.json,
 * and `DRY_RUN=True` / `DRY_RUN=1` ran live.)
 */
export function resolveDryRun(envValue, configValue) {
  return parseFlag(envValue) === true || parseFlag(configValue) === true;
}

// ─── Untrusted text ────────────────────────────────────────────

/** Flatten text that came from a token, an API or the model before it is stored or put into a prompt. */
export function sanitizeUntrusted(text, maxLen = 120) {
  if (text === undefined || text === null) return null;
  const cleaned = String(text)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[<>`{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
  return cleaned || null;
}

// ─── update_config bounds ──────────────────────────────────────

const num  = (min, max, extra = {}) => ({ t: "num", min, max, ...extra });
const int  = (min, max, extra = {}) => ({ t: "int", min, max, ...extra });
const bool = () => ({ t: "bool" });
const str  = (maxLen = 80, pattern = null) => ({ t: "str", maxLen, pattern });

/**
 * Every key update_config may touch, with its type and hard range. A value outside the range is rejected,
 * not clamped, so a typo or a hallucinated number never lands in user-config.json.
 */
export const CONFIG_BOUNDS = {
  // risk: these ceilings are the hard caps
  maxPositions:    int(1, 5),
  maxDeployAmount: num(0.1, 50),
  // sizing
  deployAmountSol: num(0.1, 50),
  positionSizePct: num(0.05, 1),
  gasReserve:      num(0.05, 5),
  minSolToOpen:    num(0.1, 100),
  // exits
  stopLossPct:             num(-60, -3),
  takeProfitFeePct:        num(0, 100),
  trailingTakeProfit:      bool(),
  trailingTriggerPct:      num(0.5, 100),
  trailingDropPct:         num(0.2, 50),
  outOfRangeBinsToClose:   int(1, 500),
  outOfRangeWaitMinutes:   num(1, 2880),
  oorCooldownTriggerCount: int(1, 20),
  oorCooldownHours:        num(0, 168),
  minFeePerTvl24h:         num(0, 100),
  minAgeBeforeYieldCheck:  num(0, 2880),
  pnlSanityMaxDiffPct:     num(1, 50),
  minClaimAmount:          num(0, 10000),
  minClaimAmountSol:       num(0, 100),
  autoSwapAfterClaim:      bool(),
  minVolumeToRebalance:    num(0, 1e9),
  solMode:                 bool(),
  poolMaxDeploys:          int(1, 50),
  poolDeployWindowDays:    num(0.1, 60),
  poolCooldownHours:       num(0, 720),
  // screening
  minFeeActiveTvlRatio: num(0, 100),
  maxFeeActiveTvlRatio: num(0, 1000, { nullable: true }),
  minTvl:            num(0, 1e9),
  maxTvl:            num(0, 1e10),
  minVolume:         num(0, 1e10),
  minOrganic:        num(0, 100),
  minHolders:        int(0, 1e8),
  minMcap:           num(0, 1e11),
  maxMcap:           num(0, 1e12),
  minBinStep:        int(1, 400),
  maxBinStep:        int(1, 400),
  timeframe:         str(8, /^\d{1,3}[mhd]$/),
  category:          str(40, /^[\w-]+$/),
  minTokenFeesSol:   num(0, 1e6),
  maxBundlePct:      num(0, 100),
  maxBotHoldersPct:  num(0, 100),
  maxTop10Pct:       num(0, 100),
  minTokenAgeHours:  num(0, 1e6, { nullable: true }),
  maxTokenAgeHours:  num(0, 1e6, { nullable: true }),
  athFilterPct:      num(-100, 0, { nullable: true }),
  minAthPct:         num(0, 100, { nullable: true }),
  minFeePct:         num(0, 10),
  blockedLaunchpads: { t: "strarr", maxItems: 50, maxLen: 60 },
  avoidPvpSymbols:   bool(),
  blockPvpSymbols:   bool(),
  // schedule
  managementIntervalMin:  int(1, 60),
  screeningIntervalMin:   int(5, 720),
  healthCheckIntervalMin: int(15, 1440),
  // models
  managementModel: str(120),
  screeningModel:  str(120),
  generalModel:    str(120),
  temperature:     num(0, 1.5),
  maxTokens:       int(256, 32768),
  maxSteps:        int(3, 40),
  // strategy
  strategy:  { t: "enum", values: ["bid_ask", "spot", "curve"] },
  binsBelow: int(10, 140),
  minBinsBelow: int(5, 140),
  maxSwapPriceImpactPct: num(0.5, 50),
  rangeMode:    { t: "enum", values: ["cover", "bins"] },
  coverMinPct:  num(10, 95),
  coverMaxPct:  num(10, 95),
  coverDeepBelowMcap: num(0, 1e12, { nullable: true }),
  maxBinsBelow: int(35, 400),
  // entry timing
  entryMode:             { t: "enum", values: ["dip", "momentum"] },
  entryDipMinPct:        num(0, 90),
  entryDipMaxPct:        num(1, 95),
  entryDipLookbackHours: num(6, 72),   // under ~4 hourly candles there is nothing to measure a pullback on
  entrySettleMinutes:    num(0, 240),
  entrySettleBouncePct:  num(0, 50),
  entryMaxFall3dPct:     num(10, 100, { nullable: true }),
  // exits added with the pullback entry
  outOfRangeAboveWaitMinutes: num(1, 2880),
  bounceExit:            bool(),
  bounceExitMinDepthPct: num(10, 100),
  bounceExitPct:         num(1, 100),
  bounceExitDeepPct:     num(1, 100),
};

/** { ok: true, value } with the value coerced to its type, or { ok: false, error }. */
export function validateConfigValue(key, raw) {
  const spec = CONFIG_BOUNDS[key];
  if (!spec) return { ok: false, error: `${key}: not a tunable key` };
  if (raw === null || raw === undefined) {
    return spec.nullable ? { ok: true, value: null } : { ok: false, error: `${key}: cannot be null` };
  }
  switch (spec.t) {
    case "num":
    case "int": {
      const v = typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim()) ? Number(raw) : raw;
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, error: `${key}: must be a number` };
      if (spec.t === "int" && !Number.isInteger(v)) return { ok: false, error: `${key}: must be a whole number` };
      if (v < spec.min || v > spec.max) return { ok: false, error: `${key}: ${v} is outside the allowed range [${spec.min}, ${spec.max}]` };
      return { ok: true, value: v };
    }
    case "bool": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
      return { ok: false, error: `${key}: must be true or false` };
    }
    case "str": {
      if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: `${key}: must be a non-empty string` };
      const v = raw.trim();
      if (v.length > spec.maxLen) return { ok: false, error: `${key}: longer than ${spec.maxLen} characters` };
      if (spec.pattern && !spec.pattern.test(v)) return { ok: false, error: `${key}: "${v}" is not a valid value` };
      return { ok: true, value: v };
    }
    case "enum":
      return spec.values.includes(raw)
        ? { ok: true, value: raw }
        : { ok: false, error: `${key}: must be one of ${spec.values.join(", ")}` };
    case "strarr": {
      if (!Array.isArray(raw) || raw.length > spec.maxItems) return { ok: false, error: `${key}: must be a list of at most ${spec.maxItems} strings` };
      if (!raw.every((x) => typeof x === "string" && x.length > 0 && x.length <= spec.maxLen)) return { ok: false, error: `${key}: every item must be a short string` };
      return { ok: true, value: raw.map((x) => x.trim()) };
    }
    default:
      return { ok: false, error: `${key}: unknown type` };
  }
}

/** Pairs that must stay ordered once the changes are applied on top of the current values. */
const ORDERED_PAIRS = [
  ["minBinStep", "maxBinStep"], ["minMcap", "maxMcap"], ["minTvl", "maxTvl"],
  ["deployAmountSol", "maxDeployAmount"], ["minTokenAgeHours", "maxTokenAgeHours"], ["minBinsBelow", "binsBelow"],
  ["entryDipMinPct", "entryDipMaxPct"], ["coverMinPct", "coverMaxPct"],
];

/**
 * Validate a whole update_config request.
 * @param {object} changes  key -> raw value (keys already resolved to their canonical spelling)
 * @param {object} current  key -> current value, for the cross-field checks
 * @returns {{ applied: object, rejected: object }} rejected maps key -> reason
 */
export function validateConfigChanges(changes, current = {}) {
  const applied = {};
  const rejected = {};
  for (const [key, raw] of Object.entries(changes || {})) {
    const r = validateConfigValue(key, raw);
    if (r.ok) applied[key] = r.value;
    else rejected[key] = r.error;
  }
  for (const [lo, hi] of ORDERED_PAIRS) {
    if (!(lo in applied) && !(hi in applied)) continue;
    const a = lo in applied ? applied[lo] : current[lo];
    const b = hi in applied ? applied[hi] : current[hi];
    if (a != null && b != null && a > b) {
      for (const k of [lo, hi]) {
        if (k in applied) {
          delete applied[k];
          rejected[k] = `${lo} (${a}) cannot be above ${hi} (${b})`;
        }
      }
    }
  }
  return { applied, rejected };
}

// ─── Deploy ────────────────────────────────────────────────────

const SHAPES = new Set(["bid_ask", "spot", "curve"]);

/** bins below the price from pool volatility: min at volatility 0, max at volatility 5+. Done in code, not by the model. */
export function binsBelowFor(volatility, min = 35, max = 69) {
  // Number(null) is 0: a pool with no volatility figure used to get the narrowest range. Unknown is unknown.
  if (volatility === null || volatility === undefined || volatility === "") return null;
  const v = Number(volatility);
  if (!Number.isFinite(v)) return null;
  return Math.max(min, Math.min(max, Math.round(min + (Math.max(0, v) / 5) * (max - min))));
}

// ─── Range: cover → bins ───────────────────────────────────────
// "Cover" is how far below the entry price the range reaches (Meteora shows it as "-65%"). It is the number the
// owner thinks in; bins are only its translation for one pool's bin step.

/** Bins needed below the price so that the bottom of the range sits `coverPct` % under it. */
export function binsForCover(coverPct, binStep) {
  const c = Number(coverPct), bs = Number(binStep);
  if (!Number.isFinite(c) || !Number.isFinite(bs) || c <= 0 || c >= 100 || bs <= 0) return null;
  return Math.ceil(Math.log(1 / (1 - c / 100)) / Math.log(1 + bs / 10_000));
}

/** The reverse: how far below the price (in %) a range of `bins` bins reaches. */
export function coverOfBins(bins, binStep) {
  const n = Number(bins), bs = Number(binStep);
  if (!Number.isFinite(n) || !Number.isFinite(bs) || n <= 0 || bs <= 0) return null;
  return (1 - Math.pow(1 + bs / 10_000, -n)) * 100;
}

const unknownNum = (v) => v === null || v === undefined || v === "" || !Number.isFinite(Number(v));

/**
 * How deep the range should reach, between coverMinPct and coverMaxPct.
 *   - pool volatility pushes it deeper: 0 → min, 5 and above → max;
 *   - a market cap under coverDeepBelowMcap (default $3M) always gets the max: small caps fall furthest;
 *   - an unknown volatility or market cap counts as the risky case (max).
 */
export function coverPctFor({ volatility, mcap } = {}, st = {}) {
  const a = Number(st.coverMinPct ?? 60), b = Number(st.coverMaxPct ?? 70);
  const lo = Math.min(a, b), hi = Math.max(a, b);
  const deepBelow = st.coverDeepBelowMcap !== undefined ? st.coverDeepBelowMcap : 3_000_000; // null = rule off
  if (unknownNum(mcap) || (deepBelow != null && Number(mcap) < deepBelow)) return hi;
  if (unknownNum(volatility)) return hi;
  const v = Math.min(5, Math.max(0, Number(volatility)));
  return Math.round((lo + (v / 5) * (hi - lo)) * 10) / 10;
}

// ─── Entry: wait for the pullback ──────────────────────────────

const bodyTop = (c) => Math.max(c.open, c.close);
const bodyLow = (c) => Math.min(c.open, c.close);

/**
 * Where the price sits relative to its recent high, from the pool's own candles (oldest first, any order accepted).
 *
 * @param {object} p
 * @param {Array} p.hourly  1h candles { timestamp (s), open, high, low, close }, ideally the last 72 hours
 * @param {Array} [p.fine]  5m candles of the last few hours: makes "has it stopped falling?" precise
 * @param {number} [p.lookbackHours] the window the high is taken from (default 24)
 * @param {number} [p.now]  unix seconds
 * @returns {null | { price, high, dipPct, highAgeHours, low, bouncePct, minsSinceLow, fall3dPct, candles }}
 *
 * Highs and lows are candle BODIES (open / close), not wicks: one thin trade at a silly price must not turn a
 * flat chart into a "30% dip", or a falling one into a "bounce".
 * Returns null when there is too little history, or the newest candle is older than 90 minutes.
 */
export function dipFromCandles({ hourly = [], fine = [], lookbackHours = 24, now = Date.now() / 1000 } = {}) {
  const clean = (arr, len) => (Array.isArray(arr) ? arr : [])
    .map((c) => ({ t: Number(c?.timestamp), open: Number(c?.open), close: Number(c?.close), len }))
    .filter((c) => Number.isFinite(c.t) && c.open > 0 && c.close > 0 && c.t <= now)
    .sort((x, y) => x.t - y.t);
  const H = clean(hourly, 3600);
  const F = clean(fine, 300);
  // one series: hourly candles up to where the 5-minute ones start, then the 5-minute ones
  const fineStart = F.length ? F[0].t : Infinity;
  const all = [...H.filter((c) => c.t + c.len <= fineStart), ...F];
  if (all.length < 4) return null;
  const last = all[all.length - 1];
  if (now - last.t > 90 * 60) return null; // stale: the pool has not traded, or the API is behind
  const price = last.close;

  const from = now - lookbackHours * 3600;
  const win = all.filter((c) => c.t + c.len > from);
  if (win.length < 4) return null;
  let hi = win[0];
  for (const c of win) if (bodyTop(c) >= bodyTop(hi)) hi = c; // the latest candle at the high wins a tie
  const high = bodyTop(hi);
  // The low AFTER the high. It starts at the high candle's own CLOSE: that candle's open is a price from before
  // the high (a candle that ran 50 → 100 would otherwise report 50 as "the low since the high", a huge fake
  // bounce, and a falling chart would pass as settled). Then the bodies of every later candle.
  let low = hi.close;
  let lowC = hi;
  for (const c of win) {
    if (c.t <= hi.t) continue;
    if (bodyLow(c) <= low) { low = bodyLow(c); lowC = c; } // the latest candle at the low wins a tie
  }
  const high3d = Math.max(...all.map(bodyTop));
  const r1 = (x) => Math.round(x * 10) / 10;
  return {
    price,
    high,
    dipPct: r1((1 - price / high) * 100),
    highAgeHours: r1((now - hi.t) / 3600),
    low,
    bouncePct: r1((price / low - 1) * 100),
    // minutes since the candle that made the low closed; 0 while that candle is still the running one
    minsSinceLow: Math.max(0, Math.round((now - (lowC.t + lowC.len)) / 60)),
    fall3dPct: r1((1 - price / high3d) * 100),
    candles: all.length,
  };
}

/**
 * The entry rule: do not open at the top. Wait until price has pulled back entryDipMinPct–entryDipMaxPct from
 * its recent high and has stopped making new lows, then open.
 *
 * Why: a SOL-only range starts buying at the entry price. Opened at the high, the first bins buy the most
 * expensive tokens of the day and an ordinary 20–30% pullback already puts the position under water. Opened
 * after the pullback, the same range buys from a lower price and a retest of the low lands inside it.
 *
 * @param {object|null} facts from dipFromCandles (source "meteora"), or the fallback
 *        { dipPct, lastStepUp, source: "okx" } built from OKX's 24h high and the discovery price trend
 * @param {object} s config.screening
 * @returns {{ pass: true } | { pass: false, reason: string, unknown?: true }}
 */
export function checkDipEntry(facts, s = {}) {
  const min = s.entryDipMinPct ?? 20, max = s.entryDipMaxPct ?? 30;
  const hrs = s.entryDipLookbackHours ?? 24;
  if (!facts || unknownNum(facts.dipPct)) {
    return { pass: false, unknown: true, reason: "dip entry: no price history for this pool, so the pullback cannot be measured" };
  }
  const d = Number(facts.dipPct);
  if (d < min) {
    return { pass: false, reason: `dip entry: only ${d.toFixed(1)}% below the ${hrs}h high — waiting for a ${min}–${max}% pullback` };
  }
  if (d > max) {
    return { pass: false, reason: `dip entry: ${d.toFixed(1)}% below the ${hrs}h high — past the ${min}–${max}% pullback zone, treated as falling` };
  }
  if (s.entryMaxFall3dPct != null && !unknownNum(facts.fall3dPct) && Number(facts.fall3dPct) > s.entryMaxFall3dPct) {
    return { pass: false, reason: `dip entry: down ${Number(facts.fall3dPct).toFixed(1)}% from its 3-day high (limit ${s.entryMaxFall3dPct}%) — a slide, not a pullback` };
  }
  // Has it stopped falling? ("Enter on the settle, do not chase the candle.")
  const needMin = s.entrySettleMinutes ?? 15, needBounce = s.entrySettleBouncePct ?? 2;
  const hasSettleFacts = !unknownNum(facts.minsSinceLow) && !unknownNum(facts.bouncePct);
  if (hasSettleFacts) {
    if (Number(facts.minsSinceLow) < needMin) {
      return { pass: false, reason: `dip entry: still making new lows (${facts.minsSinceLow} min since the last one, need ${needMin})` };
    }
    if (Number(facts.bouncePct) < needBounce) {
      return { pass: false, reason: `dip entry: no bounce yet (+${Number(facts.bouncePct).toFixed(1)}% off the low, need +${needBounce}%)` };
    }
    return { pass: true };
  }
  // Fallback facts carry only the direction of the last price step.
  if (facts.lastStepUp === true) return { pass: true };
  return { pass: false, unknown: facts.lastStepUp == null ? true : undefined, reason: "dip entry: cannot confirm the pullback has stopped (last price step is not up)" };
}

// ─── Exit: leave on the bounce ─────────────────────────────────

/**
 * "Let it dump, leave on the bounce", for a range price has travelled deep into.
 *
 * depth  = how far into the range the lowest price went: 0 = top, 1 = bottom, above 1 = below the range;
 * bounce = how far price has come back up off that low.
 * Once the low is past bounceExitMinDepthPct of the range (default: half), the first bounce of bounceExitPct
 * closes the position; past three quarters a smaller bounce (bounceExitDeepPct) is taken, because that deep
 * the small pump usually comes and the full recovery often does not.
 *
 * @param {object} p { topBin, lowerBin, activeBin, lowBin, binStep } — topBin = the bin the range starts at
 *        (the entry price for a SOL-only position), lowBin = the lowest active bin seen since the open
 * @param {object} m config.management
 */
export function checkBounceExit({ topBin, lowerBin, activeBin, lowBin, binStep } = {}, m = {}) {
  if (m.bounceExit === false) return { exit: false };
  if ([topBin, lowerBin, activeBin, lowBin, binStep].some(unknownNum)) return { exit: false };
  const top = Number(topBin), lo = Number(lowerBin), act = Number(activeBin), low = Number(lowBin), bs = Number(binStep);
  const width = top - lo;
  if (width <= 0 || bs <= 0 || low > act) return { exit: false };
  const depth = (top - low) / width;
  if (depth < (m.bounceExitMinDepthPct ?? 50) / 100) return { exit: false, depth };
  const bouncePct = (Math.pow(1 + bs / 10_000, act - low) - 1) * 100;
  const need = depth >= 0.75 ? (m.bounceExitDeepPct ?? 6) : (m.bounceExitPct ?? 10);
  if (bouncePct < need) return { exit: false, depth, bouncePct, need };
  return {
    exit: true, depth, bouncePct, need,
    reason: `Bounce exit: price went ${Math.round(depth * 100)}% into the range and is back up ${bouncePct.toFixed(1)}% off the low (leave on a +${need}% bounce)`,
  };
}

/**
 * Decide whether a deploy may go ahead, and with which arguments. Pure: everything it needs is passed in.
 *
 * @param {object} p
 * @param {object} p.args              what the model (or a human command) asked for
 * @param {object|null} p.candidate    this pool's record from the last screening run ({ pool, name, bin_step, base_mint, volatility }) or null
 * @param {object} p.cfg               { risk, screening, management, strategy } from config.js
 * @param {Array|null} p.openPositions [{ pool, base_mint }] or null when the positions API failed
 * @param {number|null} p.sizeCapSol   computeDeployAmount(wallet SOL); null = no size cap beyond maxDeployAmount
 *                                     (dry run, or a deploy typed by the owner at the CLI)
 * @param {boolean} [p.requireScreened] pool must be in the latest screening result. Default: on, unless
 *                                     allowUnscreenedDeploy. The executor turns it off for the owner's own CLI deploys.
 * @param {boolean} [p.ownerRange]     the caller is the owner at the CLI: a bins_below he typed is kept (up to
 *                                     maxBinsBelow) instead of being recomputed
 * @returns {{ pass: false, reason: string } | { pass: true, args: object }}
 */
export function checkDeploy({ args = {}, candidate = null, cfg, openPositions, sizeCapSol = null, requireScreened, ownerRange = false }) {
  const risk = cfg.risk || {};
  if (requireScreened === undefined) requireScreened = risk.allowUnscreenedDeploy !== true;
  const twoSided = risk.allowTwoSided === true;

  if (!args.pool_address || typeof args.pool_address !== "string") {
    return { pass: false, reason: "pool_address is required." };
  }
  if (!Array.isArray(openPositions)) {
    return { pass: false, reason: "Open positions could not be read (API error), so the position count and duplicate checks cannot run. Not deploying blind — retry next cycle." };
  }
  if (!candidate && requireScreened) {
    return { pass: false, reason: `Pool ${args.pool_address} is not in the latest screening result. Only screened pools can be deployed into (run get_top_candidates again, or set allowUnscreenedDeploy to deploy by hand).` };
  }

  // bin step: the screened record is authoritative; the model's own claim is only a fallback.
  // (dlmm.js re-checks against the on-chain pool before sending anything.)
  const binStep = candidate?.bin_step ?? args.bin_step ?? null;
  const { minBinStep, maxBinStep } = cfg.screening;
  if (binStep != null && (binStep < minBinStep || binStep > maxBinStep)) {
    return { pass: false, reason: `bin_step ${binStep} is outside the allowed range of [${minBinStep}-${maxBinStep}].` };
  }

  if (openPositions.length >= risk.maxPositions) {
    return { pass: false, reason: `Max positions (${risk.maxPositions}) reached. Close a position first.` };
  }
  if (openPositions.some((p) => p.pool === args.pool_address)) {
    return { pass: false, reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.` };
  }
  const baseMint = candidate?.base_mint ?? args.base_mint ?? null;
  if (baseMint && openPositions.some((p) => p.base_mint === baseMint)) {
    return { pass: false, reason: `Already holding base token ${baseMint} in another pool. One position per token only.` };
  }

  const amountY = Number(args.amount_y ?? args.amount_sol ?? 0);
  if (!Number.isFinite(amountY) || amountY <= 0) {
    return { pass: false, reason: "Must provide a positive SOL amount (amount_y)." };
  }
  const minDeploy = Math.max(0.1, cfg.management.deployAmountSol);
  if (amountY < minDeploy) {
    return { pass: false, reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.` };
  }
  if (amountY > risk.maxDeployAmount) {
    return { pass: false, reason: `SOL amount ${amountY} exceeds maximum allowed per position (${risk.maxDeployAmount}).` };
  }
  if (sizeCapSol != null && amountY > sizeCapSol * 1.01) {
    return { pass: false, reason: `SOL amount ${amountY} is above the position size for this wallet (${sizeCapSol} SOL = positionSizePct of the balance after the gas reserve). Use ${sizeCapSol} SOL.` };
  }

  const amountX = Number(args.amount_x ?? 0);
  if (!Number.isFinite(amountX) || amountX < 0) {
    return { pass: false, reason: "amount_x must be 0 or a positive number." };
  }
  const binsAbove = Number(args.bins_above ?? 0);
  if (!Number.isInteger(binsAbove) || binsAbove < 0) {
    return { pass: false, reason: "bins_above must be a whole number, 0 or more." };
  }
  if (!twoSided && (amountX > 0 || binsAbove > 0)) {
    return { pass: false, reason: "This agent is set to SOL-only positions (amount_x = 0, bins_above = 0). Two-sided deposits put half the money into the token; set allowTwoSided to permit them." };
  }

  // Range. Computed here, not by the model.
  //   rangeMode "cover" (default): the bottom sits coverMinPct–coverMaxPct below the entry price, deeper for
  //     volatile pools and small market caps; bins = that distance at this pool's bin step.
  //   rangeMode "bins": the older rule, minBinsBelow–binsBelow bins by volatility.
  // A range the owner typed at the CLI is kept as typed.
  const st = cfg.strategy || {};
  const hardMaxBins = st.maxBinsBelow ?? 200;
  const askedBins = Number(args.bins_below);
  let binsBelow;
  let coverPct = null;
  if (ownerRange && Number.isInteger(askedBins) && askedBins > 0) {
    binsBelow = Math.min(hardMaxBins, askedBins);
  } else if ((st.rangeMode ?? "cover") === "cover") {
    if (binStep == null) {
      return { pass: false, reason: "The pool's bin step is not known, so the range cannot be sized. Pass bin_step (or --bins-below at the CLI)." };
    }
    coverPct = coverPctFor({ volatility: candidate?.volatility, mcap: candidate?.mcap }, st);
    binsBelow = binsForCover(coverPct, binStep);
    if (binsBelow == null) return { pass: false, reason: `Could not size a ${coverPct}% range at bin step ${binStep}.` };
    if (binsBelow > hardMaxBins) binsBelow = hardMaxBins; // very small bin steps: cap the transaction count
  } else {
    const minBins = st.minBinsBelow ?? 35;
    const maxBins = Math.max(minBins, st.binsBelow ?? 69);
    const computed = binsBelowFor(candidate?.volatility, minBins, maxBins);
    binsBelow = computed ?? Number(args.bins_below ?? maxBins);
    if (!Number.isFinite(binsBelow)) binsBelow = maxBins;
    binsBelow = Math.max(minBins, Math.min(maxBins, Math.round(binsBelow)));
  }
  const actualCover = binStep != null ? coverOfBins(binsBelow, binStep) : null;

  const strategy = args.strategy || cfg.strategy.strategy;
  if (!SHAPES.has(strategy)) {
    return { pass: false, reason: `Invalid strategy "${strategy}". Use bid_ask, spot or curve.` };
  }

  return {
    pass: true,
    args: {
      ...args,
      amount_y: amountY,
      amount_x: twoSided ? amountX : 0,
      bins_above: twoSided ? binsAbove : 0,
      bins_below: binsBelow,
      ...(actualCover != null ? { cover_pct: Math.round(actualCover * 10) / 10 } : {}),
      strategy,
      ...(binStep != null ? { bin_step: binStep } : {}),
      ...(baseMint ? { base_mint: baseMint } : {}),
      pool_name: sanitizeUntrusted(candidate?.name ?? args.pool_name, 40) ?? args.pool_address.slice(0, 8),
    },
  };
}

// ─── Swap ──────────────────────────────────────────────────────

/**
 * Selling a token for SOL is always allowed (that is how a closed position gets back to SOL).
 * Buying a token with SOL is only allowed when two-sided positions are switched on, and then only up to the
 * position cap and never into the gas reserve. Token-to-token swaps are refused.
 */
export function checkSwap({ args = {}, cfg, solMint, solBalance = null }) {
  const norm = (m) => (m === "SOL" || m === "native" ? solMint : m);
  const input = norm(args.input_mint);
  const output = norm(args.output_mint);
  const amount = Number(args.amount);
  if (!input || !output || input === output) return { pass: false, reason: "input_mint and output_mint are required and must differ." };
  if (!Number.isFinite(amount) || amount <= 0) return { pass: false, reason: "amount must be a positive number." };
  if (output === solMint) return { pass: true };
  if (input !== solMint) return { pass: false, reason: "Token-to-token swaps are not allowed. Swap to SOL." };
  if (cfg.risk?.allowTwoSided !== true) {
    return { pass: false, reason: "Buying a token with SOL is disabled: this agent runs SOL-only positions (set allowTwoSided to permit it)." };
  }
  if (amount > cfg.risk.maxDeployAmount) {
    return { pass: false, reason: `Swap of ${amount} SOL exceeds the per-position cap (${cfg.risk.maxDeployAmount} SOL).` };
  }
  const reserve = cfg.management?.gasReserve ?? 0.2;
  if (solBalance != null && amount > solBalance - reserve) {
    return { pass: false, reason: `Swap of ${amount} SOL would eat into the ${reserve} SOL gas reserve (balance ${solBalance}).` };
  }
  return { pass: true };
}

/**
 * Price impact of a quote in percent, or null when it cannot be told.
 * Preferred: the quote's own USD values (1 - out/in), which needs no unit convention. The reported
 * priceImpactPct is only trusted when it is above 1: Jupiter has used both "0.01 = 1%" and "1 = 1%" across
 * APIs, and guessing wrong would block every ordinary swap, so a small ambiguous value counts as unknown.
 */
export function quoteImpactPct({ inUsd, outUsd, reported } = {}) {
  const i = Number(inUsd), o = Number(outUsd);
  if (Number.isFinite(i) && Number.isFinite(o) && i > 0 && o >= 0) return Math.max(0, (1 - o / i) * 100);
  const r = Math.abs(Number(reported));
  return Number.isFinite(r) && r > 1 ? r : null;
}

/** Refuse a quote whose price impact is above the limit. An unknown impact passes (the route still has its own slippage cap). */
export function checkPriceImpact(impactPct, maxPct) {
  const v = Math.abs(Number(impactPct));
  if (!Number.isFinite(v) || maxPct == null) return { pass: true };
  return v > maxPct
    ? { pass: false, reason: `Price impact ${v.toFixed(2)}% is above the ${maxPct}% limit — not swapping. Sell by hand or raise maxSwapPriceImpactPct.` }
    : { pass: true };
}

// ─── Agent loop ────────────────────────────────────────────────

/**
 * Key for the "once per session" lock. Closing two different positions (or swapping two different tokens) in one
 * session is legitimate; doing the same one twice is not. A deploy stays one per session whatever the pool.
 */
export function lockKey(name, args) {
  const a = args && typeof args === "object" ? args : {}; // a model can send `null` as arguments
  if (name === "close_position") return `${name}:${a.position_address ?? "?"}`;
  if (name === "swap_token") return `${name}:${a.input_mint ?? "?"}`;
  return name;
}

// ─── Token audit ───────────────────────────────────────────────

/**
 * Hard token checks that need the token's audit record (Jupiter): blocked launchpad, bot holders, mint / freeze
 * authority, top-10 concentration. One function so that every way of reaching a deploy (scheduled cycle, chat,
 * Telegram, the `auto` command) runs the same checks.
 *
 * @param {object} p
 * @param {object|null} p.token  { launchpad, audit: { mint_disabled, freeze_disabled, top_holders_pct, bot_holders_pct } }
 * @param {object} p.screening   config.screening
 * @returns {{ pass: true } | { pass: false, reason: string, missing?: true }}
 */
export function checkTokenAudit({ token, screening: s = {} }) {
  const failClosed = s.failClosedOnMissingData !== false;
  const launchpad = token?.launchpad ?? null;
  if (launchpad && Array.isArray(s.blockedLaunchpads) && s.blockedLaunchpads.includes(launchpad)) {
    return { pass: false, reason: `blocked launchpad (${launchpad})` };
  }
  const audit = token?.audit ?? null;
  if (!audit) {
    return failClosed ? { pass: false, missing: true, reason: "no token audit data (failClosedOnMissingData)" } : { pass: true };
  }
  const bots = Number.parseFloat(audit.bot_holders_pct);
  if (s.maxBotHoldersPct != null && Number.isFinite(bots) && bots > s.maxBotHoldersPct) {
    return { pass: false, reason: `bot holders ${bots}% > ${s.maxBotHoldersPct}%` };
  }
  if (s.requireRenouncedAuthorities !== false) {
    if (audit.mint_disabled === false) return { pass: false, reason: "mint authority is still active (supply can be inflated)" };
    if (audit.freeze_disabled === false) return { pass: false, reason: "freeze authority is still active (your tokens can be frozen)" };
    if (failClosed && (audit.mint_disabled == null || audit.freeze_disabled == null)) {
      return { pass: false, missing: true, reason: "mint / freeze authority unknown (failClosedOnMissingData)" };
    }
  }
  const top10 = Number.parseFloat(audit.top_holders_pct);
  if (s.maxTop10Pct != null && Number.isFinite(top10) && top10 > s.maxTop10Pct) {
    return { pass: false, reason: `top-10 holders ${top10}% > ${s.maxTop10Pct}%` };
  }
  return { pass: true };
}
