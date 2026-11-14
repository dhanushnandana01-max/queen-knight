// Run with:  node tests/test_engine.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const QK = require("../js/engine.js");

const FIX = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures.json"), "utf8"));
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("rules match the Python reference on 400 positions (placements, captures, phase rules)", () => {
  for (const p of FIX.positions) {
    assert.deepStrictEqual(QK.legalPlacements(p.board), p.legal);
    assert.deepStrictEqual(QK.captures(p.board), p.captures);
    assert.strictEqual(QK.phase2Ok(p.board), p.p2ok);
    assert.strictEqual(QK.pieces(p.board), p.pieces);
    assert.strictEqual(QK.finalDiff(p.board, p.scores, 0, 0), p.final_diff[0]);
    assert.strictEqual(QK.finalDiff(p.board, p.scores, 1, 0), p.final_diff[1]);
  }
});

test("alpha–beta search returns the same value and move as the Python reference (261 checks)", () => {
  for (const s of FIX.searches) {
    const r = QK.search(s.board, s.scores, s.turn, s.p3s, s.depth, -Infinity, Infinity, s.turn, s.width, true);
    assert.ok(Math.abs(r.v - s.value) < 1e-9, `value ${r.v} vs ${s.value} at depth ${s.depth}`);
    assert.deepStrictEqual(r.move, s.move);
  }
});

test("minimax and alpha–beta agree in the JavaScript port", () => {
  for (const s of FIX.searches.slice(0, 80)) {
    const a = QK.search(s.board, s.scores, s.turn, s.p3s, 3, -Infinity, Infinity, s.turn, 7, false);
    const b = QK.search(s.board, s.scores, s.turn, s.p3s, 3, -Infinity, Infinity, s.turn, 7, true);
    assert.ok(Math.abs(a.v - b.v) < 1e-9);
  }
});

test("the logged game (seed 2, AB-4 vs Greedy) replays to the same final score and winner", () => {
  const st = QK.newGame();
  for (const a of FIX.replay.actions) {
    assert.strictEqual(st.turn, a.player, "turn must match the logged player");
    let act;
    if (a.type === "place") act = { type: "place", kind: a.kind, cell: a.cell };
    else if (a.type === "capture") act = { type: "capture", a: a.a, t: a.t };
    else if (a.type === "remove") act = { type: "remove", cell: a.cell };
    else act = { type: a.type };
    QK.apply(st, act);
  }
  assert.ok(st.over);
  assert.deepStrictEqual(st.result.scores, FIX.replay.final_scores);
  assert.strictEqual(st.result.winner, FIX.replay.winner);
  assert.ok(st.board.every(x => x === 0));
});

test("placement rules: first Knight is free, later Knights need support, Queens may not see Queens", () => {
  const empty = new Array(36).fill(0);
  assert.strictEqual(QK.placementReason(empty, QK.K, 0), null);
  const withK = empty.slice(); withK[0] = QK.K;
  assert.ok(QK.placementReason(withK, QK.K, 35) !== null);      // unsupported later Knight
  assert.strictEqual(QK.placementReason(withK, QK.K, 8), null); // (1,2) is a knight move from (0,0)
  const withQ = empty.slice(); withQ[0] = QK.Q;
  assert.ok(QK.placementReason(withQ, QK.Q, 5) !== null);       // same row: sees the Queen
  assert.strictEqual(QK.placementReason(withQ, QK.Q, 20), null); // (3,2) is on no line from (0,0)
});

test("options: no Phase 2 start before n <= Q <= K, and a pass is only allowed when nothing can be placed", () => {
  const st = QK.newGame();
  const o = QK.options(st);
  assert.strictEqual(o.canStartPhase2, false);
  assert.strictEqual(o.canPass, false);
  assert.strictEqual(o.placements.length, 72);
});

