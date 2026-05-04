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
const MAX_HIT_DISTANCE = 160;
const DAMAGE_PER_SHOT = 34;
const FIRE_COOLDOWN_MS = 145;
const RESPAWN_MS = 3000;
const STALE_ROOM_MS = 5 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

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
  const playerId = randomId(12);
  const room = getRoom(roomId);
  const spawn = randomSpawn();

  const player = {
    id: playerId,
    name: cleanName(url.searchParams.get("name")),
    color: randomColor(playerId),
    position: spawn,
    yaw: 0,
    pitch: 0,
    hp: 100,
    kills: 0,
    deaths: 0,
    alive: true,
    invulnerableUntil: Date.now() + 1600,
    respawnAt: 0,
    lastFireAt: 0,
    lastSeenAt: Date.now(),
    ws
  };

  room.players.set(player.id, player);
  room.updatedAt = Date.now();

  send(ws, {
    type: "welcome",
    id: player.id,
    room: room.id,
    player: publicPlayer(player)
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
      applyPlayerState(player, msg);
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

    if (msg.type === "fire") {
      handleFire(room, player, msg);
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
    for (const player of room.players.values()) {
      if (!player.alive && player.respawnAt <= now) {
        respawn(player);
        broadcast(room, {
          type: "event",
          event: "respawn",
          player: publicPlayer(player)
        });
      }
    }

    broadcast(room, {
      type: "snapshot",
      serverTime: now,
      players: Array.from(room.players.values()).map(publicPlayer)
    });

    if (room.players.size === 0 && now - room.updatedAt > STALE_ROOM_MS) {
      rooms.delete(room.id);
    }
  }
}, TICK_MS);

server.listen(PORT, HOST, () => {
  console.log(`Multiplayer shooter running at http://${HOST}:${PORT}`);
});

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      players: new Map(),
      updatedAt: Date.now()
    });
  }

  return rooms.get(roomId);
}

function handleFire(room, shooter, msg) {
  const now = Date.now();
  if (!shooter.alive) return;
  if (now - shooter.lastFireAt < FIRE_COOLDOWN_MS) return;
  shooter.lastFireAt = now;

  const direction = normalizeVector(msg.direction);
  if (!direction) return;

  const origin = {
    x: shooter.position.x,
    y: shooter.position.y,
    z: shooter.position.z
  };

  let best = null;
  for (const target of room.players.values()) {
    if (target.id === shooter.id || !target.alive) continue;
    if (target.invulnerableUntil > now) continue;

    const hit = rayHitsPlayer(origin, direction, target);
    if (!hit) continue;
    if (!best || hit.distance < best.distance) {
      best = { target, distance: hit.distance };
    }
  }

  const event = {
    type: "event",
    event: "shot",
    shooterId: shooter.id,
    origin,
    direction,
    hitId: best ? best.target.id : null,
    killed: false
  };

  if (best) {
    best.target.hp = Math.max(0, best.target.hp - DAMAGE_PER_SHOT);
    event.damage = DAMAGE_PER_SHOT;

    if (best.target.hp <= 0) {
      best.target.alive = false;
      best.target.deaths += 1;
      best.target.respawnAt = now + RESPAWN_MS;
      shooter.kills += 1;
      event.killed = true;
    }
  }

  broadcast(room, event);
}

function applyPlayerState(player, msg) {
  if (!player.alive) return;

  const next = msg.position || {};
  if (
    Number.isFinite(next.x) &&
    Number.isFinite(next.y) &&
    Number.isFinite(next.z)
  ) {
    player.position = {
      x: clamp(next.x, -MAP_LIMIT, MAP_LIMIT),
      y: clamp(next.y, 0.8, 5),
      z: clamp(next.z, -MAP_LIMIT, MAP_LIMIT)
    };
  }

  if (Number.isFinite(msg.yaw)) {
    player.yaw = clamp(msg.yaw, -Math.PI * 4, Math.PI * 4);
  }

  if (Number.isFinite(msg.pitch)) {
    player.pitch = clamp(msg.pitch, -1.35, 1.35);
  }
}

function respawn(player) {
  player.position = randomSpawn();
  player.hp = 100;
  player.alive = true;
  player.invulnerableUntil = Date.now() + 1600;
  player.respawnAt = 0;
}

function rayHitsPlayer(origin, direction, target) {
  const samples = [-1.35, -0.85, -0.35, 0.12, 0.36];
  let nearest = Infinity;

  for (const offsetY of samples) {
    const point = {
      x: target.position.x,
      y: target.position.y + offsetY,
      z: target.position.z
    };
    const hit = distanceFromRay(origin, direction, point);

    if (
      hit.distanceFromRay <= PLAYER_RADIUS &&
      hit.distanceAlongRay > 0.6 &&
      hit.distanceAlongRay <= MAX_HIT_DISTANCE
    ) {
      nearest = Math.min(nearest, hit.distanceAlongRay);
    }
  }

  if (!Number.isFinite(nearest)) return null;
  return { distance: nearest };
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

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    position: player.position,
    yaw: player.yaw,
    pitch: player.pitch,
    hp: player.hp,
    kills: player.kills,
    deaths: player.deaths,
    alive: player.alive,
    respawnAt: player.respawnAt
  };
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
    y: 2,
    z: Math.sin(angle) * radius
  };
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
