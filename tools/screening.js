import { config } from "../config.js";
import { isBlacklisted } from "../token-blacklist.js";
import { isDevBlocked, getBlockedDevs } from "../dev-blocklist.js";
import { log } from "../logger.js";
import { isBaseMintOnCooldown, isPoolOnCooldown } from "../pool-memory.js";
import { getTokenInfo } from "./token.js";
import { checkTokenAudit, checkDipEntry } from "../guards.js";
import { getDipFacts } from "./meteora.js";

const DATAPI_JUP = "https://datapi.jup.ag/v1";

const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";

// SOL mint — only screen pools where the quote token is native SOL
const SOL_MINT = "So11111111111111111111111111111111111111112";

/**
 * Fetch pools from the Meteora Pool Discovery API.
 * Fetches both trending + volume in parallel (page_size 100 each), merges, deduplicates
 * by pool address, then deduplicates by base token keeping the best fee/tvl pool per token.
 * Returns condensed data optimized for LLM consumption (saves tokens).
 * Only returns TOKEN/SOL pools — USDC and other quote tokens are excluded.
 */
export async function discoverPools({
  page_size = 50,
} = {}) {
  const s = config.screening;
  const filters = [
    "base_token_has_critical_warnings=false",
    "quote_token_has_critical_warnings=false",
    "base_token_has_high_single_ownership=false",
    "pool_type=dlmm",
    // NOTE: quote_token_address filter removed — API returns 0 results when it's included.
    // SOL-only enforcement is handled by the hard post-filter below (condensePool + solOnly check).
    `base_token_market_cap>=${s.minMcap}`,
    `base_token_market_cap<=${s.maxMcap}`,
    `base_token_holders>=${s.minHolders}`,
    `volume>=${s.minVolume}`,
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `dlmm_bin_step>=${s.minBinStep}`,
    `dlmm_bin_step<=${s.maxBinStep}`,
    `fee_active_tvl_ratio>=${s.minFeeActiveTvlRatio}`,
    s.maxFeeActiveTvlRatio != null ? `fee_active_tvl_ratio<=${s.maxFeeActiveTvlRatio}` : null,
    `base_token_organic_score>=${s.minOrganic}`,
    "quote_token_organic_score>=60",
    s.minTokenAgeHours != null ? `base_token_created_at<=${Date.now() - s.minTokenAgeHours * 3_600_000}` : null,
    s.maxTokenAgeHours != null ? `base_token_created_at>=${Date.now() - s.maxTokenAgeHours * 3_600_000}` : null,
  ].filter(Boolean).join("&&");

  const encodedFilters = encodeURIComponent(filters);
  const buildUrl = (category) =>
    `${POOL_DISCOVERY_BASE}/pools?page_size=${page_size}&filter_by=${encodedFilters}&timeframe=${s.timeframe}&category=${category}`;

  // Fetch trending + top in parallel
  const [trendingRes, topRes] = await Promise.allSettled([
    fetch(buildUrl("trending")).then((r) => {
      if (!r.ok) throw new Error(`Pool Discovery API error (trending): ${r.status} ${r.statusText}`);
      return r.json();
    }),
    fetch(buildUrl("top")).then((r) => {
      if (!r.ok) throw new Error(`Pool Discovery API error (top): ${r.status} ${r.statusText}`);
      return r.json();
    }),
  ]);

  // Merge and deduplicate by pool address — trending results ranked first
  const seenPools = new Set();
  const merged = [];
  const succeededCategories = [];
  const categories = ["trending", "top"];
  for (const [i, res] of [trendingRes, topRes].entries()) {
    if (res.status !== "fulfilled") {
      log("screening", `Pool Discovery fetch failed (${categories[i]}): ${res.reason}`);
      continue;
    }
    succeededCategories.push(categories[i]);
    for (const pool of (res.value.data || [])) {
      if (!seenPools.has(pool.pool_address)) {
        seenPools.add(pool.pool_address);
        merged.push(pool);
      }
    }
  }

  // Deduplicate by base token — keep highest fee_active_tvl_ratio pool per token
  // Prevents same token eating multiple candidate slots (e.g. BURNIE-SOL pool A and B)
  const bestByMint = new Map();
  for (const pool of merged) {
    const mint = pool.token_x?.address;
    if (!mint) continue;
    const existing = bestByMint.get(mint);
    if (!existing || (pool.fee_active_tvl_ratio ?? 0) > (existing.fee_active_tvl_ratio ?? 0)) {
      bestByMint.set(mint, pool);
    }
  }
  const deduped = Array.from(bestByMint.values());
  log("screening", `Dual-pass discovery: ${merged.length} pools → ${deduped.length} unique tokens (${succeededCategories.join(" + ") || "none succeeded"})`);

  const condensed = deduped.map(condensePool);

  // Hard-filter: SOL quote only — drop any non-SOL pool that slipped through the API filter
  const nonSol = condensed.filter((p) => p.quote?.mint !== SOL_MINT);
  if (nonSol.length > 0) {
    log("screening", `SOL filter: dropped ${nonSol.length} non-SOL pool(s): ${nonSol.map(p => p.name).join(", ")}`);
  }
  const solOnly = condensed.filter((p) => p.quote?.mint === SOL_MINT);

  // Hard-filter blacklisted tokens and blocked deployers (what pool discovery already gave us)
  let pools = solOnly.filter((p) => {
    if (isBlacklisted(p.base?.mint)) {
      log("blacklist", `Filtered blacklisted token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)}) in pool ${p.name}`);
      return false;
    }
    if (p.dev && isDevBlocked(p.dev)) {
      log("dev_blocklist", `Filtered blocked deployer ${p.dev?.slice(0, 8)} token ${p.base?.symbol} in pool ${p.name}`);
      return false;
    }
    return true;
  });

  const filtered = condensed.length - pools.length;
  if (filtered > 0) log("blacklist", `Filtered ${filtered} pool(s) with blacklisted tokens/devs`);

  // If pool discovery didn't supply dev field, batch-fetch from Jupiter for any pools
  // where dev is null — but only if the dev blocklist is non-empty (avoid useless calls)
  const blockedDevs = getBlockedDevs();
  if (Object.keys(blockedDevs).length > 0) {
    const missingDev = pools.filter((p) => !p.dev && p.base?.mint);
    if (missingDev.length > 0) {
      const devResults = await Promise.allSettled(
        missingDev.map((p) =>
          fetch(`${DATAPI_JUP}/assets/search?query=${p.base.mint}`)
            .then((r) => r.ok ? r.json() : null)
            .then((d) => {
              const t = Array.isArray(d) ? d[0] : d;
              return { pool: p.pool, dev: t?.dev || null };
            })
            .catch(() => ({ pool: p.pool, dev: null }))
        )
      );
      const devMap = {};
      for (const r of devResults) {
        if (r.status === "fulfilled") devMap[r.value.pool] = r.value.dev;
      }
      pools = pools.filter((p) => {
        const dev = devMap[p.pool];
        if (dev) p.dev = dev; // enrich in-place
        if (dev && isDevBlocked(dev)) {
          log("dev_blocklist", `Filtered blocked deployer (jup) ${dev.slice(0, 8)} token ${p.base?.symbol}`);
          return false;
        }
        return true;
      });
    }
  }

  return {
    total: pools.length,
    pools,
  };
}

