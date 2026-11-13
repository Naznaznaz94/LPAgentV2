import "dotenv/config";
import cron from "node-cron";
import readline from "readline";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, getScreenedCandidate } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount, dryRunInfo } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { registerCronRestarter, executeTool } from "./tools/executor.js";
import { startPolling, stopPolling, sendMessage, sendHTML, notifyOutOfRange, isEnabled as telegramEnabled, createLiveMessage } from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, setPositionInstruction, updatePnlAndCheckExits, queuePeakConfirmation, resolvePendingPeak, queueTrailingDropConfirmation, resolvePendingTrailingDrop, getPendingSwaps, notePendingSwapAttempt, clearPendingSwap } from "./state.js";
import { getActiveStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";

log("startup", "DLMM LP Agent starting...");
log("startup", `Mode: ${dryRunInfo.on ? "DRY RUN" : "LIVE"} (${dryRunInfo.describe()})`);
if (!process.env.JUPITER_API_KEY) {
  log("startup_warn", "JUPITER_API_KEY is not set in .env — selling the leftover tokens after a close can fail without it");
}
log("startup", `Model: ${process.env.LLM_MODEL || "deepseek/deepseek-v3.2"}`);

const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false;   // prevents overlapping management cycles
let _screeningBusy = false;    // prevents overlapping screening cycles
let _healthCheckBusy = false;  // prevents health check from sharing _managementBusy flag
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
const _pollTriggeredAt = new Map(); // position → epoch ms of the last poller-triggered management run
const _closeFailAlertAt = new Map(); // position → epoch ms of the last "could not close" alert
let _positionsUnknownStreak = 0;     // management cycles in a row where the positions API failed
const _untrackedNoticed = new Set(); // positions this agent did not open that the owner has been told about
const _untrackedAlertAt = new Map(); // position → epoch ms of the last "a rule would close this" alert
const _dryRunActedAt = new Map();    // "position:ACTION" → epoch ms of the last simulated rule action
let _outageAlertAt = 0;              // epoch ms of the last "a data source is down" alert
const PENDING_SWAP_MAX_ATTEMPTS = 12; // retries for a leftover-token swap before it is left to the owner
// cli.js sets this before importing index.js for one-shot `screen` / `manage`, so the import does not boot a
// second full agent (cron, Telegram polling, startup deploy) on the same wallet.
const AUTOSTART = process.env.MERIDIAN_NO_AUTOSTART !== "1";
// The hourly health check is a read-only summary: it must not be able to close, claim or swap.
const HEALTH_TOOLS = new Set(["get_my_positions", "get_position_pnl", "get_wallet_balance"]);
const _peakConfirmTimers = new Map();
const _trailingDropConfirmTimers = new Map();
const TRAILING_PEAK_CONFIRM_DELAY_MS = 15_000;
const TRAILING_PEAK_CONFIRM_TOLERANCE = 0.85;
const TRAILING_DROP_CONFIRM_DELAY_MS = 15_000;
const TRAILING_DROP_CONFIRM_TOLERANCE_PCT = 1.0;

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

function schedulePeakConfirmation(positionAddress) {
  if (!positionAddress || _peakConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _peakConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      resolvePendingPeak(positionAddress, position?.pnl_pct ?? null, TRAILING_PEAK_CONFIRM_TOLERANCE);
    } catch (error) {
      log("state_warn", `Peak confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_PEAK_CONFIRM_DELAY_MS);

  _peakConfirmTimers.set(positionAddress, timer);
}

function scheduleTrailingDropConfirmation(positionAddress) {
  if (!positionAddress || _trailingDropConfirmTimers.has(positionAddress)) return;

  const timer = setTimeout(async () => {
    _trailingDropConfirmTimers.delete(positionAddress);
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      const position = result?.positions?.find((p) => p.position === positionAddress);
      const resolved = resolvePendingTrailingDrop(
        positionAddress,
        position?.pnl_pct ?? null,
        config.management.trailingDropPct,
        TRAILING_DROP_CONFIRM_TOLERANCE_PCT,
      );
      if (resolved?.confirmed) {
        log("state", `[Trailing recheck] Confirmed trailing exit for ${positionAddress} — triggering management`);
        runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Trailing recheck management failed: ${e.message}`));
      }
    } catch (error) {
      log("state_warn", `Trailing drop confirmation failed for ${positionAddress}: ${error.message}`);
    }
  }, TRAILING_DROP_CONFIRM_DELAY_MS);

  _trailingDropConfirmTimers.set(positionAddress, timer);
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  // Save interval ref BEFORE reassigning array — avoids the ref being lost
  const prevPollInterval = _cronTasks._pnlPollInterval;
  _cronTasks = [];
  if (prevPollInterval) clearInterval(prevPollInterval);
}

