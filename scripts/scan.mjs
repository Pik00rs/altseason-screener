// Tourne côté serveur (GitHub Actions), JAMAIS dans le navigateur.
// Appelle CoinMarketCap avec la clé des Secrets, calcule un score, écrit :
//   - docs/data/screener.json  (candidats du moment)
//   - docs/data/tracker.json   (suivi perf +1j/+7j/+30j des picks passés)
// Node 18+ (fetch natif). Read-only : ne touche aucun fonds.

import { writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CONFIG = {
  apiKey: process.env.CMC_API_KEY || "",
  base: "https://pro-api.coinmarketcap.com",
  limit: Number(process.env.CMC_LIMIT || 500),        // 500 -> couvre le band small-cap (~3 crédits/run)
  minMcap: Number(process.env.MIN_MARKET_CAP || 15_000_000),
  maxMcap: Number(process.env.MAX_MARKET_CAP || 500_000_000),
  minVol: Number(process.env.MIN_VOLUME_24H || 1_000_000),
  topN: Number(process.env.TOP_N || 50),
  trackTopN: Number(process.env.TRACK_TOP_N || 20),    // combien de picks on suit chaque jour
  out: process.env.OUT || "docs/data/screener.json",
  trackerOut: process.env.TRACKER_OUT || "docs/data/tracker.json",
};

const WEIGHTS = { float_quality: 0.25, momentum_7d: 0.25, momentum_30d: 0.2, volume_surge: 0.3 };
const HORIZONS = [1, 7, 30];
const DAY = 86400000;
const clamp01 = (x) => Math.max(0, Math.min(1, x));

function scoreFloatQuality(c) {
  const total = c.total_supply || c.max_supply || 0;
  return total ? clamp01((c.circulating_supply || 0) / total) : 0;
}
const scoreMomentum = (pct, capAt) => (pct == null ? 0 : clamp01(pct / capAt));
const scoreVolumeSurge = (q) => (q.market_cap ? clamp01(q.volume_24h / q.market_cap / 0.5) : 0);

function composite(c) {
  const q = c.quote.USD;
  const parts = {
    float_quality: scoreFloatQuality(c),
    momentum_7d: scoreMomentum(q.percent_change_7d, 50),
    momentum_30d: scoreMomentum(q.percent_change_30d, 100),
    volume_surge: scoreVolumeSurge(q),
  };
  const totalW = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  const s = Object.keys(parts).reduce((acc, k) => acc + parts[k] * WEIGHTS[k], 0) / totalW;
  return { score: s, parts };
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

function summarize(entries) {
  const buckets = [
    { label: "score < 0.40", min: 0, max: 0.40 },
    { label: "0.40 – 0.55", min: 0.40, max: 0.55 },
    { label: "score ≥ 0.55", min: 0.55, max: 1.01 },
  ];
  const avg = (arr, k) => {
    const v = arr.map((e) => e[k]).filter((x) => x != null);
    return v.length ? +(v.reduce((a, x) => a + x, 0) / v.length).toFixed(1) : null;
  };
  return buckets.map((b) => {
    const inB = entries.filter((e) => e.score >= b.min && e.score < b.max);
    return { label: b.label, n: inB.length, avg_d7: avg(inB, "d7"), avg_d30: avg(inB, "d30") };
  });
}

async function updateTracker(listings, candidates) {
  const now = Date.now();
  const priceById = new Map(listings.map((c) => [c.id, c.quote.USD.price]));

  let tracker = await loadJson(CONFIG.trackerOut, { entries: [] });
  if (tracker.source === "SAMPLE") tracker = { entries: [] }; // on jette l'exemple au 1er vrai run
  let entries = tracker.entries || [];

  // 1) Maturation : remplir +1j/+7j/+30j quand le délai est atteint.
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

  // 2) Nouveaux picks : max 1/jour/token, on photographie le top trackTopN.
  const recentCutoff = now - 20 * 3600 * 1000;
  const recent = new Set(entries.filter((e) => new Date(e.entry_ts).getTime() > recentCutoff).map((e) => e.id));
  for (const c of candidates.slice(0, CONFIG.trackTopN)) {
    if (recent.has(c.id)) continue;
    entries.push({
      id: c.id, symbol: c.symbol, name: c.name,
      entry_ts: new Date(now).toISOString(), entry_price: c.price,
      score: +c.score.toFixed(2), d1: null, d7: null, d30: null,
    });
  }

  // 3) Purge > 35 jours.
  entries = entries.filter((e) => new Date(e.entry_ts).getTime() > now - 35 * DAY);
  entries.sort((a, b) => new Date(b.entry_ts) - new Date(a.entry_ts));

  const payload = { updated_at: new Date(now).toISOString(), count: entries.length, summary: summarize(entries), entries };
  await mkdir(dirname(CONFIG.trackerOut), { recursive: true });
  await writeFile(CONFIG.trackerOut, JSON.stringify(payload, null, 2));
  console.log(`Tracker: ${entries.length} entrées suivies.`);
}

async function main() {
  const listings = await fetchListings();
  const candidates = listings
    .filter(passesFilters)
    .map((c) => {
      const q = c.quote.USD;
      const { score, parts } = composite(c);
      const total = c.total_supply || c.max_supply;
      return {
        id: c.id, symbol: c.symbol, name: c.name, price: q.price,
        market_cap: q.market_cap, volume_24h: q.volume_24h,
        pct_7d: q.percent_change_7d, pct_30d: q.percent_change_30d,
        float_ratio: total ? (c.circulating_supply || 0) / total : null,
        score, parts,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.topN);

  const payload = {
    updated_at: new Date().toISOString(), source: "coinmarketcap",
    note: "Outil de triage, pas un prédicteur. Le tracker dit si le score vaut quelque chose.",
    weights: WEIGHTS, count: candidates.length, candidates,
  };
  await mkdir(dirname(CONFIG.out), { recursive: true });
  await writeFile(CONFIG.out, JSON.stringify(payload, null, 2));
  console.log(`Écrit ${candidates.length} candidats -> ${CONFIG.out}`);

  await updateTracker(listings, candidates);
}

main().catch((e) => { console.error("Échec du scan:", e.message); process.exit(1); });
