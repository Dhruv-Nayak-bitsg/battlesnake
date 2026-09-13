import runServer from './server.js';

function info() {
  return {
    apiversion: "1",
    author: "MySurvivalSnake",
    color: "#4287f5",
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
  FOOD_BASELINE_MULTIPLIER: 1, // baseline food interest even when healthy/long (never fully stop growing)
  MIN_SAFE_SPACE: 6,          // if the space behind a move is below this, food urgency is ignored
};

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
  let space = 0;

  while (queue.length > 0) {
    const cur = queue.shift();
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

      const minEnemyDist = Math.min(...enemyHeads.map(eh => manhattan(eh, target)));

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
    const myNeck = gameState.you.body[1];
    const myLength = gameState.you.length;
    const myHealth = gameState.you.health;
    const boardWidth = gameState.board.width;
    const boardHeight = gameState.board.height;
    const snakes = gameState.board.snakes;
    const hazards = gameState.board.hazards || [];
    const food = gameState.board.food || [];
    const constrictor = isConstrictor(gameState);

    let isMoveSafe = { up: true, down: true, left: true, right: true };

    // 1. Never reverse into your own neck
    if (myNeck.x < myHead.x) isMoveSafe.left = false;
    else if (myNeck.x > myHead.x) isMoveSafe.right = false;
    else if (myNeck.y < myHead.y) isMoveSafe.down = false;
    else if (myNeck.y > myHead.y) isMoveSafe.up = false;

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
      const iAmClearlyBigger = myLength - snake.length >= PARAMS.MIN_LENGTH_ADVANTAGE;
      const isDangerous = PARAMS.AVOID_EQUAL_LENGTH_HEADS
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
      const reverseDir = Object.keys(DIRS).find(dir => {
        const nx = myHead.x + DIRS[dir].x;
        const ny = myHead.y + DIRS[dir].y;
        return nx === myNeck.x && ny === myNeck.y;
      });

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
    const currentFoodDist = closestFoodDist(myHead, food);
    let foodUrgencyMultiplier = 0;
    if (!constrictor && food.length > 0) {
      if (myHealth <= PARAMS.FOOD_URGENT_HEALTH) {
        // Scale urgency up as health drops further, so starving overrides almost everything
        const healthRatio = 1 - (myHealth / PARAMS.FOOD_URGENT_HEALTH);
        foodUrgencyMultiplier = PARAMS.FOOD_URGENT_MULTIPLIER * (1 + healthRatio);
      } else if (myLength < PARAMS.FOOD_LENGTH_TARGET) {
        foodUrgencyMultiplier = 1.5;
      } else {
        // Still meaningfully interested in nearby food even when big/healthy —
        // growth stays the dominant priority rather than dropping off a cliff
        foodUrgencyMultiplier = PARAMS.FOOD_BASELINE_MULTIPLIER;
      }
    }

    const scores = {};
    safeMoves.forEach(dir => {
      const targetX = myHead.x + DIRS[dir].x;
      const targetY = myHead.y + DIRS[dir].y;

      const space = floodFill(targetX, targetY, boardWidth, boardHeight, occupied, hazardSet);
      const territory = getTerritoryControl({ x: targetX, y: targetY }, enemyHeads, boardWidth, boardHeight, occupied);

      let score = (space * PARAMS.SPACE_WEIGHT) + (territory * PARAMS.TERRITORY_WEIGHT);

      if (hazardSet.has(coordKey(targetX, targetY))) score -= PARAMS.HAZARD_PENALTY;

      if (ownBodyAdjacent.has(coordKey(targetX, targetY))) {
        score -= Math.min(PARAMS.OWN_BODY_ADJACENT_MAX_PENALTY, space * 0.5);
      }

      if (preyHeadCells.has(coordKey(targetX, targetY))) score += PARAMS.PREY_HEAD_BONUS;

      const centerX = (boardWidth - 1) / 2;
      const centerY = (boardHeight - 1) / 2;
      const distFromCenter = Math.abs(targetX - centerX) + Math.abs(targetY - centerY);
      score -= distFromCenter * PARAMS.CENTER_BIAS_WEIGHT;

      // Food: reward moves that reduce distance to the nearest food,
      // but only meaningfully when the destination has enough breathing room.
      if (foodUrgencyMultiplier > 0 && currentFoodDist !== null && space >= PARAMS.MIN_SAFE_SPACE) {
        const newFoodDist = closestFoodDist({ x: targetX, y: targetY }, food);
        if (newFoodDist !== null) {
          const improvement = currentFoodDist - newFoodDist; // positive if we got closer
          score += improvement * PARAMS.FOOD_WEIGHT * foodUrgencyMultiplier;
        }
      }

      scores[dir] = score;
    });

    const maxScore = Math.max(...Object.values(scores));
    let bestMoves = safeMoves.filter(dir => scores[dir] >= maxScore - 0.01);
    if (bestMoves.length === 0) bestMoves = safeMoves;

    const nextMove = bestMoves[Math.floor(Math.random() * bestMoves.length)] || safeMoves[0];

    const execTime = Date.now() - startTime;
    console.log(`MOVE ${gameState.turn}: ${nextMove} | Mode: ${constrictor ? "constrictor" : "standard"} | Len: ${myLength} | FoodUrgency: ${foodUrgencyMultiplier.toFixed(2)} | Took: ${execTime}ms`);
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
