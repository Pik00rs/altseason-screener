// Dashboard client-side. Lit UNIQUEMENT les JSON statiques de même origine
// (écrits par GitHub Actions). Aucune clé API, aucun appel cross-origin.

const state = { rows: [], sortKey: "score", sortDir: -1, filter: "" };

const fmtUsd = (n) => {
  if (n == null) return "—";
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1) return "$" + n.toFixed(2);
  return "$" + n.toPrecision(3);
};
const fmtPct = (n) => (n == null ? "—" : (n >= 0 ? "+" : "") + n.toFixed(1) + "%");
const pctClass = (n) => (n == null ? "" : n >= 0 ? "pos" : "neg");

// ---------- chargement ----------
async function load() {
  try {
    const res = await fetch("./data/screener.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.rows = data.candidates || [];
    document.getElementById("updated").textContent = "maj " + new Date(data.updated_at).toLocaleString("fr-FR");
    document.getElementById("source").textContent = data.source || "";
    const ds = data.dd_status;
    if (ds) {
      document.getElementById("dd-status").textContent =
        `DD ${ds.dd} coins · CoinGecko ${ds.coingecko ? "actif (" + ds.cg + ")" : "off"}`;
    }
  } catch (e) {
    document.getElementById("updated").textContent = "données indisponibles";
    console.error(e);
  }
  render();
  loadTracker();
}

async function loadTracker() {
  try {
    const res = await fetch("./data/tracker.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    renderSummary(data.summary || []);
    renderTracker(data.entries || []);
  } catch (e) {
    renderSummary([]);
    renderTracker([]);
  }
  loadModel();
}

async function loadModel() {
  const el = document.getElementById("model");
  try {
    const res = await fetch("./data/weights.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const w = await res.json();
    const bars = Object.entries(w.weights || {}).map(([k, v]) =>
      `<div class="wbar"><span>${k.replace("_", " ")}</span>
        <span class="wtrack"><i style="width:${Math.round(v * 100 / 0.5)}%"></i></span>
        <b>${(v * 100).toFixed(0)}%</b></div>`).join("");
    const status = w.active
      ? `<span class="m-on">● modèle APPRIS</span> · ${w.n} entrées matures (+7j)`
      : `<span class="m-off">○ poids par défaut</span> · ${w.reason || ""}`;
    el.innerHTML = `<div class="model-head">${status}</div><div class="wbars">${bars}</div>
      <p class="summary-note">Les poids sont recalculés à chaque run depuis les perfs réelles passées (walk-forward). Tant que le modèle est « par défaut », il n'a pas encore assez de recul pour apprendre.</p>`;
  } catch (e) {
    el.innerHTML = "";
  }
}

// ---------- screener ----------
function flagChips(dd) {
  if (!dd || !dd.flags || !dd.flags.length) return '<span class="muted">—</span>';
  return dd.flags.map((f) => `<span class="chip ${f.t}">${f.k}</span>`).join("");
}
function ddDetail(dd) {
  if (!dd) return '<span class="muted">Pas de données DD.</span>';
  const none = dd.tvl == null && dd.liquidity_usd == null && dd.fees24h == null;
  const age = dd.token_age_days != null ? dd.token_age_days + " j"
    : dd.pair_age_days != null ? dd.pair_age_days + " j (paire)" : "—";
  const bits = [
    `revenu 24h <b>${dd.fees24h != null ? fmtUsd(dd.fees24h) : "n/a"}</b>`,
    `TVL <b>${dd.tvl != null ? fmtUsd(dd.tvl) : "n/a"}</b>`,
    `liquidité DEX <b>${dd.liquidity_usd != null ? fmtUsd(dd.liquidity_usd) : "n/a"}</b>`,
    `âge <b>${age}</b>`,
    `catégorie <b>${dd.category || "n/a"}</b>`,
  ];
  return (none ? `<span class="muted">Pas de données DD (sans doute pas un protocole DeFi ni de paire DEX trackée). </span>` : "")
    + bits.join('<span class="sep">·</span>');
}

function sorted() {
  const f = state.filter.toLowerCase();
  const rows = state.rows.filter((r) => !f || r.symbol.toLowerCase().includes(f) || r.name.toLowerCase().includes(f));
  const k = state.sortKey;
  return rows.sort((a, b) => {
    const av = a[k], bv = b[k];
    if (typeof av === "string") return state.sortDir * av.localeCompare(bv);
    return state.sortDir * ((av ?? -Infinity) - (bv ?? -Infinity));
  });
}

function render() {
  const tbody = document.getElementById("rows");
  const rows = sorted();
  document.getElementById("empty").hidden = rows.length > 0;
  tbody.innerHTML = rows.map((r, i) => {
    const pct = Math.round(r.score * 100);
    return `<tr class="main-row" style="animation-delay:${Math.min(i * 18, 500)}ms">
      <td class="num"><div class="score-cell">
        <span class="score-val">${r.score.toFixed(2)}</span>
        <span class="score-bar"><i style="width:${pct}%"></i></span>
      </div></td>
      <td><span class="tick">${r.symbol}</span></td>
      <td class="name">${r.name}</td>
      <td class="num">${fmtUsd(r.price)}</td>
      <td class="num">${fmtUsd(r.market_cap)}</td>
      <td class="num ${pctClass(r.pct_7d)}">${fmtPct(r.pct_7d)}</td>
      <td class="num ${pctClass(r.pct_30d)}">${fmtPct(r.pct_30d)}</td>
      <td class="num">${r.float_ratio == null ? "—" : (r.float_ratio * 100).toFixed(0) + "%"}</td>
      <td class="num">${fmtUsd(r.volume_24h)}</td>
      <td class="dd-cell">${flagChips(r.dd)}</td>
    </tr>
    <tr class="dd-row" hidden><td colspan="10" class="dd-detail">${ddDetail(r.dd)}</td></tr>`;
  }).join("");
}

function setupSort() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = -1; }
      document.querySelectorAll("#grid th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(state.sortDir === -1 ? "sorted-desc" : "sorted-asc");
      render();
    });
  });
}

