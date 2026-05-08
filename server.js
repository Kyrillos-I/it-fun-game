require("dotenv").config({ quiet: true });

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TICK_MS = 50;
const MAP_LIMIT = 280;
const PLAYER_RADIUS = 0.62;
const MAX_HIT_DISTANCE = 190;
const STALE_ROOM_MS = 5 * 60 * 1000;
const PICKUP_RADIUS = 4.2;
const PICKUP_RADIUS_XZ = 5.6;
const PICKUP_Y_TOLERANCE = 14;
const BOT_SPAWN_MIN_MS = 12000;
const BOT_SPAWN_MAX_MS = 26000;
const MAX_BOTS = 5;
const BOSS_SPAWN_MS = 2 * 60 * 1000;
const NUKE_DAMAGE = 240;
const MATCH_DURATION_MS = 5 * 60 * 1000;
const KILL_LIMIT = 25;
const ROUND_RESTART_MS = 10000;
const BOOST_PICKUPS = ["heal", "armor", "speed-boost", "damage-boost", "jump-boost"];

const COOP_BREAK_MS = 8200;
const COOP_CHAOS_THRESHOLD = 100;
const COOP_COMBO_WINDOW_MS = 3400;
const COOP_MUTATOR_EVERY = 5;

const GOAT_HP = 400;
const GOAT_CD_RAM = 7500;
const GOAT_CD_SWARM = 11000;
const GOAT_CD_FREEZE = 13000;
const GOAT_CD_BLIND = 9000;
const GOAT_RAM_RANGE = 8;
const GOAT_RAM_DAMAGE = 42;
const GOAT_FREEZE_MS = 2600;
const GOAT_FREEZE_RADIUS = 12;
const GOAT_BLIND_RADIUS = 28;
const GOAT_BLIND_COUNT = 3;

const COOP_MUTATORS = {
  none: { label: "Standard issue chaos" },
  speed: { label: "SPEED DEMONS — bots move faster", speed: 1.38 },
  tank: { label: "IRON LEGION — chunky bots", hp: 1.42 },
  swarm: { label: "SWARM MODE — extra bodies", count: 1.45 },
  glass: { label: "GLASS CANNONS — deadly but fragile", hp: 0.72, damage: 1.55 }
};

const WEAPONS = {
  pistol: {
    name: "Pistol",
    infinite: true,
    ammo: Infinity,
    reloadMs: 360,
    pellets: 1,
    spread: 0,
    range: 145,
    bodyDamage: 20,
    headDamage: 50,
    tracerLength: 75,
    color: "#ffe27a"
  },
  sniper: {
    name: "Sniper",
    ammo: 6,
    reloadMs: 1450,
    pellets: 1,
    spread: 0,
    range: 230,
    bodyDamage: 70,
    headDamage: 140,
    tracerLength: 170,
    color: "#9fe8ff"
  },
  shotgun: {
    name: "Shotgun",
    ammo: 18,
    reloadMs: 950,
    pellets: 8,
    spread: 0.095,
    range: 95,
    bodyDamage: 11,
    headDamage: 18,
    tracerLength: 48,
    color: "#ffb15f"
  },
  machinegun: {
    name: "Machine Gun",
    ammo: 70,
    reloadMs: 95,
    pellets: 1,
    spread: 0.025,
    range: 135,
    bodyDamage: 12,
    headDamage: 24,
    tracerLength: 68,
    color: "#a9ff8f"
  },
  bazooka: {
    name: "Bazooka",
    ammo: 3,
    reloadMs: 2300,
    pellets: 1,
    spread: 0,
    range: 120,
    bodyDamage: 95,
    headDamage: 95,
    splashDamage: 85,
    splashRadius: 11,
    tracerLength: 90,
    color: "#ff6b3d"
  }
};

const POWERUPS = {
  none: { name: "None", speedMultiplier: 1, damageMultiplier: 1, maxHp: 100 },
  speed: { name: "Double Speed", speedMultiplier: 2, damageMultiplier: 1, maxHp: 100 },
  damage: { name: "+0.5 Damage", speedMultiplier: 1, damageMultiplier: 1.5, maxHp: 100 },
  health: { name: "+0.5 Health", speedMultiplier: 1, damageMultiplier: 1, maxHp: 150 }
};

const PICKUP_WEAPONS = ["sniper", "shotgun", "machinegun", "bazooka"];
const BOT_VARIANTS = {
  swarm: { name: "Swarm Bot", hp: 55, speed: 0.48, damage: 7, attackMs: 620, radius: 0.52, color: "#7bff8c" },
  tank: { name: "Tank Bot", hp: 170, speed: 0.18, damage: 18, attackMs: 1150, radius: 0.9, color: "#d9ff7b" },
  sniper: { name: "Sniper Bot", hp: 75, speed: 0.24, damage: 20, attackMs: 1700, radius: 0.55, color: "#9fe8ff" },
  bomber: { name: "Bomber Bot", hp: 45, speed: 0.38, damage: 35, attackMs: 1200, radius: 0.58, color: "#ff8f5a" }
};

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

// All game state is intentionally in memory. A room owns the authoritative copy
// of players, pickups, bots, boss state, match timers, and castle collision.
// Restarting the Node process clears rooms, which keeps hosting simple.
const rooms = new Map();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

app.get("/vendor/three.min.js", (_req, res) => {
  res.sendFile(path.join(__dirname, "node_modules", "three", "build", "three.min.js"));
});

app.get("/tts.png", (_req, res) => {
  res.sendFile(path.join(__dirname, "tts.png"));
});

