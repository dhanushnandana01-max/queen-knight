#!/usr/bin/env python3
"""Generates tests/fixtures.json from the Python reference engine (queen_knight_sim.py).

The JavaScript engine (js/engine.js) must agree with these values. Run from the repository root:
    python3 engine_reference/make_fixtures.py
"""
import json, random, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import queen_knight_sim as qk

INF = qk.INF


def random_board(rng, steps):
    b = [0] * 36
    for _ in range(steps):
        acts = qk.legal_placements(b)
        if not acts:
            break
        kind, i = rng.choice(acts)
        b[i] = kind
    return b


def to_move(m):
    if m is None or m == "P3":
        return m
    return [m[0], m[1]]


def cell_of(text):
    # text like "places Q at (2,3)"
    r, c = text.split("(")[1].split(")")[0].split(",")
    return int(r) * 6 + int(c)


positions, searches = [], []
rng = random.Random(2024)
for _ in range(400):
    b = random_board(rng, rng.randint(0, 36))
    caps = qk.captures(b)
    sc = [rng.randint(0, 6), rng.randint(0, 6)]
    positions.append(dict(board=b,
                          legal=[[k, i] for k, i in qk.legal_placements(b)],
                          captures=[[a, t] for a, t in caps],
                          p2ok=qk.phase2_ok(b), pieces=qk.pieces(b), scores=sc,
                          final_diff=[qk.final_diff(b, sc, 0, 0), qk.final_diff(b, sc, 1, 0)]))
    if caps and len(searches) < 260:
        for turn in (0, 1):
            for depth, width in ((2, 7), (3, 6), (4, 7)):
                if depth == 4 and len(searches) >= 160:
                    continue
                v, m = qk.search(b, sc, turn, 1 - turn, depth, -INF, INF, turn, width, True, [0])
                searches.append(dict(board=b, scores=sc, turn=turn, p3s=1 - turn, depth=depth,
                                     width=width, value=v, move=to_move(m)))

log = []
res = qk.play([qk.AGENTS["AB-4"], qk.AGENTS["Greedy"]], 2, log)
actions = []
for ph, who, text, board, scores, mv in log:
    if ph == "P1" and text.startswith("places"):
        kind = qk.Q if text.split()[1] == "Q" else qk.K
        actions.append(dict(player=who, type="place", kind=kind, cell=cell_of(text)))
    elif ph == "P1":
        actions.append(dict(player=who, type="startP2"))
    elif ph == "P2" and mv is not None:
        actions.append(dict(player=who, type="capture", a=mv[0], t=mv[1]))
    elif ph == "P2":
        actions.append(dict(player=who, type="startP2"))
    elif ph == "P3" and text.startswith("starts"):
        if qk.captures(board):  # automatic starts (no captures left) are not choices
            actions.append(dict(player=who, type="startP3"))
    elif ph == "P3" and text.startswith("removes"):
        actions.append(dict(player=who, type="remove", cell=cell_of(text)))

# AI policy checks: the website AI (qk.AGENTS["AI"]) must choose the same placement and capture
ai_checks = []
for entry in positions:
    b = entry["board"]
    acts = qk.legal_placements(b)
    pl = qk.queen_first_choice(b, acts) if acts else None
    caps = qk.captures(b)
    cap = None
    if caps and qk.pieces(b) > 0:
        _, mv = qk.search(b, [0, 0], 0, 1, 3, -INF, INF, 0, 100, True, [0])
        cap = to_move(mv)
    ai_checks.append(dict(board=b, place=None if pl is None else [pl[0], pl[1]], phase2=cap))

out = dict(positions=positions, searches=searches, ai=ai_checks,
           replay=dict(actions=actions, final_scores=res["scores"], winner=res["w"], end=res["end"]))
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures.json")
json.dump(out, open(path, "w"))
print("positions", len(positions), "searches", len(searches), "replay actions", len(actions),
      "final", res["scores"], "winner", res["w"])
