// Tourne côté serveur (GitHub Actions), JAMAIS dans le navigateur.
// Appelle l'API CoinMarketCap avec la clé planquée dans les Secrets,
// calcule un score, et écrit docs/data/screener.json (lu par le dashboard).
// Node 18+ (fetch natif). Read-only sur la blockchain : ne touche aucun fonds.

import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const CONFIG = {
  apiKey: process.env.CMC_API_KEY || "",
  base: "https://pro-api.coinmarketcap.com",
  limit: Number(process.env.CMC_LIMIT || 200),         // 1 crédit/appel jusqu'à 200
  minMcap: Number(process.env.MIN_MARKET_CAP || 15_000_000),
  maxMcap: Number(process.env.MAX_MARKET_CAP || 500_000_000),
  minVol: Number(process.env.MIN_VOLUME_24H || 1_000_000),
  topN: Number(process.env.TOP_N || 50),
  out: process.env.OUT || "docs/data/screener.json",
};

// Poids du scoring. À BACKTESTER. sector_heat non dispo simplement sur CMC free -> TODO.
const WEIGHTS = {
  float_quality: 0.25,
  momentum_7d: 0.25,
  momentum_30d: 0.2,
  volume_surge: 0.3,
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

function scoreFloatQuality(c) {
  const total = c.total_supply || c.max_supply || 0;
  if (!total) return 0;
  return clamp01((c.circulating_supply || 0) / total);
}
function scoreMomentum(pct, capAt) {
  if (pct == null) return 0;
  return clamp01(pct / capAt);
}
function scoreVolumeSurge(q) {
  if (!q.market_cap) return 0;
  return clamp01(q.volume_24h / q.market_cap / 0.5); // turnover 50% = 1.0
}

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
  if (!CONFIG.apiKey) throw new Error("CMC_API_KEY manquante (mets-la dans les GitHub Secrets).");
  const url = new URL("/v1/cryptocurrency/listings/latest", CONFIG.base);
  url.searchParams.set("start", "1");
  url.searchParams.set("limit", String(CONFIG.limit));
  url.searchParams.set("sort", "market_cap");
  url.searchParams.set("convert", "USD");
  const res = await fetch(url, { headers: { "X-CMC_PRO_API_KEY": CONFIG.apiKey, accept: "application/json" } });
  if (!res.ok) throw new Error(`CMC HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  return json.data || [];
}

function passesFilters(c) {
  const q = c.quote.USD;
  return q.market_cap >= CONFIG.minMcap && q.market_cap <= CONFIG.maxMcap && q.volume_24h >= CONFIG.minVol;
}

async function main() {
  const listings = await fetchListings();
  const candidates = listings
    .filter(passesFilters)
    .map((c) => {
      const q = c.quote.USD;
      const { score, parts } = composite(c);
      return {
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        price: q.price,
        market_cap: q.market_cap,
        volume_24h: q.volume_24h,
        pct_7d: q.percent_change_7d,
        pct_30d: q.percent_change_30d,
        float_ratio: (c.total_supply || c.max_supply) ? (c.circulating_supply || 0) / (c.total_supply || c.max_supply) : null,
        score,
        parts,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, CONFIG.topN);

  const payload = {
    updated_at: new Date().toISOString(),
    source: "coinmarketcap",
    note: "Outil de triage, pas un prédicteur. Backteste avant de croire le score.",
    weights: WEIGHTS,
    count: candidates.length,
    candidates,
  };

  await mkdir(dirname(CONFIG.out), { recursive: true });
  await writeFile(CONFIG.out, JSON.stringify(payload, null, 2));
  console.log(`Écrit ${candidates.length} candidats -> ${CONFIG.out}`);
}

main().catch((e) => {
  console.error("Échec du scan:", e.message);
  process.exit(1);
});