app.get("/r/:room", (_req, res) => {
  res.sendFile(path.join(__dirname, "game.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "game.html"));
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = cleanRoomId(url.searchParams.get("room")) || randomId(6);
  const requestedMode = url.searchParams.get("mode") === "coop" ? "coop" : "pvp";
  const playerId = randomId(12);
  const room = getRoom(roomId, requestedMode);
  const spawn = randomSafeSpawn(room);

  const player = {
    id: playerId,
    name: cleanName(url.searchParams.get("name")),
    color: randomColor(playerId),
    position: spawn,
    yaw: 0,
    pitch: 0,
    hp: 0,
    maxHp: 100,
    kills: 0,
    deaths: 0,
    alive: false,
    spawned: false,
    invulnerableUntil: 0,
    respawnAt: 0,
    lastFireAt: 0,
    lastSeenAt: Date.now(),
    powerup: "none",
    speedMultiplier: 1,
    damageMultiplier: 1,
    currentWeapon: "pistol",
    ammo: 0,
    nukes: 0,
    armorUntil: 0,
    speedBoostUntil: 0,
    damageBoostUntil: 0,
    jumpBoostUntil: 0,
    streak: 0,
    revealUntil: 0,
    isGoat: false,
    goatTier: 0,
    goatRamAt: 0,
    goatSwarmAt: 0,
    goatFreezeAt: 0,
    goatBlindAt: 0,
    frozenUntil: 0,
    ws
  };

  room.players.set(player.id, player);
  room.updatedAt = Date.now();

  send(ws, {
    type: "welcome",
    id: player.id,
    room: room.id,
    gameMode: room.gameMode,
    player: publicPlayer(player),
    weapons: publicWeapons(),
    powerups: POWERUPS
  });

  broadcast(room, {
    type: "event",
    event: "joined",
    player: publicPlayer(player)
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    player.lastSeenAt = Date.now();
    room.updatedAt = player.lastSeenAt;

    if (msg.type === "state") {
      applyPlayerState(room, player, msg);
      return;
    }

    if (msg.type === "rename") {
      player.name = cleanName(msg.name);
      broadcast(room, {
        type: "event",
        event: "renamed",
        player: publicPlayer(player)
      });
      return;
    }

    if (msg.type === "powerup") {
      applyPowerup(player, msg.powerup);
      broadcast(room, {
        type: "event",
        event: "powerup",
        player: publicPlayer(player)
      });
      return;
    }

    if (msg.type === "play") {
      // Join and respawn both use the same client command. The server is the
      // authority that chooses a safe spawn and resets per-life state.
      spawnPlayer(room, player, true);
      broadcast(room, {
        type: "event",
        event: "spawn",
        player: publicPlayer(player)
      });
      return;
    }

    if (msg.type === "pickup") {
      handlePickup(room, player, msg.id);
      return;
    }

    if (msg.type === "fire") {
      handleFire(room, player, msg);
      return;
    }

    if (msg.type === "nuke") {
      useNuke(room, player);
      return;
    }

    if (msg.type === "goatAbility") {
      handleGoatAbility(room, player, msg);
      return;
    }
  });

  ws.on("close", () => {
    const currentRoom = rooms.get(room.id);
    if (!currentRoom) return;

    currentRoom.players.delete(player.id);
    currentRoom.updatedAt = Date.now();
    broadcast(currentRoom, {
      type: "event",
      event: "left",
      id: player.id
    });

    if (currentRoom.players.size === 0) {
      rooms.delete(currentRoom.id);
    }
  });
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    // This is the room tick. Clients only send intent/state updates; this loop
    // advances server-owned systems and broadcasts a fresh snapshot.
    updateMatch(room, now);
    updateCoopRoom(room, now);
    replenishPickups(room);
    updateAi(room, now);
    processProximityPickups(room);

    broadcast(room, {
      type: "snapshot",
      serverTime: now,
      gameMode: room.gameMode,
      players: Array.from(room.players.values()).map(publicPlayer),
      pickups: room.pickups.map(publicPickup),
      bots: Array.from(room.bots.values()).map(publicBot),
      boss: room.boss && room.boss.alive ? publicBot(room.boss) : null,
      nextBossAt: room.nextBossAt,
      match: publicMatch(room)
    });

    if (room.players.size === 0 && now - room.updatedAt > STALE_ROOM_MS) {
      rooms.delete(room.id);
    }
  }
}, TICK_MS);

server.listen(PORT, HOST, () => {
  console.log(`Multiplayer shooter running at http://${HOST}:${PORT}`);
});

function createCoopState(playerCount) {
  const baseLives = 12 + Math.max(1, playerCount) * 4;
  return {
    phase: "lobby",
    wave: 0,
    nextWave: 1,
    breakEndsAt: 0,
    chaosMeter: 0,
    combo: 0,
    lastKillAt: 0,
    credits: 0,
    mutatorKey: "none",
    mutator: COOP_MUTATORS.none,
    pinataSpawned: false,
    lives: baseLives,
    maxLives: Math.round(baseLives * 1.6),
    gameOverAt: 0,
    runStartedAt: 0
  };
}

function getRoom(roomId, requestedMode = "pvp") {
  if (!rooms.has(roomId)) {
    const gameMode = requestedMode === "coop" ? "coop" : "pvp";
    const room = {
      id: roomId,
      gameMode,
      players: new Map(),
      bots: new Map(),
      boss: null,
      obstacles: buildObstacleLayout(roomId),
      nextBotAt: Date.now() + randomBetween(BOT_SPAWN_MIN_MS, BOT_SPAWN_MAX_MS),
      nextBossAt: Date.now() + BOSS_SPAWN_MS,
      match: createMatchState(),
      pickups: [],
      coop: createCoopState(1),
      updatedAt: Date.now()
    };
    replenishPickups(room);
    rooms.set(roomId, room);
  }

  return rooms.get(roomId);
}

function beginCoopRun(room) {
  const c = room.coop;
  if (c.phase !== "lobby") return;
  const n = Math.max(1, room.players.size);
  c.lives = 12 + n * 4;
  c.maxLives = Math.round(c.lives * 1.6);
  c.credits = 0;
  c.chaosMeter = 0;
  c.combo = 0;
  c.wave = 0;
  c.nextWave = 1;
  c.breakEndsAt = 0;
  c.gameOverAt = 0;
  c.pinataSpawned = false;
  c.runStartedAt = Date.now();
  startCoopWave(room, 1);
}

function pickCoopMutator(wave) {
  if (wave <= 0 || wave % COOP_MUTATOR_EVERY !== 0) {
    return "none";
  }
  const keys = Object.keys(COOP_MUTATORS).filter((key) => key !== "none");
  return randomChoice(keys);
}

function startCoopWave(room, waveNum) {
  const c = room.coop;
  c.phase = "wave";
  c.wave = waveNum;
  c.pinataSpawned = false;
  c.chaosMeter = Math.min(85, c.chaosMeter);

  c.mutatorKey = pickCoopMutator(waveNum);
  c.mutator = COOP_MUTATORS[c.mutatorKey] || COOP_MUTATORS.none;

  const m = c.mutator;
  const base = 7 + waveNum * 2.6 + (waveNum > 6 ? waveNum * 0.35 : 0);
  const count = Math.max(5, Math.round(base * (m.count || 1)));

  room.bots.clear();
  room.boss = null;

  for (let i = 0; i < count; i += 1) {
    spawnCoopBot(room, waveNum, i, count);
  }

  broadcast(room, {
    type: "event",
    event: "coop-wave-start",
    wave: waveNum,
    mutatorKey: c.mutatorKey,
    mutatorLabel: m.label,
    enemies: count
  });
}

function spawnCoopBot(room, wave, index, total) {
  const c = room.coop;
  const m = c.mutator;
  const scaleHp = 1 + (wave - 1) * 0.11;
  const scaleDmg = Math.min(2.35, 1 + (wave - 1) * 0.068);
  const scaleSpeed = Math.min(1.62, 1 + (wave - 1) * 0.038);

  const keys = ["swarm", "tank", "sniper", "bomber"];
  const variantKey =
    wave >= 8 && total > 2 && index === Math.floor(total / 2) ? "tank" : randomChoice(keys);
  const variant = BOT_VARIANTS[variantKey];

  let hp = Math.round(variant.hp * scaleHp * (m.hp || 1));
  let damage = Math.round(variant.damage * scaleDmg * (m.damage || 1));
  let speed = variant.speed * scaleSpeed * (m.speed || 1);
  const attackMs = Math.max(320, Math.round(variant.attackMs * Math.max(0.82, 1 - (wave - 1) * 0.022)));

  const t = total <= 1 ? 0.5 : index / Math.max(1, total - 1);
  const angle = t * Math.PI * 2 + Math.random() * 0.55;
  const radius = 198 + Math.random() * 76;
  const x = clamp(Math.cos(angle) * radius, -MAP_LIMIT + 10, MAP_LIMIT - 10);
  const z = clamp(Math.sin(angle) * radius, -MAP_LIMIT + 10, MAP_LIMIT - 10);
  const y = terrainHeightAt(x, z) + 1.4;

  const bot = {
    id: `coop-${randomId(10)}`,
    type: "bot",
    variant: variantKey,
    name: variant.name,
    color: variant.color,
    position: { x, y, z },
    yaw: Math.atan2(-x, -z),
    hp,
    maxHp: hp,
    alive: true,
    lastAttackAt: 0,
    attackMs,
    damage,
    speed,
    radius: variant.radius,
    coop: true
  };

  room.bots.set(bot.id, bot);
}

function spawnCoopPinata(room) {
  const wave = room.coop.wave;
  const x = clamp((Math.random() - 0.5) * 52, -MAP_LIMIT + 14, MAP_LIMIT - 14);
  const z = clamp((Math.random() - 0.5) * 52, -MAP_LIMIT + 14, MAP_LIMIT - 14);
  const y = terrainHeightAt(x, z) + 1.4;
  const hp = Math.round(240 + wave * 46);

  const bot = {
    id: `pinata-${randomId(8)}`,
    type: "bot",
    variant: "tank",
    name: "Golden Piñata",
    color: "#ffd93d",
    position: { x, y, z },
    yaw: 0,
    hp,
    maxHp: hp,
    alive: true,
    lastAttackAt: 0,
    attackMs: 880,
    damage: Math.round(13 + wave * 2.1),
    speed: 0.5,
    radius: 1.05,
    coop: true,
    pinata: true
  };

  room.bots.set(bot.id, bot);
}

function dropPinataLoot(room, position) {
  const boosts = ["heal", "armor", "speed-boost", "damage-boost", "jump-boost"];
  const weapons = ["shotgun", "machinegun", "bazooka"];
  for (let i = 0; i < 4; i += 1) {
    const boost = randomChoice(boosts);
    room.pickups.push({
      id: randomId(10),
      type: "boost",
      weapon: boost,
      boost,
      position: {
        x: position.x + (Math.random() - 0.5) * 8,
        y: position.y + 0.35,
        z: position.z + (Math.random() - 0.5) * 8
      }
    });
  }
  for (let i = 0; i < 2; i += 1) {
    room.pickups.push({
      id: randomId(10),
      weapon: randomChoice(weapons),
      position: {
        x: position.x + (Math.random() - 0.5) * 10,
        y: position.y + 0.9,
        z: position.z + (Math.random() - 0.5) * 10
      }
    });
  }
  room.updatedAt = Date.now();
}

function addCoopKill(room, killer, target) {
  if (room.gameMode !== "coop") return;
  const c = room.coop;
  if (c.phase !== "wave") return;

  const now = Date.now();
  if (now - c.lastKillAt < COOP_COMBO_WINDOW_MS) {
    c.combo += 1;
  } else {
    c.combo = 1;
  }
  c.lastKillAt = now;

  const gained = target.pinata
    ? 95 + c.wave * 8
    : 14 + c.combo * 6 + Math.floor(c.wave * 1.4);
  c.credits += gained;

  if (!target.pinata) {
    const chaosGain = 10 + Math.min(20, c.combo * 2);
    c.chaosMeter = Math.min(COOP_CHAOS_THRESHOLD, c.chaosMeter + chaosGain);
  }

  if (!c.pinataSpawned && c.chaosMeter >= COOP_CHAOS_THRESHOLD && c.phase === "wave") {
    c.chaosMeter = 0;
    c.pinataSpawned = true;
    spawnCoopPinata(room);
    broadcast(room, { type: "event", event: "coop-chaos-full", wave: c.wave });
  }
}

function spawnCoopWaveBonusPickups(room) {
  const spots = [
    { x: 0, z: 0 },
    { x: 9, z: 0 },
    { x: -9, z: 0 },
    { x: 0, z: 9 },
    { x: 0, z: -9 }
  ];
  const boosts = ["heal", "armor", "damage-boost"];
  spots.forEach((spot, index) => {
    const x = spot.x + (Math.random() - 0.5) * 4;
    const z = spot.z + (Math.random() - 0.5) * 4;
    const y = walkableHeightAt(x, z, room.obstacles) + 1.05;
    if (index < 3) {
      const boost = boosts[index];
      room.pickups.push({
        id: randomId(10),
        type: "boost",
        weapon: boost,
        boost,
        position: { x, y, z }
      });
    } else {
      room.pickups.push({
        id: randomId(10),
        weapon: randomChoice(PICKUP_WEAPONS),
        position: { x, y, z }
      });
    }
  });
  room.updatedAt = Date.now();
}

function maybeFinishCoopWave(room) {
  if (room.gameMode !== "coop") return;
  if (room.coop.phase !== "wave") return;
  if (room.bots.size > 0) return;

  const c = room.coop;
  const completed = c.wave;
  c.phase = "between";
  c.breakEndsAt = Date.now() + COOP_BREAK_MS;
  c.nextWave = completed + 1;
  c.combo = 0;
  c.chaosMeter = Math.min(95, c.chaosMeter + 12);

  c.lives = Math.min(c.maxLives, c.lives + 3);

  for (const player of room.players.values()) {
    if (player.alive) player.hp = player.maxHp;
  }

  spawnCoopWaveBonusPickups(room);

  broadcast(room, {
    type: "event",
    event: "coop-wave-clear",
    completedWave: completed,
    nextWave: c.nextWave,
    breakMs: COOP_BREAK_MS
  });
}

function updateCoopRoom(room, now) {
  if (room.gameMode !== "coop") return;
  const c = room.coop;

  if (c.phase === "gameover" && c.gameOverAt > 0 && now >= c.gameOverAt) {
    resetCoopAfterGameOver(room);
    return;
  }

  if (c.phase === "between" && c.breakEndsAt > 0 && now >= c.breakEndsAt) {
    startCoopWave(room, c.nextWave);
  }
}

function coopPlayerDown(room) {
  const c = room.coop;
  if (c.phase === "gameover") return;
  c.lives = Math.max(0, c.lives - 1);
  broadcast(room, {
    type: "event",
    event: "coop-life-lost",
    lives: c.lives,
    maxLives: c.maxLives
  });
  if (c.lives <= 0) {
    endCoopGame(room);
  }
}

function endCoopGame(room) {
  const c = room.coop;
  c.phase = "gameover";
  c.gameOverAt = Date.now() + 14000;
  broadcast(room, {
    type: "event",
    event: "coop-game-over",
    wave: c.wave,
    credits: c.credits,
    restartAt: c.gameOverAt
  });
}

function resetCoopAfterGameOver(room) {
  room.boss = null;
  room.bots.clear();
  room.pickups = [];
  replenishPickups(room);
  room.coop = createCoopState(room.players.size);
  for (const player of room.players.values()) {
    player.kills = 0;
    player.deaths = 0;
    player.streak = 0;
    if (player.spawned) {
      spawnPlayer(room, player, true);
    }
  }
}

function handleFire(room, shooter, msg) {
  const now = Date.now();
  if (!shooter.alive) return;
  if (shooter.isGoat) return;
  if (room.gameMode === "pvp" && room.match.phase !== "playing") return;
  if (room.gameMode === "coop" && room.coop.phase === "gameover") return;

  const firedWeaponName = shooter.currentWeapon;
  const weapon = WEAPONS[firedWeaponName] || WEAPONS.pistol;
  if (now - shooter.lastFireAt < weapon.reloadMs) return;
  if (!weapon.infinite && shooter.ammo <= 0) {
    shooter.currentWeapon = "pistol";
    shooter.ammo = 0;
    send(shooter.ws, { type: "event", event: "weapon-empty", player: publicPlayer(shooter) });
    return;
  }

  shooter.lastFireAt = now;
  if (!weapon.infinite) {
    shooter.ammo -= 1;
    if (shooter.ammo <= 0) {
      shooter.currentWeapon = "pistol";
      shooter.ammo = 0;
      send(shooter.ws, { type: "event", event: "weapon-empty", player: publicPlayer(shooter) });
    }
  }

  const direction = normalizeVector(msg.direction);
  if (!direction) return;

  const origin = {
    x: shooter.position.x,
    y: shooter.position.y,
    z: shooter.position.z
  };

  const projectiles = [];
  // One trigger pull can create several damage sources: shotgun pellets,
  // bazooka splash, and direct hits. Merge them by target before applying HP.
  const damageByTarget = new Map();

  for (let i = 0; i < weapon.pellets; i += 1) {
    const shotDirection = weapon.spread > 0 ? spreadDirection(direction, weapon.spread) : direction;
    const obstacleHit = rayHitsObstacles(origin, shotDirection, room.obstacles, weapon.range);
    const direct = findDirectHit(room, shooter, shotDirection, obstacleHit ? obstacleHit.distance : weapon.range);
    const impactDistance = direct
      ? direct.distance
      : obstacleHit
        ? obstacleHit.distance
        : weapon.tracerLength;
    const projectile = {
      direction: shotDirection,
      length: Math.min(weapon.tracerLength, impactDistance),
      hitPoint: pointAlong(origin, shotDirection, impactDistance),
      blockedByObject: !!obstacleHit && (!direct || obstacleHit.distance <= direct.distance)
    };

    if (direct) {
      applyDamageMap(damageByTarget, direct.target, direct.part, weapon, currentDamageMultiplier(shooter));
    }

    if (weapon === WEAPONS.bazooka) {
      const center = projectile.hitPoint;
      projectile.explosion = { x: center.x, y: center.y, z: center.z, radius: weapon.splashRadius };

      for (const target of room.players.values()) {
        if (room.gameMode === "coop") continue;
        if (target.id === shooter.id || !target.alive) continue;
        if (target.invulnerableUntil > now) continue;

        const distance = distance3(center, target.position);
        if (distance <= weapon.splashRadius) {
          const falloff = 1 - distance / weapon.splashRadius;
          applyDamageMap(damageByTarget, target, "body", {
            bodyDamage: Math.round(weapon.splashDamage * (0.45 + falloff * 0.55)),
            headDamage: Math.round(weapon.splashDamage * (0.45 + falloff * 0.55))
          }, currentDamageMultiplier(shooter));
        }
      }

      for (const target of aiTargets(room)) {
        if (!target.alive) continue;
        const distance = distance3(center, target.position);
        if (distance <= weapon.splashRadius) {
          const falloff = 1 - distance / weapon.splashRadius;
          applyDamageMap(damageByTarget, target, "body", {
            bodyDamage: Math.round(weapon.splashDamage * (0.45 + falloff * 0.55)),
            headDamage: Math.round(weapon.splashDamage * (0.45 + falloff * 0.55))
          }, currentDamageMultiplier(shooter));
        }
      }
    }

    projectiles.push(projectile);
  }

  const hits = [];
  let killed = false;

  for (const [targetId, hit] of damageByTarget) {
    const target = getDamageTarget(room, targetId);
    if (!target || !target.alive) continue;

    const damage = Math.min(target.hp, hit.damage);
    target.hp = Math.max(0, target.hp - hit.damage);
    hits.push({
      id: target.id,
      damage,
      part: hit.headshot ? "head" : "body"
    });

    if (target.hp <= 0) {
      const victimWasPlayer = room.players.has(target.id);
      killTarget(room, target, shooter);
      shooter.kills += 1;
      if (!shooter.isGoat) {
        shooter.hp = shooter.maxHp;
      }
      shooter.streak += 1;
      if (shooter.streak >= 3) shooter.revealUntil = now + 5000;
      killed = true;
      if (victimWasPlayer && room.gameMode === "pvp") {
        maybeEnterGoatMode(room, shooter);
      }
    }
  }

  const firstHit = hits[0];
  broadcast(room, {
    type: "event",
    event: "shot",
    shooterId: shooter.id,
    weapon: firedWeaponName,
    origin,
    direction,
    projectiles,
    hits,
    hitId: firstHit ? firstHit.id : null,
    hitPart: firstHit ? firstHit.part : null,
    damage: firstHit ? firstHit.damage : 0,
    killed,
    shooter: publicPlayer(shooter)
  });

  if (room.gameMode === "pvp" && shooter.kills >= KILL_LIMIT && room.match.phase === "playing") {
    finishMatch(room, shooter);
  }
}

function findDirectHit(room, shooter, direction, range) {
  let best = null;
  for (const target of combatTargets(room)) {
    if (target.id === shooter.id || !target.alive) continue;
    if (room.gameMode === "coop" && room.players.has(target.id)) continue;
    if (target.invulnerableUntil > Date.now()) continue;

    const hit = rayHitsPlayer(shooter.position, direction, target, range);
    if (!hit) continue;
    if (!best || hit.distance < best.distance) {
      best = { target, distance: hit.distance, part: hit.part };
    }
  }

  return best;
}

function applyDamageMap(damageByTarget, target, part, weapon, multiplier) {
  const current = damageByTarget.get(target.id) || { damage: 0, headshot: false };
  const base = part === "head" ? weapon.headDamage : weapon.bodyDamage;
  const armor = target.armorUntil && target.armorUntil > Date.now() ? 0.65 : 1;
  current.damage += Math.max(1, Math.round(base * multiplier * armor));
  current.headshot = current.headshot || part === "head";
  damageByTarget.set(target.id, current);
}

function pickupWithinReach(player, pickup) {
  const dx = player.position.x - pickup.position.x;
  const dz = player.position.z - pickup.position.z;
  const h = Math.hypot(dx, dz);
  const dy = Math.abs(player.position.y - pickup.position.y);
  return h <= PICKUP_RADIUS_XZ && dy <= PICKUP_Y_TOLERANCE;
}

function applyPickupToPlayer(room, player, pickupId) {
  if (!player.alive) return false;
  if (room.gameMode === "pvp" && room.match.phase !== "playing") return false;
  if (room.gameMode === "coop" && room.coop.phase === "gameover") return false;

  const pickup = room.pickups.find((item) => item.id === pickupId);
  if (!pickup) return false;
  if (!pickupWithinReach(player, pickup)) return false;

  room.pickups = room.pickups.filter((item) => item.id !== pickup.id);
  if (pickup.type === "nuke") {
    player.nukes += 1;
  } else if (pickup.type === "boost") {
    applyBoostPickup(player, pickup.boost);
  } else {
    player.currentWeapon = pickup.weapon;
    player.ammo = WEAPONS[pickup.weapon].ammo;
  }
  room.updatedAt = Date.now();

  broadcast(room, {
    type: "event",
    event: "pickup",
    player: publicPlayer(player),
    pickup: publicPickup(pickup)
  });
  return true;
}

function handlePickup(room, player, pickupId) {
  applyPickupToPlayer(room, player, pickupId);
}

function processProximityPickups(room) {
  for (const player of room.players.values()) {
    let guard = 0;
    while (guard < 32) {
      guard += 1;
      let best = null;
      let bestD = Infinity;
      for (const pickup of room.pickups) {
        if (!pickupWithinReach(player, pickup)) continue;
        const dx = player.position.x - pickup.position.x;
        const dz = player.position.z - pickup.position.z;
        const h = Math.hypot(dx, dz);
        if (h < bestD) {
          bestD = h;
          best = pickup;
        }
      }
      if (!best) break;
      if (!applyPickupToPlayer(room, player, best.id)) break;
    }
  }
}

function goatCooldownRemaining(lastAt, cdMs) {
  const elapsed = Date.now() - lastAt;
  return Math.max(0, cdMs - elapsed);
}

function maybeEnterGoatMode(room, shooter) {
  if (room.gameMode !== "pvp") return;
  if (shooter.kills < 10 || shooter.kills % 10 !== 0) return;
  shooter.isGoat = true;
  shooter.goatTier = Math.floor(shooter.kills / 10);
  shooter.maxHp = GOAT_HP;
  shooter.hp = GOAT_HP;
  shooter.goatRamAt = 0;
  shooter.goatSwarmAt = 0;
  shooter.goatFreezeAt = 0;
  shooter.goatBlindAt = 0;
  broadcast(room, {
    type: "event",
    event: "goat-mode",
    player: publicPlayer(shooter),
    tier: shooter.goatTier
  });
}

function handleGoatAbility(room, player, msg) {
  const now = Date.now();
  if (!player.alive || !player.isGoat || room.gameMode !== "pvp" || room.match.phase !== "playing") {
    return;
  }

  const ability = msg.ability;
  if (ability === "ram") {
    if (goatCooldownRemaining(player.goatRamAt, GOAT_CD_RAM) > 0) return;
    const dir = normalizeVector({
      x: msg.direction?.x || 0,
      y: 0,
      z: msg.direction?.z || 0
    });
    if (!dir) return;
    player.goatRamAt = now;
    player.position.x += dir.x * GOAT_RAM_RANGE * 0.62;
    player.position.z += dir.z * GOAT_RAM_RANGE * 0.62;
    player.position.x = clamp(player.position.x, -MAP_LIMIT, MAP_LIMIT);
    player.position.z = clamp(player.position.z, -MAP_LIMIT, MAP_LIMIT);
    player.position = resolveAgainstObstacles(player.position, PLAYER_RADIUS, room.obstacles);

    const ramHits = [];
    for (const other of room.players.values()) {
      if (other.id === player.id || !other.alive) continue;
      if (distance3(player.position, other.position) <= 5.8) {
        other.hp = Math.max(0, other.hp - GOAT_RAM_DAMAGE);
        ramHits.push({ id: other.id, damage: GOAT_RAM_DAMAGE });
        other.position.x += dir.x * 3.5;
        other.position.z += dir.z * 3.5;
        other.position.x = clamp(other.position.x, -MAP_LIMIT, MAP_LIMIT);
        other.position.z = clamp(other.position.z, -MAP_LIMIT, MAP_LIMIT);
        other.position = resolveAgainstObstacles(other.position, PLAYER_RADIUS, room.obstacles);
        if (other.hp <= 0) {
          killTarget(room, other, player);
          player.kills += 1;
          maybeEnterGoatMode(room, player);
        }
      }
    }

    broadcast(room, {
      type: "event",
      event: "goat-ram",
      playerId: player.id,
      direction: dir,
      hits: ramHits,
      player: publicPlayer(player)
    });
    return;
  }

  if (ability === "swarm") {
    if (goatCooldownRemaining(player.goatSwarmAt, GOAT_CD_SWARM) > 0) return;
    player.goatSwarmAt = now;
    const count = Math.min(8, 2 + Math.floor(player.goatTier));
    const seeds = [];
    for (let i = 0; i < count; i += 1) {
      const ang = (i / Math.max(1, count)) * Math.PI * 2 + Math.random() * 0.35;
      seeds.push({
        x: player.position.x + Math.cos(ang) * (3.5 + Math.random() * 2),
        z: player.position.z + Math.sin(ang) * (3.5 + Math.random() * 2),
        phase: Math.random() * Math.PI * 2
      });
    }
    broadcast(room, {
      type: "event",
      event: "goat-swarm",
      playerId: player.id,
      tier: player.goatTier,
      seeds,
      ttl: 5200
    });
    return;
  }

  if (ability === "freeze") {
    if (goatCooldownRemaining(player.goatFreezeAt, GOAT_CD_FREEZE) > 0) return;
    player.goatFreezeAt = now;
    for (const other of room.players.values()) {
      if (other.id === player.id || !other.alive) continue;
      if (distance3(player.position, other.position) <= GOAT_FREEZE_RADIUS) {
        other.frozenUntil = now + GOAT_FREEZE_MS;
      }
    }
    broadcast(room, {
      type: "event",
      event: "goat-freeze",
      playerId: player.id,
      radius: GOAT_FREEZE_RADIUS
    });
    return;
  }

  if (ability === "blind") {
    if (goatCooldownRemaining(player.goatBlindAt, GOAT_CD_BLIND) > 0) return;
    player.goatBlindAt = now;
    const candidates = [...room.players.values()].filter(
      (p) => p.id !== player.id && p.alive && distance3(player.position, p.position) <= GOAT_BLIND_RADIUS
    );
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const victims = candidates.slice(0, GOAT_BLIND_COUNT);
    for (const v of victims) {
      send(v.ws, {
        type: "event",
        event: "goat-blind-you",
        memeIndex: Math.floor(Math.random() * 10),
        by: player.name
      });
    }
    broadcast(room, {
      type: "event",
      event: "goat-blind",
      playerId: player.id,
      victimIds: victims.map((v) => v.id)
    });
    return;
  }
}

function applyPlayerState(room, player, msg) {
  if (!player.alive) return;

  const now = Date.now();
  const frozen = player.frozenUntil > now;

  // Rotation stays live while frozen so a frozen player can still look around.
  if (Number.isFinite(msg.yaw)) {
    player.yaw = clamp(msg.yaw, -Math.PI * 4, Math.PI * 4);
  }

  if (Number.isFinite(msg.pitch)) {
    player.pitch = clamp(msg.pitch, -1.35, 1.35);
  }

  if (frozen) return;

  // Movement is client-predicted for feel, then bounded here by map limits,
  // walkable castle platform height, and authoritative obstacle collision.
  const next = msg.position || {};
  if (
    Number.isFinite(next.x) &&
    Number.isFinite(next.y) &&
    Number.isFinite(next.z)
  ) {
    const floorY = walkableHeightAt(next.x, next.z, room.obstacles, next.y) + 2;
    player.position = {
      x: clamp(next.x, -MAP_LIMIT, MAP_LIMIT),
      y: clamp(next.y, floorY, 34),
      z: clamp(next.z, -MAP_LIMIT, MAP_LIMIT)
    };
    player.position = resolveAgainstObstacles(player.position, PLAYER_RADIUS, room.obstacles);
  }
}

function applyPowerup(player, powerupName) {
  const powerup = POWERUPS[powerupName] || POWERUPS.none;
  player.powerup = POWERUPS[powerupName] ? powerupName : "none";
  player.speedMultiplier = powerup.speedMultiplier;
  player.damageMultiplier = powerup.damageMultiplier;
  const hpPct = player.maxHp > 0 ? player.hp / player.maxHp : 1;
  player.maxHp = powerup.maxHp;
  player.hp = Math.min(player.maxHp, Math.max(1, Math.round(player.maxHp * hpPct)));
}

function respawn(player) {
  player.position = randomSpawn();
  player.currentWeapon = "pistol";
  player.ammo = 0;
  player.nukes = 0;
  player.hp = player.maxHp;
  player.alive = true;
  player.invulnerableUntil = Date.now() + 1600;
  player.respawnAt = 0;
}

function spawnPlayer(room, player, firstSpawn) {
  // Per-life reset. Scores and selected powerup stay, but temporary combat
  // state and weapons reset so every life starts from the same pistol baseline.
  player.isGoat = false;
  player.goatTier = 0;
  player.frozenUntil = 0;
  player.goatRamAt = 0;
  player.goatSwarmAt = 0;
  player.goatFreezeAt = 0;
  player.goatBlindAt = 0;
  applyPowerup(player, player.powerup);
  player.position = randomSafeSpawn(room);
  player.currentWeapon = "pistol";
  player.ammo = 0;
  if (!firstSpawn) player.nukes = 0;
  player.hp = player.maxHp;
  player.alive = true;
  player.spawned = true;
  player.streak = 0;
  player.invulnerableUntil = Date.now() + 2200;
  player.respawnAt = 0;

  if (room.gameMode === "coop" && room.coop.phase === "lobby") {
    beginCoopRun(room);
  }
}

function rayHitsPlayer(origin, direction, target, range = MAX_HIT_DISTANCE) {
  const headHit = rayHitsZone(origin, direction, target, {
    part: "head",
    offsetY: 0.12,
    radius: 0.48,
    range
  });
  if (headHit) return headHit;

  const bodyZones = [
    { part: "body", offsetY: -0.38, radius: PLAYER_RADIUS, range },
    { part: "body", offsetY: -0.82, radius: PLAYER_RADIUS, range },
    { part: "body", offsetY: -1.22, radius: 0.54, range }
  ];
  let bestBody = null;

  for (const zone of bodyZones) {
    const bodyHit = rayHitsZone(origin, direction, target, zone);
    if (bodyHit && (!bestBody || bodyHit.distance < bestBody.distance)) {
      bestBody = bodyHit;
    }
  }

  return bestBody;
}

function rayHitsZone(origin, direction, target, zone) {
  const point = {
    x: target.position.x,
    y: target.position.y + zone.offsetY,
    z: target.position.z
  };
  const hit = distanceFromRay(origin, direction, point);

  if (
    hit.distanceFromRay <= zone.radius &&
    hit.distanceAlongRay > 0.6 &&
    hit.distanceAlongRay <= zone.range
  ) {
    return {
      distance: hit.distanceAlongRay,
      part: zone.part
    };
  }

  return null;
}

function distanceFromRay(origin, direction, point) {
  const ox = point.x - origin.x;
  const oy = point.y - origin.y;
  const oz = point.z - origin.z;
  const distanceAlongRay = ox * direction.x + oy * direction.y + oz * direction.z;
  const cx = origin.x + direction.x * distanceAlongRay;
  const cy = origin.y + direction.y * distanceAlongRay;
  const cz = origin.z + direction.z * distanceAlongRay;

  return {
    distanceAlongRay,
    distanceFromRay: Math.hypot(point.x - cx, point.y - cy, point.z - cz)
  };
}

function normalizeVector(vec = {}) {
  if (
    !Number.isFinite(vec.x) ||
    !Number.isFinite(vec.y) ||
    !Number.isFinite(vec.z)
  ) {
    return null;
  }

  const length = Math.hypot(vec.x, vec.y, vec.z);
  if (length < 0.001) return null;

  return {
    x: vec.x / length,
    y: vec.y / length,
    z: vec.z / length
  };
}

function spreadDirection(direction, spread) {
  return normalizeVector({
    x: direction.x + (Math.random() - 0.5) * spread,
    y: direction.y + (Math.random() - 0.5) * spread,
    z: direction.z + (Math.random() - 0.5) * spread
  });
}

function publicPlayer(player) {
  // Snapshots use public serializers so server-only fields such as ws handles
  // never leave the backend.
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    position: player.position,
    yaw: player.yaw,
    pitch: player.pitch,
    hp: player.hp,
    maxHp: player.maxHp,
    kills: player.kills,
    deaths: player.deaths,
    alive: player.alive,
    respawnAt: player.respawnAt,
    currentWeapon: player.currentWeapon,
    ammo: player.ammo,
    nukes: player.nukes,
    powerup: player.powerup,
    speedMultiplier: currentSpeedMultiplier(player),
    armorUntil: player.armorUntil,
    speedBoostUntil: player.speedBoostUntil,
    damageBoostUntil: player.damageBoostUntil,
    jumpBoostUntil: player.jumpBoostUntil,
    streak: player.streak,
    revealUntil: player.revealUntil,
    spawned: player.spawned,
    isGoat: !!player.isGoat,
    goatTier: player.goatTier || 0,
    frozenUntil: player.frozenUntil || 0,
    goatCdRam: goatCooldownRemaining(player.goatRamAt || 0, GOAT_CD_RAM),
    goatCdSwarm: goatCooldownRemaining(player.goatSwarmAt || 0, GOAT_CD_SWARM),
    goatCdFreeze: goatCooldownRemaining(player.goatFreezeAt || 0, GOAT_CD_FREEZE),
    goatCdBlind: goatCooldownRemaining(player.goatBlindAt || 0, GOAT_CD_BLIND)
  };
}

