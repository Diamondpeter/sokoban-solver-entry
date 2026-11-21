// Sokoban solver for make.fun bounty sokoban-solver-01-run-20261121.
//
// Strategy: the generated levels are a 1-wide hallway with small rooms
// (<=6x6, 3-4 boxes) hanging off it through one door each, and a box pushed
// out of a room can never return. So each room is solved on its own,
// push-optimally, and the answers are stitched together with hallway walks.
//
// Per room the search is a breadth-first search over *pushes*: a state is
// the boxes' squares plus the player's reachable region (named by its
// lowest square), so walking never branches the search. Two deadlocks are
// pruned: dead squares (a box there can never reach a goal, found by
// pulling boxes back from the goals) and frozen 2x2 blocks of walls/boxes
// holding a box off its goal. BFS over pushes makes the first solved state
// push-optimal, which is what the scoring pays for.
//
// All budgets are counted in states/expansions, never wall-clock time, so
// two runs write byte-identical output. Node 22, standard library only.
//
// Local run: mkdir -p out && MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Work budgets, in states expanded. The generator only keeps rooms its own
// push search solves within 250k states, so 250k per room is ample; the
// whole-level fallback gets the same per level.
const ROOM_STATE_LIMIT = 250_000;
const ASTAR_EXPANSION_LIMIT = 200_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array;
  goals: number[];
  boxes: number[];
  player: number;
}

interface Dir {
  dx: number;
  dy: number;
  step: string;
  push: string;
}

const DIRS: Dir[] = [
  { dx: 0, dy: -1, step: 'u', push: 'U' },
  { dx: 0, dy: 1, step: 'd', push: 'D' },
  { dx: -1, dy: 0, step: 'l', push: 'L' },
  { dx: 1, dy: 0, step: 'r', push: 'R' },
];

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x]!;
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
    }
  }
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goals, boxes, player };
}

// Squares a lone box can be pushed from and still reach some goal: start
// at the goals and pull backwards (a box at q can be pulled from q - d
// when the player can stand at q - 2d... here: from a live square x, the
// square y = x - d is live when y and y - d are both open floor).
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    queue.push(g);
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const dir of DIRS) {
      const d = dir.dy * w + dir.dx;
      const y = x - d;
      if (y < 0 || y >= wall.length) continue;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

// Flood-fill the squares the player can reach from `from` with `occupied`
// boxes in the way. Returns the lowest square of the region (its name) and
// fills `seen` with `stamp` for the region squares.
function regionLow(
  level: Level,
  occupied: Uint8Array,
  from: number,
  seen: Int32Array,
  stamp: number,
  stack: Int32Array,
): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] === 0 && occupied[q] === 0 && seen[q] !== stamp) {
        seen[q] = stamp;
        stack[n++] = q;
      }
    }
  }
  return low;
}

// True when the box just pushed to `t` is stuck in a 2x2 block made of
// walls and boxes that holds a box off its goal.
function frozen2x2(
  level: Level,
  occupied: Uint8Array,
  isGoal: Uint8Array,
  t: number,
): boolean {
  const { w, wall } = level;
  const corners = [t, t - 1, t - w, t - w - 1];
  for (const a of corners) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (a < 0 || d >= wall.length) continue;
    const filled = (s: number): boolean => wall[s] === 1 || occupied[s] === 1;
    if (!filled(a) || !filled(b) || !filled(c) || !filled(d)) continue;
    if (
      (occupied[a] && !isGoal[a]) ||
      (occupied[b] && !isGoal[b]) ||
      (occupied[c] && !isGoal[c]) ||
      (occupied[d] && !isGoal[d])
    ) {
      return true;
    }
  }
  return false;
}

