#!/usr/bin/env python3
"""Queen-Knight self-play simulator (revised rules, standard library only).

Rules implemented
Phase 1  one piece per step. Q: must not see a Q, must not sit an L-step from a K.
         K: must not attack a Q; first K needs no support, later K need a K an L-step away.
         Points: Q=2, K=1. Either player may start Phase 2 on own turn once n<=Q<=K,
         up to the point where no placements remain (both decline then -> draw).
Phase 2  one capture per step, attacker stays, target removed.
         KxQ=2, QxK=1, QxQ=3, KxK=0. Starter of Phase 2 moves first.
         Only the other player (Phase-3 starter) may start Phase 3 while captures remain
         (needs Q+K<=n). If no captures remain: Q+K<=n -> player on turn starts Phase 3,
         otherwise draw.
Phase 3  alternate removals, starter first. Q=2, K=1. Higher total wins.
"""
import random, time, sys, json
from multiprocessing import Pool

N = 6
NN = N * N
# True: the attacker moves onto the captured square (chess-like). False: the attacker stays (report v1 rule).
ATTACKER_MOVES = True
LEAF_WEIGHT = 0.35  # weight of the best immediate capture in the search cut-off heuristic
E, Q, K = 0, 1, 2
INF = float("inf")
KSTEPS = ((-2, -1), (-2, 1), (-1, -2), (-1, 2), (1, -2), (1, 2), (2, -1), (2, 1))
QDIRS = ((-1, -1), (-1, 0), (-1, 1), (0, -1), (0, 1), (1, -1), (1, 0), (1, 1))
PTS = [[0] * 3 for _ in range(3)]
PTS[K][Q], PTS[Q][K], PTS[Q][Q], PTS[K][K] = 2, 1, 3, 0

KN = [[] for _ in range(NN)]
RAYS = [[] for _ in range(NN)]
for _r in range(N):
    for _c in range(N):
        _i = _r * N + _c
        for dr, dc in KSTEPS:
            rr, cc = _r + dr, _c + dc
            if 0 <= rr < N and 0 <= cc < N:
                KN[_i].append(rr * N + cc)
        for dr, dc in QDIRS:
            ray, rr, cc = [], _r + dr, _c + dc
            while 0 <= rr < N and 0 <= cc < N:
                ray.append(rr * N + cc)
                rr += dr
                cc += dc
            if ray:
                RAYS[_i].append(ray)


# ----------------------------------------------------------------- rules
def legal_placements(board):
    acts = []
    has_k = K in board
    for i in range(NN):
        if board[i]:
            continue
        ok = True
        for t in KN[i]:
            if board[t] == K:
                ok = False
                break
        if ok:
            for ray in RAYS[i]:
                for t in ray:
                    if board[t]:
                        if board[t] == Q:
                            ok = False
                        break
                if not ok:
                    break
        if ok:
            acts.append((Q, i))
        sup, okk = (not has_k), True
        for t in KN[i]:
            b = board[t]
            if b == Q:
                okk = False
                break
            if b == K:
                sup = True
        if okk and sup:
            acts.append((K, i))
    return acts


def captures(board):
    acts = []
    for i in range(NN):
        p = board[i]
        if p == Q:
            for ray in RAYS[i]:
                for t in ray:
                    if board[t]:
                        acts.append((i, t))
                        break
        elif p == K:
            for t in KN[i]:
                if board[t]:
                    acts.append((i, t))
    return acts


def apply_capture(board, a, t):
    """Return the board after a capture. The target is removed; the attacker moves if ATTACKER_MOVES."""
    nb = board[:]
    if ATTACKER_MOVES:
        nb[t] = nb[a]
        nb[a] = E
    else:
        nb[t] = E
    return nb


def phase2_ok(board):
    q, k = board.count(Q), board.count(K)
    return N <= q <= k


def pieces(board):
    return NN - board.count(E)


def final_diff(board, scores, first, root):
    """Exact Phase-3 outcome: alternate removals, Queens first, starting with `first`."""
    q, k = board.count(Q), board.count(K)
    s, p = scores[:], first
    while q or k:
        if q:
            q -= 1
            s[p] += 2
        else:
            k -= 1
            s[p] += 1
        p = 1 - p
    return s[root] - s[1 - root]