function publicPickup(pickup) {
  return {
    id: pickup.id,
    type: pickup.type || "weapon",
    weapon: pickup.weapon,
    boost: pickup.boost,
    position: pickup.position
  };
}

function publicBot(bot) {
  return {
    id: bot.id,
    type: bot.type,
    name: bot.name,
    position: bot.position,
    yaw: bot.yaw,
    hp: bot.hp,
    maxHp: bot.maxHp,
    alive: bot.alive,
    color: bot.color,
    pinata: !!bot.pinata
  };
}

function publicMatch(room) {
  if (room.gameMode === "coop") {
    const c = room.coop;
    return {
      mode: "coop",
      phase: c.phase,
      wave: c.wave,
      nextWave: c.nextWave,
      breakEndsAt: c.breakEndsAt,
      chaosMeter: c.chaosMeter,
      credits: c.credits,
      combo: c.combo,
      lives: c.lives,
      maxLives: c.maxLives,
      mutatorKey: c.mutatorKey,
      mutatorLabel: c.mutator ? c.mutator.label : "",
      enemiesLeft: room.bots.size,
      killLimit: null,
      round: c.wave,
      endsAt: null,
      restartAt: c.gameOverAt || null,
      winner: null
    };
  }

  return {
    mode: "pvp",
    phase: room.match.phase,
    round: room.match.round,
    startedAt: room.match.startedAt,
    endsAt: room.match.endsAt,
    winner: room.match.winner,
    restartAt: room.match.restartAt,
    killLimit: KILL_LIMIT
  };
}