// Shortest walk from `from` to `to` around walls and `occupied` boxes.
// Lower-case LURD letters, first direction first on ties. Throws if
// unreachable (callers only ask for reachable squares).
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length).fill('');
  const queue: number[] = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const dir of DIRS) {
      const q = p + dir.dy * w + dir.dx;
      if (q < 0 || q >= wall.length) continue;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = dir.step;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: target unreachable');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

interface PushSolution {
  pushes: number;
  moves: string;
}

// Push-optimal BFS for one (sub-)level. Returns null when the state budget
// runs out or the level is unsolvable.
function solvePushBfs(level: Level, maxStates: number): PushSolution | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  const solved = (boxes: number[]): boolean => boxes.every((b) => isGoal[b]);
  const stateKey = (boxes: number[], low: number): string => `${low}:${boxes.join(',')}`;

  // States in discovery order: boxes, the player's square after the push
  // that made the state (the box's old square), and the parent link.
  const stateBoxes: number[][] = [level.boxes.slice()];
  const statePlayer: number[] = [level.player];
  const parent: number[] = [-1];
  const seenKeys = new Map<string, number>();

  for (const b of level.boxes) occupied[b] = 1;
  const startLow = regionLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  seenKeys.set(stateKey(level.boxes, startLow), 0);

  let found = solved(level.boxes) ? 0 : -1;
  for (let head = 0; found < 0 && head < stateBoxes.length; head++) {
    const boxes = stateBoxes[head]!;
    for (const b of boxes) occupied[b] = 1;
    regionLow(level, occupied, statePlayer[head]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length && found < 0; bi++) {
      const b = boxes[bi]!;
      for (const dir of DIRS) {
        const d = dir.dy * w + dir.dx;
        const t = b + d;
        // The player must reach the square behind the box, and the box
        // must land on open, live floor.
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozen2x2(level, occupied, isGoal, t);
        let next: number[] | null = null;
        let key = '';
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          const low = regionLow(level, occupied, b, mark, ++stamp, stack);
          key = stateKey(next, low);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null || seenKeys.has(key)) continue;
        if (stateBoxes.length >= maxStates) {
          for (const x of boxes) occupied[x] = 0;
          return null;
        }
        seenKeys.set(key, stateBoxes.length);
        stateBoxes.push(next);
        statePlayer.push(b);
        parent.push(head);
        if (solved(next)) {
          found = stateBoxes.length - 1;
          break;
        }
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  // Rebuild the push path, then turn each push into a walk + a push letter.
  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = stateBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find((dd) => dd.dy * w + dd.dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

// --- Push-A* fallback (same state shape, heuristic = cheapest assignment
// of boxes to goals by walking distance ignoring other boxes). Used only
// when the optimal BFS runs out of states, so an instance still gets a
// (possibly non-optimal) answer instead of none. ---
function solvePushAstar(level: Level, maxExpansions: number): PushSolution | null {
  const { w, wall, goals } = level;
  const size = wall.length;
  const isGoal = new Uint8Array(size);
  for (const g of goals) isGoal[g] = 1;
  const live = liveSquares(level);
  if (level.boxes.some((b) => !live[b])) return null;

  // Walking distances between every pair of floor squares (boxes ignored).
  const dist = new Int32Array(size * size).fill(-1);
  const bfsFrom = (src: number): void => {
    const q: number[] = [src];
    dist[src * size + src] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi]!;
      for (const dir of DIRS) {
        const nq = p + dir.dy * w + dir.dx;
        if (nq < 0 || nq >= size) continue;
        if (wall[nq] || dist[src * size + nq] !== -1) continue;
        dist[src * size + nq] = dist[src * size + p]! + 1;
        q.push(nq);
      }
    }
  };
  for (let s = 0; s < size; s++) if (!wall[s]) bfsFrom(s);

  // Cheapest box->goal assignment by brute-force permutation (<=4 boxes).
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    const perm = (rest: number[], acc: number, used: boolean[]): void => {
      if (acc >= best) return;
      if (rest.length === 0) {
        best = acc;
        return;
      }
      const b = rest[0]!;
      for (let gi = 0; gi < goals.length; gi++) {
        if (used[gi]) continue;
        const d = dist[b * size + goals[gi]!]!;
        if (d < 0) continue;
        used[gi] = true;
        perm(rest.slice(1), acc + d, used);
        used[gi] = false;
      }
    };
    perm(boxes, 0, new Array(goals.length).fill(false));
    return best === Infinity ? 1_000_000 : best;
  };

  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;
  const solved = (boxes: number[]): boolean => boxes.every((b) => isGoal[b]);
  const stateKey = (boxes: number[], low: number): string => `${low}:${boxes.join(',')}`;

  const stateBoxes: number[][] = [level.boxes.slice()];
  const statePlayer: number[] = [level.player];
  const stateG: number[] = [0];
  const parent: number[] = [-1];
  const bestG = new Map<string, number>();
  for (const b of level.boxes) occupied[b] = 1;
  const startLow = regionLow(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  bestG.set(stateKey(level.boxes, startLow), 0);

  // Binary heap on (g + h, -g, state index) for deterministic ties.
  const heap: number[] = [];
  const score = (s: number): number => stateG[s]! + heuristic(stateBoxes[s]!);
  const less = (a: number, b: number): boolean =>
    score(a) < score(b) || (score(a) === score(b) && (stateG[a]! > stateG[b]! || (stateG[a] === stateG[b] && a < b)));
  const heapPush = (s: number): void => {
    let i = heap.length;
    heap.push(s);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): number => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  heapPush(0);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0 && expanded < maxExpansions) {
    const s = heapPop();
    const boxes = stateBoxes[s]!;
    for (const b of boxes) occupied[b] = 1;
    const low = regionLow(level, occupied, statePlayer[s]!, seen, ++stamp, stack);
    for (const b of boxes) occupied[b] = 0;
    // Stale heap entry: a cheaper route to this same state (same boxes and
    // same reachable region) was found after this entry was pushed.
    const hereKey = stateKey(boxes, low);
    if (stateG[s]! > (bestG.get(hereKey) ?? Infinity)) continue;
    if (solved(boxes)) {
      found = s;
      break;
    }
    expanded++;
    for (const b of boxes) occupied[b] = 1;
    regionLow(level, occupied, statePlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (const dir of DIRS) {
        const d = dir.dy * w + dir.dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozen2x2(level, occupied, isGoal, t);
        let next: number[] | null = null;
        let key = '';
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((a, b2) => a - b2);
          const nlow = regionLow(level, occupied, b, mark, ++stamp, stack);
          key = stateKey(next, nlow);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || next === null) continue;
        const g = stateG[s]! + 1;
        const prev = bestG.get(key);
        if (prev !== undefined && prev <= g) continue;
        bestG.set(key, g);
        stateBoxes.push(next);
        statePlayer.push(b);
        stateG.push(g);
        parent.push(s);
        heapPush(stateBoxes.length - 1);
      }
    }
    for (const x of boxes) occupied[x] = 0;
  }
  if (found < 0) return null;

  const path: number[] = [];
  for (let s = found; s > 0; s = parent[s]!) path.push(s);
  path.reverse();
  let moves = '';
  let player = level.player;
  let boxes = level.boxes.slice();
  for (const s of path) {
    const nextBoxes = stateBoxes[s]!;
    const from = boxes.find((b) => !nextBoxes.includes(b))!;
    const to = nextBoxes.find((b) => !boxes.includes(b))!;
    const d = to - from;
    const dir = DIRS.find((dd) => dd.dy * w + dd.dx === d)!;
    for (const b of boxes) occupied[b] = 1;
    moves += walkTo(level, occupied, player, from - d);
    for (const b of boxes) occupied[b] = 0;
    moves += dir.push;
    player = from;
    boxes = nextBoxes;
  }
  return { pushes: path.length, moves };
}

