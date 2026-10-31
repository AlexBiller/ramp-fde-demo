(function () {
  "use strict";
  const A = window.Agent;
  const idx = A.indexData(window.SEED);
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const pct = (x) => (x * 100).toFixed(0) + "%";
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const preset = (id) => clone(A.PRESETS.find((p) => p.id === id));

  const state = {
    reviewConfig: preset("context"),
    selected: idx.seed.transactions[0].id,
    filter: "all",
    search: "",
    lastResult: null,
    evalConfig: preset("context"),
    evalResult: null,
    evalOnlyMisses: false,
    cmp: [preset("baseline"), preset("context")],
    recordsTab: "transactions",
  };

  const badge = (d) => `<span class="badge ${d}">${d === "flag" ? "Flag" : d === "reject" ? "Reject" : "Approve"}</span>`;
  const statusIcon = { pass: "✓", flag: "!", reject: "✕", info: "i" };
  const label = (kind, id) => {
    if (kind === "policy") return `${id} ${idx.policy[id].title}`;
    if (kind === "vendor") return `Vendor list: ${idx.merchant[id].name}`;
    if (kind === "merchant") return `${id} ${idx.merchant[id].name}`;
    if (kind === "employee") return `${id} ${idx.emp[id].name}`;
    return id;
  };
  const chip = (c) => `<button class="cite ${c.kind}" data-kind="${c.kind}" data-id="${esc(c.id)}" data-fields="${esc((c.fields || []).join(","))}" title="Open source record">${esc(label(c.kind, c.id))}${c.fields && c.fields.length ? `<span class="cite-fields">${esc(c.fields.join(", "))}</span>` : ""}</button>`;

  function recordFor(kind, id) {
    switch (kind) {
      case "transaction": return idx.tx[id];
      case "merchant": return idx.merchant[id];
      case "employee": return idx.emp[id];
      case "trip": return idx.trip[id];
      case "receipt": return idx.receipt[id];
      case "policy": return idx.policy[id];
      case "vendor": return idx.vendors[id];
    }
  }

  function recordTable(kind, id, fields = []) {
    const r = recordFor(kind, id);
    if (!r) return `<p class="muted">Record not found.</p>`;
    const rows = Object.entries(r).map(([k, v]) => {
      let val = typeof v === "object" && v !== null ? `<code>${esc(JSON.stringify(v, null, 1))}</code>` : esc(v === null ? "—" : v);
      if (k === "amount" || k === "total") val = esc(A.fmt(v));
      return `<tr class="${fields.includes(k) ? "hl" : ""}"><th>${esc(k)}</th><td>${val}</td></tr>`;
    }).join("");
    return `<table class="kv">${rows}</table>`;
  }

  function traceHtml(r, opts = {}) {
    const steps = r.findings.map((f, i) => `
      <li class="step ${f.status}" style="--i:${i}">
        <span class="step-icon">${statusIcon[f.status]}</span>
        <div class="step-body">
          <div class="step-title">${esc(f.title)}${f.clause ? ` <span class="clause">${esc(f.clause)}</span>` : ""}</div>
          <div class="step-detail">${esc(f.detail)}</div>
          <div class="cites">${f.citations.map(chip).join("")}</div>
        </div>
      </li>`).join("");
    return `
      <div class="trace ${opts.animate ? "animate" : ""}">
        <div class="decision">
          ${badge(r.decision)}
          <div class="decision-text">${esc(r.summary)}</div>
          <div class="conf" title="Lower when the agent had to assume missing context">Confidence <b>${pct(r.confidence)}</b></div>
        </div>
        ${r.assumptions.length ? `<div class="assume"><b>Assumptions:</b> ${r.assumptions.map(esc).join(" ")}</div>` : ""}
        <ol class="steps">${steps}</ol>
        <div class="sources"><span class="muted">Records consulted (${r.sources.length}):</span> ${r.sources.map(chip).join("")}</div>
      </div>`;
  }

  // Drawer
  function openDrawer(title, html, wide) {
    $("#drawer-title").textContent = title;
    $("#drawer-body").innerHTML = html;
    $("#drawer").classList.toggle("wide", !!wide);
    $("#drawer").classList.add("open");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#scrim").classList.add("open");
  }
  function closeDrawer() {
    $("#drawer").classList.remove("open");
    $("#drawer").setAttribute("aria-hidden", "true");
    $("#scrim").classList.remove("open");
  }
  function openRecord(kind, id, fields) {
    let html = "";
    if (kind === "policy") {
      const p = idx.policy[id];
      html = `<div class="policy-text">${esc(p.text)}</div>${p.params ? `<h4>Parameters</h4><code class="block">${esc(JSON.stringify(p.params, null, 2))}</code>` : ""}`;
    } else {
      html = `<p class="muted">Highlighted fields were used by the agent.</p>${recordTable(kind, id, fields)}`;
      if (kind === "transaction") {
        const t = idx.tx[id];
        const related = [["merchant", t.merchant_id], ["employee", t.employee_id], t.receipt_id && ["receipt", t.receipt_id], t.trip_id && ["trip", t.trip_id]].filter(Boolean);
        html += `<h4>Linked records</h4><div class="cites">${related.map(([k, i]) => chip({ kind: k, id: i })).join("")}</div>`;
        const ev = idx.seed.eval_set.find((e) => e.txn_id === id);
        if (ev) html += `<h4>Ground-truth label (eval set)</h4><p>${badge(ev.label)} ${esc(ev.reviewer_note)}</p>`;
      }
    }
    const kindName = { transaction: "Transaction", merchant: "Merchant", employee: "Employee", trip: "Trip", receipt: "Receipt", policy: "Policy clause", vendor: "Approved vendor" }[kind];
    openDrawer(`${kindName} · ${label(kind, id)}`, html);
  }
  function openTrace(txId, config) {
    const r = A.review(txId, config, idx);
    const t = idx.tx[txId];
    const ev = idx.seed.eval_set.find((e) => e.txn_id === txId);
    openDrawer(`Agent trace · ${txId}`, `
      <div class="txn-mini">${esc(idx.merchant[t.merchant_id].name)} · ${esc(A.fmt(t.amount))} · ${esc(t.date)}<br><span class="muted">“${esc(t.memo)}”</span></div>
      <p class="muted">Config: ${esc(config.name)}</p>
      ${ev ? `<div class="expected">Expected ${badge(ev.label)} <span class="muted">${esc(ev.reviewer_note)}</span></div>` : ""}
      ${traceHtml(r)}`);
  }
  function openSideBySide(txId) {
    const t = idx.tx[txId];
    const ev = idx.seed.eval_set.find((e) => e.txn_id === txId);
    const cols = state.cmp.map((c, i) => `<div><h4>${"AB"[i]} · ${esc(c.name)}</h4>${traceHtml(A.review(txId, c, idx))}</div>`).join("");
    openDrawer(`Side-by-side trace · ${txId}`, `
      <div class="txn-mini">${esc(idx.merchant[t.merchant_id].name)} · ${esc(A.fmt(t.amount))} · ${esc(t.date)}<br><span class="muted">“${esc(t.memo)}”</span></div>
      ${ev ? `<div class="expected">Expected ${badge(ev.label)} <span class="muted">${esc(ev.reviewer_note)}</span></div>` : ""}
      <div class="two-col">${cols}</div>`, true);
  }

  document.addEventListener("click", (e) => {
    const c = e.target.closest(".cite");
    if (c) { e.preventDefault(); openRecord(c.dataset.kind, c.dataset.id, c.dataset.fields ? c.dataset.fields.split(",") : []); }
  });
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  // Config editor
  function configEditor(cfg, key) {
    return `
      <div class="cfg" data-key="${key}">
        <label class="field"><span>Preset</span>
          <select data-act="preset">${A.PRESETS.map((p) => `<option value="${p.id}" ${p.id === cfg.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}${cfg.id === "custom" ? `<option value="custom" selected>Custom</option>` : ""}</select>
        </label>
        <p class="muted small">${esc(cfg.description)}</p>
        <div class="toggles">${A.TOGGLES.map(([k, l]) => `<label class="tog"><input type="checkbox" data-act="toggle" data-k="${k}" ${cfg[k] ? "checked" : ""}> ${esc(l)}</label>`).join("")}</div>
        <label class="field"><span>Over-cap tolerance: <b>${cfg.tolerance_pct}%</b></span><input type="range" min="0" max="10" step="1" value="${cfg.tolerance_pct}" data-act="tol"></label>
      </div>`;
  }
  function bindConfig(root, get, set, onChange) {
    root.querySelectorAll(".cfg").forEach((el) => {
      const key = el.dataset.key;
      el.addEventListener("change", (e) => {
        let cfg = get(key);
        const act = e.target.dataset.act;
        if (act === "preset") cfg = preset(e.target.value);
        else {
          cfg = { ...cfg, id: "custom", name: "Custom", description: "Edited configuration." };
          if (act === "toggle") cfg[e.target.dataset.k] = e.target.checked;
          if (act === "tol") cfg.tolerance_pct = Number(e.target.value);
        }
        set(key, cfg);
        onChange();
      });
    });
  }

  // Views
  const views = {
    review() {
      const q = state.search.toLowerCase();
      const cats = ["all", ...new Set(idx.seed.merchants.map((m) => m.category))];
      const list = idx.seed.transactions.filter((t) => {
        const m = idx.merchant[t.merchant_id];
        if (state.filter !== "all" && m.category !== state.filter) return false;
        return !q || [t.id, t.memo, m.name, idx.emp[t.employee_id].name].join(" ").toLowerCase().includes(q);
      });
      const t = idx.tx[state.selected];
      const m = idx.merchant[t.merchant_id];
      const r = state.lastResult && state.lastResult.txn_id === t.id ? state.lastResult : null;
      return `
        <section class="intro"><h1>Review card transactions against policy</h1>
          <p>Pick a seeded transaction and run the agent. Every reasoning step cites the policy clause and source records it used. Click any chip to open the record.</p></section>
        <div class="review-grid">
          <div class="panel list-panel">
            <div class="list-tools">
              <input type="search" id="search" placeholder="Search memo, merchant, person…" value="${esc(state.search)}">
              <select id="cat">${cats.map((c) => `<option ${c === state.filter ? "selected" : ""}>${c}</option>`).join("")}</select>
            </div>
            <div class="list-count muted small">${list.length} of ${idx.seed.transactions.length} transactions</div>
            <ul class="txlist">${list.map((x) => {
              const mm = idx.merchant[x.merchant_id];
              return `<li class="${x.id === t.id ? "sel" : ""}" data-tx="${x.id}"><div class="row1"><span>${esc(mm.name)}</span><b>${esc(A.fmt(x.amount))}</b></div><div class="row2 muted"><span>${esc(x.id)} · ${esc(x.date)} · ${esc(mm.category)}</span></div><div class="row3">${esc(x.memo)}</div></li>`;
            }).join("") || `<li class="muted">No matches.</li>`}</ul>
          </div>
          <div class="panel detail-panel">
            <div class="txn-head">
              <div><div class="muted small">${esc(t.id)} · ${esc(t.date)}</div><h2>${esc(m.name)} <span class="amt">${esc(A.fmt(t.amount))}</span></h2>
              <div class="memo">“${esc(t.memo)}”</div>
              <div class="cites">${chip({ kind: "transaction", id: t.id })}${chip({ kind: "employee", id: t.employee_id })}${chip({ kind: "merchant", id: t.merchant_id })}${t.receipt_id ? chip({ kind: "receipt", id: t.receipt_id }) : `<span class="pill warn">No receipt</span>`}${t.trip_id ? chip({ kind: "trip", id: t.trip_id }) : ""}</div></div>
            </div>
            <div class="run-row">
              <label class="field inline"><span>Configuration</span>
                <select id="rev-preset">${A.PRESETS.map((p) => `<option value="${p.id}" ${p.id === state.reviewConfig.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}</select></label>
              <button class="btn primary" id="run">Run agent ▸</button>
            </div>
            <div id="result">${r ? traceHtml(r, { animate: state.animate }) : `<div class="empty">Run the agent to see its decision, reasoning steps and citations.</div>`}</div>
          </div>
        </div>`;
    },
    evaluate() {
      const e = state.evalResult;
      const cases = e ? e.cases.filter((c) => !state.evalOnlyMisses || !c.correct) : [];
      const labels = ["approve", "flag", "reject"];
      return `
        <section class="intro"><h1>Evaluation set</h1>
          <p>${idx.seed.eval_set.length} seeded transactions labeled by a (fictional) finance reviewer. Run the agent against all of them and see where it agrees.</p></section>
        <div class="eval-grid">
          <div class="panel">${configEditor(state.evalConfig, "eval")}<button class="btn primary wide" id="run-eval">Run evaluation (${idx.seed.eval_set.length} cases) ▸</button></div>
          <div class="panel">${e ? `
            <div class="metrics">
              ${metric("Accuracy", pct(e.accuracy), `${e.correct}/${e.n} exact match`)}
              ${metric("Violation recall", pct(e.violation_recall), `${e.tp} of ${e.tp + e.fn} violations caught`)}
              ${metric("Violation precision", pct(e.violation_precision), `${e.tp} of ${e.tp + e.fp} holds were right`)}
              ${metric("False-flag rate", pct(e.false_flag_rate), `${e.fp} clean txns held`)}
            </div>
            <h3>Confusion matrix <span class="muted small">(rows = expected, columns = agent)</span></h3>
            <table class="matrix"><tr><th></th>${labels.map((l) => `<th>${badge(l)}</th>`).join("")}</tr>
              ${labels.map((a) => `<tr><th>${badge(a)}</th>${labels.map((b) => `<td class="${a === b ? "diag" : e.matrix[a][b] ? "off" : ""}">${e.matrix[a][b]}</td>`).join("")}</tr>`).join("")}</table>` : `<div class="empty">Choose a configuration and run the evaluation.</div>`}
          </div>
        </div>
        ${e ? `<div class="panel">
          <div class="table-head"><h3>Cases</h3><label class="tog"><input type="checkbox" id="only-miss" ${state.evalOnlyMisses ? "checked" : ""}> Show misses only (${e.n - e.correct})</label></div>
          <table class="grid clickable"><thead><tr><th>Txn</th><th>Merchant · memo</th><th>Amount</th><th>Expected</th><th>Agent</th><th></th><th>Reviewer note</th></tr></thead><tbody>
          ${cases.map((c) => { const t = idx.tx[c.txn_id]; return `<tr data-trace="${c.txn_id}" class="${c.correct ? "" : "miss"}"><td>${c.txn_id}</td><td>${esc(idx.merchant[t.merchant_id].name)}<div class="muted small">${esc(t.memo)}</div></td><td class="num">${esc(A.fmt(t.amount))}</td><td>${badge(c.label)}</td><td>${badge(c.predicted)}</td><td>${c.correct ? `<span class="ok">✓</span>` : `<span class="bad">✕</span>`}</td><td class="small">${esc(c.reviewer_note)}</td></tr>`; }).join("")}
          </tbody></table><p class="muted small">Click a row to open the agent's trace for that case.</p></div>` : ""}`;
    },
    compare() {
      const [ea, eb] = state.cmp.map((c) => A.evaluate(c, idx));
      const rows = [["Accuracy", "accuracy", true], ["Violation recall", "violation_recall", true], ["Violation precision", "violation_precision", true], ["False-flag rate", "false_flag_rate", false], ["Auto-approved", "auto_approved", null]];
      const diffs = ea.cases.map((c, i) => ({ a: c, b: eb.cases[i] })).filter((d) => d.a.predicted !== d.b.predicted);
      const delta = (k, better) => {
        const d = eb[k] - ea[k];
        if (Math.abs(d) < 1e-9) return `<span class="muted">±0</span>`;
        const good = better === null ? null : (d > 0) === better;
        return `<span class="${good === null ? "muted" : good ? "ok" : "bad"}">${d > 0 ? "+" : "−"}${(Math.abs(d) * 100).toFixed(0)} pts</span>`;
      };
      return `
        <section class="intro"><h1>Compare two configurations</h1>
          <p>Edit either side. Both run on the same ${ea.n}-case evaluation set and the results update instantly.</p></section>
        <div class="cmp-grid">
          <div class="panel"><h3 class="side">A</h3>${configEditor(state.cmp[0], "0")}</div>
          <div class="panel"><h3 class="side">B</h3>${configEditor(state.cmp[1], "1")}</div>
        </div>
        <div class="panel">
          <table class="grid cmp-table"><thead><tr><th>Metric</th><th>A · ${esc(state.cmp[0].name)}</th><th>B · ${esc(state.cmp[1].name)}</th><th>B vs A</th></tr></thead><tbody>
          ${rows.map(([n, k, better]) => `<tr><td>${n}</td><td class="num"><div class="bar"><i style="width:${ea[k] * 100}%"></i></div>${pct(ea[k])}</td><td class="num"><div class="bar b"><i style="width:${eb[k] * 100}%"></i></div>${pct(eb[k])}</td><td>${delta(k, better)}</td></tr>`).join("")}
          </tbody></table>
        </div>
        <div class="panel">
          <h3>Where they disagree (${diffs.length})</h3>
          ${diffs.length ? `<table class="grid clickable"><thead><tr><th>Txn</th><th>Merchant · memo</th><th>Expected</th><th>A</th><th>B</th><th>Right</th></tr></thead><tbody>
          ${diffs.map(({ a, b }) => { const t = idx.tx[a.txn_id]; const who = a.correct && !b.correct ? "A" : b.correct && !a.correct ? "B" : "Neither"; return `<tr data-sbs="${a.txn_id}"><td>${a.txn_id}</td><td>${esc(idx.merchant[t.merchant_id].name)}<div class="muted small">${esc(t.memo)}</div></td><td>${badge(a.label)}</td><td>${badge(a.predicted)}</td><td>${badge(b.predicted)}</td><td><b class="who ${who}">${who}</b></td></tr>`; }).join("")}
          </tbody></table><p class="muted small">Click a row to see both traces side by side.</p>` : `<div class="empty">The two configurations make identical decisions on every case.</div>`}
        </div>`;
    },
    records() {
      const tabs = { transactions: "Transactions", trips: "Trips", receipts: "Receipts", policy: "Policy", approved_vendors: "Approved vendors", merchants: "Merchants", employees: "Employees" };
      const kindOf = { transactions: "transaction", trips: "trip", receipts: "receipt", policy: "policy", approved_vendors: "vendor", merchants: "merchant", employees: "employee" };
      const rows = idx.seed[state.recordsTab];
      const cols = Object.keys(rows[0]).filter((k) => !["items", "params"].includes(k));
      const kind = kindOf[state.recordsTab];
      return `
        <section class="intro"><h1>Source records</h1><p>The full synthetic dataset generated by <code>seed/seed.py</code> (RNG seed ${idx.seed.meta.rng_seed}). ${esc(idx.seed.company.note)}</p></section>
        <div class="subtabs">${Object.entries(tabs).map(([k, v]) => `<button class="btn ${k === state.recordsTab ? "primary" : "ghost"}" data-rtab="${k}">${v} (${idx.seed[k].length})</button>`).join("")}</div>
        <div class="panel scroll-x"><table class="grid clickable"><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>
          ${rows.map((r) => `<tr data-rec="${esc(kind)}|${esc(kind === "vendor" ? r.merchant_id : r.id)}">${cols.map((c) => `<td class="${c === "amount" || c === "total" ? "num" : ""}">${esc(c === "amount" || c === "total" ? A.fmt(r[c]) : r[c] ?? "—")}</td>`).join("")}</tr>`).join("")}
        </tbody></table></div>`;
    },
    about() {
      return `
        <section class="intro"><h1>About this demo</h1></section>
        <div class="panel prose">
          <p><b>Unofficial demo built with Devin - synthetic data.</b> Not affiliated with or endorsed by Ramp. It prototypes the kind of agent a Forward Deployed Engineer might build with a finance team: reviewing card spend in the transaction flow, explaining every decision, and measuring quality before rollout.</p>
          <h3>Five-minute walkthrough</h3>
          <ol>
            <li><b>Review</b> — select <i>Team dinner after release</i> and run the agent with <i>Baseline</i>, then with <i>Context-aware</i>. Note how reading the memo changes the per-person math.</li>
            <li><b>Trace</b> — click any citation chip (policy clause, transaction field, trip, receipt) to open the exact source record; used fields are highlighted.</li>
            <li><b>Evaluate</b> — run the ${idx.seed.eval_set.length}-case labeled set; inspect the confusion matrix and toggle “misses only”.</li>
            <li><b>Compare</b> — put two configurations side by side (try adding a 5% tolerance) and open a disagreement to see both traces.</li>
          </ol>
          <h3>How it works</h3>
          <ul>
            <li>The agent is a deterministic reasoning pipeline in <code>app/agent.js</code>: classify → read memo → apply policy clauses → check context (trips, vendor list, duplicates) → decide. It calls no external model or API, so results are reproducible and free to run.</li>
            <li>All data is fictional and generated by <code>seed/seed.py</code>: ${idx.seed.transactions.length} transactions, ${idx.seed.trips.length} trips, ${idx.seed.receipts.length} receipts, ${idx.seed.policy.length} policy clauses for the made-up company ${esc(idx.seed.company.name)}.</li>
            <li>The app is static (HTML/CSS/JS). No login, no backend, no tracking.</li>
          </ul>
        </div>`;
    },
  };
  const metric = (n, v, s) => `<div class="metric"><div class="m-label">${n}</div><div class="m-value">${v}</div><div class="m-sub muted small">${s}</div></div>`;

  function bind(route) {
    const view = $("#view");
    if (route === "review") {
      view.querySelectorAll("[data-tx]").forEach((li) => li.addEventListener("click", () => { state.selected = li.dataset.tx; state.lastResult = null; render(); }));
      $("#search").addEventListener("input", (e) => { state.search = e.target.value; render(); const s = $("#search"); s.focus(); s.setSelectionRange(s.value.length, s.value.length); });
      $("#cat").addEventListener("change", (e) => { state.filter = e.target.value; render(); });
      $("#rev-preset").addEventListener("change", (e) => { state.reviewConfig = preset(e.target.value); state.lastResult = null; render(); });
      $("#run").addEventListener("click", () => { state.lastResult = A.review(state.selected, state.reviewConfig, idx); state.animate = true; render(); state.animate = false; });
    }
    if (route === "evaluate") {
      bindConfig(view, () => state.evalConfig, (_, c) => { state.evalConfig = c; state.evalResult = null; }, render);
      $("#run-eval").addEventListener("click", () => { state.evalResult = A.evaluate(state.evalConfig, idx); render(); });
      const om = $("#only-miss"); if (om) om.addEventListener("change", (e) => { state.evalOnlyMisses = e.target.checked; render(); });
      view.querySelectorAll("[data-trace]").forEach((tr) => tr.addEventListener("click", () => openTrace(tr.dataset.trace, state.evalConfig)));
    }
    if (route === "compare") {
      bindConfig(view, (k) => state.cmp[k], (k, c) => { state.cmp[k] = c; }, render);
      view.querySelectorAll("[data-sbs]").forEach((tr) => tr.addEventListener("click", () => openSideBySide(tr.dataset.sbs)));
    }
    if (route === "records") {
      view.querySelectorAll("[data-rtab]").forEach((b) => b.addEventListener("click", () => { state.recordsTab = b.dataset.rtab; render(); }));
      view.querySelectorAll("[data-rec]").forEach((tr) => tr.addEventListener("click", () => { const [k, id] = tr.dataset.rec.split("|"); openRecord(k, id, []); }));
    }
  }

  function currentRoute() {
    const r = (location.hash.replace(/^#\/?/, "") || "review").split("?")[0];
    return views[r] ? r : "review";
  }
  function render() {
    const route = currentRoute();
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
    const scrollY = window.scrollY;
    $("#view").innerHTML = views[route]();
    bind(route);
    window.scrollTo(0, scrollY);
  }
  window.addEventListener("hashchange", () => { closeDrawer(); render(); window.scrollTo(0, 0); });
  render();
})();
