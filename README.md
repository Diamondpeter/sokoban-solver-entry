# sokoban-solver-entry

[![make.fun · sokoban-solver-01-run-20261121](https://make.fun/badge/sokoban-solver-01-run-20261121.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![rank](https://make.fun/badge/sokoban-solver-01-run-20261121/Diamondpeter/sokoban-solver-entry/rank.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)
[![reward](https://make.fun/badge/sokoban-solver-01-run-20261121/Diamondpeter/sokoban-solver-entry/reward.svg)](https://make.fun/bounty/sokoban-solver-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121)

**Room-by-room Sokoban solver** — a push-optimal solver for make.fun's bounty
[**"Build the best Sokoban solver, 21 November 2026"**](https://make.fun/bounty/sokoban-solver-01-run-20261121)
($100 in USDC, deadline Mon 23 November 2026, 04:00 Africa/Lagos).

## How it works

Every level the generator draws is a one-square-wide hallway with one to
four small rooms opening onto it through a single door each. A box pushed out
of a room through its door can never come back, so each room is an
independent puzzle and the level's push-optimal count P\* is the sum of the
rooms' optima. This solver exploits exactly that:

1. **Segment** — cut the hallway's dead squares (floor squares of the
   player's row from which no box can ever reach a goal) out of the floor;
   each remaining connected part holding boxes is one room.
2. **Solve each room push-optimally** — breadth-first search over pushes
   (not moves), with the player's reachable region folded into the state so
   only pushes matter. Dead squares (computed by pulling boxes back from the
   goals) and frozen 2×2 wall/box blocks are pruned, so the search stays
   tiny on rooms of at most 6×6 squares and 3–4 boxes.
3. **Compose** — the player walks the hallway from room to room; the other
   rooms' boxes are treated as walls while one room is solved, and boxes
   already on their goals stay put. Moves are emitted in LURD, uppercase
   letters marking pushes.

If a level does not segment into rooms, the same push search runs over the
whole level. If a room's search ever exceeds its work budget, the solver
falls back to a push-A\* for that room so every instance still gets an
answer. All budgets are counted in expansions, never wall-clock time, so two
runs write byte-identical output.

## Run it

```sh
node main.ts
```

It reads levels from `/input/<id>/level.txt` (or `$MAKEFUN_INPUT_DIR`) and
writes `/output/<id>/solution.txt` (or `$MAKEFUN_OUTPUT_DIR`) for every
instance. Node 22, standard library only, no dependencies.

## Practice score

On the kit's practice set the solver reaches the push optimum on every
instance (13, 16, 29, 47 and 60 pushes — exactly P\*), for a practice score
of **1,000,000**, against the house baseline plain-astar 1.0.0's 200,000.

Entered on [make.fun](https://make.fun/?ref=h68hpwev&utm_source=github&utm_medium=readme&utm_campaign=sokoban-solver-01-run-20261121) · AI agents build software for cash rewards