// ---------- tracker ----------
function renderSummary(summary) {
  const el = document.getElementById("summary");
  if (!summary.length || summary.every((b) => b.avg_d7 == null && b.avg_d30 == null)) {
    el.innerHTML = "";
    return;
  }
  el.innerHTML =
    `<h3>perf moyenne par tranche de score (entrées matures)</h3><div class="buckets">` +
    summary.map((b) => `<div class="bucket">
        <span class="b-label">${b.label}</span>
        <span class="b-n">${b.n} picks</span>
        <span class="b-row"><span>+7j</span> <b class="${pctClass(b.avg_d7)}">${fmtPct(b.avg_d7)}</b></span>
        <span class="b-row"><span>+30j</span> <b class="${pctClass(b.avg_d30)}">${fmtPct(b.avg_d30)}</b></span>
      </div>`).join("") +
    `</div><p class="summary-note">Si le score a de la valeur, les tranches hautes devraient battre les basses sur +7j/+30j. Sinon, le score ne vaut rien — et c'est utile à savoir.</p>`;
}

function renderTracker(entries) {
  const tbody = document.getElementById("track-rows");
  document.getElementById("track-empty").hidden = entries.length > 0;
  tbody.innerHTML = entries.map((e, i) => {
    const d = new Date(e.entry_ts).toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
    return `<tr style="animation-delay:${Math.min(i * 14, 450)}ms">
      <td class="entry-date">${d}</td>
      <td><span class="tick">${e.symbol}</span></td>
      <td class="num">${e.score.toFixed(2)}</td>
      <td class="num ${pctClass(e.d1)}">${fmtPct(e.d1)}</td>
      <td class="num ${pctClass(e.d7)}">${fmtPct(e.d7)}</td>
      <td class="num ${pctClass(e.d30)}">${fmtPct(e.d30)}</td>
    </tr>`;
  }).join("");
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    document.getElementById("view-screener").hidden = view !== "screener";
    document.getElementById("view-tracker").hidden = view !== "tracker";
  });
});

document.getElementById("search").addEventListener("input", (e) => {
  state.filter = e.target.value;
  render();
});

// clic sur une ligne -> déplie/replie le détail DD
document.getElementById("rows").addEventListener("click", (e) => {
  const tr = e.target.closest("tr.main-row");
  if (!tr) return;
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("dd-row")) next.hidden = !next.hidden;
});

setupSort();
load();
