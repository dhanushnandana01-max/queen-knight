/*
 * Queen × Knight: rules engine, alpha–beta search and AI policy (browser and Node).
 * Port of queen_knight_sim.py (engine_reference/). tests/ check it against that reference.
 */
(function (global) {
  "use strict";

  const N = 6, NN = 36;
  const E = 0, Q = 1, K = 2;
  const INF = Infinity;
  // true: the attacker moves onto the captured square (chess-like). false: the attacker stays.
  const ATTACKER_MOVES = true;
  const LEAF_WEIGHT = 0.35; // weight of the best immediate capture in the search cut-off
  const KSTEPS = [[-2, -1], [-2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2], [2, -1], [2, 1]];
  const QDIRS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];

  // PTS[attacker][target]: K×Q=2, Q×K=1, Q×Q=3, K×K=0
  const PTS = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  PTS[K][Q] = 2; PTS[Q][K] = 1; PTS[Q][Q] = 3; PTS[K][K] = 0;

  const KN = [], RAYS = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      const i = r * N + c;
      KN[i] = [];
      RAYS[i] = [];
      for (const [dr, dc] of KSTEPS) {
        const rr = r + dr, cc = c + dc;
        if (rr >= 0 && rr < N && cc >= 0 && cc < N) KN[i].push(rr * N + cc);
      }
      for (const [dr, dc] of QDIRS) {
        const ray = [];
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < N && cc >= 0 && cc < N) {
          ray.push(rr * N + cc);
          rr += dr;
          cc += dc;
        }
        if (ray.length) RAYS[i].push(ray);
      }
    }
  }

  // ------------------------------------------------------------ rules
  function count(board, v) {
    let n = 0;
    for (let i = 0; i < NN; i++) if (board[i] === v) n++;
    return n;
  }

  function pieces(board) {
    return NN - count(board, E);
  }

  function phase2Ok(board) {
    const q = count(board, Q), k = count(board, K);
    return N <= q && q <= k;
  }

  // A Queen may not see another Queen and may not stand one knight-move from a Knight.
  function queenOk(board, i) {
    for (const t of KN[i]) if (board[t] === K) return false;
    for (const ray of RAYS[i]) {
      for (const t of ray) {
        if (board[t]) {
          if (board[t] === Q) return false;
          break;
        }
      }
    }
    return true;
  }

  // A Knight may not attack a Queen. Every Knight after the first needs a Knight one knight-move away.
  function knightOk(board, i, hasK) {
    let sup = !hasK;
    for (const t of KN[i]) {
      const b = board[t];
      if (b === Q) return false;
      if (b === K) sup = true;
    }
    return sup;
  }

  function legalPlacements(board) {
    const acts = [];
    const hasK = count(board, K) > 0;
    for (let i = 0; i < NN; i++) {
      if (board[i]) continue;
      if (queenOk(board, i)) acts.push([Q, i]);
      if (knightOk(board, i, hasK)) acts.push([K, i]);
    }
    return acts;
  }

  // Why a placement is illegal (null when it is legal)
  function placementReason(board, kind, i) {
    if (board[i]) return "That square is already occupied.";
    const hasK = count(board, K) > 0;
    if (kind === Q) {
      if (KN[i].some(t => board[t] === K)) return "A Queen cannot stand one knight-move away from a Knight.";
      if (!queenOk(board, i)) return "This Queen would see another Queen along a row, column or diagonal.";
      return null;
    }
    if (KN[i].some(t => board[t] === Q)) return "A Knight may not attack a Queen.";
    if (!knightOk(board, i, hasK)) return "After the first Knight, each Knight needs another Knight one knight-move away.";
    return null;
  }

  function captures(board) {
    const acts = [];
    for (let i = 0; i < NN; i++) {
      const p = board[i];
      if (p === Q) {
        for (const ray of RAYS[i]) {
          for (const t of ray) {
            if (board[t]) {
              acts.push([i, t]);
              break;
            }
          }
        }
      } else if (p === K) {
        for (const t of KN[i]) if (board[t]) acts.push([i, t]);
      }
    }
    return acts;
  }

  // The board after a capture: the target is removed, and the attacker moves if ATTACKER_MOVES.
  function applyCapture(board, a, t) {
    const nb = board.slice();
    if (ATTACKER_MOVES) {
      nb[t] = nb[a];
      nb[a] = E;
    } else {
      nb[t] = E;
    }
    return nb;
  }

  // Exact Phase 3: alternating removals, Queens first, starter first
  function finalDiff(board, scores, first, root) {
    let q = count(board, Q), k = count(board, K);
    const s = scores.slice();
    let p = first;
    while (q || k) {
      if (q) { q--; s[p] += 2; } else { k--; s[p] += 1; }
      p = 1 - p;
    }
    return s[root] - s[1 - root];
  }

  // ------------------------------------------------------------ search
  // Depth-limited minimax (prune=false) or alpha–beta (prune=true). width = how many captures to
  // consider at each node, in descending order of points (Infinity = all of them).
  // Returns {v, move}; move: [attacker, target], "P3" (start Phase 3) or null.
  function search(board, scores, turn, p3s, depth, alpha, beta, root, width, prune) {
    const caps = captures(board);
    const p3ok = pieces(board) <= N;
    if (!caps.length) return { v: p3ok ? finalDiff(board, scores, turn, root) : 0, move: null };
    const maxing = turn === root;
    const can3 = p3ok && turn === p3s;
    const sv = can3 ? finalDiff(board, scores, turn, root) : null;
    if (depth === 0) {
      const diff = scores[root] - scores[1 - root];
      let best = -INF;
      for (const [a, t] of caps) best = Math.max(best, PTS[board[a]][board[t]]);
      let v = diff + (maxing ? LEAF_WEIGHT * best : -LEAF_WEIGHT * best);
      if (can3) v = maxing ? Math.max(v, sv) : Math.min(v, sv);
      return { v, move: null };
    }
    // stable sort, highest points first (the same order as the Python reference)
    const sorted = caps.slice().sort((x, y) => PTS[board[y[0]]][board[y[1]]] - PTS[board[x[0]]][board[x[1]]]);
    const moves = sorted.slice(0, width);
    if (can3) moves.push("P3");
    let best = null;
    let val = maxing ? -INF : INF;
    for (const m of moves) {
      let cv;
      if (m === "P3") {
        cv = sv;
      } else {
        const [a, t] = m;
        const pts = PTS[board[a]][board[t]];
        const nb = applyCapture(board, a, t);
        const ns = scores.slice();
        ns[turn] += pts;
        cv = search(nb, ns, 1 - turn, p3s, depth - 1, alpha, beta, root, width, prune).v;
      }
      if (maxing) {
        if (cv > val) { val = cv; best = m; }
        if (prune) {
          alpha = Math.max(alpha, val);
          if (beta <= alpha) break;
        }
      } else {
        if (cv < val) { val = cv; best = m; }
        if (prune) {
          beta = Math.min(beta, val);
          if (beta <= alpha) break;
        }
      }
    }
    return { v: val, move: best };
  }

  // ------------------------------------------------------------ AI policy
  // Phase 1: a Queen whenever a Queen square is legal; a Knight only when none is left.
  // Among the allowed squares, take the one that leaves the opponent the fewest captures.
  function queenFirstChoice(board, acts) {
    const qs = acts.filter(a => a[0] === Q);
    const pool = qs.length ? qs : acts;
    let best = null, bv = -INF;
    for (const [kind, i] of pool) {
      const nb = board.slice();
      nb[i] = kind;
      const cp = captures(nb).map(([x, y]) => PTS[nb[x]][nb[y]]);
      const v = (kind === Q ? 2 : 1) - 0.5 * (cp.length ? Math.max(...cp) : 0) - 0.05 * cp.length;
      if (v > bv) { bv = v; best = [kind, i]; }
    }
    return best;
  }

  // Start Phase 2 when a depth-3 search (width 6) says it is worth at least +1,
  // or at least 0 when no placement is left.
  function aiStartPhase2(board, scores, turn, acts) {
    const v = search(board, scores, turn, 1 - turn, 3, -INF, INF, turn, 6, true).v;
    return v >= 1 || (acts.length === 0 && v >= 0);
  }

  // Phase 2: captures and the choice to start Phase 3. Depth-3 alpha–beta over all captures.
  function aiPhase2Move(board, scores, turn, p3s) {
    return search(board, scores, turn, p3s, 3, -INF, INF, turn, INF, true).move;
  }

  // ------------------------------------------------------------ game state
  // stage: "phase1" | "phase2" | "phase3" | "over". turn: 0 = Player 1 (moves first), 1 = Player 2.
  function newGame() {
    return {
      board: new Array(NN).fill(E),
      scores: [0, 0],
      turn: 0,
      stage: "phase1",
      p2s: null,
      p3s: null,
      passes: 0,
      log: [],
      over: false,
      result: null,
    };
  }

  function cellName(i) {
    return "row " + Math.floor(i / N) + ", column " + (i % N);
  }

  // The actions the player to move may take now
  function options(state) {
    if (state.over) return { actions: [] };
    if (state.stage === "phase1") {
      const placements = legalPlacements(state.board);
      const canStart = phase2Ok(state.board);
      return { placements, canStartPhase2: canStart, canPass: placements.length === 0 && canStart };
    }
    if (state.stage === "phase2") {
      const caps = captures(state.board);
      return { captures: caps, canStartPhase3: pieces(state.board) <= N && state.turn === state.p3s && caps.length > 0 };
    }
    const removable = [];
    for (let i = 0; i < NN; i++) if (state.board[i]) removable.push(i);
    return { removable };
  }

  function winnerOf(scores) {
    if (scores[0] > scores[1]) return 0;
    if (scores[1] > scores[0]) return 1;
    return null;
  }

  function endGame(state, reason) {
    state.over = true;
    const w = reason === "normal" ? winnerOf(state.scores) : null;
    state.result = { winner: w, reason, scores: state.scores.slice() };
    state.log.push({ player: null, text: outcomeText(state) });
  }

  function outcomeText(state) {
    const r = state.result;
    if (r.reason !== "normal") return "The game ends in a draw: the next phase could not start.";
    if (r.winner === null) return "Game over: " + r.scores[0] + " – " + r.scores[1] + ", a draw.";
    return "Game over: " + r.scores[0] + " – " + r.scores[1] + ", Player " + (r.winner + 1) + " wins.";
  }

  // Automatic transitions, exactly as in the Python simulator
  function refresh(state) {
    if (state.over) return;
    if (state.stage === "phase1") {
      if (!legalPlacements(state.board).length && !phase2Ok(state.board)) endGame(state, "stuck-P1");
      return;
    }
    if (state.stage === "phase2") {
      if (captures(state.board).length) return;
      if (pieces(state.board) <= N) {
        state.stage = "phase3";
        state.p3s = state.turn;
        state.log.push({ player: state.turn, text: "No captures remain, so Player " + (state.turn + 1) + " starts Phase 3." });
        refresh(state);
        return;
      }
      endGame(state, "stuck-P2");
      return;
    }
    if (state.stage === "phase3" && pieces(state.board) === 0) endGame(state, "normal");
  }

  function describePiece(kind) {
    return kind === Q ? "Queen" : "Knight";
  }

  // Apply one action by the player to move. Throws if the action is not allowed.
  function apply(state, action) {
    if (state.over) throw new Error("The game is over.");
    const who = state.turn;
    const name = "Player " + (who + 1);
    const opts = options(state);

    if (state.stage === "phase1") {
      if (action.type === "place") {
        if (!opts.placements.some(([k, i]) => k === action.kind && i === action.cell)) throw new Error("Illegal placement.");
        const pts = action.kind === Q ? 2 : 1;
        state.board[action.cell] = action.kind;
        state.scores[who] += pts;
        state.passes = 0;
        state.log.push({ player: who, text: name + " places a " + describePiece(action.kind) + " at " + cellName(action.cell) + " (+" + pts + ")." });
        state.turn = 1 - who;
      } else if (action.type === "startP2") {
        if (!opts.canStartPhase2) throw new Error("Phase 2 cannot start yet.");
        state.stage = "phase2";
        state.p2s = who;
        state.p3s = 1 - who;
        state.log.push({ player: who, text: name + " starts Phase 2 (captures). " + name + " moves first." });
      } else if (action.type === "pass") {
        if (!opts.canPass) throw new Error("A pass is only allowed when no placement is possible.");
        state.passes += 1;
        state.log.push({ player: who, text: name + " passes." });
        if (state.passes >= 2) {
          endGame(state, "stuck-P1");
          return state;
        }
        state.turn = 1 - who;
      } else {
        throw new Error("Action not allowed in Phase 1: " + action.type);
      }
    } else if (state.stage === "phase2") {
      if (action.type === "capture") {
        if (!opts.captures.some(([a, t]) => a === action.a && t === action.t)) throw new Error("Illegal capture.");
        const attacker = state.board[action.a], target = state.board[action.t];
        const pts = PTS[attacker][target];
        state.board = applyCapture(state.board, action.a, action.t);
        state.scores[who] += pts;
        const move = ATTACKER_MOVES ? " and moves onto that square" : "";
        state.log.push({
          player: who,
          text: name + " captures with a " + describePiece(attacker) + " at " + cellName(action.a) +
                ", taking a " + describePiece(target) + " at " + cellName(action.t) + move + " (+" + pts + ").",
        });
        state.turn = 1 - who;
      } else if (action.type === "startP3") {
        if (!opts.canStartPhase3) throw new Error("Phase 3 cannot start yet.");
        state.stage = "phase3";
        state.p3s = who;
        state.log.push({ player: who, text: name + " starts Phase 3 (removal) and removes first." });
      } else {
        throw new Error("Action not allowed in Phase 2: " + action.type);
      }
    } else if (state.stage === "phase3") {
      if (action.type !== "remove") throw new Error("Action not allowed in Phase 3: " + action.type);
      if (!opts.removable.includes(action.cell)) throw new Error("No piece there.");
      const kind = state.board[action.cell];
      const pts = kind === Q ? 2 : 1;
      state.board[action.cell] = E;
      state.scores[who] += pts;
      state.log.push({ player: who, text: name + " removes a " + describePiece(kind) + " (+" + pts + ")." });
      state.turn = 1 - who;
    }
    refresh(state);
    return state;
  }

  // The move the AI makes for the player to move (does not change the state)
  function aiAction(state) {
    const who = state.turn;
    if (state.stage === "phase1") {
      const acts = legalPlacements(state.board);
      if (phase2Ok(state.board) && aiStartPhase2(state.board, state.scores, who, acts)) return { type: "startP2" };
      if (acts.length) {
        const [kind, cell] = queenFirstChoice(state.board, acts);
        return { type: "place", kind, cell };
      }
      return { type: "pass" };
    }
    if (state.stage === "phase2") {
      const mv = aiPhase2Move(state.board, state.scores, who, state.p3s);
      if (mv === "P3") return { type: "startP3" };
      return { type: "capture", a: mv[0], t: mv[1] };
    }
    // Phase 3: take a Queen whenever one is left (optimal, see the report)
    let cell = -1;
    for (let i = 0; i < NN && cell < 0; i++) if (state.board[i] === Q) cell = i;
    for (let i = 0; i < NN && cell < 0; i++) if (state.board[i] === K) cell = i;
    return { type: "remove", cell };
  }

  const api = {
    N, NN, E, Q, K, PTS, ATTACKER_MOVES,
    legalPlacements, captures, phase2Ok, pieces, finalDiff, placementReason, applyCapture,
    search, newGame, options, apply, aiAction, queenFirstChoice, aiStartPhase2, aiPhase2Move, cellName,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.QK = api;
})(typeof window !== "undefined" ? window : globalThis);