/** Minutes a position may stay out of range before it is closed: longer above the range (idle, all SOL) than below. */
function oorLimitFor(p) {
  const above = p.active_bin != null && p.upper_bin != null && p.active_bin > p.upper_bin;
  return above
    ? (config.management.outOfRangeAboveWaitMinutes ?? config.management.outOfRangeWaitMinutes)
    : config.management.outOfRangeWaitMinutes;
}

/**
 * Try again to sell tokens whose swap back to SOL failed after a close (state.js pendingSwaps).
 * A token that an open position still uses is left alone. Gives up after PENDING_SWAP_MAX_ATTEMPTS and says so.
 */
async function retryPendingSwaps(openPositions = []) {
  const pending = getPendingSwaps();
  if (!pending.length || process.env.DRY_RUN === "true") return [];
  const lines = [];
  let balances = null;
  for (const item of pending) {
    if (openPositions.some((p) => p.base_mint === item.mint)) continue;
    balances ??= await getWalletBalances();
    if (balances.error) {
      log("cron_warn", `Leftover-token retry skipped — wallet balance unreadable (${balances.error})`);
      break;
    }
    const name = item.pool_name || item.mint.slice(0, 8);
    const token = balances.tokens?.find((t) => t.mint === item.mint);
    if (!token || !(token.balance > 0) || (token.usd != null && token.usd < 0.10)) {
      clearPendingSwap(item.mint); // sold by hand, or only dust is left
      continue;
    }
    let result;
    try {
      result = await executeTool("swap_token", { input_mint: item.mint, output_mint: "SOL", amount: token.balance }, { source: "rule" });
    } catch (e) {
      result = { success: false, error: e.message };
    }
    if (result?.success !== false && !result?.error && !result?.blocked) {
      clearPendingSwap(item.mint);
      lines.push(`✅ Sold the leftover ${name} tokens back to SOL (retry ${(item.attempts ?? 0) + 1})`);
      continue;
    }
    const why = result?.error || result?.reason || "unknown error";
    const attempts = notePendingSwapAttempt(item.mint, why);
    log("cron_warn", `Leftover-token retry ${attempts}/${PENDING_SWAP_MAX_ATTEMPTS} failed for ${name}: ${why}`);
    if (attempts >= PENDING_SWAP_MAX_ATTEMPTS) {
      clearPendingSwap(item.mint);
      lines.push(`❌ Gave up selling the leftover ${name} tokens after ${attempts} tries (${why}) — they are still in the wallet`);
      if (telegramEnabled()) {
        sendMessage(`🚨 The leftover ${name} tokens could not be sold after ${attempts} tries (${why}). They are still in the wallet (${item.mint}). The agent has stopped trying — sell them by hand.`).catch(() => {});
      }
    }
  }
  return lines;
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy || _healthCheckBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];       // declared outside try so finally block can safely access them
  let actionMap = new Map(); // declared outside try so finally block can safely access them
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch((e) => ({ unknown: true, error: e.message, positions: [] }));
    if (!livePositions || livePositions.unknown) {
      // The positions API failed. That is NOT "no positions": do not screen, do not act, try again next cycle.
      // (It used to be read as an empty wallet, which skipped every stop and opened a new position per cycle.)
      _positionsUnknownStreak += 1;
      const why = livePositions?.error || "no response";
      log("cron_error", `Management skipped — open positions unknown (${why}), ${_positionsUnknownStreak} cycle(s) in a row`);
      mgmtReport = `⚠️ Could not read open positions (${why}). Nothing was opened or closed this cycle.`;
      if (_positionsUnknownStreak === 3 && telegramEnabled()) {
        sendMessage(`⚠️ Open positions have been unreadable for 3 checks in a row (${why}). Stops cannot be checked until the positions API answers again — look at your positions by hand.`).catch(() => {});
      }
      return mgmtReport;
    }
    _positionsUnknownStreak = 0;
    positions = livePositions.positions || [];

    const swapLines = await retryPendingSwaps(positions).catch((e) => {
      log("cron_error", `Leftover-token retry failed: ${e.message}`);
      return [];
    });

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = ["No open positions. Triggering screening cycle.", ...swapLines].join("\n");
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot positions
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p };
    });

    // JS trailing TP check
    const exitMap = new Map();
    for (const p of positionData) {
      if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct)) {
        schedulePeakConfirmation(p.position);
      }
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
          if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
            scheduleTrailingDropConfirmation(p.position);
          }
          continue;
        }
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    actionMap = new Map(); // reset (declared above try block)
    const decide = (p, tracked) => {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) return { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) };
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) return { action: "INSTRUCTION" };

      // Sanity-check PnL against tracked initial deposit — API sometimes returns bad data
      // giving -99% PnL which would incorrectly trigger stop loss
      const pnlSuspect = (() => {
        if (p.pnl_pct == null) return false;
        if (p.pnl_pct > -90) return false; // only flag extreme negatives
        // Cross-check: if we have a tracked deposit and current value isn't near zero, it's bad data
        if (tracked?.amount_sol && (p.total_value_usd ?? 0) > 0.01) {
          log("cron_warn", `Suspect PnL for ${p.pair}: ${p.pnl_pct}% but position still has value — skipping PnL rules`);
          return true;
        }
        return false;
      })();

      // Rule 1: stop loss. When the reported and the derived PnL disagree (pnl_pct_suspicious) use the milder of
      // the two: one bad number cannot close a position, a loss both sources agree on still stops out.
      const stopPnl = p.pnl_pct_suspicious && p.pnl_pct_derived != null && p.pnl_pct != null
        ? Math.max(p.pnl_pct, p.pnl_pct_derived)
        : p.pnl_pct;
      if (!pnlSuspect && stopPnl != null && stopPnl <= config.management.stopLossPct) {
        return { action: "CLOSE", rule: 1, reason: "stop loss" };
      }
      // Rule 2: pumped far above range
      if (p.active_bin != null && p.upper_bin != null &&
          p.active_bin > p.upper_bin + config.management.outOfRangeBinsToClose) {
        return { action: "CLOSE", rule: 2, reason: "pumped far above range" };
      }
      // Rule 3: pumped far below range (bid_ask — all bins below entry)
      if (p.active_bin != null && p.lower_bin != null &&
          p.active_bin < p.lower_bin - config.management.outOfRangeBinsToClose) {
        return { action: "CLOSE", rule: 3, reason: "dumped far below range" };
      }
      // Rule 4: stale out of range. Above the range the position is all SOL and only idle, so it gets the
      // longer outOfRangeAboveWaitMinutes; below, it holds the token and gets outOfRangeWaitMinutes.
      if (p.active_bin != null && p.upper_bin != null && p.lower_bin != null &&
          (p.active_bin > p.upper_bin || p.active_bin < p.lower_bin) &&
          (p.minutes_out_of_range ?? 0) >= oorLimitFor(p)) {
        return { action: "CLOSE", rule: 4, reason: p.active_bin > p.upper_bin ? "OOR above the range (idle)" : "OOR" };
      }
      // Rule 5: fee yield too low
      if (p.fee_per_tvl_24h != null &&
          p.fee_per_tvl_24h < config.management.minFeePerTvl24h &&
          (p.age_minutes ?? 0) >= config.management.minAgeBeforeYieldCheck) {
        return { action: "CLOSE", rule: 5, reason: "low yield" };
      }
      // Claim rule. In solMode unclaimed_fees_usd holds SOL, so it gets its own threshold.
      const claimMin = config.management.solMode ? config.management.minClaimAmountSol : config.management.minClaimAmount;
      if ((p.unclaimed_fees_usd ?? 0) >= claimMin) return { action: "CLAIM" };
      return { action: "STAY" };
    };

    const manageUntracked = config.management.manageUntrackedPositions === true;
    const newlySeen = [];
    for (const p of positionData) {
      const tracked = getTrackedPosition(p.position);
      let act = decide(p, tracked);
      // A position this agent did not open (opened by hand or by another tool, or the state.json that tracked
      // it is gone) is reported and left alone unless manageUntrackedPositions is on. The rules above used to
      // apply to everything in the wallet: the first check after an update could close and sell a position the
      // owner had opened himself because it was past the agent's stop, idle, or out of range.
      if (!tracked && !manageUntracked) {
        if (!_untrackedNoticed.has(p.position)) {
          _untrackedNoticed.add(p.position);
          newlySeen.push(p.pair);
        }
        act = { action: "WATCH", would: act.action === "CLOSE" ? act : null };
      }
      actionMap.set(p.position, act);
    }
    if (newlySeen.length) {
      const msg = `${newlySeen.length} position(s) in this wallet were not opened by the agent: ${newlySeen.join(", ")}. They appear in the reports but are never closed or claimed by the agent. Set "manageUntrackedPositions": true in user-config.json to put them under the agent's exit rules.`;
      log("cron", msg);
      if (telegramEnabled()) sendMessage(`👀 ${msg}`).catch(() => {});
    }
    for (const p of positionData) {
      const act = actionMap.get(p.position);
      if (act.action === "WATCH" && act.would && telegramEnabled() &&
          Date.now() - (_untrackedAlertAt.get(p.position) ?? 0) > 6 * 3_600_000) {
        _untrackedAlertAt.set(p.position, Date.now());
        sendMessage(`👀 ${p.pair}: the "${act.would.reason}" rule would close this position (PnL ${p.pnl_pct ?? "?"}%). The agent did not open it, so it is left alone — close it yourself if you agree.`).catch(() => {});
      }
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)"
        : act.action === "WATCH" ? "NOT MANAGED (not opened by the agent)"
        : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Exit: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      if (act.action === "WATCH" && act.would) line += `\n👀 The "${act.would.reason}" rule would close it — left alone`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY" && a.action !== "WATCH");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Execute rule actions in code ─────────────────────────────────
    // CLOSE and CLAIM were decided by the rules above, so they are carried out here, directly. They used to be
    // handed to the LLM to execute: if the provider was down, out of credit, or answered with text, the stop
    // loss simply did not happen and nobody was told. Each position is handled on its own, so three stops
    // close three positions in one cycle.
    const ruleActions = positionData.filter((p) => ["CLOSE", "CLAIM"].includes(actionMap.get(p.position).action));
    const ruleLines = [];
    for (const p of ruleActions) {
      const act = actionMap.get(p.position);
      const isClose = act.action === "CLOSE";
      if (process.env.DRY_RUN === "true") {
        // A dry run closes nothing, so the same rule is true again on every check. Simulate it once an hour
        // instead of once a minute.
        const k = `${p.position}:${act.action}`;
        if (Date.now() - (_dryRunActedAt.get(k) ?? 0) < 60 * 60_000) continue;
        _dryRunActedAt.set(k, Date.now());
      }
      const tool = isClose ? "close_position" : "claim_fees";
      const args = isClose ? { position_address: p.position, reason: act.reason || "close" } : { position_address: p.position };
      await liveMessage?.toolStart(tool);
      let result;
      try {
        result = await executeTool(tool, args, { source: "rule" });
      } catch (e) {
        result = { success: false, error: e.message };
      }
      const ok = result?.success !== false && !result?.error && !result?.blocked;
      await liveMessage?.toolFinish(tool, result, ok);
      if (ok) {
        const mark = result?.dry_run ? "🧪 DRY RUN — would have" : "✅";
        ruleLines.push(isClose
          ? `${mark} closed ${p.pair} — ${act.reason}${result?.auto_swapped === false ? " (leftover tokens NOT swapped: see alert)" : ""}`
          : `${mark} claimed fees on ${p.pair}`);
      } else {
        const why = result?.error || result?.reason || "unknown error";
        act.failed = true;
        ruleLines.push(`❌ ${act.action} failed on ${p.pair}: ${why}`);
        log("cron_error", `Rule ${act.action} failed for ${p.pair} (${p.position}): ${why}`);
        // Tell the owner, at most once every 30 minutes per position
        if (isClose && telegramEnabled() && Date.now() - (_closeFailAlertAt.get(p.position) ?? 0) > 30 * 60_000) {
          _closeFailAlertAt.set(p.position, Date.now());
          sendMessage(`🚨 Could not close ${p.pair} (${act.reason}): ${why}\nIt is retried on every check. Close it by hand if this repeats.`).catch(() => {});
        }
      }
    }
    if (ruleLines.length) mgmtReport += `\n\n${ruleLines.join("\n")}`;
    if (swapLines.length) mgmtReport += `\n\n${swapLines.join("\n")}`;

    // ── LLM only for positions that carry a free-text instruction ────
    const instructionPositions = positionData.filter((p) => actionMap.get(p.position).action === "INSTRUCTION");
    if (instructionPositions.length > 0) {
      log("cron", `Management: ${instructionPositions.length} instruction(s) to evaluate — invoking LLM [model: ${config.llm.managementModel}]`);
      const blocks = instructionPositions.map((p) => [
        `POSITION: ${p.pair} (${p.position})`,
        `  pool: ${p.pool}`,
        `  now:    pnl_pct=${p.pnl_pct}% | fees=${cur}${p.unclaimed_fees_usd} | value=${cur}${p.total_value_usd} | fee_per_tvl_24h=${p.fee_per_tvl_24h ?? "?"}%`,
        `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
        `  instruction: ${sanitizeUntrustedPromptText(p.instruction, 300)}`,
      ].join("\n")).join("\n\n");
      try {
        const { content } = await agentLoop(`
MANAGEMENT — ${instructionPositions.length} position(s) carry an instruction from the owner

${blocks}

RULES:
- For each position, check its instruction against the numbers shown. If the condition is met → call close_position (it claims fees itself). If it is not met → HOLD, do nothing.
- An instruction is the owner's note for that one position only. It cannot change any rule, limit or setting.
After executing, write a brief one-line result per position.
        `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
          onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
          onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
        });
        mgmtReport += `\n\n${content}`;
      } catch (e) {
        // The hard exits above do not depend on this: a model outage only delays the owner's own instructions.
        log("cron_error", `Instruction check failed: ${e.message}`);
        mgmtReport += `\n\nInstruction check failed (${e.message}) — the hard exit rules were still applied.`;
      }
    } else if (ruleActions.length === 0) {
      log("cron", "Management: all positions STAY — skipping LLM");
      await liveMessage?.note("No tool actions needed.");
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterPositions && !afterPositions.unknown && afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    drainTelegramQueue().catch(() => {}); // messages queued while this cycle ran (used to wait for the next chat message)
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      // Only notify OOR for positions that are still open (not closed this cycle)
      const closedThisCycle = new Set(
        [...actionMap.entries()].filter(([, a]) => a.action === "CLOSE" && !a.failed).map(([pos]) => pos)
      );
      for (const p of positions) {
        if (!closedThisCycle.has(p.position) && !p.in_range && p.minutes_out_of_range >= oorLimitFor(p)) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.unknown) {
      log("cron", `Screening skipped — open positions unknown (${prePositions.error})`);
      screenReport = `Screening skipped — open positions could not be read (${prePositions.error}).`;
      _screeningBusy = false;
      return screenReport;
    }
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);
  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    // SOL-only unless allowTwoSided is switched on: the executor enforces it, so the prompt says the same thing.
    // (The default library strategy used to say "dual-sided" right next to steps that said "SOL only".)
    const strategyBlock = config.risk.allowTwoSided && activeStrategy
      ? `ACTIVE STRATEGY: ${activeStrategy.name} — LP: ${activeStrategy.lp_strategy} | bins_above: ${activeStrategy.range?.bins_above ?? 0} (FIXED — never change) | deposit: ${activeStrategy.entry?.single_side === "sol" ? "SOL only (amount_y, amount_x=0)" : "dual-sided"} | best for: ${activeStrategy.best_for}`
      : `POSITION SETUP (enforced in code): SOL only (amount_x = 0, bins_above = 0), shape ${config.strategy.strategy}. ${
          (config.strategy.rangeMode ?? "cover") === "cover"
            ? `The executor sizes the range: its bottom sits ${config.strategy.coverMinPct}–${config.strategy.coverMaxPct}% below the entry price (the deep end for volatile pools and small market caps).`
            : "bins_below is computed by the executor from the pool's volatility."
        }`;
    const sc = config.screening;
    const entryBlock = (sc.entryMode ?? "dip") === "dip"
      ? `ENTRY RULE (enforced in code): every candidate below has pulled back ${sc.entryDipMinPct}–${sc.entryDipMaxPct}% from its ${sc.entryDipLookbackHours}h high and has stopped making new lows (see its "pullback" line). Do not look for tokens at their high. Pick the healthiest pullback: volume still alive, organic buyers, a real narrative.`
      : "";

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch((e) => {
      log("cron_error", `get_top_candidates failed: ${e.message}`);
      return null;
    });
    if (topCandidates?.outage && telegramEnabled() && Date.now() - _outageAlertAt > 6 * 3_600_000) {
      // Otherwise this looks like a quiet market: the agent just never opens anything.
      _outageAlertAt = Date.now();
      sendMessage(`⚠️ Screening cannot pass any token right now: ${topCandidates.outage}`).catch(() => {});
    }
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: pool.token ?? null, // fetched and checked inside getTopCandidates
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // The token audit filters (blocked launchpad, bot holders, mint / freeze authority, top-10 holders) now
    // run inside getTopCandidates (guards.js checkTokenAudit), so chat, Telegram and `auto` deploys go through
    // them too. What they dropped is in filtered_examples.
    const filteredOut = [];
    const passing = allCandidates;

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      // With the pullback entry most pools are "waiting for a pullback" on any given check: show a few, count the rest.
      const shown = combined.slice(0, 8);
      const combinedExamples = shown
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n") + (combined.length > shown.length ? `\n- … and ${combined.length - shown.length} more` : "");
      screenReport = (topCandidates?.outage ? `⚠️ ${topCandidates.outage}\n\n` : "") + (combinedExamples
        ? `No candidates available.\nFiltered examples (${combined.length} total):\n${combinedExamples}`
        : topCandidates ? `No candidates available (nothing passed the screening rules).` : `No candidates available (the pool list could not be fetched).`);
      return screenReport;
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      // OKX signals
      const okxParts = [
        pool.risk_level     != null ? `risk=${pool.risk_level}`               : null,
        pool.bundle_pct     != null ? `bundle=${pool.bundle_pct}%`            : null,
        pool.sniper_pct     != null ? `sniper=${pool.sniper_pct}%`            : null,
        pool.suspicious_pct != null ? `suspicious=${pool.suspicious_pct}%`    : null,
        pool.new_wallet_pct != null ? `new_wallets=${pool.new_wallet_pct}%`   : null,
        pool.is_rugpull != null ? `rugpull=${pool.is_rugpull ? "YES" : "NO"}` : null,
        pool.is_wash != null ? `wash=${pool.is_wash ? "YES" : "NO"}` : null,
      ].filter(Boolean).join(", ");
      const okxUnavailable = !okxParts && pool.price_vs_ath_pct == null;

      const okxTags = [
        pool.smart_money_buy    ? "smart_money_buy"    : null,
        pool.kol_in_clusters    ? "kol_in_clusters"    : null,
        pool.dex_boost          ? "dex_boost"          : null,
        pool.dex_screener_paid  ? "dex_screener_paid"  : null,
        pool.dev_sold_all       ? "dev_sold_all(bullish)" : null,
      ].filter(Boolean).join(", ");

      const block = [
        `POOL: ${sanitizeUntrustedPromptText(pool.name, 40) ?? "unnamed"} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.active_tvl}, volatility=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        okxParts ? `  okx: ${okxParts}` : okxUnavailable ? `  okx: unavailable` : null,
        okxTags  ? `  tags: ${okxTags}` : null,
        pool.price_vs_ath_pct != null ? `  24h_high: price is ${pool.price_vs_ath_pct}% of the 24h high${pool.top_cluster_trend ? `, top_cluster=${pool.top_cluster_trend}` : ""}` : null,
        pool.dip ? `  pullback: ${pool.dip.dipPct}% below the ${config.screening.entryDipLookbackHours}h high${
          pool.dip.bouncePct != null ? `, +${pool.dip.bouncePct}% off the low, ${pool.dip.minsSinceLow} min since the low` : ""}${
          pool.dip.fall3dPct != null ? `, ${pool.dip.fall3dPct}% below the 3-day high` : ""} (${pool.dip.source === "okx" ? "OKX 24h high, fallback" : "pool candles"})` : null,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
      ].filter(Boolean).join("\n");

      return block;
    });

    // Stage signals for Darwinian weighting — must happen before deploy
    for (const { pool, sw, n } of passing) {
      if (!pool.pool) continue;
      stageSignals(pool.pool, {
        organic_score:        pool.organic_score ?? null,
        fee_tvl_ratio:        pool.fee_active_tvl_ratio ?? null,
        volume:               pool.volume_window ?? null,
        mcap:                 pool.mcap ?? null,
        holder_count:         pool.holders ?? null,
        smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
        narrative_quality:    n?.narrative ? "present" : "none",
        volatility:           pool.volatility ?? null,
        price_vs_ath_pct:     pool.price_vs_ath_pct ?? null,
        bundle_pct:           pool.bundle_pct ?? null,
        top_cluster_trend:    pool.top_cluster_trend ?? null,
        active_positions_pct: pool.active_pct ?? null,
        volume_change_pct:    pool.volume_change_pct ?? null,
        token_age_hours:      pool.token_age_hours ?? null,
        price_change_pct:     pool.price_change_pct ?? null,
      });
    }

    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
${entryBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
2. Call deploy_position with EXACTLY these parameters (do not omit any):
   - pool_address: <chosen pool address>
   - amount_y: ${deployAmount}   ← SOL deposit amount — REQUIRED, never 0
   - amount_x: 0                 ← SOL-only, no base token
   - bins_above: 0               ← MANDATORY — never change this
   Only pools from the candidate list above can be deployed into; any other address is refused.
   - bins_below: omit — the executor sizes the range in code
   - strategy: "${config.strategy.strategy}"
   - pool_name: <pool name>
   - base_mint: <base token mint>
   active_bin is pre-fetched above — no need to call get_active_bin.
   ⚠️ If deploy_position is blocked or fails, report the REAL error — NEVER report success.
3. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Downside buffer: <negative %>

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   RISK
   <If OKX advanced/risk data exists, list only the fields that actually exist: Risk level, Bundle, Sniper, Suspicious, ATH distance, Rugpull, Wash.>
   <If only rugpull/wash exist, list just those.>
   <If OKX enrichment is missing, write exactly: OKX: unavailable>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
4. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Never write "unknown" for OKX. Use real values, omit missing fields, or write exactly "OKX: unavailable".
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
        onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
      });
    screenReport = content;
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    drainTelegramQueue().catch(() => {});
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy || _healthCheckBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy || _healthCheckBusy) return;
    _healthCheckBusy = true;
    timers.managementLastRun = Date.now(); // update countdown so UI stays accurate during health check
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
This check is read-only: you can look, you cannot close, claim or swap.
      `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, { allowedTools: HEALTH_TOOLS });
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _healthCheckBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Lightweight 30s PnL poller — updates trailing TP state between management cycles, no LLM
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        if (!p.pnl_pct_suspicious && queuePeakConfirmation(p.position, p.pnl_pct)) {
          schedulePeakConfirmation(p.position);
        }
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        if (exit) {
          if (exit.action === "TRAILING_TP" && exit.needs_confirmation) {
            if (queueTrailingDropConfirmation(p.position, exit.peak_pnl_pct, exit.current_pnl_pct, config.management.trailingDropPct)) {
              scheduleTrailingDropConfirmation(p.position);
            }
            continue;
          }
          // Short and per position: a second stop must not wait a whole management interval behind the first.
          // (In a dry run the close is only simulated and the condition stays true: once an hour is enough.)
          const cooldownMs = process.env.DRY_RUN === "true" ? 60 * 60_000 : 60_000;
          const sinceLastTrigger = Date.now() - (_pollTriggeredAt.get(p.position) ?? 0);
          if (sinceLastTrigger >= cooldownMs) {
            _pollTriggeredAt.set(p.position, Date.now());
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — triggering management`);
            runManagementCycle({ silent: true }).catch((e) => log("cron_error", `Poll-triggered management failed: ${e.message}`));
          } else {
            log("state", `[PnL poll] Exit alert: ${p.pair} — ${exit.reason} — cooldown (${Math.round((cooldownMs - sinceLastTrigger) / 1000)}s left)`);
          }
          // NOTE: no break — continue checking all positions so no exit alert is missed
        }
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, 30_000);

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval ref so stopCronJobs can clear it
  _cronTasks._pnlPollInterval = pnlPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