/**
 * Returns eligible pools for the agent to evaluate and pick from.
 * Hard filters applied in code, agent decides which to deploy into.
 */
export async function getTopCandidates({ limit = 10 } = {}) {
  const { config } = await import("../config.js");
  // Fetch 3× the target limit so OKX filters (wash, bundle, ATH, fees) have backfill headroom
  const { pools } = await discoverPools({ page_size: 100 });
  const filteredOut = [];

  // Exclude pools where the wallet already has an open position
  const { getMyPositions } = await import("./dlmm.js");
  const { positions } = await getMyPositions();
  const occupiedPools = new Set(positions.map((p) => p.pool));
  const occupiedMints = new Set(positions.map((p) => p.base_mint).filter(Boolean));

  const eligible = pools
    .filter((p) => {
      if (occupiedPools.has(p.pool)) {
        pushFilteredReason(filteredOut, p, "already have an open position in this pool");
        return false;
      }
      if (occupiedMints.has(p.base?.mint)) {
        pushFilteredReason(filteredOut, p, "already holding this base token in another pool");
        return false;
      }
      if (isPoolOnCooldown(p.pool)) {
        log("screening", `Filtered cooldown pool ${p.name} (${p.pool.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "pool cooldown active");
        return false;
      }
      if (isBaseMintOnCooldown(p.base?.mint)) {
        log("screening", `Filtered cooldown token ${p.base?.symbol} (${p.base?.mint?.slice(0, 8)})`);
        pushFilteredReason(filteredOut, p, "token cooldown active");
        return false;
      }
      if (p.fee_pct != null && p.fee_pct < config.screening.minFeePct) {
        log("screening", `Filtered low-fee pool ${p.name} — fee_pct ${p.fee_pct}% < min ${config.screening.minFeePct}%`);
        pushFilteredReason(filteredOut, p, `fee_pct ${p.fee_pct}% below minimum ${config.screening.minFeePct}%`);
        return false;
      }
      const maxFee = config.screening.maxFeeActiveTvlRatio;
      if (maxFee != null && p.fee_active_tvl_ratio != null && p.fee_active_tvl_ratio > maxFee) {
        log("screening", `Filtered pump-peak pool ${p.name} — fee_tvl ${p.fee_active_tvl_ratio} > max ${maxFee}`);
        pushFilteredReason(filteredOut, p, `fee_tvl ${p.fee_active_tvl_ratio} above max ${maxFee} (pump peak)`);
        return false;
      }
      return true;
    });
  // (The cut to 3× the limit used to happen here. It now comes after the entry check below: only a few pools
  // are inside the pullback zone at any moment, so every pool that passed the cheap filters gets looked at.)

  // failClosedOnMissingData (default on): a check that cannot run for lack of data drops the candidate. These
  // used to pass on "no data", so an OKX or price-feed outage switched the safety filters off.
  const failClosed = config.screening.failClosedOnMissingData !== false;
  // How many candidates each outside data source was asked about, and for how many it had nothing. When a
  // source is down for every candidate the screen passes nobody; the result then says so (`outage`) instead of
  // looking like an ordinary quiet market.
  const gaps = { okx: { checked: 0, missing: 0 }, audit: { checked: 0, missing: 0 } };

  // ── Entry timing ────────────────────────────────────────────────
  const entryMode = config.screening.entryMode ?? "dip";
  const validTrend = (p) => (Array.isArray(p.price_trend) ? p.price_trend.filter((v) => v > 0) : []); // strip -1.0 placeholders
  if (entryMode === "dip") {
    // Wait for the pullback (guards.js checkDipEntry): price 20–30% below its recent high and no longer making
    // new lows. Measured on the pool's own candles from Meteora (SOL per token, the price the range lives on).
    // A SOL-only range opened at the top buys the day's most expensive tokens first; opened after the pullback
    // it buys from a lower price and a retest of the low lands inside it.
    const band = { min: config.screening.entryDipMinPct ?? 20, max: config.screening.entryDipMaxPct ?? 30 };
    const lookbackHours = config.screening.entryDipLookbackHours ?? 24;
    for (let i = 0; i < eligible.length; i += 5) { // small batches: polite to the API
      await Promise.all(eligible.slice(i, i + 5).map(async (p) => {
        try {
          p.dip = await getDipFacts(p.pool, { lookbackHours, band });
        } catch (e) {
          p.dip = null;
          log("screening", `Meteora candles unavailable for ${p.name}: ${e.message} — falling back to OKX's 24h high`);
        }
      }));
    }
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      if (!p.dip) return true; // no candles: decided after the OKX enrichment below
      const v = checkDipEntry(p.dip, config.screening);
      if (v.pass) return true;
      log("screening", `Entry filter: dropped ${p.name} — ${v.reason}`);
      pushFilteredReason(filteredOut, p, v.reason);
      return false;
    }));
  } else {
    // "momentum": the older rule. Price must be stepping up over the last candles of the discovery trend:
    //   up, up, up  |  (anything), up, up  |  up, down, up
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      const valid = validTrend(p);
      if (valid.length < 3) { // need at least 3 points to see a pattern
        if (!failClosed) return true;
        pushFilteredReason(filteredOut, p, "price direction: not enough price points to check the entry pattern");
        return false;
      }
      const n = valid.length;
      const allGreen = valid.every((v, i) => i === 0 || v > valid[i - 1]);
      const lastTwoGreen = valid[n - 1] > valid[n - 2] && valid[n - 2] > valid[n - 3];
      const upDownUp = n >= 4
        && valid[n - 1] > valid[n - 2]   // last candle: green
        && valid[n - 2] < valid[n - 3]   // second-to-last: red (dip)
        && valid[n - 3] > valid[n - 4];  // third-to-last: green (leading move)
      if (!allGreen && !lastTwoGreen && !upDownUp) {
        const tail = valid.slice(-4).map(v => v.toExponential(2)).join(" → ");
        log("screening", `Price direction filter: dropped ${p.name} — need up/up, up/up/up, or up/down/up pattern (last 4: ${tail})`);
        pushFilteredReason(filteredOut, p, "price direction: no valid entry pattern (blocked: not up/up, up/up/up, or up/down/up)");
        return false;
      }
      return true;
    }));
  }
  // Keep 3× headroom for the OKX and audit filters below (4 OKX calls per pool: do not enrich the whole list).
  if (eligible.length > limit * 3) eligible.splice(limit * 3);

  // Enrich with OKX data — advanced info (risk/bundle/sniper) + ATH price (no API key required)
  if (eligible.length > 0) {
    const { getAdvancedInfo, getPriceInfo, getClusterList, getRiskFlags } = await import("./okx.js");
    const okxResults = await Promise.allSettled(
      eligible.map(async (p) => {
        if (!p.base?.mint) return { adv: null, price: null, clusters: [], risk: null };
        const [adv, price, clusters, risk] = await Promise.allSettled([
          getAdvancedInfo(p.base.mint),
          getPriceInfo(p.base.mint),
          getClusterList(p.base.mint),
          getRiskFlags(p.base.mint),
        ]);

        const mintShort = p.base.mint.slice(0, 8);
        if (adv.status !== "fulfilled")      log("okx", `advanced-info unavailable for ${p.name} (${mintShort})`);
        if (price.status !== "fulfilled")    log("okx", `price-info unavailable for ${p.name} (${mintShort})`);
        if (clusters.status !== "fulfilled") log("okx", `cluster-list unavailable for ${p.name} (${mintShort})`);
        if (risk.status !== "fulfilled")     log("okx", `risk-check unavailable for ${p.name} (${mintShort})`);

        return {
          adv: adv.status === "fulfilled" ? adv.value : null,
          price: price.status === "fulfilled" ? price.value : null,
          clusters: clusters.status === "fulfilled" ? clusters.value : [],
          risk: risk.status === "fulfilled" ? risk.value : null,
        };
      })
    );
    for (let i = 0; i < eligible.length; i++) {
      const r = okxResults[i];
      if (r.status !== "fulfilled") continue;
      const { adv, price, clusters, risk } = r.value;
      if (adv) {
        eligible[i].risk_level      = adv.risk_level;
        eligible[i].bundle_pct      = adv.bundle_pct;
        eligible[i].sniper_pct      = adv.sniper_pct;
        eligible[i].suspicious_pct  = adv.suspicious_pct;
        eligible[i].smart_money_buy = adv.smart_money_buy;
        eligible[i].dev_sold_all    = adv.dev_sold_all;
        eligible[i].dex_boost       = adv.dex_boost;
        eligible[i].dex_screener_paid = adv.dex_screener_paid;
        eligible[i].fees_sol        = adv.total_fee_sol;   // lifetime fees in SOL — enforces minTokenFeesSol hard rule
        eligible[i].is_honeypot     = adv.is_honeypot;     // these three were fetched and then dropped
        eligible[i].dev_rug_count   = adv.dev_rug_count;
        eligible[i].lp_burned_pct   = adv.lp_burned_pct;
        if (adv.creator && !eligible[i].dev) eligible[i].dev = adv.creator;
      }
      if (risk) {
        eligible[i].is_rugpull = risk.is_rugpull;
        eligible[i].is_wash    = risk.is_wash;
      }
      if (price) {
        eligible[i].price_vs_ath_pct = price.price_vs_ath_pct;
        eligible[i].ath              = price.ath;
      }
      if (clusters?.length) {
        // Surface KOL presence and top cluster trend for LLM
        eligible[i].kol_in_clusters      = clusters.some((c) => c.has_kol);
        eligible[i].top_cluster_trend    = clusters[0]?.trend ?? null;      // buy|sell|neutral
        eligible[i].top_cluster_hold_pct = clusters[0]?.holding_pct ?? null;
      }
    }
    if (entryMode === "dip") {
      // Pools Meteora had no candles for: measure the pullback from OKX's 24h high instead (a USD price across
      // all venues), with the direction of the last price step standing in for "has it stopped falling".
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.dip) return true; // already passed on the pool's own candles
        const t = validTrend(p);
        const facts = p.price_vs_ath_pct != null
          ? {
              dipPct: Math.round((100 - p.price_vs_ath_pct) * 10) / 10,
              lastStepUp: t.length >= 2 ? t[t.length - 1] > t[t.length - 2] : null,
              source: "okx",
            }
          : null;
        const v = checkDipEntry(facts, config.screening);
        if (v.pass) { p.dip = facts; return true; }
        if (v.unknown && !failClosed) return true; // the owner chose to let "no data" pass
        log("screening", `Entry filter: dropped ${p.name} — ${v.reason}`);
        pushFilteredReason(filteredOut, p, v.reason);
        return false;
      }));
    }

    // Hard risk filters, in code. Wash trading = fake volume. A liquidity-removal (rug) flag and a honeypot tag
    // were only shown to the model before, with a prompt line that let "smart wallets" override a rug flag.
    eligible.splice(0, eligible.length, ...eligible.filter((p) => {
      const drop = (why) => {
        log("screening", `Risk filter: dropped ${p.name} — ${why}`);
        pushFilteredReason(filteredOut, p, why);
        return false;
      };
      if (p.is_wash) return drop("wash trading flagged");
      if (p.is_rugpull) return drop("liquidity-removal (rug) flag");
      if (p.is_honeypot) return drop("honeypot tag");
      gaps.okx.checked += 1;
      if (p.is_wash == null || p.bundle_pct == null) {
        gaps.okx.missing += 1;
        if (failClosed) return drop("no OKX risk data for this token (failClosedOnMissingData)");
      }
      return true;
    }));

    // Bundle % hard filter — high bundle = coordinated launch = manipulation risk
    const maxBundle = config.screening.maxBundlePct;
    if (maxBundle != null) {
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.bundle_pct == null) return true; // no OKX data → pass
        if (p.bundle_pct > maxBundle) {
          log("screening", `Bundle filter: dropped ${p.name} — ${p.bundle_pct}% bundle > max ${maxBundle}%`);
          pushFilteredReason(filteredOut, p, `${p.bundle_pct}% bundle above max ${maxBundle}%`);
          return false;
        }
        return true;
      }));
    }

    // Lifetime token fees filter — token must have generated enough real fees to prove legitimacy
    const minFeesSol = config.screening.minTokenFeesSol;
    if (minFeesSol != null) {
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.fees_sol == null) { // no OKX data
          if (!failClosed) return true;
          pushFilteredReason(filteredOut, p, "lifetime fees unknown (failClosedOnMissingData)");
          return false;
        }
        if (p.fees_sol < minFeesSol) {
          log("screening", `Token fees filter: dropped ${p.name} — ${p.fees_sol.toFixed(1)} SOL lifetime fees < min ${minFeesSol}`);
          pushFilteredReason(filteredOut, p, `${p.fees_sol.toFixed(1)} SOL lifetime fees below min ${minFeesSol}`);
          return false;
        }
        return true;
      }));
    }

    // ATH filter — caps the UPPER end: drops pools where price is too close to (or above) ATH
    // e.g. athFilterPct = -20 means price must be <= 80% of ATH (overbought / extended)
    // This is separate from minAthPct which sets the LOWER floor (too far below ATH = dead)
    const athFilter = config.screening.athFilterPct;
    if (athFilter != null) {
      const threshold = 100 + athFilter; // e.g. -20 → threshold = 80 (price must be <= 80% of ATH)
      const before = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        if (p.price_vs_ath_pct == null) return true; // no data → don't filter
        if (p.price_vs_ath_pct > threshold) {
          log("screening", `ATH filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (limit: ${threshold}%)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH > ${threshold}% limit`);
          return false;
        }
        return true;
      }));
      if (eligible.length < before) log("screening", `ATH filter removed ${before - eligible.length} pool(s)`);
    }

    // minAthPct filter — only applies to NEW tokens (< 5 days old)
    // Old tokens are judged purely by fee/tvl, volume, and organic score — ATH is irrelevant
    // for coins that pumped weeks/months ago; what matters is whether the pool is active now
    const minAthPct = config.screening.minAthPct;
    if (minAthPct != null) {
      const NEW_TOKEN_MAX_HOURS = 5 * 24; // 5 days
      const beforeAth = eligible.length;
      eligible.splice(0, eligible.length, ...eligible.filter((p) => {
        // Old token — skip ATH filter entirely, trust fee/tvl + volume
        if (p.token_age_hours != null && p.token_age_hours >= NEW_TOKEN_MAX_HOURS) return true;
        if (p.price_vs_ath_pct == null) return true; // no OKX data → don't filter
        if (p.price_vs_ath_pct < minAthPct) {
          log("screening", `minAthPct filter: dropped ${p.name} — ${p.price_vs_ath_pct}% of ATH (min: ${minAthPct}%, age: ${p.token_age_hours}h)`);
          pushFilteredReason(filteredOut, p, `${p.price_vs_ath_pct}% of ATH below min ${minAthPct}% (new token, ${p.token_age_hours}h old)`);
          return false;
        }
        return true;
      }));
      if (eligible.length < beforeAth) log("screening", `minAthPct filter removed ${beforeAth - eligible.length} new token(s) below ATH threshold`);
    }

    // Drop any pools whose creator is on the dev blocklist (caught via advanced-info)
    const before = eligible.length;
    const filtered = eligible.filter((p) => {
      if (p.dev && isDevBlocked(p.dev)) {
        log("dev_blocklist", `Filtered blocked deployer (okx) ${p.dev.slice(0, 8)} token ${p.base?.symbol}`);
        pushFilteredReason(filteredOut, p, "blocked deployer");
        return false;
      }
      return true;
    });
    eligible.splice(0, eligible.length, ...filtered);
    if (eligible.length < before) log("dev_blocklist", `Filtered ${before - eligible.length} pool(s) via OKX creator check`);
  }

  // Token audit (Jupiter): blocked launchpad, bot holders, mint / freeze authority, top-10 holders.
  // It used to run only inside the scheduled screening cycle, after the pools had already been registered as
  // deployable, so a deploy asked for in chat, on Telegram or with `auto` skipped it. Candidates are checked in
  // rank order until `limit` have passed, so one bad token does not shrink the list.
  const audited = [];
  for (const p of eligible) {
    if (audited.length >= limit) break;
    let token = null;
    if (p.base?.mint) {
      try {
        token = (await getTokenInfo({ query: p.base.mint }))?.results?.[0] ?? null;
      } catch (e) {
        log("screening", `Token info unavailable for ${p.name}: ${e.message}`);
      }
      await new Promise((r) => setTimeout(r, 150)); // avoid 429s
    }
    gaps.audit.checked += 1;
    const verdict = checkTokenAudit({ token, screening: config.screening });
    if (!verdict.pass) {
      if (verdict.missing) gaps.audit.missing += 1;
      log("screening", `Audit filter: dropped ${p.name} — ${verdict.reason}`);
      pushFilteredReason(filteredOut, p, verdict.reason);
      continue;
    }
    // Kept small on purpose: this object goes to the model with the candidate.
    p.token = token
      ? { launchpad: token.launchpad ?? null, global_fees_sol: token.global_fees_sol ?? null, audit: token.audit ?? null, stats_1h: token.stats_1h ?? null }
      : null;
    audited.push(p);
  }
  eligible.splice(0, eligible.length, ...audited);

  log("screening", `Final candidates after all filters: ${eligible.length}/${pools.length} screened`);
  rememberScreened(eligible);

  const down = [];
  if (failClosed && gaps.okx.checked >= 3 && gaps.okx.missing === gaps.okx.checked) down.push(`OKX risk data was unavailable for all ${gaps.okx.checked} candidates checked`);
  if (failClosed && gaps.audit.checked >= 3 && gaps.audit.missing === gaps.audit.checked) down.push(`Jupiter token-audit data was unavailable for all ${gaps.audit.checked} candidates checked`);
  const outage = down.length
    ? `${down.join("; ")}. With failClosedOnMissingData on, nothing can pass the safety screen until that data is back.`
    : null;
  if (outage) log("screening_warn", outage);

  return {
    candidates: eligible,
    total_screened: pools.length,
    filtered_examples: filteredOut,
    outage,
    fetched_at: new Date().toISOString(),
  };
}