# ---------------------------------------------------------------- search
def search(board, scores, turn, p3s, depth, alpha, beta, root, width, prune, ctr):
    """Depth-limited minimax; prune=True gives alpha-beta. ctr[0] counts visited nodes."""
    ctr[0] += 1
    caps = captures(board)
    p3ok = pieces(board) <= N
    if not caps:
        return (final_diff(board, scores, turn, root) if p3ok else 0.0), None
    maxing = turn == root
    can3 = p3ok and turn == p3s
    sv = final_diff(board, scores, turn, root) if can3 else None
    if depth == 0:
        diff = scores[root] - scores[1 - root]
        best = max(PTS[board[a]][board[t]] for a, t in caps)
        v = diff + (LEAF_WEIGHT * best if maxing else -LEAF_WEIGHT * best)
        if can3:
            v = max(v, sv) if maxing else min(v, sv)
        return v, None
    caps.sort(key=lambda m: -PTS[board[m[0]]][board[m[1]]])
    moves = caps[:width]
    if can3:
        moves.append("P3")
    best = None
    val = -INF if maxing else INF
    for m in moves:
        if m == "P3":
            cv = sv
        else:
            a, t = m
            pts = PTS[board[a]][board[t]]
            nb = apply_capture(board, a, t)
            ns = scores[:]
            ns[turn] += pts
            cv, _ = search(nb, ns, 1 - turn, p3s, depth - 1, alpha, beta, root, width, prune, ctr)
        if maxing:
            if cv > val:
                val, best = cv, m
            if prune:
                alpha = max(alpha, val)
                if beta <= alpha:
                    break
        else:
            if cv < val:
                val, best = cv, m
            if prune:
                beta = min(beta, val)
                if beta <= alpha:
                    break
    return val, best


# -------------------------------------------------------------- policies
def queen_first_choice(board, acts):
    """Queen whenever a Queen square is legal; a Knight only when none is left.
    Among the allowed squares, pick the one that leaves the fewest captures for the opponent."""
    qs = [a for a in acts if a[0] == Q]
    pool = qs if qs else acts
    best, bv = None, -INF
    for kind, i in pool:
        nb = board[:]; nb[i] = kind
        cp = [PTS[nb[x]][nb[y]] for x, y in captures(nb)]
        v = (2 if kind == Q else 1) - 0.5 * (max(cp) if cp else 0) - 0.05 * len(cp)
        if v > bv:
            bv, best = v, (kind, i)
    return best


def place_choice(name, board, acts, rng):
    if name == "queenfirst":
        return queen_first_choice(board, acts)
    if name == "random":
        return rng.choice(acts)
    if name == "greedyQ":
        qs = [a for a in acts if a[0] == Q]
        return rng.choice(qs or acts)
    if name == "balanced":  # keep K >= Q so Phase 2 stays reachable
        want = K if board.count(K) <= board.count(Q) else Q
        c = [a for a in acts if a[0] == want]
        return rng.choice(c or acts)
    best, bv = None, -INF
    for kind, i in acts:
        nb = board[:]
        nb[i] = kind
        caps = captures(nb)
        cp = [PTS[nb[a]][nb[t]] for a, t in caps]
        pts = 2 if kind == Q else 1
        if name == "defensive":  # leave a quiet board: few and cheap captures
            v = pts - 0.5 * (max(cp) if cp else 0) - 0.05 * len(cp)
        else:  # aggressive: build a capture-rich board
            v = pts + 0.3 * sum(cp)
        v += rng.random() * 1e-3
        if v > bv:
            bv, best = v, (kind, i)
    return best


def start2_decision(cfg, board, scores, turn, acts, rng, ctr):
    m = cfg["start2"]
    if m == "early":
        return True
    if m == "late":
        return not acts
    if m == "random":
        return rng.random() < (0.5 if not acts else 0.15)
    v, _ = search(board, scores, turn, 1 - turn, 3, -INF, INF, turn, 6, True, ctr)
    return v >= 1 or (not acts and v >= 0)


def capture_choice(name, board, scores, turn, caps, rng):
    best, bv = None, -INF
    for a, t in caps:
        pts = PTS[board[a]][board[t]]
        if name == "greedy":
            v = pts
        elif name == "attacker":
            v = pts + (0.4 if board[t] == Q else 0)
        elif name == "defensive":  # own points minus best immediate reply
            nb = apply_capture(board, a, t)
            rep = [PTS[nb[x]][nb[y]] for x, y in captures(nb)]
            v = pts - (max(rep) if rep else 0)
        else:
            v = 0
        v += rng.random() * 1e-3
        if v > bv:
            bv, best = v, (a, t)
    return best


def start3_decision(mode, rng):
    return mode == "early" or (mode == "random" and rng.random() < 0.3)


