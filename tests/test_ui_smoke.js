// UI tests without a browser. js/app.js runs against a small DOM stub. Animations are stubbed so
// that each one finishes when the test driver runs the next queued timer, which exercises the
// same asynchronous flow as a real browser. Run with:  node tests/test_ui_smoke.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const REDUCED = process.argv.includes("--reduced-check");

// ---- DOM stub ----------------------------------------------------------------------------
const animations = [];           // every animation requested: { frames, opts }
class El {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {};
    this.classSet = new Set(); this.handlers = {}; this._text = ""; this._html = "";
    this.disabled = false; this.hidden = false; this.value = ""; this.checked = false;
    this.scrollTop = 0; this.scrollHeight = 0; this.offsetWidth = 0; this.offsetHeight = 0;
  }
  get className() { return [...this.classSet].join(" "); }
  set className(v) { this.classSet = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this.classSet;
    return { add: c => s.add(c), remove: c => s.delete(c), contains: c => s.has(c) };
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  set innerHTML(v) { this._html = String(v); this.children = []; this._text = ""; }
  appendChild(c) { this.children.push(c); return c; }
  addEventListener(type, fn) { this.handlers[type] = fn; }
  click() { if (!this.disabled && this.handlers.click) this.handlers.click({ target: this }); }
  animate(frames, opts) {
    animations.push({ frames, opts: opts || {} });
    const d = (opts && opts.duration) || 0;
    return { finished: new Promise(res => setTimeout(res, d)), cancel() {} };
  }
}
const byId = {};
const el = id => (byId[id] = byId[id] || new El("div"));
function mk(v, checked) { const r = new El("input"); r.value = v; r.checked = checked; return r; }
const radios = { kind: [mk("1", true), mk("2", false)], first: [mk("0", true), mk("1", false)] };
const document = {
  getElementById: el,
  createElement: t => new El(t),
  createTextNode: t => { const n = new El("#text"); n.textContent = t; return n; },
  querySelectorAll: sel => sel.includes('"kind"') ? radios.kind : sel.includes('"first"') ? radios.first : [],
  querySelector: sel => sel.includes('"first"') ? radios.first.find(r => r.checked) : null,
};
let timers = [], nextId = 1;
global.setTimeout = (fn, ms) => { const id = nextId++; timers.push({ id, fn }); return id; };
global.clearTimeout = id => { timers = timers.filter(t => t.id !== id); };
global.document = document;
global.window = global;
window.matchMedia = () => ({ matches: REDUCED });
el("speed").value = "250";

require("../js/engine.js");
require("../js/app.js");

// ---- driver ------------------------------------------------------------------------------
const cells = () => el("board").children;
const cellsWith = cls => cells().filter(c => c.classList.contains(cls));
const turnText = () => el("turn-line").textContent;
const phaseText = () => el("phase-badge").textContent;
const flush = async () => { for (let i = 0; i < 40; i++) await null; };
const humanReady = () => !phaseText().includes("Game over") && turnText() === "Your turn" && cells().some(c => !c.disabled);

// Runs queued timers (AI pauses and animation ends) until it is the human's turn again.
async function waitHuman() {
  for (let guard = 0; guard < 200000; guard++) {
    await flush();
    if (phaseText().includes("Game over")) {
      // let the last animation and the result message finish
      while (timers.length) { const t = timers.shift(); t.fn(); await flush(); }
      return false;
    }
    if (humanReady()) return true;
    const t = timers.shift();
    if (!t) throw new Error("stuck: no pending work, turn text is '" + turnText() + "'");
    t.fn();
  }
  throw new Error("too many steps");
}

// variant changes the human's choices (square order, when to start Phase 2) so that games differ
async function playGame(humanFirst, variant = 0) {
  radios.first.forEach(r => (r.checked = r.value === (humanFirst ? "0" : "1")));
  el("btn-new").click();
  await flush();
  let steps = 0;
  for (;;) {
    if (!(await waitHuman())) break;
    if (++steps > 2000) throw new Error("game did not finish");
    if (phaseText().includes("Phase 1")) {
      const startNow = !el("btn-start2").disabled && (variant % 3 === 0 || steps % 4 === 0);
      if (startNow) el("btn-start2").click();
      else if (!el("btn-pass").disabled) el("btn-pass").click();
      else {
        const legal = cellsWith("legal");
        assert.ok(legal.length, "no legal placement shown");
        (variant % 2 ? legal[legal.length - 1] : legal[0]).click();
      }
    } else if (phaseText().includes("Phase 2")) {
      if (!el("btn-start3").disabled && steps % 3 === 0) { el("btn-start3").click(); await flush(); continue; }
      const att = cellsWith("capturable");
      assert.ok(att.length, "no capturable piece shown");
      att[variant % att.length].click();
      const tgt = cellsWith("target");
      assert.ok(tgt.length, "no target shown after choosing an attacker");
      tgt[variant % tgt.length].click();
    } else if (phaseText().includes("Phase 3")) {
      const r = cellsWith("removable")[0];
      assert.ok(r, "no removable piece shown");
      r.click();
    }
    await flush();
  }
  return el("message").textContent;
}