function publicWeapons() {
  return Object.fromEntries(
    Object.entries(WEAPONS).map(([key, weapon]) => [key, {
      name: weapon.name,
      ammo: Number.isFinite(weapon.ammo) ? weapon.ammo : null,
      reloadMs: weapon.reloadMs,
      color: weapon.color
    }])
  );
}

function replenishPickups(room) {
  for (const weapon of PICKUP_WEAPONS) {
    const wanted = weapon === "bazooka" ? 2 : 4;
    const current = room.pickups.filter((pickup) => pickup.weapon === weapon).length;
    for (let i = current; i < wanted; i += 1) {
      room.pickups.push({
        id: randomId(10),
        weapon,
        position: randomPickupPosition()
      });
    }
  }

  for (const boost of BOOST_PICKUPS) {
    const current = room.pickups.filter((pickup) => pickup.type === "boost" && pickup.boost === boost).length;
    for (let i = current; i < 2; i += 1) {
      room.pickups.push({
        id: randomId(10),
        type: "boost",
        weapon: boost,
        boost,
        position: randomPickupPosition()
      });
    }
  }
}

function applyBoostPickup(player, boost) {
  const now = Date.now();
  if (boost === "heal") {
    if (player.isGoat) return;
    player.hp = player.maxHp;
  }
  if (boost === "armor") player.armorUntil = now + 20000;
  if (boost === "speed-boost") player.speedBoostUntil = now + 18000;
  if (boost === "damage-boost") player.damageBoostUntil = now + 18000;
  if (boost === "jump-boost") player.jumpBoostUntil = now + 25000;
}