interface Room {
  boxes: number[];
  goals: number[];
  done: boolean;
}

// Split the level into rooms: cut the hallway row's dead floor squares
// (floor the player's row that no box can ever be pushed to a goal from)
// out of the floor; each remaining connected part holding boxes is a room.
// Returns null when the level does not split cleanly.
function roomsOf(level: Level): Room[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) {
    if (!wall[i] && !live[i]) cut[i] = 1;
  }
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: Room[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares: number[] = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const dir of DIRS) {
        const q = squares[i]! + dir.dy * w + dir.dx;
        if (q < 0 || q >= wall.length) continue;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ boxes: [], goals: [], done: false });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) {
    if (part[g]! < 0) return null;
    rooms[part[g]!]!.goals.push(g);
  }
  if (rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

// The square the player stands on after playing `moves` from `from`.
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) {
    p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  }
  return p;
}

// Solve one level: room by room when it segments, else whole-level search.
// Every room is solved with the other rooms' boxes standing as walls (on
// their goals once their room is done), the player walking on from where
// the last room left it.
function solveLevel(level: Level): string {
  const rooms = roomsOf(level);
  if (rooms === null) {
    const whole = solvePushBfs(level, ROOM_STATE_LIMIT) ?? solvePushAstar(level, ASTAR_EXPANSION_LIMIT);
    return whole === null ? '' : whole.moves;
  }
  let player = level.player;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) {
      if (other === room) continue;
      const blockers = other.done ? other.goals : other.boxes;
      for (const b of blockers) wall[b] = 1;
    }
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solvePushBfs(sub, ROOM_STATE_LIMIT) ?? solvePushAstar(sub, ASTAR_EXPANSION_LIMIT);
    if (solved === null) return moves; // keep what is solved; never emit an illegal move
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(parseLevel(readFileSync(join(I, id, 'level.txt'), 'utf8')));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