// ---- tests -------------------------------------------------------------------------------
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("the page has the chess-piece symbols and the legend (static check of index.html)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  assert.ok(html.includes('id="sym-queen"') && html.includes('id="sym-knight"'));
  assert.ok(html.includes('id="legend"') && html.includes("Queen = 2 points") && html.includes("Knight = 1 point"));
  for (const id of ["phase-badge", "turn-line", "board", "message", "btn-start2", "btn-pass", "btn-start3",
                    "btn-cancel", "score-you", "score-ai", "speed", "btn-new", "log", "piece-picker", "board-wrap"]) {
    assert.ok(html.includes('id="' + id + '"'), "missing id " + id);
  }
});

test("a new game builds 36 cells once and shows the start state", async () => {
  el("btn-new").click();
  await flush();
  assert.strictEqual(cells().length, 36);
  assert.strictEqual(phaseText(), "Phase 1 · Placement");
});

test("a placement is animated, and the board is locked while it runs (no duplicate moves)", async () => {
  radios.first[0].checked = true; radios.first[1].checked = false;
  el("btn-new").click();
  await flush();
  animations.length = 0;
  cells()[0].click();                          // human places a Queen
  assert.ok(cells().every(c => c.disabled), "board must be locked during the animation");
  cells()[1].click();                          // a second click while busy must do nothing
  assert.ok(cells().every(c => c.disabled));
  assert.ok(animations.some(a => a.frames.some(f => /scale\(\.6\)/.test(f.transform || ""))), "placement animation");
  await waitHuman();                           // AI replies and the board unlocks again
  assert.strictEqual(cells()[0].dataset.kind, "1", "the Queen stays on its square");
});

test("a new game started during an animation cancels it cleanly", async () => {
  radios.first.forEach(r => (r.checked = r.value === "0"));
  el("btn-new").click();
  await flush();
  cells()[7].click();                          // a placement starts animating
  el("btn-new").click();                       // ...and a new game starts before it finishes
  await flush();
  for (let g = 0; g < 2000 && timers.length; g++) { const t = timers.shift(); t.fn(); await flush(); }
  assert.strictEqual(el("score-you").textContent, "0");
  assert.strictEqual(el("score-ai").textContent, "0");
  assert.strictEqual(el("log").children.length, 0, "stale callbacks must not write to the log");
  assert.ok(cells().every(c => c.dataset.kind === "0"), "the new board must be empty");
});

test("capture and removal animations are used in full games (both seats)", async () => {
  animations.length = 0;
  for (let g = 0; g < 6; g++) await playGame(g % 2 === 0, g);
  const hasCapture = animations.some(a => a.frames.some(f => /translate/.test(f.transform || "")));
  const hasRemove = animations.some(a => a.frames.some(f => f.transform === "scale(.15)"));
  const hasPlace = animations.some(a => a.frames.some(f => f.transform === "scale(.6)"));
  assert.ok(hasPlace, "placement animation was not used");
  assert.ok(hasCapture, "attacker slide animation was not used");
  assert.ok(hasRemove, "removal animation was not used");
});

test("all four capture combinations and both removal types are played and animated", async () => {
  const seen = new Set();
  const logTexts = () => el("log").children.map(c => c.textContent);
  for (let g = 0; g < 60 && seen.size < 6; g++) {
    animations.length = 0;
    await playGame(g % 2 === 0, g);
    for (const t of logTexts()) {
      const cap = t.match(/with a (Queen|Knight) .*taking a (Queen|Knight)/);
      if (cap) seen.add("capture " + cap[1] + " takes " + cap[2]);
      const rem = t.match(/removes a (Queen|Knight)/);
      if (rem) seen.add("remove " + rem[1]);
    }
  }
  for (const want of ["capture Queen takes Queen", "capture Queen takes Knight", "capture Knight takes Queen",
                      "capture Knight takes Knight", "remove Queen", "remove Knight"]) {
    assert.ok(seen.has(want), "not played in 60 games: " + want + " (seen: " + [...seen].join(", ") + ")");
  }
});

test("10 complete games, both seats, end with a result and no exception", async () => {
  for (let g = 0; g < 10; g++) {
    const msg = await playGame(g % 2 === 0, g);
    assert.ok(/win|draw/.test(msg), "final message: " + msg);
  }
});

test("reduced motion: no animations are requested and the game still plays", async () => {
  if (!REDUCED) return;                       // run in the child process below
  animations.length = 0;
  radios.first.forEach(r => (r.checked = r.value === "0"));
  el("btn-new").click();
  await flush();
  cells()[0].click();
  await waitHuman();
  assert.strictEqual(animations.length, 0, "no animation should run");
  assert.strictEqual(cells()[0].dataset.kind, "1");
});

let passed = 0, total = 0;
(async () => {
  if (REDUCED) {
    try { await tests.find(([n]) => n.startsWith("reduced"))[1](); console.log("PASS reduced motion"); process.exitCode = 0; }
    catch (e) { console.log("FAIL reduced motion\n     " + e.message); process.exitCode = 1; }
    return;
  }
  for (const [name, fn] of tests) {
    total++;
    try { await fn(); console.log("PASS " + name); passed++; }
    catch (e) { console.log("FAIL " + name + "\n     " + e.message); }
  }
  // reduced motion runs in a separate process, because matchMedia is read when app.js loads
  const r = spawnSync(process.execPath, [__filename, "--reduced-check"], { env: process.env, encoding: "utf8" });
  total++;
  if (r.status === 0) { console.log("PASS reduced motion (separate process)"); passed++; }
  else console.log("FAIL reduced motion (separate process)\n     " + (r.stdout + r.stderr).trim());
  console.log("\n" + passed + "/" + total + " UI tests passed");
  process.exitCode = passed === total ? 0 : 1;
})();