function currentSpeedMultiplier(player) {
  return player.speedMultiplier * (player.speedBoostUntil && player.speedBoostUntil > Date.now() ? 1.45 : 1);
}

function currentDamageMultiplier(player) {
  return player.damageMultiplier * (player.damageBoostUntil && player.damageBoostUntil > Date.now() ? 1.5 : 1);
}

function updateMatch(room, now) {
  if (room.gameMode === "coop") return;

  if (room.match.phase === "playing" && now >= room.match.endsAt) {
    const winner = [...room.players.values()].sort((a, b) => b.kills - a.kills)[0] || null;
    finishMatch(room, winner);
  }

  if (room.match.phase === "ended" && now >= room.match.restartAt) {
    room.match = createMatchState(room.match.round + 1);
    room.bots.clear();
    room.boss = null;
    room.pickups = [];
    replenishPickups(room);

    for (const player of room.players.values()) {
      player.kills = 0;
      player.deaths = 0;
      player.streak = 0;
      if (player.spawned) spawnPlayer(room, player, true);
    }

    broadcast(room, { type: "event", event: "round-start", match: publicMatch(room) });
  }
}

function createMatchState(round = 1) {
  const now = Date.now();
  return {
    phase: "playing",
    round,
    startedAt: now,
    endsAt: now + MATCH_DURATION_MS,
    winner: null,
    restartAt: 0
  };
}

