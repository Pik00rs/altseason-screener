// Côté serveur (GitHub Actions), jamais dans le navigateur. Read-only.
// Écrit : screener.json (candidats), tracker.json (perf +1j/+7j/+30j),
//         weights.json (poids appris en walk-forward).
// Boucle d'apprentissage : ce run SCORE avec les poids appris au run précédent,
// puis ré-apprend de nouveaux poids (depuis les entrées matures) pour le prochain.
// Node 18+ (fetch natif).

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CONFIG = {
  apiKey: process.env.CMC_API_KEY || "",
  base: "https://pro-api.coinmarketcap.com",
  limit: Number(process.env.CMC_LIMIT || 500),
  minMcap: Number(process.env.MIN_MARKET_CAP || 15_000_000),
  maxMcap: Number(process.env.MAX_MARKET_CAP || 500_000_000),
  minVol: Number(process.env.MIN_VOLUME_24H || 1_000_000),
  topN: Number(process.env.TOP_N || 50),
  trackTopN: Number(process.env.TRACK_TOP_N || 20),
  out: "docs/data/screener.json",
  trackerOut: "docs/data/tracker.json",
  weightsOut: "docs/data/weights.json",
};

// Garde-fous d'apprentissage.
const MIN_SAMPLES = Number(process.env.MIN_LEARN_SAMPLES || 60); // mini d'entrées matures (+7j) avant d'apprendre
const BLEND = 0.5;   // 0 = 100% défaut, 1 = 100% appris (shrinkage anti-bruit)
const FLOOR = 0.04;  // poids minimum par signal (garde de la diversité)

const DEFAULT_WEIGHTS = {
  float_quality: 0.20, momentum_24h: 0.15, momentum_7d: 0.20, momentum_30d: 0.15, volume_surge: 0.30,
};
const SIGNALS = Object.keys(DEFAULT_WEIGHTS);
const HORIZONS = [1, 7, 30];
const DAY = 86400000;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

const scoreFloatQuality = (c) => {
  const total = c.total_supply || c.max_supply || 0;
  return total ? clamp01((c.circulating_supply || 0) / total) : 0;
};
const mom = (pct, capAt) => (pct == null ? 0 : clamp01(pct / capAt));
const volSurge = (q) => (q.market_cap ? clamp01(q.volume_24h / q.market_cap / 0.5) : 0);

function signalParts(c) {
  const q = c.quote.USD;
  return {
    float_quality: scoreFloatQuality(c),
    momentum_24h: mom(q.percent_change_24h, 30),
    momentum_7d: mom(q.percent_change_7d, 50),
    momentum_30d: mom(q.percent_change_30d, 100),
    volume_surge: volSurge(q),
  };
}
function scoreWith(parts, w) {
  const tw = SIGNALS.reduce((a, k) => a + (w[k] || 0), 0) || 1;
  return SIGNALS.reduce((a, k) => a + (parts[k] || 0) * (w[k] || 0), 0) / tw;
}

async function fetchListings() {
  if (!CONFIG.apiKey) throw new Error("CMC_API_KEY manquante (GitHub Secrets).");
  const url = new URL("/v1/cryptocurrency/listings/latest", CONFIG.base);
  url.searchParams.set("start", "1");
  url.searchParams.set("limit", String(CONFIG.limit));
  url.searchParams.set("sort", "market_cap");
  url.searchParams.set("convert", "USD");
  const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": CONFIG.apiKey, accept: "application/json" } });
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).data || [];
}
const passesFilters = (c) => {
  const q = c.quote.USD;
  return q.market_cap >= CONFIG.minMcap && q.market_cap <= CONFIG.maxMcap && q.volume_24h >= CONFIG.minVol;
};
async function loadJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; }
}

// ---------- apprentissage walk-forward ----------
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  const den = Math.sqrt(dx * dy);
  return den ? num / den : 0;
}