# ------------------------------------------------------------------ game
def play(cfgs, seed, log=None):
    rng = random.Random(seed)
    board, scores = [E] * NN, [0, 0]
    ph = [[0, 0, 0], [0, 0, 0]]
    info = dict(p2s=None, p3s=None, caps=0, places=0, end="normal",
                nodes=[0, 0], moves=[0, 0], ms=[0.0, 0.0])
    ctr = [[0], [0]]
    turn, passes = 0, 0
    while True:  # ---- phase 1
        acts = legal_placements(board)
        p2ok = phase2_ok(board)
        if p2ok and start2_decision(cfgs[turn], board, scores, turn, acts, rng, ctr[turn]):
            info["p2s"], p3s = turn, 1 - turn
            if log is not None:
                log.append(("P2", turn, "starts Phase 2", board[:], scores[:], None))
            break
        if acts:
            kind, i = place_choice(cfgs[turn]["place"], board, acts, rng)
            board[i] = kind
            pts = 2 if kind == Q else 1
            scores[turn] += pts
            ph[turn][0] += pts
            info["places"] += 1
            passes = 0
            if log is not None:
                log.append(("P1", turn, "places %s at (%d,%d)" % ("Q" if kind == Q else "K", i // N, i % N),
                            board[:], scores[:], None))
        else:
            passes += 1
            if not p2ok or passes >= 2:
                info["end"] = "stuck-P1"
                return finish(scores, ph, info, ctr, None)
        turn = 1 - turn
    while True:  # ---- phase 2
        caps = captures(board)
        p3ok = pieces(board) <= N
        if not caps:
            if p3ok:
                info["p3s"] = turn
                break
            info["end"] = "stuck-P2"
            return finish(scores, ph, info, ctr, None)
        cfg = cfgs[turn]
        can3 = p3ok and turn == p3s
        if isinstance(cfg["cap"], tuple):
            _, depth, width = cfg["cap"]
            t0 = time.perf_counter()
            _, mv = search(board, scores, turn, p3s, depth, -INF, INF, turn, width, True, ctr[turn])
            info["ms"][turn] += (time.perf_counter() - t0) * 1000
            info["moves"][turn] += 1
            if mv == "P3":
                info["p3s"] = turn
                break
        else:
            if can3 and start3_decision(cfg["start3"], rng):
                info["p3s"] = turn
                break
            mv = capture_choice(cfg["cap"], board, scores, turn, caps, rng)
        a, t = mv
        pts = PTS[board[a]][board[t]]
        if log is not None:
            log.append(("P2", turn, "%s(%d,%d) captures %s(%d,%d) +%d" % (
                "Q" if board[a] == Q else "K", a // N, a % N,
                "Q" if board[t] == Q else "K", t // N, t % N, pts), board[:], scores[:], (a, t)))
        board = apply_capture(board, a, t)
        scores[turn] += pts
        ph[turn][1] += pts
        info["caps"] += 1
        turn = 1 - turn
    q, k = board.count(Q), board.count(K)  # ---- phase 3
    p = info["p3s"]
    if log is not None:
        log.append(("P3", p, "starts Phase 3", board[:], scores[:], None))
        lb, ls, lp = board[:], scores[:], p
        while Q in lb or K in lb:
            kind = Q if Q in lb else K
            i = lb.index(kind)
            lb[i] = E
            ls[lp] += 2 if kind == Q else 1
            log.append(("P3", lp, "removes %s at (%d,%d)" % ("Q" if kind == Q else "K", i // N, i % N),
                        lb[:], ls[:], (i, i)))
            lp = 1 - lp
    while q or k:
        if q:
            q -= 1
            scores[p] += 2
            ph[p][2] += 2
        else:
            k -= 1
            scores[p] += 1
            ph[p][2] += 1
        p = 1 - p
    w = 0 if scores[0] > scores[1] else 1 if scores[1] > scores[0] else None
    return finish(scores, ph, info, ctr, w)


def finish(scores, ph, info, ctr, w):
    info["nodes"] = [ctr[0][0], ctr[1][0]]
    return dict(w=w, scores=scores, ph=ph, **info)


# ---------------------------------------------------------------- agents
AGENTS = {
    "Greedy": dict(place="greedyQ", start2="early", cap="greedy", start3="early"),
    "Defensive": dict(place="defensive", start2="late", cap="defensive", start3="late"),
    "Attacker": dict(place="aggressive", start2="early", cap="attacker", start3="early"),
    "Random": dict(place="random", start2="random", cap="random", start3="random"),
    "AB-4": dict(place="balanced", start2="smart", cap=("ab", 4, 7), start3="smart"),
    "AB-4Q": dict(place="greedyQ", start2="early", cap=("ab", 4, 7), start3="smart"),
    # The AI used in the website: Queen-first placement, full-width alpha-beta (depth 3) for captures.
    "AI": dict(place="queenfirst", start2="smart", cap=("ab", 3, 100), start3="smart"),
    "QF-AB4": dict(place="queenfirst", start2="smart", cap=("ab", 4, 7), start3="smart"),
    "QF-AB4-late": dict(place="queenfirst", start2="late", cap=("ab", 4, 7), start3="smart"),
    "QF-AB4-early": dict(place="queenfirst", start2="early", cap=("ab", 4, 7), start3="smart"),
    "AB-2": dict(place="balanced", start2="smart", cap=("ab", 2, 7), start3="smart"),
    "Early-Start": dict(place="balanced", start2="early", cap="greedy", start3="early"),
    "Late-Start": dict(place="balanced", start2="late", cap="greedy", start3="late"),
    "Balanced-Place": dict(place="balanced", start2="early", cap="greedy", start3="early"),
    "Aggr-Setup": dict(place="aggressive", start2="early", cap="greedy", start3="early"),
    "Def-Setup": dict(place="defensive", start2="early", cap="greedy", start3="early"),
}
PAIRS = [
    ("Greedy", "Defensive"), ("Greedy", "Attacker"), ("Defensive", "Attacker"),
    ("Greedy", "Random"), ("AB-4", "Greedy"), ("AB-4", "Defensive"),
    ("AB-4", "Attacker"), ("AB-4", "Random"), ("AB-2", "AB-4"),
    ("Early-Start", "Late-Start"), ("Greedy", "Balanced-Place"),
    ("Aggr-Setup", "Def-Setup"),
    ("AB-4Q", "Greedy"), ("AB-4Q", "Defensive"), ("AB-4Q", "AB-4"),
]


def job(args):
    pi, g, seed = args
    a, b = PAIRS[pi]
    cfgs = [AGENTS[a], AGENTS[b]] if g % 2 == 0 else [AGENTS[b], AGENTS[a]]
    return pi, g, play(cfgs, seed)


def summarize(pi, rows):
    a, b = PAIRS[pi]
    S = dict(pair=f"{a} vs {b}", games=len(rows), A=0, B=0, D=0, stuck=0,
             sA=0, sB=0, A_start2=0, caps=0, places=0,
             phA=[0, 0, 0], phB=[0, 0, 0], nodes=0, ms=0.0, moves=0,
             p1w=0, p2w=0, stuckP1=0, starter_win=0, nonstarter_win=0, starter_tie=0,
             normal=0, A_win_as_p1=0, A_win_as_p2=0)
    for g, r in rows:
        sa = 0 if g % 2 == 0 else 1
        sb = 1 - sa
        if r["w"] is None:
            S["D"] += 1
        elif r["w"] == sa:
            S["A"] += 1
        else:
            S["B"] += 1
        if r["w"] == 0:
            S["p1w"] += 1
        if r["w"] == 1:
            S["p2w"] += 1
        if r["end"] != "normal":
            S["stuck"] += 1
            S["stuckP1"] += 1 if r["end"] == "stuck-P1" else 0
        else:
            S["normal"] += 1
            if r["w"] is None:
                S["starter_tie"] += 1
            elif r["w"] == r["p2s"]:
                S["starter_win"] += 1
            else:
                S["nonstarter_win"] += 1
        if r["w"] == sa:
            S["A_win_as_p1" if sa == 0 else "A_win_as_p2"] += 1
        S["sA"] += r["scores"][sa]
        S["sB"] += r["scores"][sb]
        for k in range(3):
            S["phA"][k] += r["ph"][sa][k]
            S["phB"][k] += r["ph"][sb][k]
        S["A_start2"] += 1 if r["p2s"] == sa else 0
        S["caps"] += r["caps"]
        S["places"] += r["places"]
        S["nodes"] += r["nodes"][sa] + r["nodes"][sb]
        S["ms"] += r["ms"][sa] + r["ms"][sb]
        S["moves"] += r["moves"][sa] + r["moves"][sb]
    return S


if __name__ == "__main__":
    games = int(sys.argv[1]) if len(sys.argv) > 1 else 100
    tasks = [(pi, g, 1000 * pi + g) for pi in range(len(PAIRS)) for g in range(games)]
    t0 = time.time()
    with Pool() as pool:
        out = pool.map(job, tasks, chunksize=4)
    by = {}
    for pi, g, r in out:
        by.setdefault(pi, []).append((g, r))
    res = [summarize(pi, by[pi]) for pi in range(len(PAIRS))]
    json.dump(res, open("sim_results.json", "w"), indent=1)
    print(f"{len(tasks)} games in {time.time() - t0:.1f}s")
    for S in res:
        n = S["games"]
        print(f"{S['pair']:28s} A {S['A']:4d} B {S['B']:4d} D {S['D']:4d} stuck {S['stuck']:4d} | "
              f"avg {S['sA']/n:5.1f}-{S['sB']/n:5.1f} | P1w {S['p1w']} P2w {S['p2w']} | "
              f"A starts P2 {S['A_start2']/n:.0%} | caps {S['caps']/n:4.1f} pl {S['places']/n:4.1f}")
