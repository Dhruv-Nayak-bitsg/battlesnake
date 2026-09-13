import runServer from './server.js';

function info() {
  return {
    apiversion: "1",
    author: "MySurvivalSnake",
    color: "#2ec4b6",
    head: "beluga",
    tail: "curled",
  };
}

function start(gameState) {
  console.log(`${gameState.game.id} GAME START`);
}

function end(gameState) {
  console.log(`${gameState.game.id} GAME OVER`);
}

// ---------- Helpers ----------

const DIRS = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

// Tunable parameters — adjust these to change personality
// Overall priority split is roughly 60% growth (food) / 40% everything else
// (space, territory, combat, positioning). See FOOD_WEIGHT / FOOD_URGENT_MULTIPLIER
// vs SPACE_WEIGHT / TERRITORY_WEIGHT / PREY_HEAD_BONUS for the actual balance.
const PARAMS = {
  SPACE_WEIGHT: 7,
  TERRITORY_WEIGHT: 3.5,
  HAZARD_PENALTY: 25,
  OWN_BODY_ADJACENT_MAX_PENALTY: 6,
  CENTER_BIAS_WEIGHT: 0.5,

  // Combat — only ever fight snakes we can actually beat
  PREY_HEAD_BONUS: 8,         // reward for moving toward a weaker enemy's head (chip damage / trap opportunity)
  MIN_LENGTH_ADVANTAGE: 2,    // must be at least this much LONGER than an enemy to treat it as prey/attackable
  AVOID_EQUAL_LENGTH_HEADS: true, // treat equal-length enemy heads as dangerous, never as targets

  // Food seeking — the dominant priority
  FOOD_WEIGHT: 6,             // score bonus per unit closer to food (scaled by urgency)
  FOOD_URGENT_HEALTH: 50,     // health at/below this triggers urgent food-seeking
  FOOD_URGENT_MULTIPLIER: 6,  // multiplies FOOD_WEIGHT when health is low
  FOOD_LENGTH_TARGET: 20,     // keep seeking food aggressively until this length
  FOOD_GROWTH_MULTIPLIER: 1.5, // urgency while under FOOD_LENGTH_TARGET but not low health
  FOOD_BASELINE_MULTIPLIER: 1, // baseline food interest even when healthy/long (never fully stop growing)
  MIN_SAFE_SPACE: 6,          // if the space behind a move is below this, food urgency is ignored
};

function isRoyale(gameState) {
  return gameState.game?.ruleset?.name === "royale";
}

// Royale-specific overrides, merged over PARAMS when ruleset is "royale".
// Rationale (from the mode description):
//  - "storm shrinks the board turn by turn and deals damage" -> hazards must be
//    avoided much more aggressively, and we should bias toward the safe zone's
//    center (not just the board's static center) since that's where the zone
//    keeps shrinking to.
//  - "someone always gets cornered" -> weight open space/mobility higher and
//    avoid tight pockets near board edges, since the storm eats edges first.
//  - "matches stay fast" -> health drains faster (damage + normal decay), so
//    food becomes urgent sooner and matters even at high length.
//  - single elimination, no draws to fall back on -> be more conservative in
//    50/50s; a fight loss ends the run, so danger avoidance gets extra weight.
const ROYALE_OVERRIDES = {
  SPACE_WEIGHT: 9,
  TERRITORY_WEIGHT: 3,
  HAZARD_PENALTY: 60,
  MIN_LENGTH_ADVANTAGE: 3,
  FOOD_URGENT_HEALTH: 65,
  FOOD_URGENT_MULTIPLIER: 7,
  MIN_SAFE_SPACE: 8,
  SAFE_ZONE_BIAS_WEIGHT: 1.2, // pull toward the centroid of remaining non-hazard space
};

function getEffectiveParams(gameState) {
  return isRoyale(gameState) ? { ...PARAMS, ...ROYALE_OVERRIDES } : PARAMS;
}

// Centroid of currently-safe, currently-open board cells (non-hazard AND
// unoccupied) — this approximates "where the shrinking storm is retreating
// to" far better than the board's fixed geometric center, since the storm
// can shrink asymmetrically, and better than including occupied cells, which
// would skew the target toward wherever snake bodies happen to be piled up.
function getSafeZoneCenter(boardWidth, boardHeight, hazardSet, occupied) {
  let sumX = 0, sumY = 0, count = 0;
  for (let x = 0; x < boardWidth; x++) {
    for (let y = 0; y < boardHeight; y++) {
      const key = coordKey(x, y);
      if (!hazardSet.has(key) && !occupied.has(key)) {
        sumX += x;
        sumY += y;
        count++;
      }
    }
  }
  if (count === 0) return { x: (boardWidth - 1) / 2, y: (boardHeight - 1) / 2 };
  return { x: sumX / count, y: sumY / count };
}