function learn(entries) {
  const matured = entries.filter((e) => e.d7 != null && e.parts);
  if (matured.length < MIN_SAMPLES) {
    return { active: false, n: matured.length, target: "d7", weights: { ...DEFAULT_WEIGHTS },
      reason: `besoin de ${MIN_SAMPLES} entrées matures (+7j), ${matured.length} pour l'instant` };
  }
  const corr = {};
  for (const s of SIGNALS) {
    corr[s] = +pearson(matured.map((e) => e.parts[s] ?? 0), matured.map((e) => e.d7)).toFixed(3);
  }
  // poids appris = corrélations positives, normalisées
  let sum = 0; const raw = {};
  for (const s of SIGNALS) { raw[s] = Math.max(0, corr[s]); sum += raw[s]; }
  if (sum === 0) for (const s of SIGNALS) { raw[s] = DEFAULT_WEIGHTS[s]; sum += raw[s]; }
  // shrinkage vers le défaut + plancher + renormalisation
  let bsum = 0; const w = {};
  for (const s of SIGNALS) {
    let v = BLEND * (raw[s] / sum) + (1 - BLEND) * DEFAULT_WEIGHTS[s];
    w[s] = Math.max(v, FLOOR); bsum += w[s];
  }
  for (const s of SIGNALS) w[s] = +(w[s] / bsum).toFixed(3);
  return { active: true, n: matured.length, target: "d7", learned_at: new Date().toISOString(), corr, weights: w };
}

// ---------- tracker ----------
function updateTrackerEntries(listings, candidates, prev) {
  const now = Date.now();
  const priceById = new Map(listings.map((c) => [c.id, c.quote.USD.price]));
  let entries = prev.source === "SAMPLE" ? [] : (prev.entries || []);

  for (const e of entries) {
    const elapsed = (now - new Date(e.entry_ts).getTime()) / DAY;
    for (const h of HORIZONS) {
      const key = `d${h}`;
      if (e[key] == null && elapsed >= h) {
        const cur = priceById.get(e.id);
        if (cur && e.entry_price) e[key] = +(((cur / e.entry_price) - 1) * 100).toFixed(1);
      }
    }
  }
  const recent = new Set(entries.filter((e) => new Date(e.entry_ts).getTime() > now - 20 * 3600 * 1000).map((e) => e.id));
  for (const c of candidates.slice(0, CONFIG.trackTopN)) {
    if (recent.has(c.id)) continue;
    entries.push({
      id: c.id, symbol: c.symbol, name: c.name, entry_ts: new Date(now).toISOString(),
      entry_price: c.price, score: +c.score.toFixed(2), parts: c.parts, d1: null, d7: null, d30: null,
    });
  }
  entries = entries.filter((e) => new Date(e.entry_ts).getTime() > now - 35 * DAY);
  entries.sort((a, b) => new Date(b.entry_ts) - new Date(a.entry_ts));
  return entries;
}

function summarize(entries) {
  const buckets = [
    { label: "score < 0.40", min: 0, max: 0.40 },
    { label: "0.40 – 0.55", min: 0.40, max: 0.55 },
    { label: "score ≥ 0.55", min: 0.55, max: 1.01 },
  ];
  const avg = (arr, k) => { const v = arr.map((e) => e[k]).filter((x) => x != null); return v.length ? +(v.reduce((a, x) => a + x, 0) / v.length).toFixed(1) : null; };
  return buckets.map((b) => {
    const inB = entries.filter((e) => e.score >= b.min && e.score < b.max);
    return { label: b.label, n: inB.length, avg_d7: avg(inB, "d7"), avg_d30: avg(inB, "d30") };
  });
}

// ---------- enrichissement DUE DILIGENCE (affichage seul, ne touche pas au score) ----------
const DD = {
  enrichN: Number(process.env.DD_ENRICH_N || 50),       // nb de candidats enrichis
  searchFallback: Number(process.env.DD_SEARCH_FALLBACK || 10), // recherches DexScreener par symbole (sans adresse)
  cgN: Number(process.env.CG_ENRICH_N || 12),           // CoinGecko : top N seulement (budget gratuit)
  lowLiq: Number(process.env.DD_LOW_LIQ || 100_000),    // seuil "liquidité faible"
  freshDays: Number(process.env.DD_FRESH_DAYS || 14),   // seuil "paire récente"
  minFees: Number(process.env.DD_MIN_FEES || 1_000),    // seuil "revenu réel" (fees 24h)
};
const CG_KEY = process.env.COINGECKO_API_KEY || "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function safeJson(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