test("illegal actions are rejected", () => {
  const st = QK.newGame();
  assert.throws(() => QK.apply(st, { type: "startP2" }));
  assert.throws(() => QK.apply(st, { type: "capture", a: 0, t: 1 }));
  assert.throws(() => QK.apply(st, { type: "place", kind: QK.Q, cell: 99 }));
});

test("random games from any policy always end, and a normal end leaves the board empty", () => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  let ends = { normal: 0, "stuck-P1": 0, "stuck-P2": 0 };
  for (let g = 0; g < 400; g++) {
    const st = QK.newGame();
    let guard = 0;
    while (!st.over) {
      if (++guard > 500) throw new Error("game did not terminate");
      const o = QK.options(st);
      let act;
      if (st.stage === "phase1") {
        const choices = [];
        if (o.canStartPhase2) choices.push({ type: "startP2" });
        if (o.canPass) choices.push({ type: "pass" });
        for (const [k, i] of o.placements) choices.push({ type: "place", kind: k, cell: i });
        act = pick(choices);
      } else if (st.stage === "phase2") {
        const choices = o.captures.map(([a, t]) => ({ type: "capture", a, t }));
        if (o.canStartPhase3) choices.push({ type: "startP3" });
        act = pick(choices);
      } else {
        act = { type: "remove", cell: pick(o.removable) };
      }
      QK.apply(st, act);
    }
    ends[st.result.reason]++;
    if (st.result.reason === "normal") assert.ok(st.board.every(x => x === 0));
    assert.strictEqual(st.result.winner === null, st.result.scores[0] === st.result.scores[1] || st.result.reason !== "normal");
  }
  assert.ok(ends.normal > 0);
});

test("AI against AI: 100 complete games, all legal, always terminates", () => {
  for (let g = 0; g < 100; g++) {
    const st = QK.newGame();
    let guard = 0;
    while (!st.over) {
      if (++guard > 500) throw new Error("AI game did not terminate");
      QK.apply(st, QK.aiAction(st));
    }
    assert.ok(st.result.reason === "normal" || st.result.reason === "stuck-P1" || st.result.reason === "stuck-P2");
  }
});

test("a capture moves the attacker onto the captured square (chess-like)", () => {
  const b = new Array(36).fill(0);
  b[0] = QK.K; b[8] = QK.Q; // Knight at (0,0) takes the Queen at (1,2)
  const st = QK.newGame();
  st.board = b.slice();
  st.stage = "phase2"; st.p2s = 0; st.p3s = 1; st.turn = 0;
  st.scores = [0, 0];
  QK.apply(st, { type: "capture", a: 0, t: 8 });
  assert.strictEqual(st.board[0], 0, "the square the Knight left is empty");
  assert.strictEqual(st.board[8], QK.K, "the Knight now stands on the captured square");
  assert.strictEqual(st.scores[0], 2, "Knight takes Queen = 2 points");
});

test("Phase 1 AI: a Queen whenever a Queen square exists, a Knight only when none is left", () => {
  for (const p of FIX.ai) {
    const choice = QK.queenFirstChoice(p.board, QK.legalPlacements(p.board));
    if (p.place === null) continue;
    assert.deepStrictEqual(choice, p.place);
    if (QK.legalPlacements(p.board).some(([k]) => k === QK.Q)) assert.strictEqual(choice[0], QK.Q);
  }
});

test("Phase 2 AI: the chosen capture or Phase 3 start matches the Python reference (depth 3, all captures)", () => {
  for (const p of FIX.ai) {
    if (p.phase2 === null) continue;
    const r = QK.aiPhase2Move(p.board, [0, 0], 0, 1);
    assert.deepStrictEqual(r, p.phase2);
  }
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log("PASS " + name);
    passed++;
  } catch (e) {
    console.log("FAIL " + name + "\n     " + e.message);
  }
}
console.log("\n" + passed + "/" + tests.length + " tests passed");
process.exitCode = passed === tests.length ? 0 : 1;
