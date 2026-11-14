/*
 * User interface: board, controls, piece animations and the human-versus-AI game loop.
 * The rules and the AI live in engine.js and are not changed here.
 *
 * Design:
 *  - The 36 cells are created once and updated in place, so running animations are never cut off.
 *  - The engine is advanced at once, but the board the player sees ("shown") is updated only after
 *    the animation for that action has finished. Scores and the move log are updated at the same time.
 *  - While an action is animating, the board and controls are locked (busy = true).
 *  - Every asynchronous step checks a generation number, so a new game cancels stale callbacks.
 */
(function () {
  "use strict";
  const QK = window.QK;
  const N = QK.N, NN = QK.NN;
  const $ = id => document.getElementById(id);

  const reduceMotion = typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Durations in milliseconds
  const DUR = { hint: 180, place: 320, capture: 420, slide: 360, remove: 380, select: 170 };

  const BLUE = "rgba(42, 122, 176, .95)";
  const GOLD = "rgba(201, 138, 18, .95)";
  const RED = "rgba(176, 58, 46, .95)";
  const clearOf = c => c.replace(/[\d.]+\)$/, "0)");

  const PHASE_NAMES = { phase1: "Phase 1 · Placement", phase2: "Phase 2 · Captures", phase3: "Phase 3 · Removal", over: "Game over" };
  const PHASE_CLASS = { phase1: "ph1", phase2: "ph2", phase3: "ph3", over: "ph0" };
  const PIECE_SVG = {
    [QK.Q]: '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><use href="#sym-queen" xlink:href="#sym-queen"></use></svg>',
    [QK.K]: '<svg viewBox="0 0 64 64" aria-hidden="true" focusable="false"><use href="#sym-knight" xlink:href="#sym-knight"></use></svg>',
  };

  let state = null;
  let human = 0;          // side the human plays: 0 = Player 1 (moves first), 1 = Player 2
  let kind = QK.Q;        // piece selected for Phase 1
  let attacker = null;    // selected attacker cell in Phase 2
  let aiTimer = null;
  let busy = false;       // true while an action is animating or the AI is about to move
  let gen = 0;            // incremented by every new game; stale callbacks compare and stop
  let shown = { board: new Array(NN).fill(0), scores: [0, 0], logCount: 0 };
  const cells = [];

  // ------------------------------------------------------------ helpers
  function setFlag(el, cls, on) {
    if (on) el.classList.add(cls);
    else el.classList.remove(cls);
  }

  // Run a Web Animation and resolve when it finishes. No animation (or reduced motion) resolves at once.
  function animate(el, frames, opts) {
    if (!el || reduceMotion || typeof el.animate !== "function") return Promise.resolve();
    try {
      const a = el.animate(frames, Object.assign({ easing: "cubic-bezier(.2,.7,.2,1)", fill: "none" }, opts));
      return Promise.resolve(a.finished).catch(() => {});
    } catch (e) {
      return Promise.resolve();
    }
  }

  function pulseFrames(color) {
    return [
      { boxShadow: "inset 0 0 0 0 " + clearOf(color) },
      { boxShadow: "inset 0 0 0 4px " + color },
      { boxShadow: "inset 0 0 0 0 " + clearOf(color) },
    ];
  }

  function setMessage(text, kindOfMsg) {
    const m = $("message");
    m.textContent = text || "";
    m.className = "message" + (kindOfMsg ? " " + kindOfMsg : "");
  }

  function you(p) { return p === human ? "You" : "AI"; }
  function isHumanTurn() { return !busy && !state.over && state.turn === human; }
  function outcome() {
    const r = state.result;
    if (r.reason !== "normal") return "The game ends in a draw: the next phase could not start.";
    if (r.winner === null) return "Final score " + r.scores[0] + " – " + r.scores[1] + ". It is a draw.";
    const mine = r.scores[human], theirs = r.scores[1 - human];
    return (r.winner === human ? "You win " : "The AI wins ") + Math.max(mine, theirs) + " – " + Math.min(mine, theirs) + ".";
  }

  // ------------------------------------------------------------ board cells
  function buildBoard() {
    const board = $("board");
    board.innerHTML = "";
    for (let i = 0; i < NN; i++) {
      const r = Math.floor(i / N), c = i % N;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "cell " + ((r + c) % 2 === 0 ? "light" : "dark");
      btn.setAttribute("role", "gridcell");
      btn.dataset.cell = String(i);
      btn.dataset.kind = "0";
      btn.addEventListener("click", () => onCell(i));
      board.appendChild(btn);
      cells.push(btn);
    }
  }

  function makePiece(p) {
    const span = document.createElement("span");
    span.className = "piece " + (p === QK.Q ? "q" : "k");
    span.innerHTML = PIECE_SVG[p];
    return span;
  }

  // Put the right piece in a cell. Leaves the element alone when nothing changes.
  function setCellPiece(i, p) {
    const c = cells[i];
    if (Number(c.dataset.kind) === p) return;
    c.innerHTML = "";
    if (p) c.appendChild(makePiece(p));
    c.dataset.kind = String(p);
  }

  function clearCell(i) {
    cells[i].innerHTML = "";
    cells[i].dataset.kind = "0";
  }

  function pieceEl(i) {
    return cells[i].children[0] || null;
  }

  function impactRing(i, gold) {
    const ring = document.createElement("span");
    ring.className = "impact" + (gold ? " gold" : "");
    cells[i].appendChild(ring);
    return ring;
  }

  // ------------------------------------------------------------ rendering (no animation here)
  function renderBoard() {
    const humanTurn = isHumanTurn();
    const opts = state.over ? {} : QK.options(state);

    // Phase 1: if no square is left for the selected piece, select the other one and say so
    if (humanTurn && state.stage === "phase1" && (opts.placements || []).length &&
        !opts.placements.some(([k]) => k === kind)) {
      kind = kind === QK.Q ? QK.K : QK.Q;
      document.querySelectorAll('input[name="kind"]').forEach(r => { r.checked = Number(r.value) === kind; });
      setMessage("No square is left for that piece, so the " + (kind === QK.Q ? "Queen" : "Knight") + " is selected.");
    }

    const legal = new Set(), targets = new Set(), capturable = new Set(), removable = new Set();
    if (humanTurn) {
      if (state.stage === "phase1") {
        for (const [k, i] of opts.placements) if (k === kind) legal.add(i);
      } else if (state.stage === "phase2") {
        if (attacker !== null) {
          for (const [a, t] of opts.captures) if (a === attacker) targets.add(t);
        } else {
          for (const [a] of opts.captures) capturable.add(a);
        }
      } else if (state.stage === "phase3") {
        for (const i of opts.removable) removable.add(i);
      }
    }

    for (let i = 0; i < NN; i++) {
      const c = cells[i];
      setCellPiece(i, shown.board[i]);
      setFlag(c, "legal", legal.has(i));
      setFlag(c, "target", targets.has(i));
      setFlag(c, "capturable", capturable.has(i));
      setFlag(c, "removable", removable.has(i));
      setFlag(c, "attacker", humanTurn && attacker === i);
      c.disabled = !humanTurn;
      const p = shown.board[i];
      c.setAttribute("aria-label", (p ? (p === QK.Q ? "Queen" : "Knight") : "Empty square") +
        ", row " + Math.floor(i / N) + ", column " + (i % N));
    }

    const wrap = $("board-wrap");
    setFlag(wrap, "human-turn", humanTurn);
    setFlag(wrap, "ai-turn", !state.over && !humanTurn && state.turn !== human);
  }

  function renderControls() {
    const humanTurn = isHumanTurn();
    const inPhase1 = !state.over && state.stage === "phase1";
    const opts = state.over ? {} : QK.options(state);

    $("phase-badge").textContent = PHASE_NAMES[state.over ? "over" : state.stage];
    $("phase-badge").className = "phase-badge " + PHASE_CLASS[state.over ? "over" : state.stage];
    $("turn-line").textContent = state.over ? "" : (busy ? "Moving…" : (humanTurn ? "Your turn" : "AI's turn"));

    $("piece-picker").hidden = !inPhase1;
    $("btn-start2").disabled = !(humanTurn && inPhase1 && opts.canStartPhase2);
    $("btn-pass").disabled = !(humanTurn && inPhase1 && opts.canPass);
    $("btn-start3").disabled = !(humanTurn && state.stage === "phase2" && opts.canStartPhase3);
    $("btn-cancel").disabled = !(humanTurn && state.stage === "phase2" && attacker !== null);
  }

  function renderScores() {
    $("score-you").textContent = shown.scores[human];
    $("score-ai").textContent = shown.scores[1 - human];
  }

  function renderLog() {
    const log = $("log");
    log.innerHTML = "";
    state.log.slice(0, shown.logCount).forEach(entry => {
      const li = document.createElement("li");
      li.className = entry.player === null ? "outcome" : (entry.player === human ? "you" : "ai");
      const who = entry.player === null ? "" : you(entry.player) + ": ";
      li.textContent = who + entry.text;
      log.appendChild(li);
    });
    log.scrollTop = log.scrollHeight;
  }

  function renderAll() {
    renderBoard();
    renderControls();
    renderScores();
    renderLog();
  }

  // ------------------------------------------------------------ animations
  // Phase 1: the new piece scales up with a small landing overshoot and fades in.
  function animatePlace(i) {
    return animate(pieceEl(i), [
      { transform: "scale(.6)", opacity: 0 },
      { transform: "scale(1.07)", opacity: 1, offset: .7 },
      { transform: "scale(1)", opacity: 1 },
    ], { duration: DUR.place });
  }

  // Phase 2: highlight the attacker and target, the target shrinks and fades with an impact ring,
  // and the attacker slides onto the target's square (the engine's capture rule).
  async function animateCapture(a, t, before, after) {
    await Promise.all([
      animate(cells[a], pulseFrames(GOLD), { duration: DUR.hint }),
      animate(cells[t], pulseFrames(RED), { duration: DUR.hint }),
    ]);

    const attackerEl = pieceEl(a), targetEl = pieceEl(t);
    const moved = before[a] !== 0 && after[a] === 0;
    const cellW = cells[a].offsetWidth || 0, cellH = cells[a].offsetHeight || 0;
    const dx = ((t % N) - (a % N)) * cellW;
    const dy = (Math.floor(t / N) - Math.floor(a / N)) * cellH;
    const ring = impactRing(t, false);

    const jobs = [
      animate(targetEl, [
        { transform: "scale(1)", opacity: 1, filter: "brightness(1)" },
        { transform: "scale(.82)", opacity: .85, filter: "brightness(1.4)", offset: .35 },
        { transform: "scale(.2)", opacity: 0, filter: "brightness(1.6)" },
      ], { duration: DUR.capture, fill: "forwards" }),
      animate(ring, [
        { transform: "scale(.45)", opacity: .95 },
        { transform: "scale(1.55)", opacity: 0 },
      ], { duration: DUR.capture, fill: "forwards" }),
    ];
    if (moved && attackerEl) {
      attackerEl.classList.add("moving");
      jobs.push(animate(attackerEl, [
        { transform: "translate(0px, 0px)" },
        { transform: "translate(" + dx + "px, " + dy + "px)" },
      ], { duration: DUR.slide, fill: "forwards" }));
    }
    await Promise.all(jobs);
  }

  // Phase 3: highlight the piece, then it shrinks and fades away with a gold ring.
  async function animateRemove(c) {
    await animate(cells[c], pulseFrames(GOLD), { duration: DUR.hint });
    const ring = impactRing(c, true);
    await Promise.all([
      animate(pieceEl(c), [
        { transform: "scale(1)", opacity: 1 },
        { transform: "scale(.7)", opacity: .7, offset: .45 },
        { transform: "scale(.15)", opacity: 0 },
      ], { duration: DUR.remove, fill: "forwards" }),
      animate(ring, [
        { transform: "scale(.5)", opacity: .9 },
        { transform: "scale(1.5)", opacity: 0 },
      ], { duration: DUR.remove, fill: "forwards" }),
    ]);
  }

  // Shows what the action is about to do (used for the AI before it moves).
  function hintAction(action, who) {
    const color = who === human ? BLUE : GOLD;
    let targets = [];
    if (action.type === "place") targets = [action.cell];
    if (action.type === "capture") targets = [action.a, action.t];
    if (action.type === "remove") targets = [action.cell];
    return Promise.all(targets.map(i => animate(cells[i], pulseFrames(color), { duration: DUR.hint })));
  }

  // Animates one applied action and returns the cells whose contents must be rebuilt afterwards.
  async function animateAction(action, before, after, who) {
    if (action.type === "place") {
      shown.board = after;     // the placed piece must exist before it can animate
      renderBoard();
      await animatePlace(action.cell);
      return [];
    }
    if (action.type === "capture") {
      await animateCapture(action.a, action.t, before, after);
      return [action.a, action.t];
    }
    if (action.type === "remove") {
      await animateRemove(action.cell);
      return [action.cell];
    }
    return [];   // Start Phase 2 / Start Phase 3 / Pass: no piece moves
  }

  // ------------------------------------------------------------ game flow
  // Applies one action (human or AI), animates it, then updates the view and continues the game.
  async function performAction(action, who) {
    const myGen = gen;
    const before = shown.board.slice();
    try {
      QK.apply(state, action);
    } catch (e) {
      busy = false;
      setMessage(e.message, "warn");
      renderAll();
      return;
    }
    attacker = null;
    busy = true;
    renderAll();                       // locks the board while the animation runs
    const after = state.board.slice();
    const clear = await animateAction(action, before, after, who);
    if (myGen !== gen) return;         // a new game started while this was animating

    for (const i of clear) clearCell(i);
    shown = { board: after, scores: state.scores.slice(), logCount: state.log.length };
    busy = false;
    renderAll();
    if (state.over) setMessage(outcome(), "good");
    else if (state.turn !== human) setMessage("AI is thinking…");
    else setMessage("");
    scheduleAi();
  }

  function scheduleAi() {
    clearTimeout(aiTimer);
    aiTimer = null;
    if (state.over || state.turn === human) return;
    const myGen = gen;
    busy = true;
    renderAll();
    setMessage("AI is thinking…");
    aiTimer = setTimeout(async () => {
      aiTimer = null;
      if (myGen !== gen) return;
      const action = QK.aiAction(state);
      await hintAction(action, 1 - human);
      if (myGen !== gen) return;
      await performAction(action, state.turn);
    }, Number($("speed").value));
  }

  function newGame() {
    gen++;
    clearTimeout(aiTimer);
    aiTimer = null;
    human = Number(document.querySelector('input[name="first"]:checked').value);
    state = QK.newGame();
    attacker = null;
    busy = false;
    shown = { board: new Array(NN).fill(0), scores: [0, 0], logCount: 0 };
    setMessage(human === 0 ? "You move first. Place a Queen or a Knight." : "The AI moves first. Watch its first placement.");
    renderAll();
    scheduleAi();
  }

  // Clicks on the board
  function onCell(i) {
    if (!isHumanTurn()) return;
    const opts = QK.options(state);
    if (state.stage === "phase1") {
      if (state.board[i]) { setMessage("That square is already occupied.", "warn"); return; }
      if (opts.placements.some(([k, c]) => k === kind && c === i)) {
        performAction({ type: "place", kind, cell: i }, human);
      } else {
        setMessage(QK.placementReason(state.board, kind, i) || "You cannot place that piece here.", "warn");
      }
      return;
    }
    if (state.stage === "phase2") {
      if (attacker !== null && opts.captures.some(([a, t]) => a === attacker && t === i)) {
        performAction({ type: "capture", a: attacker, t: i }, human);
        return;
      }
      if (attacker === i) {
        attacker = null;
        setMessage("Attacker cleared.");
        renderBoard();
        return;
      }
      if (opts.captures.some(([a]) => a === i)) {
        attacker = i;
        animate(cells[i], [{ transform: "scale(.92)" }, { transform: "scale(1.04)" }, { transform: "scale(1)" }], { duration: DUR.select });
        setMessage("Choose a highlighted target.");
        renderBoard();
        return;
      }
      setMessage(state.board[i] ? "That piece has no capture. Choose a piece that can capture." : "Choose one of your pieces to capture with.", "warn");
      return;
    }
    if (state.stage === "phase3" && state.board[i]) {
      performAction({ type: "remove", cell: i }, human);
    }
  }

  // ------------------------------------------------------------ wiring
  buildBoard();
  document.querySelectorAll('input[name="kind"]').forEach(r => r.addEventListener("change", e => {
    kind = Number(e.target.value);
    setMessage("");
    renderBoard();
  }));
  $("btn-start2").addEventListener("click", () => performAction({ type: "startP2" }, human));
  $("btn-pass").addEventListener("click", () => performAction({ type: "pass" }, human));
  $("btn-start3").addEventListener("click", () => performAction({ type: "startP3" }, human));
  $("btn-cancel").addEventListener("click", () => { attacker = null; setMessage(""); renderBoard(); renderControls(); });
  $("btn-new").addEventListener("click", newGame);
  document.querySelectorAll('input[name="first"]').forEach(r => r.addEventListener("change", newGame));

  newGame();
})();
