import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync, readdirSync } from "node:fs";

const require = createRequire(import.meta.url);
const A = require("../app/agent.js");
const seed = require("../data/seed.json");
const idx = A.indexData(seed);
const preset = (id) => A.PRESETS.find((p) => p.id === id);

test("seed data is consistent", () => {
  for (const t of seed.transactions) {
    assert.ok(idx.merchant[t.merchant_id], t.id);
    assert.ok(idx.emp[t.employee_id], t.id);
    if (t.receipt_id) assert.equal(idx.receipt[t.receipt_id].txn_id, t.id);
    if (t.trip_id) assert.ok(idx.trip[t.trip_id], t.id);
  }
  for (const e of seed.eval_set) assert.ok(idx.tx[e.txn_id]);
});

test("every citation resolves to a real source record", () => {
  const kinds = { transaction: idx.tx, merchant: idx.merchant, employee: idx.emp, trip: idx.trip, receipt: idx.receipt, policy: idx.policy, vendor: idx.vendors };
  for (const p of A.PRESETS) for (const t of seed.transactions) {
    const r = A.review(t.id, p, idx);
    for (const f of r.findings) for (const c of f.citations) {
      const rec = kinds[c.kind][c.id];
      assert.ok(rec, `${c.kind}:${c.id}`);
      for (const field of c.fields || []) assert.ok(field in rec, `${c.kind}:${c.id}.${field}`);
    }
    if (r.decision !== "approve") assert.ok(r.findings.some((f) => f.status === r.decision && f.clause));
  }
});

test("context-aware config beats baseline on the eval set", () => {
  const base = A.evaluate(preset("baseline"), idx);
  const ctx = A.evaluate(preset("context"), idx);
  assert.ok(ctx.accuracy > base.accuracy);
  assert.equal(ctx.violation_recall, 1);
});

test("memo parsing", () => {
  assert.deepEqual(A.parseMemo("Client dinner - Customer: Halcyon Freight (4 attendees)").customer, "Halcyon Freight");
  assert.equal(A.parseMemo("Team dinner after release, 6 attendees").attendees, 6);
  assert.equal(A.parseMemo("Pilot seats, approved in IT-4821").itRequest, "IT-4821");
});

test("disclaimer banner is on every page", () => {
  const pages = readdirSync(new URL("..", import.meta.url)).filter((f) => f.endsWith(".html"));
  assert.ok(pages.length > 0);
  for (const p of pages) assert.match(readFileSync(new URL("../" + p, import.meta.url), "utf8"), /Unofficial demo built with Devin - synthetic data/);
});