// ─── Screened-pool registry ────────────────────────────────────
// Pools that came out of a recent screening run. executor.js only lets a deploy go into one of these, and
// takes bin step / base mint / volatility from this record rather than from what the model says.
const SCREENED_TTL_MS = 45 * 60_000;
const _screened = new Map(); // pool address -> { pool, name, bin_step, base_mint, volatility, at }

export function rememberScreened(pools) {
  const now = Date.now();
  for (const [k, v] of _screened) if (now - v.at > SCREENED_TTL_MS) _screened.delete(k);
  for (const p of pools || []) {
    if (!p?.pool) continue;
    _screened.set(p.pool, {
      pool: p.pool, name: p.name ?? null, bin_step: p.bin_step ?? null,
      base_mint: p.base?.mint ?? null, volatility: p.volatility ?? null,
      mcap: p.mcap ?? null, dip_pct: p.dip?.dipPct ?? null, at: now,
    });
  }
}

export function forgetScreened(poolAddress) {
  _screened.delete(poolAddress);
}

export function getScreenedCandidate(poolAddress) {
  const c = _screened.get(poolAddress);
  if (!c) return null;
  if (Date.now() - c.at > SCREENED_TTL_MS) { _screened.delete(poolAddress); return null; }
  return c;
}

/**
 * Get full raw details for a specific pool.
 * Fetches top 50 pools from discovery API and finds the matching address.
 * Returns the full unfiltered API object (all fields, not condensed).
 */