function finishMatch(room, winner) {
  room.match.phase = "ended";
  room.match.winner = winner ? { id: winner.id, name: winner.name, kills: winner.kills } : null;
  room.match.restartAt = Date.now() + ROUND_RESTART_MS;
  broadcast(room, { type: "event", event: "match-ended", match: publicMatch(room) });
}

function updateAi(room, now) {
  if (room.players.size === 0) return;

  if (room.gameMode === "pvp") {
    if (room.bots.size < MAX_BOTS && now >= room.nextBotAt) {
      spawnBot(room);
      room.nextBotAt = now + randomBetween(BOT_SPAWN_MIN_MS, BOT_SPAWN_MAX_MS);
    }

    if ((!room.boss || !room.boss.alive) && now >= room.nextBossAt) {
      spawnBoss(room);
      room.nextBossAt = now + BOSS_SPAWN_MS;
    }
  }

  // Simple authoritative AI: the server moves enemies, resolves collisions, and
  // applies melee damage so every browser sees the same fight.
  for (const bot of aiTargets(room)) {
    if (!bot.alive) continue;
    const target = nearestAlivePlayer(room, bot.position);
    if (!target) continue;
    const dx = target.position.x - bot.position.x;
    const dz = target.position.z - bot.position.z;
    const distance = Math.hypot(dx, dz);
    bot.yaw = Math.atan2(dx, dz);

    const speed = bot.type === "boss" ? 0.18 : bot.speed;
    if (distance > (bot.type === "boss" ? 8 : 2.4)) {
      bot.position.x += (dx / distance) * speed;
      bot.position.z += (dz / distance) * speed;
      bot.position = resolveAgainstObstacles(bot.position, bot.type === "boss" ? 1.55 : bot.radius, room.obstacles);
      bot.position.x = clamp(bot.position.x, -MAP_LIMIT, MAP_LIMIT);
      bot.position.z = clamp(bot.position.z, -MAP_LIMIT, MAP_LIMIT);
      bot.position.y = walkableHeightAt(bot.position.x, bot.position.z, room.obstacles) + (bot.type === "boss" ? 3.4 : 1.4);
    }

    if (distance <= (bot.type === "boss" ? 9 : 3) && now - bot.lastAttackAt > bot.attackMs) {
      bot.lastAttackAt = now;
      const damage = bot.type === "boss" ? 28 : bot.damage;
      target.hp = Math.max(0, target.hp - damage);
      if (target.hp <= 0) {
        target.alive = false;
        target.deaths += 1;
        target.respawnAt = 0;
        if (room.gameMode === "coop") {
          coopPlayerDown(room);
        }
      }
      broadcast(room, {
        type: "event",
        event: "ai-hit",
        attacker: publicBot(bot),
        target: publicPlayer(target),
        damage
      });
    }
  }
}