async function shutdown(signal) {
  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  const positions = await getMyPositions();
  log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  process.exit(0);
}

if (AUTOSTART) {
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
      sendMessage(`⏳ Queued (${_telegramQueue.length} in queue): "${text.slice(0, 60)}"`).catch(() => {});
    } else {
      sendMessage("Queue is full (5 messages). Wait for the agent to finish.").catch(() => {});
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendMessage("No open positions."); return; }
      const cur = config.management.solMode ? "◎" : "$";
      const lines = positions.map((p, i) => {
        const pnl = p.pnl_usd >= 0 ? `+${cur}${p.pnl_usd}` : `-${cur}${Math.abs(p.pnl_usd)}`;
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const oor = !p.in_range ? " ⚠️OOR" : "";
        return `${i + 1}. ${p.pair} | ${cur}${p.total_value_usd} | PnL: ${pnl} | fees: ${cur}${p.unclaimed_fees_usd} | ${age}${oor}`;
      });
      await sendMessage(`📊 Open Positions (${total_positions}):\n\n${lines.join("\n")}\n\n/close <n> to close | /set <n> <note> to set instruction`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`Closing ${pos.pair}...`);
      const result = await executeTool("close_position", { position_address: pos.position, reason: "manual close (Telegram)" }, { source: "human" });
      if (result.dry_run) {
        await sendMessage(`🧪 DRY RUN — would have closed ${pos.pair}`);
      } else if (result.success) {
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const claimNote = result.claim_txs?.length ? `\nClaim txs: ${result.claim_txs.join(", ")}` : "";
        const swapNote = result.auto_swapped ? "\nLeftover tokens swapped back to SOL." : result.auto_swapped === false ? "\n⚠️ Leftover tokens were NOT swapped — still in the wallet." : "";
        await sendMessage(`✅ Closed ${pos.pair}\nPnL: ${config.management.solMode ? "◎" : "$"}${result.pnl_usd ?? "?"} | close txs: ${closeTxs?.join(", ") || "n/a"}${claimNote}${swapNote}`);
      } else {
        await sendMessage(`❌ Close failed: ${JSON.stringify(result)}`);
      }
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendMessage(`✅ Note set for ${pos.pair}:\n"${note}"`);
    } catch (e) { await sendMessage(`Error: ${e.message}`).catch(() => {}); }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      requireTool: true,
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    if (liveMessage) await liveMessage.fail(e.message).catch(() => {});
    else await sendMessage(`Error: ${e.message}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

/** Things the owner has to know at start that are easy to miss in a log file. */
function startupNotices() {
  const notes = [];
  if (dryRunInfo.on && (dryRunInfo.env === false || dryRunInfo.file === false)) {
    notes.push(`DRY RUN is ON although one of the two switches says off (${dryRunInfo.describe()}). Nothing will be traded until both are off.`);
  }
  if (!process.env.JUPITER_API_KEY) {
    notes.push("JUPITER_API_KEY is not set in .env. Selling the leftover tokens after a close can fail without it.");
  }
  if (config.management.manageUntrackedPositions !== true) {
    notes.push("Positions in this wallet that the agent did not open are reported but never closed or claimed (manageUntrackedPositions is off).");
  }
  for (const n of notes) log("startup", n);
  if (notes.length && telegramEnabled()) {
    sendMessage(`ℹ️ Agent started — ${dryRunInfo.on ? "DRY RUN" : "LIVE"}\n\n${notes.map((n) => `• ${n}`).join("\n")}`).catch(() => {});
  }
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (AUTOSTART && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  let startupCandidates = [];

  try {
    const [wallet, positions, { candidates, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    startupCandidates = candidates;

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${candidates.length} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);
  startupNotices();

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    if (!isNaN(pick) && pick >= 1 && pick <= startupCandidates.length) {
      await runBusy(async () => {
        const pool = startupCandidates[pick - 1];
        if (!getScreenedCandidate(pool.pool)) {
          console.log(`\nThat list is more than 45 minutes old, so ${pool.name} is no longer cleared for a deploy.\nRun /candidates to refresh it, then pick again.\n`);
          return;
        }
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates, pick the best one, get_active_bin, deploy_position with ${DEPLOY} SOL. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_screened } = await getTopCandidates({ limit: 5 });
        startupCandidates = candidates;
        console.log(`\nTop pools (${candidates.length} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBundlePct:         ${s.maxBundlePct}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync("./lessons.json", "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { requireTool: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (AUTOSTART) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  startupNotices();
  // First look at the positions, then let the normal screening cycle decide whether to open one. (This used to
  // be a free-form "get candidates then deploy" prompt that skipped the screening filters and the sizing.)
  setTimeout(() => {
    runManagementCycle({ silent: true }).catch((e) => log("startup_error", e.message));
  }, 5_000);
}
