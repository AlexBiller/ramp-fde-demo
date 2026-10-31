// Policy Review Agent: a deterministic, explainable reasoning pipeline that
// reviews card transactions against an expense policy. No external model or
// API is called; every conclusion cites the source records it used.
(function (root) {
  "use strict";

  const PRESETS = [
    {
      id: "baseline",
      name: "Baseline: card data only",
      description: "Amount, merchant category and receipt presence. No memo parsing, trip context, vendor list or duplicate scan.",
      use_memo: false, use_trips: false, use_vendor_list: false, detect_duplicates: false,
      tolerance_pct: 0, reject_prohibited: true,
    },
    {
      id: "context",
      name: "Context-aware agent",
      description: "Adds memo understanding (attendees, customers, IT requests), trip context, the approved vendor list and duplicate detection.",
      use_memo: true, use_trips: true, use_vendor_list: true, detect_duplicates: true,
      tolerance_pct: 0, reject_prohibited: true,
    },
    {
      id: "context_tolerant",
      name: "Context-aware + 5% tolerance",
      description: "Same as context-aware, but auto-approves amounts up to 5% over a cap.",
      use_memo: true, use_trips: true, use_vendor_list: true, detect_duplicates: true,
      tolerance_pct: 5, reject_prohibited: true,
    },
  ];

  const TOGGLES = [
    ["use_memo", "Read memos (attendees, customer, IT request, personal)"],
    ["use_trips", "Use trip records (city, nights, linkage)"],
    ["use_vendor_list", "Check approved vendor list"],
    ["detect_duplicates", "Scan for duplicate charges"],
    ["reject_prohibited", "Auto-reject prohibited spend (else flag)"],
  ];

  function indexData(seed) {
    const by = (arr) => Object.fromEntries(arr.map((r) => [r.id, r]));
    return {
      seed,
      tx: by(seed.transactions),
      emp: by(seed.employees),
      merchant: by(seed.merchants),
      trip: by(seed.trips),
      receipt: by(seed.receipts),
      policy: by(seed.policy),
      vendors: Object.fromEntries(seed.approved_vendors.map((v) => [v.merchant_id, v])),
    };
  }

  const fmt = (n) => "$" + Number(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function parseMemo(memo) {
    const m = memo || "";
    const out = {};
    const att = m.match(/(\d+)\s*(attendees|people|guests|ppl)\b/i);
    if (att) out.attendees = parseInt(att[1], 10);
    const cust = m.match(/customer:\s*([A-Z][\w&.' -]*?)\s*(?=[(,;]|$)/i);
    if (cust) out.customer = cust[1].trim();
    if (/\bclient|prospect|customer\b/i.test(m)) out.mentionsClient = true;
    if (/\b(team|w\/|with)\b/i.test(m) && !out.attendees) out.groupWithoutCount = true;
    const it = m.match(/\bIT-\d{4}\b/);
    if (it) out.itRequest = it[0];
    if (/\b(personal|will repay|my own)\b/i.test(m)) out.personal = true;
    if (/\b(business|first)[ -]class|upgrade/i.test(m)) out.premiumCabin = true;
    return out;
  }

  // A finding is one reasoning step: { status, clause, title, detail, citations[] }
  // status: "pass" | "flag" | "reject" | "info"; citations: { kind, id, fields[] }
  function review(txId, config, idx) {
    const t = idx.tx[txId];
    const merchant = idx.merchant[t.merchant_id];
    const employee = idx.emp[t.employee_id];
    const receipt = t.receipt_id ? idx.receipt[t.receipt_id] : null;
    const trip = t.trip_id ? idx.trip[t.trip_id] : null;
    const tol = 1 + (config.tolerance_pct || 0) / 100;
    const memo = config.use_memo ? parseMemo(t.memo) : {};
    const findings = [];
    const assumptions = [];
    const P = (id) => idx.policy[id];
    const txc = (...fields) => ({ kind: "transaction", id: t.id, fields });
    const mc = (...fields) => ({ kind: "merchant", id: merchant.id, fields });
    const pc = (id) => ({ kind: "policy", id });
    const add = (status, clause, title, detail, citations) => findings.push({ status, clause, title, detail, citations });
    const overCap = (value, cap) => value > cap * tol + 1e-9;
    const capText = (cap) => config.tolerance_pct ? `${fmt(cap)} (+${config.tolerance_pct}% tolerance = ${fmt(cap * tol)})` : fmt(cap);

    add("info", null, "Classified transaction",
      `${merchant.name} → category "${merchant.category}" (MCC ${merchant.mcc}); ${fmt(t.amount)} by ${employee.name}, ${employee.department}.`,
      [txc("merchant_id", "amount", "employee_id"), mc("category", "mcc"), { kind: "employee", id: employee.id, fields: ["department"] }]);

    if (config.use_memo && t.memo) {
      const bits = [];
      if (memo.attendees) bits.push(`${memo.attendees} attendees`);
      if (memo.customer) bits.push(`customer "${memo.customer}"`);
      if (memo.itRequest) bits.push(`IT request ${memo.itRequest}`);
      if (memo.personal) bits.push("personal expense language");
      if (memo.premiumCabin) bits.push("premium cabin");
      add("info", null, "Read memo", bits.length ? `Extracted: ${bits.join(", ")}.` : "No policy-relevant entities in memo.", [txc("memo")]);
    }

    // Prohibited spend
    const prohibitedStatus = config.reject_prohibited ? "reject" : "flag";
    if (merchant.category === "gift_cards") {
      add(prohibitedStatus, "POL-7", "Prohibited: gift card", "Gift cards are cash equivalents and are not reimbursable.", [mc("category"), pc("POL-7")]);
    }
    if (memo.personal) {
      add(prohibitedStatus, "POL-7", "Prohibited: personal expense", `Memo indicates a personal purchase: "${t.memo}".`, [txc("memo"), pc("POL-7")]);
    }

    // Receipts
    const rcap = P("POL-6").params.threshold;
    if (t.amount >= rcap) {
      if (receipt) add("pass", "POL-6", "Receipt on file", `${receipt.id} uploaded ${receipt.uploaded}, total ${fmt(receipt.total)}.`, [txc("receipt_id"), { kind: "receipt", id: receipt.id, fields: ["total", "uploaded"] }, pc("POL-6")]);
      else add("flag", "POL-6", "Missing receipt", `${fmt(t.amount)} is at or above the ${fmt(rcap)} receipt threshold and no receipt is attached.`, [txc("amount", "receipt_id"), pc("POL-6")]);
    }

    // Category-specific checks
    const cat = merchant.category;
    if (cat === "meals" || cat === "bar") {
      const isClient = !!memo.customer;
      if (cat === "bar" && !isClient) {
        add(prohibitedStatus === "reject" ? "reject" : "flag", "POL-2", "Alcohol outside client entertainment",
          config.use_memo ? "Bar/alcohol merchant and the memo names no customer organization." : "Bar/alcohol merchant; memo not read, so no client context is available.",
          [mc("category", "mcc"), config.use_memo ? txc("memo") : txc("merchant_id"), pc("POL-2")]);
      } else {
        let n = memo.attendees || 1;
        if (!memo.attendees) assumptions.push(config.use_memo ? "Attendee count not stated; assumed 1." : "Memo not read; assumed 1 attendee.");
        if (memo.groupWithoutCount) add("info", "POL-1", "Group meal without attendee count", "Memo suggests a group but does not state how many attended, so the per-person limit is applied to 1 person.", [txc("memo"), pc("POL-1")]);
        if (memo.mentionsClient && !isClient) add("info", "POL-2", "Client mentioned but not named", "Client entertainment requires \"Customer: <name>\"; falling back to the standard meal cap.", [txc("memo"), pc("POL-2")]);
        const clause = isClient ? "POL-2" : "POL-1";
        const cap = P(clause).params.per_person_cap;
        const pp = t.amount / n;
        const cites = [txc("amount", ...(config.use_memo ? ["memo"] : [])), pc(clause)];
        if (overCap(pp, cap)) add("flag", clause, "Over per-person cap", `${fmt(t.amount)} ÷ ${n} = ${fmt(pp)} per person, above ${capText(cap)}.`, cites);
        else add("pass", clause, "Within per-person cap", `${fmt(t.amount)} ÷ ${n} = ${fmt(pp)} per person, within ${capText(cap)}${isClient ? ` for client entertainment with ${memo.customer}` : ""}.`, cites);
      }
    }

    if (cat === "airfare") {
      const cap = P("POL-3").params.cap;
      if (overCap(t.amount, cap)) add("flag", "POL-3", "Fare over cap", `${fmt(t.amount)} exceeds ${capText(cap)}.`, [txc("amount"), pc("POL-3")]);
      else add("pass", "POL-3", "Fare within cap", `${fmt(t.amount)} is within ${capText(cap)}.`, [txc("amount"), pc("POL-3")]);
      if (memo.premiumCabin) add("flag", "POL-3", "Premium cabin", "Memo indicates business/first class or an upgrade; policy allows economy only.", [txc("memo"), pc("POL-3")]);
      if (config.use_trips) {
        if (trip) add("pass", "POL-3", "Linked to approved trip", `${trip.id}: ${trip.city}, ${trip.start} → ${trip.end} (${trip.purpose}).`, [txc("trip_id"), { kind: "trip", id: trip.id, fields: ["city", "status", "purpose"] }, pc("POL-3")]);
        else add("flag", "POL-3", "No approved trip", "Airfare is not linked to any approved trip.", [txc("trip_id"), pc("POL-3")]);
      }
    }

    if (cat === "lodging") {
      const pol = P("POL-4").params;
      let nights = 1, city = null;
      if (config.use_trips && trip) { nights = trip.nights; city = trip.city; }
      else assumptions.push(config.use_trips ? "No trip on file; assumed 1 night, standard city." : "Trip records not used; assumed 1 night, standard city.");
      const highCost = city && pol.high_cost_cities.includes(city);
      const cap = highCost ? pol.high_cost_nightly_cap : pol.nightly_cap;
      const nightly = t.amount / nights;
      const cites = [txc("amount"), ...(config.use_trips && trip ? [{ kind: "trip", id: trip.id, fields: ["city", "nights"] }] : []), pc("POL-4")];
      const where = city ? `${city}${highCost ? " (high-cost city)" : ""}` : "unknown city";
      if (overCap(nightly, cap)) add("flag", "POL-4", "Nightly rate over cap", `${fmt(t.amount)} ÷ ${nights} night(s) = ${fmt(nightly)}/night in ${where}, above ${capText(cap)}.`, cites);
      else add("pass", "POL-4", "Nightly rate within cap", `${fmt(t.amount)} ÷ ${nights} night(s) = ${fmt(nightly)}/night in ${where}, within ${capText(cap)}.`, cites);
      if (config.use_trips && !trip) add("flag", "POL-4", "No approved trip", "Lodging is not linked to any approved trip.", [txc("trip_id"), pc("POL-4")]);
    }

    if (cat === "software") {
      if (!config.use_vendor_list) {
        add("info", "POL-5", "Vendor list not checked", "This configuration does not consult the approved vendor list.", [pc("POL-5")]);
      } else if (idx.vendors[merchant.id]) {
        const v = idx.vendors[merchant.id];
        add("pass", "POL-5", "Approved vendor", `${merchant.name} approved ${v.approved_on} (owner: ${v.owner}, ${v.contract}).`, [{ kind: "vendor", id: merchant.id, fields: ["approved_on", "owner"] }, pc("POL-5")]);
      } else if (memo.itRequest) {
        add("pass", "POL-5", "Approved IT request", `Not on the vendor list, but memo references ${memo.itRequest}.`, [txc("memo"), pc("POL-5")]);
      } else {
        add("flag", "POL-5", "Unapproved software vendor", `${merchant.name} is not on the approved vendor list and no IT request is referenced.`, [mc("name"), ...(config.use_memo ? [txc("memo")] : []), pc("POL-5")]);
      }
    }

    // Duplicates
    if (config.detect_duplicates) {
      const win = P("POL-8").params.window_days;
      const day = (s) => Date.parse(s + "T00:00:00Z") / 86400000;
      const prior = idx.seed.transactions.find((o) => o.id !== t.id && o.employee_id === t.employee_id &&
        o.merchant_id === t.merchant_id && Math.abs(o.amount - t.amount) < 0.005 &&
        Math.abs(day(o.date) - day(t.date)) <= win && (o.date < t.date || (o.date === t.date && o.id < t.id)));
      if (prior) add("flag", "POL-8", "Possible duplicate", `Same cardholder, merchant and amount as ${prior.id} on ${prior.date}.`, [txc("amount", "date", "merchant_id"), { kind: "transaction", id: prior.id, fields: ["amount", "date", "merchant_id"] }, pc("POL-8")]);
    }

    const has = (s) => findings.some((f) => f.status === s);
    const decision = has("reject") ? "reject" : has("flag") ? "flag" : "approve";
    const confidence = Math.max(0.5, 0.96 - 0.14 * assumptions.length - (findings.some((f) => f.status === "info" && f.clause) ? 0.08 : 0));
    const decisive = findings.filter((f) => f.status === decision || (decision === "approve" && f.status === "pass"));
    const summary = decision === "approve"
      ? (decisive.length ? `Approve: ${decisive.map((f) => f.title.toLowerCase()).join("; ")}.` : "Approve: no policy checks apply.")
      : `${decision === "reject" ? "Reject" : "Flag for review"}: ${decisive.map((f) => f.title.toLowerCase()).join("; ")}.`;

    const sources = {};
    for (const f of findings) for (const c of f.citations) sources[c.kind + ":" + c.id] = c;
    return { txn_id: t.id, decision, confidence: Math.round(confidence * 100) / 100, summary, findings, assumptions, sources: Object.values(sources), config_id: config.id };
  }

  function evaluate(config, idx) {
    const labels = ["approve", "flag", "reject"];
    const matrix = Object.fromEntries(labels.map((a) => [a, Object.fromEntries(labels.map((b) => [b, 0]))]));
    const cases = idx.seed.eval_set.map((c) => {
      const r = review(c.txn_id, config, idx);
      matrix[c.label][r.decision]++;
      return { ...c, predicted: r.decision, correct: r.decision === c.label, confidence: r.confidence, result: r };
    });
    const n = cases.length;
    const correct = cases.filter((c) => c.correct).length;
    const isViol = (d) => d !== "approve";
    const tp = cases.filter((c) => isViol(c.label) && isViol(c.predicted)).length;
    const fn = cases.filter((c) => isViol(c.label) && !isViol(c.predicted)).length;
    const fp = cases.filter((c) => !isViol(c.label) && isViol(c.predicted)).length;
    const tn = cases.filter((c) => !isViol(c.label) && !isViol(c.predicted)).length;
    return {
      config, cases, matrix, n, correct,
      accuracy: correct / n,
      violation_recall: tp / (tp + fn || 1),
      violation_precision: tp / (tp + fp || 1),
      false_flag_rate: fp / (fp + tn || 1),
      auto_approved: cases.filter((c) => c.predicted === "approve").length / n,
      tp, fn, fp, tn,
    };
  }

  const api = { PRESETS, TOGGLES, indexData, parseMemo, review, evaluate, fmt };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Agent = api;
})(typeof window !== "undefined" ? window : globalThis);