function spawnBot(room) {
  const position = randomPickupPosition();
  position.y = terrainHeightAt(position.x, position.z) + 1.4;
  const variantKey = randomChoice(Object.keys(BOT_VARIANTS));
  const variant = BOT_VARIANTS[variantKey];
  const bot = {
    id: `bot-${randomId(8)}`,
    type: "bot",
    variant: variantKey,
    name: variant.name,
    color: variant.color,
    position,
    yaw: 0,
    hp: variant.hp,
    maxHp: variant.hp,
    alive: true,
    lastAttackAt: 0,
    attackMs: variant.attackMs,
    damage: variant.damage,
    speed: variant.speed,
    radius: variant.radius
  };
  room.bots.set(bot.id, bot);
  broadcast(room, { type: "event", event: "bot-spawn", bot: publicBot(bot) });
}

function spawnBoss(room) {
  const position = randomSpawn();
  position.y = terrainHeightAt(position.x, position.z) + 3.4;
  room.boss = {
    id: `boss-${randomId(8)}`,
    type: "boss",
    name: "Boss",
    position,
    yaw: 0,
    hp: 900,
    maxHp: 900,
    alive: true,
    lastAttackAt: 0,
    attackMs: 1500
  };
  broadcast(room, { type: "event", event: "boss-spawn", boss: publicBot(room.boss) });
}

function useNuke(room, player) {
  if (!player.alive || player.nukes <= 0) return;
  if (player.isGoat) return;
  if (room.gameMode === "coop" && room.coop.phase === "gameover") return;
  player.nukes -= 1;

  const hits = [];
  for (const target of aiTargets(room)) {
    if (!target.alive) continue;
    const damage = Math.min(target.hp, NUKE_DAMAGE);
    target.hp = Math.max(0, target.hp - NUKE_DAMAGE);
    hits.push({ id: target.id, damage, part: "body" });
    if (target.hp <= 0) {
      killTarget(room, target, player);
      player.kills += 1;
      player.hp = player.maxHp;
    }
  }

  broadcast(room, {
    type: "event",
    event: "nuke",
    player: publicPlayer(player),
    origin: player.position,
    hits
  });
}

function combatTargets(room) {
  return [...room.players.values(), ...aiTargets(room)];
}

function aiTargets(room) {
  return [
    ...room.bots.values(),
    ...(room.boss && room.boss.alive ? [room.boss] : [])
  ];
}

function getDamageTarget(room, id) {
  return room.players.get(id) || room.bots.get(id) || (room.boss && room.boss.id === id ? room.boss : null);
}

function killTarget(room, target, killer = null) {
  target.alive = false;
  if (target.type === "bot") {
    if (room.gameMode === "coop") {
      const dropPos = { ...target.position };
      if (killer) {
        addCoopKill(room, killer, target);
      }
      if (target.pinata) {
        dropPinataLoot(room, dropPos);
      }
    }
    room.bots.delete(target.id);
    maybeFinishCoopWave(room);
    return;
  }

  if (target.type === "boss") {
    const drop = {
      id: randomId(10),
      type: "nuke",
      weapon: "nuke",
      position: { ...target.position, y: terrainHeightAt(target.position.x, target.position.z) + 1.2 }
    };
    room.pickups.push(drop);
    room.boss = null;
    broadcast(room, { type: "event", event: "boss-dead", pickup: publicPickup(drop) });
    return;
  }

  target.deaths += 1;
  target.streak = 0;
  // No auto-respawn: the browser must send another "play" command.
  target.respawnAt = 0;
}

function nearestAlivePlayer(room, position) {
  let best = null;
  for (const player of room.players.values()) {
    if (!player.alive) continue;
    const distance = distance3(position, player.position);
    if (!best || distance < best.distance) {
      best = { player, distance };
    }
  }
  return best && best.player;
}

function broadcast(room, payload) {
  const text = JSON.stringify(payload);
  for (const player of room.players.values()) {
    send(player.ws, text, true);
  }
}

function send(ws, payload, alreadyString = false) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(alreadyString ? payload : JSON.stringify(payload));
}

function randomSpawn() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 18 + Math.random() * 75;
  return {
    x: Math.cos(angle) * radius,
    y: terrainHeightAt(Math.cos(angle) * radius, Math.sin(angle) * radius) + 2,
    z: Math.sin(angle) * radius
  };
}

function randomSafeSpawn(room) {
  const alivePlayers = [...room.players.values()].filter((player) => player.alive);
  for (let i = 0; i < 80; i += 1) {
    let spawn = randomSpawn();
    spawn = resolveAgainstObstacles(spawn, PLAYER_RADIUS, room.obstacles);
    const tooClose = alivePlayers.some((player) => distance3(player.position, spawn) < 35);
    if (!tooClose) return spawn;
  }
  return randomSpawn();
}

function randomPickupPosition() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 20 + Math.random() * 145;
  const x = Math.cos(angle) * radius;
  const z = Math.sin(angle) * radius;
  return {
    x,
    y: terrainHeightAt(x, z) + 1.15,
    z
  };
}

function terrainHeightAt(x, z) {
  return (
    Math.sin(x * 0.018) * 0.62 +
    Math.cos(z * 0.021) * 0.52 +
    Math.sin((x + z) * 0.012) * 0.35 +
    Math.cos(Math.hypot(x, z) * 0.018) * 0.45
  );
}

