import { discoverPools, getPoolDetail, getTopCandidates, getScreenedCandidate } from "./screening.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken, normalizeMint } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, updateSignalSnapshot, recordPendingSwap, clearPendingSwap } from "../state.js";
import { getAndClearStagedSignals } from "../signal-tracker.js";

import { getPoolMemory, addPoolNote, isPoolOnCooldown, isBaseMintOnCooldown } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "../config.js";
import { checkDeploy, checkSwap, validateConfigChanges } from "../guards.js";
import { getPoolFacts } from "./meteora.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, sendMessage } from "../telegram.js";

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    // setPositionInstruction returns: true (saved), false (not found), or { error: string } (rejected)
    if (ok === false) return { error: `Position ${position_address} not found in state` };
    if (ok && typeof ok === "object" && ok.error) return { error: ok.error };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        const child = spawn(process.execPath, process.argv.slice(1), {
          detached: true,
          stdio: "inherit",
          cwd: process.cwd(),
        });
        child.unref();
        process.exit(0);
      }, 3000);
      return { success: true, updated: true, message: `Updated! Restarting in 3s...\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" } = {}, ctx = {}) => {
    // Only a human-driven chat session may change config. The autonomous screening and management cycles
    // (and anything injected into them) cannot widen their own limits.
    if (ctx.agentType && ctx.agentType !== "GENERAL") {
      log("safety_block", `update_config refused for ${ctx.agentType} cycle: ${JSON.stringify(changes)}`);
      return { success: false, error: "update_config is only available in a chat session, not to the autonomous cycles." };
    }
    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object of key → value" };
    }
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      maxFeeActiveTvlRatio: ["screening", "maxFeeActiveTvlRatio"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minAthPct:        ["screening", "minAthPct"],
      minFeePct:        ["screening", "minFeePct"],
      blockedLaunchpads:    ["screening", "blockedLaunchpads"],
      avoidPvpSymbols:      ["screening", "avoidPvpSymbols"],
      blockPvpSymbols:      ["screening", "blockPvpSymbols"],
      minFeePerTvl24h:      ["management", "minFeePerTvl24h"],
      pnlSanityMaxDiffPct:    ["management", "pnlSanityMaxDiffPct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      poolMaxDeploys:         ["management", "poolMaxDeploys"],
      poolDeployWindowDays:   ["management", "poolDeployWindowDays"],
      poolCooldownHours:      ["management", "poolCooldownHours"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      minClaimAmountSol: ["management", "minClaimAmountSol"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitFeePct: ["management", "takeProfitFeePct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin:  ["schedule", "managementIntervalMin"],
      screeningIntervalMin:   ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel:  ["llm", "screeningModel"],
      generalModel:    ["llm", "generalModel"],
      temperature:     ["llm", "temperature"],
      maxTokens:       ["llm", "maxTokens"],
      maxSteps:        ["llm", "maxSteps"],
      // strategy
      strategy:  ["strategy", "strategy"],
      rangeMode: ["strategy", "rangeMode"],
      coverMinPct: ["strategy", "coverMinPct"],
      coverMaxPct: ["strategy", "coverMaxPct"],
      coverDeepBelowMcap: ["strategy", "coverDeepBelowMcap"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      binsBelow: ["strategy", "binsBelow"],
      minBinsBelow: ["strategy", "minBinsBelow"],
      // entry timing
      entryMode:             ["screening", "entryMode"],
      entryDipMinPct:        ["screening", "entryDipMinPct"],
      entryDipMaxPct:        ["screening", "entryDipMaxPct"],
      entryDipLookbackHours: ["screening", "entryDipLookbackHours"],
      entrySettleMinutes:    ["screening", "entrySettleMinutes"],
      entrySettleBouncePct:  ["screening", "entrySettleBouncePct"],
      entryMaxFall3dPct:     ["screening", "entryMaxFall3dPct"],
      // exits added with the pullback entry
      outOfRangeAboveWaitMinutes: ["management", "outOfRangeAboveWaitMinutes"],
      bounceExit:            ["management", "bounceExit"],
      bounceExitMinDepthPct: ["management", "bounceExitMinDepthPct"],
      bounceExitPct:         ["management", "bounceExitPct"],
      bounceExitDeepPct:     ["management", "bounceExitDeepPct"],
      maxSwapPriceImpactPct: ["risk", "maxSwapPriceImpactPct"],
    };

    const requested = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      requested[match[0]] = val;
    }

    // Type and range check every value (guards.js CONFIG_BOUNDS). Out-of-range values are rejected, not clamped.
    const current = Object.fromEntries(Object.entries(CONFIG_MAP).map(([k, [section, field]]) => [k, config[section][field]]));
    const { applied, rejected } = validateConfigChanges(requested, current);
    if (Object.keys(rejected).length > 0) {
      log("config", `update_config rejected: ${JSON.stringify(rejected)}`);
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, rejected: ${JSON.stringify(rejected)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, rejected, reason };
    }

    // Apply to live config immediately
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }

    // Persist to user-config.json
    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try { userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8")); } catch { /**/ }
    }
    Object.assign(userConfig, applied);
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Save as a lesson — but skip ephemeral per-deploy interval changes
    // (managementIntervalMin / screeningIntervalMin change every deploy based on volatility;
    //  the rule is already in the system prompt, storing it 75+ times is pure noise)
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, rejected, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args, ctx = {}) {
  // ctx = { agentType, source }: who is asking. agentType is the LLM role (SCREENER / MANAGER / GENERAL);
  // source "rule" = a deterministic exit rule in index.js, "human" = a direct Telegram / CLI command.
  const startTime = Date.now();
  args = args && typeof args === "object" ? args : {};

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  if (PROTECTED_TOOLS.has(name)) {
    const safetyCheck = await runSafetyChecks(name, args, ctx);
    if (!safetyCheck.pass) {
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args, ctx);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    // A dry run sent nothing: no "Deployed" / "Closed" message, no signals attached, no swap to follow up.
    // (Telegram used to say "Closed … +$0.00" for every simulated close.)
    if (success && !result?.dry_run) {
      if (name === "swap_token" && result.tx) {
        if (normalizeMint(args.output_mint) === config.tokens.SOL) clearPendingSwap(normalizeMint(args.input_mint));
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        // Attach staged Darwin signals to the new position
        if (result.position && args.pool_address) {
          const signals = getAndClearStagedSignals(args.pool_address);
          if (signals) updateSignalSnapshot(result.position, signals);
        }
      } else if (name === "close_position") {
        notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0 }).catch(() => {});
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` });
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          const sym = result.base_mint.slice(0, 8);
          const swapFailed = (why) => {
            // Say what really happened: the bag is still in the wallet. (This used to report "already swapped".)
            result.auto_swapped = false;
            result.auto_swap_error = why;
            result.auto_swap_note = `Auto-swap of the leftover ${sym} back to SOL FAILED (${why}). The tokens are still in the wallet; the swap is retried on the next management checks.`;
            log("executor_warn", `Auto-swap after close failed: ${why}`);
            // Remember it: index.js retries on every management check until it goes through or gives up.
            recordPendingSwap(result.base_mint, { pool_name: result.pool_name || null, error: why });
            sendMessage(`⚠️ Closed ${result.pool_name || sym}, but the leftover tokens were NOT swapped to SOL: ${why}. They are still in the wallet. The swap will be retried on the next checks; sell by hand if you do not want to wait.`).catch(() => {});
          };
          try {
            const balances = await getWalletBalances({});
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            // Helius has no price for many new or dumped tokens (usd = null). That is not a reason to keep the bag.
            if (token && token.balance > 0 && (token.usd == null || token.usd >= 0.10)) {
              log("executor", `Auto-swapping ${token.symbol || sym} (${token.usd != null ? "$" + token.usd.toFixed(2) : "no price"}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
              if (swapResult?.success === false) {
                swapFailed(swapResult.error || "swap failed");
              } else {
                // Tell the model the swap already happened so it doesn't call swap_token again
                result.auto_swapped = true;
                result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || sym} → SOL). Do NOT call swap_token again.`;
                if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
              }
            } else if (balances.error) {
              swapFailed(`wallet balance could not be read (${balances.error})`);
            } else if (!token || !(token.balance > 0)) {
              // Not in the balance list. Either the position held no tokens, or the balance API has not caught
              // up with the close yet. Do not assume the first: the management cycle looks again (3 times).
              recordPendingSwap(result.base_mint, { pool_name: result.pool_name || null, error: "not in the wallet balance list right after the close" });
            }
          } catch (e) {
            swapFailed(e.message);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args, ctx = {}) {
  switch (name) {
    case "deploy_position": {
      // All the yes/no logic is in guards.js checkDeploy (unit-tested). Here we only gather the facts.
      const positions = await getMyPositions({ force: true });
      let balance = null;
      if (process.env.DRY_RUN !== "true") {
        balance = await getWalletBalances();
        if (balance.error) {
          return { pass: false, reason: `Wallet balance could not be read (${balance.error}). Not deploying blind.` };
        }
      }
      args.pool_address = normalizeMint(args.pool_address);
      // A deploy typed by the owner (cli.js) may name any pool and any size up to maxDeployAmount; everything
      // that comes through the model is tied to the screening result and to the computed position size.
      const human = ctx.source === "human";
      const requireScreened = !human && config.risk.allowUnscreenedDeploy !== true;
      let candidate = getScreenedCandidate(args.pool_address);
      if (!candidate && !requireScreened) {
        // A pool named by hand has no screening record. Read its bin step, market cap and base mint from
        // Meteora's pool record so the range can still be sized in code.
        try {
          const facts = await getPoolFacts(args.pool_address);
          if (facts.is_blacklisted) {
            return { pass: false, reason: `Pool ${args.pool_address} is blacklisted by Meteora.` };
          }
          candidate = facts;
        } catch (e) {
          log("executor_warn", `Pool record unavailable for ${args.pool_address}: ${e.message}`);
        }
      }
      const verdict = checkDeploy({
        args,
        candidate,
        cfg: config,
        openPositions: positions.unknown ? null : positions.positions,
        sizeCapSol: balance && !human ? computeDeployAmount(balance.sol) : null,
        requireScreened,
        // Only a range the owner typed himself at the CLI is kept as typed. Anything that reaches here through
        // the model (the autonomous cycles, and chat too) is sized in code: a chat message is turned into
        // arguments by the model, which could just as well invent a shallow range nobody asked for. To use a
        // different range from chat, change coverMinPct / coverMaxPct with update_config first.
        ownerRange: human,
      });
      if (!verdict.pass) return verdict;
      // Use the checked arguments from here on: bin step and base mint from the screening record, bins below
      // computed in code, SOL-only unless allowTwoSided.
      Object.assign(args, verdict.args);

      // Cooldown check — block re-entry into pools/tokens that are on cooldown
      if (isPoolOnCooldown(args.pool_address)) {
        return {
          pass: false,
          reason: `Pool ${args.pool_address} is on cooldown — re-entry blocked. Wait for cooldown to expire.`,
        };
      }
      if (args.base_mint && isBaseMintOnCooldown(args.base_mint)) {
        return {
          pass: false,
          reason: `Base token ${args.base_mint} is on cooldown — re-entry blocked. Wait for cooldown to expire.`,
        };
      }

      if (balance) {
        const gasReserve = config.management.gasReserve;
        const minRequired = args.amount_y + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${args.amount_y} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      return { pass: true };
    }

    case "swap_token": {
      // Selling a token for SOL always passes. Buying a token needs allowTwoSided, a size cap and the gas reserve.
      const input = normalizeMint(args.input_mint);
      const output = normalizeMint(args.output_mint);
      let solBalance = null;
      if (input === config.tokens.SOL && process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        solBalance = balance.error ? 0 : balance.sol;
      }
      return checkSwap({ args: { ...args, input_mint: input, output_mint: output }, cfg: config, solMint: config.tokens.SOL, solBalance });
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