export async function getPoolDetail({ pool_address, timeframe = "5m" }) {
  const url = `${POOL_DISCOVERY_BASE}/pools?` +
    `page_size=1` +
    `&filter_by=${encodeURIComponent(`pool_address=${pool_address}`)}` +
    `&timeframe=${timeframe}`;

  const res = await fetch(url);

  if (!res.ok) {
    throw new Error(`Pool detail API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const pool = (data.data || [])[0];

  if (!pool) {
    throw new Error(`Pool ${pool_address} not found`);
  }

  return pool;
}

/**
 * Condense a pool object for LLM consumption.
 * Raw API returns ~100+ fields per pool. The LLM only needs ~20.
 */
function condensePool(p) {
  return {
    pool: p.pool_address,
    name: p.name,
    base: {
      symbol: p.token_x?.symbol,
      mint: p.token_x?.address,
      organic: Math.round(p.token_x?.organic_score || 0),
      warnings: p.token_x?.warnings?.length || 0,
    },
    quote: {
      symbol: p.token_y?.symbol,
      mint: p.token_y?.address,
    },
    pool_type: p.pool_type,
    bin_step: p.dlmm_params?.bin_step || null,
    fee_pct: p.fee_pct,

    // Core metrics (the numbers that matter)
    active_tvl: round(p.active_tvl),
    fee_window: round(p.fee),
    volume_window: round(p.volume),
    // API sometimes returns 0 for fee_active_tvl_ratio on short timeframes — compute from raw values as fallback
    // NaN guard: only divide when both fee and active_tvl are non-null, non-zero numbers
    fee_active_tvl_ratio: p.fee_active_tvl_ratio > 0
      ? fix(p.fee_active_tvl_ratio, 4)
      : (p.fee != null && p.active_tvl != null && p.active_tvl > 0 && p.fee > 0
          ? fix((p.fee / p.active_tvl) * 100, 4)
          : 0),
    volatility: fix(p.volatility, 2),


    // Token health
    holders: p.base_token_holders,
    mcap: round(p.token_x?.market_cap),
    organic_score: Math.round(p.token_x?.organic_score || 0),
    token_age_hours: (p.token_x?.created_at && Number.isFinite(p.token_x.created_at))
      ? Math.floor((Date.now() - p.token_x.created_at) / 3_600_000)
      : null,
    dev: p.token_x?.dev || null,

    // Position health
    active_positions: p.active_positions,
    active_pct: fix(p.active_positions_pct, 1),
    open_positions: p.open_positions,

    // Price action
    price: p.pool_price,
    price_change_pct: fix(p.pool_price_change_pct, 1),
    price_trend: p.price_trend,
    min_price: p.min_price,
    max_price: p.max_price,

    // Activity trends
    volume_change_pct: fix(p.volume_change_pct, 1),
    fee_change_pct: fix(p.fee_change_pct, 1),
    swap_count: p.swap_count,
    unique_traders: p.unique_traders,
  };
}

function round(n) {
  return n != null ? Math.round(n) : null;
}

function fix(n, decimals) {
  return n != null ? Number(n.toFixed(decimals)) : null;
}

function pushFilteredReason(list, pool, reason) {
  if (!list || !pool) return;
  list.push({
    name: pool.name || `${pool.base?.symbol || "?"}-${pool.quote?.symbol || "?"}`,
    reason,
  });
}