function walkableHeightAt(x, z, obstacles = [], eyeY = Infinity) {
  let height = terrainHeightAt(x, z);
  for (const obstacle of obstacles) {
    if (obstacle.type !== "platform") continue;
    const insideX = Math.abs(x - obstacle.x) <= obstacle.w / 2;
    const insideZ = Math.abs(z - obstacle.z) <= obstacle.d / 2;
    if (!insideX || !insideZ) continue;
    if (eyeY < obstacle.y + obstacle.height + 1.1) continue;
    height = Math.max(height, obstacle.y + obstacle.height);
  }
  return height;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function buildObstacleLayout(roomId) {
  const rng = mulberry32(hashString(roomId));
  const obstacles = [];

  const platforms = [
    { x: -86, z: -106, w: 58, d: 42, height: 7.4 },
    { x: 86, z: 106, w: 58, d: 42, height: 7.4 },
    { x: 0, z: 0, w: 32, d: 32, height: 4.8 }
  ];

  for (const platform of platforms) {
    obstacles.push({
      type: "platform",
      x: platform.x,
      z: platform.z,
      y: terrainHeightAt(platform.x, platform.z),
      radius: Math.hypot(platform.w, platform.d) / 2,
      height: platform.height,
      w: platform.w,
      d: platform.d
    });
  }

  const jumpPads = [
    { x: -70, z: -82, boost: 24 },
    { x: 70, z: 82, boost: 24 },
    { x: -12, z: -8, boost: 20 },
    { x: 12, z: 8, boost: 20 }
  ];

  for (const jp of jumpPads) {
    const gy = terrainHeightAt(jp.x, jp.z);
    obstacles.push({
      type: "jumpPad",
      x: jp.x,
      z: jp.z,
      y: gy,
      radius: 2.85,
      boost: jp.boost
    });
  }

  const wallSegments = [
    { x: 0, z: -198, w: 340, d: 10 },
    { x: 0, z: 198, w: 340, d: 10 },
    { x: -198, z: 0, w: 10, d: 340 },
    { x: 198, z: 0, w: 10, d: 340 },
    { x: -122, z: -124, w: 6, d: 78 },
    { x: -50, z: -132, w: 70, d: 6 },
    { x: 122, z: 124, w: 6, d: 78 },
    { x: 50, z: 132, w: 70, d: 6 },
    { x: -108, z: 0, w: 6, d: 52 },
    { x: 108, z: 0, w: 6, d: 52 }
  ];

  for (const segment of wallSegments) {
    const steps = Math.max(2, Math.ceil(Math.max(segment.w, segment.d) / 8));
    for (let i = 0; i < steps; i += 1) {
      const t = steps === 1 ? 0.5 : i / (steps - 1);
      const x = segment.x + (t - 0.5) * segment.w;
      const z = segment.z + (t - 0.5) * segment.d;
      obstacles.push({
        type: "wall",
        x,
        z,
        y: terrainHeightAt(x, z),
        radius: 4.4,
        height: 7,
        w: segment.w,
        d: segment.d
      });
    }
  }

  const towers = [
    [-165, -165], [165, -165], [-165, 165], [165, 165]
  ];
  for (const [x, z] of towers) {
    obstacles.push({
      type: "tower",
      x,
      z,
      y: terrainHeightAt(x, z),
      radius: 6.8,
      height: 10
    });
  }

  const lawns = [
    { x: -120, z: -92 },
    { x: -150, z: -56 },
    { x: 120, z: 92 },
    { x: 150, z: 56 },
    { x: -26, z: -150 },
    { x: 26, z: 150 }
  ];
  for (const spot of lawns) {
    const x = spot.x + (rng() - 0.5) * 14;
    const z = spot.z + (rng() - 0.5) * 14;
    const trunkTop = 3 + rng() * 1.2;
    const canopy = 1.3 + rng() * 0.65;
    obstacles.push({
      type: "tree",
      x,
      z,
      y: terrainHeightAt(x, z),
      radius: Math.max(0.85, canopy * 0.62),
      height: trunkTop + canopy + 1.2,
      trunkHeight: trunkTop,
      canopyRadius: canopy
    });
  }

  const centerCrates = [
    [-22, -8], [-12, -6], [12, 6], [22, 8],
    [-38, 16], [38, -16], [-56, 0], [56, 0]
  ];
  for (const [x, z] of centerCrates) {
    obstacles.push({
      type: "crate",
      x,
      z,
      y: terrainHeightAt(x, z),
      radius: 2.45,
      height: 2.4,
      angle: Math.atan2(z, x)
    });
  }

  const vehicles = [
    { x: -28, z: 0, type: "bus", size: 4.8, scaleY: 0.62 },
    { x: 28, z: 0, type: "truck", size: 4.2, scaleY: 0.7 },
    { x: -82, z: 32, type: "car", size: 2.8, scaleY: 0.75 },
    { x: 82, z: -32, type: "car", size: 2.8, scaleY: 0.75 }
  ];
  for (const vehicle of vehicles) {
    const size = vehicle.size;
    const scaleY = vehicle.scaleY;
    const x = vehicle.x;
    const z = vehicle.z;
    obstacles.push({
      type: vehicle.type,
      x,
      z,
      y: terrainHeightAt(x, z),
      radius: size * 0.85,
      height: Math.max(1.2, size * scaleY),
      size,
      scaleY,
      rx: 0,
      ry: rng() * 0.5,
      rz: 0
    });
  }

  return obstacles;
}

function resolveAgainstObstacles(position, radius, obstacles = []) {
  const resolved = { ...position };
  for (const obstacle of obstacles) {
    if (obstacle.type === "jumpPad" || obstacle.type === "platform") continue;
    if (position.y - 2 > obstacle.y + obstacle.height - 0.25) continue;
    const dx = resolved.x - obstacle.x;
    const dz = resolved.z - obstacle.z;
    const distance = Math.hypot(dx, dz);
    const minDistance = radius + obstacle.radius;
    if (distance > 0.0001 && distance < minDistance) {
      const push = minDistance - distance;
      resolved.x += (dx / distance) * push;
      resolved.z += (dz / distance) * push;
    } else if (distance <= 0.0001) {
      resolved.x += minDistance;
    }
  }
  return resolved;
}

function rayHitsObstacles(origin, direction, obstacles = [], range) {
  let best = null;
  for (const obstacle of obstacles) {
    const hit = rayHitsObstacle(origin, direction, obstacle, range);
    if (hit && (!best || hit.distance < best.distance)) {
      best = hit;
    }
  }
  return best;
}

function rayHitsObstacle(origin, direction, obstacle, range) {
  if (obstacle.type === "jumpPad" || obstacle.type === "platform") return null;
  const ox = origin.x - obstacle.x;
  const oz = origin.z - obstacle.z;
  const dx = direction.x;
  const dz = direction.z;
  const a = dx * dx + dz * dz;
  if (a < 0.00001) return null;

  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - obstacle.radius * obstacle.radius;
  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) return null;

  const sqrt = Math.sqrt(discriminant);
  const t1 = (-b - sqrt) / (2 * a);
  const t2 = (-b + sqrt) / (2 * a);
  const distance = t1 > 0.4 ? t1 : t2 > 0.4 ? t2 : null;
  if (distance === null || distance > range) return null;

  const y = origin.y + direction.y * distance;
  if (y < obstacle.y || y > obstacle.y + obstacle.height) return null;

  return {
    distance,
    point: pointAlong(origin, direction, distance),
    obstacle
  };
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  return function random() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function pointAlong(origin, direction, distance) {
  return {
    x: origin.x + direction.x * distance,
    y: origin.y + direction.y * distance,
    z: origin.z + direction.z * distance
  };
}

function distance3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function randomColor(seed) {
  const hash = crypto.createHash("sha256").update(seed).digest();
  const hue = hash[0] / 255;
  const saturation = 0.66;
  const lightness = 0.55;
  return hslToHex(hue, saturation, lightness);
}

function hslToHex(h, s, l) {
  const hueToRgb = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const r = Math.round(hueToRgb(p, q, h + 1 / 3) * 255);
  const g = Math.round(hueToRgb(p, q, h) * 255);
  const b = Math.round(hueToRgb(p, q, h - 1 / 3) * 255);

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function toHex(value) {
  return value.toString(16).padStart(2, "0");
}

function cleanRoomId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 32);
}

function cleanName(value) {
  const name = String(value || "")
    .replace(/[^\w -]/g, "")
    .trim()
    .slice(0, 18);

  return name || `Player ${Math.floor(100 + Math.random() * 900)}`;
}

function randomId(size) {
  return crypto.randomBytes(size).toString("hex").slice(0, size);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
