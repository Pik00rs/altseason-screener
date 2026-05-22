// Dashboard client-side. Lit UNIQUEMENT le JSON statique de même origine
// (écrit par GitHub Actions). Aucune clé API ici, aucun appel cross-origin.

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

async function load() {
  try {
    const res = await fetch("./data/screener.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    state.rows = data.candidates || [];
    document.getElementById("updated").textContent =
      "maj " + new Date(data.updated_at).toLocaleString("fr-FR");
    document.getElementById("source").textContent = data.source || "";
  } catch (e) {
    document.getElementById("updated").textContent = "données indisponibles";
    console.error(e);
  }
  render();
}

function sorted() {
  const f = state.filter.toLowerCase();
  const rows = state.rows.filter(
    (r) => !f || r.symbol.toLowerCase().includes(f) || r.name.toLowerCase().includes(f)
  );
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
  tbody.innerHTML = rows
    .map((r, i) => {
      const pct = Math.round(r.score * 100);
      return `<tr style="animation-delay:${Math.min(i * 18, 500)}ms">
        <td class="num">
          <div class="score-cell">
            <span class="score-val">${r.score.toFixed(2)}</span>
            <span class="score-bar"><i style="width:${pct}%"></i></span>
          </div>
        </td>
        <td><span class="tick">${r.symbol}</span></td>
        <td class="name">${r.name}</td>
        <td class="num">${fmtUsd(r.price)}</td>
        <td class="num">${fmtUsd(r.market_cap)}</td>
        <td class="num ${pctClass(r.pct_7d)}">${fmtPct(r.pct_7d)}</td>
        <td class="num ${pctClass(r.pct_30d)}">${fmtPct(r.pct_30d)}</td>
        <td class="num">${r.float_ratio == null ? "—" : (r.float_ratio * 100).toFixed(0) + "%"}</td>
        <td class="num">${fmtUsd(r.volume_24h)}</td>
      </tr>`;
    })
    .join("");
}

function setupSort() {
  document.querySelectorAll("th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (state.sortKey === key) state.sortDir *= -1;
      else { state.sortKey = key; state.sortDir = -1; }
      document.querySelectorAll("th").forEach((h) => h.classList.remove("sorted-asc", "sorted-desc"));
      th.classList.add(state.sortDir === -1 ? "sorted-desc" : "sorted-asc");
      render();
    });
  });
}

document.getElementById("search").addEventListener("input", (e) => {
  state.filter = e.target.value;
  render();
});

setupSort();
load();