// DefiLlama : 2 appels groupés (pas par coin), sans clé.
async function fetchDefiLlama() {
  const [protos, feesObj] = await Promise.all([
    safeJson("https://api.llama.fi/protocols"),
    safeJson("https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true"),
  ]);
  const bySymbol = new Map();
  if (Array.isArray(protos)) {
    for (const p of protos) {
      if (!p.symbol || p.symbol === "-") continue;
      const k = p.symbol.toUpperCase();
      const prev = bySymbol.get(k);
      if (!prev || (p.tvl || 0) > (prev.tvl || 0)) {
        bySymbol.set(k, { name: p.name, tvl: p.tvl || 0, category: p.category || null });
      }
    }
  }
  const feesByName = new Map();
  const fp = feesObj && (feesObj.protocols || feesObj);
  if (Array.isArray(fp)) for (const f of fp) if (f.name) feesByName.set(f.name.toLowerCase(), f.total24h ?? null);
  return { bySymbol, feesByName };
}

// DexScreener : groupé par adresse (30 max/appel), sans clé.
async function fetchDexByAddress(addresses) {
  const out = new Map();
  for (let i = 0; i < addresses.length; i += 30) {
    const chunk = addresses.slice(i, i + 30);
    const data = await safeJson(`https://api.dexscreener.com/latest/dex/tokens/${chunk.join(",")}`);
    for (const pr of (data && data.pairs) || []) {
      const addr = ((pr.baseToken && pr.baseToken.address) || "").toLowerCase();
      if (!addr) continue;
      const liq = (pr.liquidity && pr.liquidity.usd) || 0;
      const prev = out.get(addr);
      if (!prev || liq > prev.liquidity_usd) {
        out.set(addr, {
          liquidity_usd: liq,
          pair_age_days: pr.pairCreatedAt ? Math.floor((Date.now() - pr.pairCreatedAt) / DAY) : null,
        });
      }
    }
    await sleep(250);
  }
  return out;
}

async function dexSearch(symbol) {
  const data = await safeJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`);
  const pairs = ((data && data.pairs) || []).filter(
    (p) => p.baseToken && (p.baseToken.symbol || "").toUpperCase() === symbol.toUpperCase()
  );
  if (!pairs.length) return null;
  pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
  const pr = pairs[0];
  return {
    liquidity_usd: (pr.liquidity && pr.liquidity.usd) || 0,
    pair_age_days: pr.pairCreatedAt ? Math.floor((Date.now() - pr.pairCreatedAt) / DAY) : null,
  };
}

async function enrichDD(candidates, rawById) {
  const llama = await fetchDefiLlama();
  const toEnrich = candidates.slice(0, DD.enrichN);

  const addrList = [];
  for (const c of toEnrich) {
    const addr = rawById.get(c.id)?.platform?.token_address;
    if (addr) addrList.push(addr);
  }
  let dexByAddr = new Map();
  try { dexByAddr = await fetchDexByAddress(addrList); } catch { /* best-effort */ }

  let searches = 0;
  for (const c of toEnrich) {
    const addr = rawById.get(c.id)?.platform?.token_address?.toLowerCase();
    let dex = addr ? dexByAddr.get(addr) : null;
    if (!dex && !addr && searches < DD.searchFallback) {
      try { dex = await dexSearch(c.symbol); } catch {}
      searches++; await sleep(250);
    }
    const fl = llama.bySymbol.get(c.symbol.toUpperCase());
    const fees24h = fl ? llama.feesByName.get(fl.name.toLowerCase()) : null;

    const dd = {
      tvl: fl?.tvl ?? null,
      category: fl?.category ?? null,
      fees24h: fees24h ?? null,
      liquidity_usd: dex?.liquidity_usd ?? null,
      pair_age_days: dex?.pair_age_days ?? null,
      token_age_days: null,
      flags: [],
    };
    if (dd.fees24h != null && dd.fees24h >= DD.minFees) dd.flags.push({ k: "revenu réel", t: "ok" });
    if (dd.tvl != null && dd.tvl > 0 && (dd.fees24h == null || dd.fees24h < DD.minFees)) dd.flags.push({ k: "TVL sans revenu", t: "warn" });
    if (dd.liquidity_usd != null && dd.liquidity_usd < DD.lowLiq) dd.flags.push({ k: "liquidité faible", t: "bad" });
    if (dd.pair_age_days != null && dd.pair_age_days < DD.freshDays) dd.flags.push({ k: "paire récente", t: "warn" });
    c.dd = dd;
  }
}

// CoinGecko : OFF tant que COINGECKO_API_KEY n'est pas dans les Secrets. Top N seulement (budget gratuit).
async function enrichCoinGecko(candidates) {
  if (!CG_KEY) return;
  const h = { "x-cg-demo-api-key": CG_KEY, accept: "application/json" };
  const list = await safeJson("https://api.coingecko.com/api/v3/coins/list", { headers: h });
  if (!Array.isArray(list)) return;
  const bySym = new Map();
  for (const c of list) { const k = (c.symbol || "").toUpperCase(); if (!bySym.has(k)) bySym.set(k, c.id); }
  let n = 0;
  for (const c of candidates) {
    if (n >= DD.cgN) break;
    const id = bySym.get(c.symbol.toUpperCase());
    if (!id) continue;
    const d = await safeJson(`https://api.coingecko.com/api/v3/coins/${id}?localization=false&tickers=false&market_data=false&community_data=false&developer_data=false`, { headers: h });
    n++; await sleep(2500); // demo ~30/min
    if (!d) continue;
    c.dd = c.dd || { flags: [] };
    if (d.genesis_date) c.dd.token_age_days = Math.floor((Date.now() - new Date(d.genesis_date).getTime()) / DAY);
    if (!c.dd.category && Array.isArray(d.categories) && d.categories[0]) c.dd.category = d.categories[0];
  }
}

