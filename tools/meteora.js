/**
 * Meteora's own DLMM data API (dlmm.datapi.meteora.ag): free, no key.
 *
 * The agent already reads its open positions and their PnL from this host (tools/dlmm.js). This file adds two
 * things from the same place:
 *   - the pool's candles: the exact pool, priced in SOL per token, which is the price a TOKEN/SOL range lives on
 *     (OKX's 24h high is a USD price across all venues, and is kept only as the fallback);
 *   - the pool record (bin step, market cap, base mint), used to size a deploy the owner types by hand.
 *
 * No config, no wallet, no SDK: safe to import anywhere, including in tests.
 */
import { log } from "../logger.js";
import { dipFromCandles } from "../guards.js";

const BASE = "https://dlmm.datapi.meteora.ag";
const HEADERS = { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; lp-agent)" };

async function getJson(path, timeoutMs = 10_000) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`Meteora API ${res.status} for ${path.split("?")[0]}`);
  return res.json();
}

/**
 * Candles for one pool, oldest first: [{ timestamp (unix s), open, high, low, close, volume }].
 * timeframe: 5m | 30m | 1h | 2h | 4h | 12h | 24h. The API limits the window per call: about 3 days of 1h
 * candles, well under a day of 5m candles ("time range too large" otherwise).
 */
export async function getPoolCandles(pool, timeframe, hours) {
  const end = Math.floor(Date.now() / 1000);
  const start = end - Math.round(hours * 3600);
  const data = await getJson(`/pools/${pool}/ohlcv?timeframe=${timeframe}&start_time=${start}&end_time=${end}`);
  return Array.isArray(data?.data) ? data.data : [];
}

/**
 * Pullback facts for one pool (guards.js dipFromCandles).
 * One call for 1h candles of the last 3 days gives the highs. Only when the pool is inside (or next to) the
 * pullback band is a second call made, for 5m candles of the last 3 hours: they answer "has it stopped falling?"
 * to within five minutes.
 * @param {string} pool
 * @param {object} [o] { lookbackHours, band: { min, max } }
 * @returns {Promise<null | object>} null when Meteora has no usable history for the pool
 */
export async function getDipFacts(pool, { lookbackHours = 24, band = null } = {}) {
  const hourly = await getPoolCandles(pool, "1h", 72);
  const coarse = dipFromCandles({ hourly, lookbackHours });
  if (!coarse) return null;
  if (band && (coarse.dipPct < band.min - 3 || coarse.dipPct > band.max + 3)) {
    return { ...coarse, source: "meteora" }; // far outside the band: the 5m detail would not change the answer
  }
  let fine = [];
  try {
    fine = await getPoolCandles(pool, "5m", 3);
  } catch (e) {
    log("meteora", `5m candles unavailable for ${pool.slice(0, 8)}: ${e.message} — using the 1h candles only`);
  }
  return { ...(dipFromCandles({ hourly, fine, lookbackHours }) ?? coarse), source: "meteora" };
}

/** The pool record, reduced to what a deploy needs. Throws when the pool is unknown or the API is down. */
export async function getPoolFacts(pool) {
  const d = await getJson(`/pools/${pool}`);
  const x = d?.token_x || {};
  const y = d?.token_y || {};
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return {
    pool: d?.address ?? pool,
    name: d?.name ?? null,
    bin_step: num(d?.pool_config?.bin_step),
    base_mint: x.address ?? null,
    quote_mint: y.address ?? null,
    mcap: num(x.market_cap),
    price: num(d?.current_price),
    is_blacklisted: d?.is_blacklisted === true,
    volatility: null, // not in this record: the range sizing then takes the deep end
  };
}