function coordKey(x, y) {
  return `${x},${y}`;
}

function isConstrictor(gameState) {
  return gameState.game?.ruleset?.name === "constrictor";
}

function buildOccupied(gameState) {
  const occupied = new Set();
  const constrictor = isConstrictor(gameState);

  gameState.board.snakes.forEach(snake => {
    const body = snake.body;
    const justAte = body.length >= 2 &&
      body[body.length - 1].x === body[body.length - 2].x &&
      body[body.length - 1].y === body[body.length - 2].y;

    const keepTail = constrictor || justAte || body.length <= 2;
    const bodyToUse = keepTail ? body : body.slice(0, -1);
    bodyToUse.forEach(p => occupied.add(coordKey(p.x, p.y)));
  });

  return occupied;
}

// Uses an index pointer instead of Array.shift(), which is O(n) per call and
// would make this BFS effectively O(n^2) — costly since this runs up to 4x
// per move, every move, for the whole match.
function floodFill(startX, startY, boardWidth, boardHeight, occupied, hazardSet) {
  if (
    startX < 0 || startX >= boardWidth ||
    startY < 0 || startY >= boardHeight ||
    occupied.has(coordKey(startX, startY))
  ) {
    return 0;
  }

  const visited = new Set([coordKey(startX, startY)]);
  const queue = [{ x: startX, y: startY }];
  let headIndex = 0;
  let space = 0;

  while (headIndex < queue.length) {
    const cur = queue[headIndex++];
    const curKey = coordKey(cur.x, cur.y);
    space += hazardSet && hazardSet.has(curKey) ? 0.4 : 1;

    for (const dir of Object.values(DIRS)) {
      const nx = cur.x + dir.x;
      const ny = cur.y + dir.y;
      const key = coordKey(nx, ny);

      if (
        nx >= 0 && nx < boardWidth &&
        ny >= 0 && ny < boardHeight &&
        !occupied.has(key) &&
        !visited.has(key)
      ) {
        visited.add(key);
        queue.push({ x: nx, y: ny });
      }
    }
  }

  return space;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function getTerritoryControl(myHead, enemyHeads, boardWidth, boardHeight, occupied) {
  let myTerritory = 0;

  for (let x = 0; x < boardWidth; x++) {
    for (let y = 0; y < boardHeight; y++) {
      if (occupied.has(coordKey(x, y))) continue;

      const target = { x, y };
      const myDist = manhattan(myHead, target);

      if (enemyHeads.length === 0) {
        myTerritory++;
        continue;
      }

      // Plain loop instead of Math.min(...enemyHeads.map(...)) — avoids
      // allocating a new array and spreading it for every empty cell on
      // the board, every move.
      let minEnemyDist = Infinity;
      for (const eh of enemyHeads) {
        const d = manhattan(eh, target);
        if (d < minEnemyDist) minEnemyDist = d;
      }

      if (myDist < minEnemyDist) myTerritory++;
    }
  }
  return myTerritory;
}

function closestFoodDist(point, food) {
  if (!food || food.length === 0) return null;
  let min = Infinity;
  food.forEach(f => {
    const d = manhattan(point, f);
    if (d < min) min = d;
  });
  return min;
}

// ---------- Main Move Logic ----------

function move(gameState) {
  const startTime = Date.now();

  try {
    const myHead = gameState.you.body[0];
    const myNeck = gameState.you.body.length > 1 ? gameState.you.body[1] : null;
    const myLength = gameState.you.length;
    const myHealth = gameState.you.health;
    const boardWidth = gameState.board.width;
    const boardHeight = gameState.board.height;
    const snakes = gameState.board.snakes;
    const hazards = gameState.board.hazards || [];
    const food = gameState.board.food || [];
    const constrictor = isConstrictor(gameState);
    const royale = isRoyale(gameState);
    const P = getEffectiveParams(gameState);

    let isMoveSafe = { up: true, down: true, left: true, right: true };

    // 1. Never reverse into your own neck (no-op if there's no neck yet, i.e. length 1)
    if (myNeck) {
      if (myNeck.x < myHead.x) isMoveSafe.left = false;
      else if (myNeck.x > myHead.x) isMoveSafe.right = false;
      else if (myNeck.y < myHead.y) isMoveSafe.down = false;
      else if (myNeck.y > myHead.y) isMoveSafe.up = false;
    }

    // 2. Never leave the board
    if (myHead.x === 0) isMoveSafe.left = false;
    if (myHead.x === boardWidth - 1) isMoveSafe.right = false;
    if (myHead.y === 0) isMoveSafe.down = false;
    if (myHead.y === boardHeight - 1) isMoveSafe.up = false;

    // 3. Body collisions (self + others), tail-aware
    const occupied = buildOccupied(gameState);
    Object.keys(DIRS).forEach(dir => {
      const nx = myHead.x + DIRS[dir].x;
      const ny = myHead.y + DIRS[dir].y;
      if (occupied.has(coordKey(nx, ny))) isMoveSafe[dir] = false;
    });

    // 4. Head-to-head danger
    const dangerHeadCells = new Set();
    const preyHeadCells = new Set();
    const enemyHeads = [];

    snakes.forEach(snake => {
      if (snake.id === gameState.you.id) return;
      const otherHead = snake.body[0];
      enemyHeads.push(otherHead);

      // Only ever treat an enemy as "prey" (attackable) if we have a real length
      // advantage. Equal-length heads are always dangerous, never targets —
      // a 50/50 head-to-head isn't a fair fight worth picking.
      const iAmClearlyBigger = myLength - snake.length >= P.MIN_LENGTH_ADVANTAGE;
      const isDangerous = P.AVOID_EQUAL_LENGTH_HEADS
        ? snake.length >= myLength || !iAmClearlyBigger
        : snake.length >= myLength;

      Object.values(DIRS).forEach(d => {
        const nx = otherHead.x + d.x;
        const ny = otherHead.y + d.y;
        if (nx < 0 || nx >= boardWidth || ny < 0 || ny >= boardHeight) return;
        const key = coordKey(nx, ny);

        if (occupied.has(key)) return;

        if (isDangerous) dangerHeadCells.add(key);
        else if (iAmClearlyBigger) preyHeadCells.add(key);
      });
    });

    Object.keys(DIRS).forEach(dir => {
      if (!isMoveSafe[dir]) return;
      const nx = myHead.x + DIRS[dir].x;
      const ny = myHead.y + DIRS[dir].y;
      if (dangerHeadCells.has(coordKey(nx, ny))) isMoveSafe[dir] = false;
    });

    let safeMoves = Object.keys(isMoveSafe).filter(key => isMoveSafe[key]);
    const hazardSet = new Set(hazards.map(h => coordKey(h.x, h.y)));

    // Fallback Logic — no safe moves, pick least-bad option
    if (safeMoves.length === 0) {
      const reverseDir = myNeck ? Object.keys(DIRS).find(dir => {
        const nx = myHead.x + DIRS[dir].x;
        const ny = myHead.y + DIRS[dir].y;
        return nx === myNeck.x && ny === myNeck.y;
      }) : null;

      const candidates = Object.keys(DIRS).filter(dir => {
        if (dir === reverseDir) return false;
        const nx = myHead.x + DIRS[dir].x;
        const ny = myHead.y + DIRS[dir].y;
        return nx >= 0 && nx < boardWidth && ny >= 0 && ny < boardHeight;
      });

      const ranked = (candidates.length > 0 ? candidates : Object.keys(DIRS)).map(dir => {
        const nx = myHead.x + DIRS[dir].x;
        const ny = myHead.y + DIRS[dir].y;
        const key = coordKey(nx, ny);
        const inBounds = nx >= 0 && nx < boardWidth && ny >= 0 && ny < boardHeight;
        const hitsBody = inBounds && occupied.has(key);
        const hitsDangerHead = inBounds && dangerHeadCells.has(key);
        const space = inBounds ? floodFill(nx, ny, boardWidth, boardHeight, occupied, hazardSet) : -1;

        let rank = space;
        if (!inBounds) rank -= 1000;
        if (hitsBody) rank -= 2000;
        if (hitsDangerHead) rank -= 500;

        return { dir, rank };
      });

      ranked.sort((a, b) => b.rank - a.rank);
      const fallback = ranked[0]?.dir || "up";

      const execTime = Date.now() - startTime;
      console.log(`MOVE ${gameState.turn}: Trapped! Defaulting to ${fallback}. (Took ${execTime}ms)`);
      return { move: fallback };
    }

    // 5. Scoring — space, territory, and food are all combined here in one pass
    const ownBodyAdjacent = new Set();
    gameState.you.body.slice(1).forEach(seg => {
      Object.values(DIRS).forEach(d => {
        const nx = seg.x + d.x;
        const ny = seg.y + d.y;
        if (nx >= 0 && nx < boardWidth && ny >= 0 && ny < boardHeight) {
          ownBodyAdjacent.add(coordKey(nx, ny));
        }
      });
    });

    // Determine how urgently we want food this turn
    let foodUrgencyMultiplier = 0;
    if (!constrictor && food.length > 0) {
      if (myHealth <= P.FOOD_URGENT_HEALTH) {
        // Scale urgency up as health drops further, so starving overrides almost everything
        const healthRatio = 1 - (myHealth / P.FOOD_URGENT_HEALTH);
        foodUrgencyMultiplier = P.FOOD_URGENT_MULTIPLIER * (1 + healthRatio);
      } else if (myLength < P.FOOD_LENGTH_TARGET) {
        foodUrgencyMultiplier = P.FOOD_GROWTH_MULTIPLIER;
      } else {
        // Still meaningfully interested in nearby food even when big/healthy —
        // growth stays the dominant priority rather than dropping off a cliff
        foodUrgencyMultiplier = P.FOOD_BASELINE_MULTIPLIER;
      }
    }

    // Royale: precompute the safe-zone centroid once (not per-move) for the bias term below.
    const safeZoneCenter = royale
      ? getSafeZoneCenter(boardWidth, boardHeight, hazardSet, occupied)
      : null;

    const scores = {};
    safeMoves.forEach(dir => {
      const targetX = myHead.x + DIRS[dir].x;
      const targetY = myHead.y + DIRS[dir].y;

      const space = floodFill(targetX, targetY, boardWidth, boardHeight, occupied, hazardSet);
      const territory = getTerritoryControl({ x: targetX, y: targetY }, enemyHeads, boardWidth, boardHeight, occupied);

      let score = (space * P.SPACE_WEIGHT) + (territory * P.TERRITORY_WEIGHT);

      if (hazardSet.has(coordKey(targetX, targetY))) score -= P.HAZARD_PENALTY;

      if (ownBodyAdjacent.has(coordKey(targetX, targetY))) {
        score -= Math.min(P.OWN_BODY_ADJACENT_MAX_PENALTY, space * 0.5);
      }

      if (preyHeadCells.has(coordKey(targetX, targetY))) score += P.PREY_HEAD_BONUS;

      const centerX = (boardWidth - 1) / 2;
      const centerY = (boardHeight - 1) / 2;
      const distFromCenter = Math.abs(targetX - centerX) + Math.abs(targetY - centerY);
      score -= distFromCenter * P.CENTER_BIAS_WEIGHT;

      // Royale: the storm shrinks the board over time, so bias toward the
      // centroid of currently-safe (non-hazard) cells rather than just the
      // static board center — this tracks the safe zone as it moves/shrinks
      // and helps avoid getting cornered as edges become hazardous.
      if (royale) {
        const distFromSafeZone = Math.abs(targetX - safeZoneCenter.x) + Math.abs(targetY - safeZoneCenter.y);
        score -= distFromSafeZone * P.SAFE_ZONE_BIAS_WEIGHT;
      }

      // Food: use an inverse-distance potential field rather than a flat
      // step bonus. A flat "+1 if closer / -1 if farther" bonus (the naive
      // approach) gives an adjacent pellet the same weight as one 15 cells
      // away, since a single move only ever changes distance by ~1. Scaling
      // by 1/(distance+1) instead means nearby food pulls much harder than
      // distant food, while still only mattering once there's room to move
      // (MIN_SAFE_SPACE gate below).
      if (foodUrgencyMultiplier > 0 && space >= P.MIN_SAFE_SPACE) {
        const newFoodDist = closestFoodDist({ x: targetX, y: targetY }, food);
        if (newFoodDist !== null) {
          score += foodUrgencyMultiplier * P.FOOD_WEIGHT / (newFoodDist + 1);
        }
      }

      scores[dir] = score;
    });

    const maxScore = Math.max(...Object.values(scores));
    let bestMoves = safeMoves.filter(dir => scores[dir] >= maxScore - 0.01);
    if (bestMoves.length === 0) bestMoves = safeMoves;

    const nextMove = bestMoves[Math.floor(Math.random() * bestMoves.length)] || safeMoves[0];

    const execTime = Date.now() - startTime;
    console.log(`MOVE ${gameState.turn}: ${nextMove} | Mode: ${constrictor ? "constrictor" : royale ? "royale" : "standard"} | Len: ${myLength} | FoodUrgency: ${foodUrgencyMultiplier.toFixed(2)} | Took: ${execTime}ms`);
    return { move: nextMove };

  } catch (error) {
    const execTime = Date.now() - startTime;
    console.error(`💥 FATAL ERROR ON TURN ${gameState.turn} (after ${execTime}ms):`, error);
    return { move: "up" };
  }
}

runServer({
  info: info,
  start: start,
  move: move,
  end: end
});
