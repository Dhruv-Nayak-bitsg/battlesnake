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
      
      const target = {x, y};
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

// ---------- Main Move Logic ----------

function move(gameState) {
  const startTime = Date.now(); // Start performance timer

  try {
    const myHead = gameState.you.body[0];
    const myNeck = gameState.you.body[1];
    const myLength = gameState.you.length;
    const boardWidth = gameState.board.width;
    const boardHeight = gameState.board.height;
    const snakes = gameState.board.snakes;
    const hazards = gameState.board.hazards || [];
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
      const biggerOrEqual = snake.length >= myLength;

      Object.values(DIRS).forEach(d => {
        const nx = otherHead.x + d.x;
        const ny = otherHead.y + d.y;
        if (nx < 0 || nx >= boardWidth || ny < 0 || ny >= boardHeight) return;
        const key = coordKey(nx, ny);
        
        if (occupied.has(key)) return;
        
        if (biggerOrEqual) dangerHeadCells.add(key);
        else preyHeadCells.add(key);
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

    // Fallback Logic
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
      const fallback = ranked[0]?.dir || "up"; // Added ?. for ultimate safety

      const execTime = Date.now() - startTime;
      console.log(`MOVE ${gameState.turn}: Trapped! Defaulting to ${fallback}. (Took ${execTime}ms)`);
      return { move: fallback };
    }

    // 5. Scoring with integrated Lookahead
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

    const scores = {};
    safeMoves.forEach(dir => {
      const targetX = myHead.x + DIRS[dir].x;
      const targetY = myHead.y + DIRS[dir].y;

      const space = floodFill(targetX, targetY, boardWidth, boardHeight, occupied, hazardSet);
      const territory = getTerritoryControl({x: targetX, y: targetY}, enemyHeads, boardWidth, boardHeight, occupied);

      let score = (space * 10) + (territory * 5);

      if (hazardSet.has(coordKey(targetX, targetY))) score -= 25;

      if (ownBodyAdjacent.has(coordKey(targetX, targetY))) {
        score -= Math.min(6, space * 0.5);
      }

      if (preyHeadCells.has(coordKey(targetX, targetY))) score += 15;

      const centerX = (boardWidth - 1) / 2;
      const centerY = (boardHeight - 1) / 2;
      const distFromCenter = Math.abs(targetX - centerX) + Math.abs(targetY - centerY);
      score -= distFromCenter * 0.5;

      scores[dir] = score;
    });

    const maxScore = Math.max(...Object.values(scores));
    let bestMoves = safeMoves.filter(dir => scores[dir] >= maxScore - 5);
    if (bestMoves.length === 0) bestMoves = safeMoves;

    let nextMove = bestMoves[Math.floor(Math.random() * bestMoves.length)] || safeMoves[0];

    // 6. Food seeking
    if (!constrictor) {
      const food = gameState.board.food;
      if (food.length > 0) {
        let closestFood = food[0];
        let minFoodDist = Infinity;

        food.forEach(f => {
          const dist = manhattan(f, myHead);
          if (dist < minFoodDist) {
            minFoodDist = dist;
            closestFood = f;
          }
        });

        const lowHealth = gameState.you.health <= 40;
        const shouldChaseFood = lowHealth || myLength < 12;

        if (shouldChaseFood) {
          let minMoveDist = Infinity;
          bestMoves.forEach(dir => {
            const targetX = myHead.x + DIRS[dir].x;
            const targetY = myHead.y + DIRS[dir].y;
            const distToFood = manhattan({ x: targetX, y: targetY }, closestFood);
            if (distToFood < minMoveDist) {
              minMoveDist = distToFood;
              nextMove = dir;
            }
          });
        }
      }
    }

    const execTime = Date.now() - startTime;
    console.log(`MOVE ${gameState.turn}: ${nextMove} | Mode: ${constrictor ? "constrictor" : "standard"} | Took: ${execTime}ms`);
    return { move: nextMove };

  } catch (error) {
    // If the code breaks, print the exact error and send a safe default move
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