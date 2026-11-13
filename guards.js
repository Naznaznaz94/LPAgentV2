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
  const v = Number(volatility);
  if (!Number.isFinite(v)) return null;
  return Math.max(min, Math.min(max, Math.round(min + (Math.max(0, v) / 5) * (max - min))));
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
 * @returns {{ pass: false, reason: string } | { pass: true, args: object }}
 */
export function checkDeploy({ args = {}, candidate = null, cfg, openPositions, sizeCapSol = null, requireScreened }) {
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

  const minBins = cfg.strategy.minBinsBelow ?? 35;
  const maxBins = Math.max(minBins, cfg.strategy.binsBelow ?? 69);
  const computed = binsBelowFor(candidate?.volatility, minBins, maxBins);
  let binsBelow = computed ?? Number(args.bins_below ?? maxBins);
  if (!Number.isFinite(binsBelow)) binsBelow = maxBins;
  binsBelow = Math.max(minBins, Math.min(maxBins, Math.round(binsBelow)));

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
export function lockKey(name, args = {}) {
  if (name === "close_position") return `${name}:${args.position_address ?? "?"}`;
  if (name === "swap_token") return `${name}:${args.input_mint ?? "?"}`;
  return name;
}