async function main() {
  const listings = await fetchListings();
  const rawById = new Map(listings.map((c) => [c.id, c]));

  // 1) Poids actifs = ceux appris au run précédent (walk-forward, pas de lookahead).
  const prevW = await loadJson(CONFIG.weightsOut, null);
  const activeWeights = prevW && prevW.active && prevW.weights ? prevW.weights : DEFAULT_WEIGHTS;

  // 2) Score les candidats avec ces poids.
  const candidates = listings.filter(passesFilters).map((c) => {
    const q = c.quote.USD;
    const parts = signalParts(c);
    const total = c.total_supply || c.max_supply;
    return {
      id: c.id, symbol: c.symbol, name: c.name, price: q.price, market_cap: q.market_cap,
      volume_24h: q.volume_24h, pct_7d: q.percent_change_7d, pct_30d: q.percent_change_30d,
      float_ratio: total ? (c.circulating_supply || 0) / total : null,
      score: scoreWith(parts, activeWeights), parts,
    };
  }).sort((a, b) => b.score - a.score).slice(0, CONFIG.topN);

  // 2b) Enrichissement Due Diligence (best-effort, n'affecte pas le score).
  try { await enrichDD(candidates, rawById); } catch (e) { console.warn("DD DefiLlama/DexScreener:", e.message); }
  try { await enrichCoinGecko(candidates); } catch (e) { console.warn("DD CoinGecko:", e.message); }
  const ddCount = candidates.filter((c) => c.dd && (c.dd.liquidity_usd != null || c.dd.tvl != null)).length;
  const cgCount = candidates.filter((c) => c.dd && c.dd.token_age_days != null).length;
  console.log(`CoinGecko: ${CG_KEY ? "clé détectée" : "PAS de clé"}, ${cgCount} enrichis (âge/catégorie).`);

  await mkdir(dirname(CONFIG.out), { recursive: true });
  await writeFile(CONFIG.out, JSON.stringify({
    updated_at: new Date().toISOString(), source: "coinmarketcap",
    note: "Triage, pas un prédicteur. Le tracker dit si le score vaut quelque chose.",
    weights_mode: prevW && prevW.active ? "appris" : "défaut", weights: activeWeights,
    count: candidates.length, candidates,
  }, null, 2));
  console.log(`screener: ${candidates.length} candidats (poids ${prevW && prevW.active ? "appris" : "défaut"}, DD sur ${ddCount}).`);

  // 3) Met à jour le tracker (maturation + nouveaux picks).
  const prevT = await loadJson(CONFIG.trackerOut, { entries: [] });
  const entries = updateTrackerEntries(listings, candidates, prevT);
  await writeFile(CONFIG.trackerOut, JSON.stringify({
    updated_at: new Date().toISOString(), count: entries.length, summary: summarize(entries), entries,
  }, null, 2));
  console.log(`tracker: ${entries.length} entrées.`);

  // 4) Ré-apprend les poids pour le PROCHAIN run, à partir des entrées matures.
  const learned = { ...learn(entries), default_weights: DEFAULT_WEIGHTS, blend: BLEND, floor: FLOOR };
  await writeFile(CONFIG.weightsOut, JSON.stringify(learned, null, 2));
  console.log(`weights: ${learned.active ? "APPRIS" : "défaut"} (${learned.n} matures).`);
}

main().catch((e) => { console.error("Échec du scan:", e.message); process.exit(1); });
