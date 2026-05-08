# Architecture

This project is an in-memory multiplayer shooter with one Node process serving both the web page and the websocket game server.

## Runtime Pieces

- `server.js`: Express static server plus a `ws` websocket server. It owns authoritative game state.
- `game.html`: Single-page Three.js client. It renders the world, predicts local movement, sends player input/state, and reconciles server snapshots.
- `package.json`: Node scripts and dependencies. `npm start` runs `server.js`.
- `.env`: Optional local environment values such as `HOST`; Railway injects `PORT` automatically.

There is no database. Rooms, scores, bots, pickups, and match state live in memory inside `rooms`. Restarting the server clears active games.

## Request And Connection Flow

HTTP routes in `server.js` serve the game:

- `/` and `/r/:room` return `game.html`.
- `/vendor/three.min.js` serves Three.js from `node_modules`.
- `/healthz` returns a simple JSON health check.

The browser opens a websocket at `/ws?room=<room>&name=<name>&mode=<pvp|coop>`. The server creates or reuses an in-memory room, creates a player object, and sends a `welcome` message containing:

- the player id
- room id
- game mode
- the public player record
- weapon metadata
- powerup metadata

After that, the server sends frequent `snapshot` messages for the whole room.

## Server Authority

The backend is the source of truth for:

- player health, deaths, kills, powerups, ammo, nukes, and alive state
- bot and boss movement/attacks
- pickups and pickup collection
- weapon damage, headshots, shotgun pellets, bazooka splash, and line-of-sight blocking
- match timers, rounds, kill limit, coop waves, and game-over state
- castle obstacle layout and collision validation

The client sends:

- `state`: predicted position, yaw, and pitch
- `play`: enter the arena or manually respawn
- `fire`: current aim direction
- `pickup`: pickup id
- `powerup`: selected powerup
- `nuke`: use a nuke
- `goatAbility`: special PVP ability payloads

The server validates those messages, updates room state, then broadcasts snapshots/events.

## Respawn Model

Players do not spawn just by connecting. They must press Play, which sends `type: "play"`.

When a player dies, the server marks them `alive: false` and leaves them dead. There is no server-side auto-respawn loop. The browser shows the overlay with Play Again, and the player respawns only when they press it.

## Room Tick

`setInterval(..., TICK_MS)` in `server.js` is the main game loop. Each tick:

1. Updates PVP match state.
2. Updates coop wave state.
3. Replenishes pickups.
4. Moves/attacks with AI.
5. Processes proximity pickups.
6. Broadcasts a room snapshot.
7. Deletes stale empty rooms.

This keeps the game simple: clients render and send intent, while the backend periodically publishes the accepted state.

## Combat

`handleFire()` reads the shooter weapon, rate-limits by reload time, consumes ammo, and builds one or more projectile traces. It checks direct hits first, then obstacle blocking, then bazooka splash if relevant.

Damage is accumulated by target before HP is changed. That lets shotgun pellets and splash combine cleanly. Headshots use a smaller hit zone with higher damage. Terrain and castle objects block shots on the server.

## Map And Collision

Both server and client implement the same deterministic `buildObstacleLayout(roomId)` and `terrainHeightAt()` logic. This matters because:

- the server uses the layout for collision and shot blocking
- the client uses it to render castle walls, towers, platforms, jump pads, trees, crates, and rocks
- the same room id creates the same layout for everyone

`walkableHeightAt()` makes raised castle platforms act like rooftops. The client uses it for movement prediction, and the server uses it to clamp player height.

## Client Rendering

`game.html` uses Three.js directly:

- `scene`, `camera`, and `renderer` set up the 3D world.
- `yaw` and `pitch` objects model first-person camera rotation.
- `buildArena()` creates static terrain and castle meshes.
- render caches (`remotePlayers`, `aiEntities`, `pickups`) reuse meshes across snapshots.
- `animate()` runs the render loop, local movement prediction, tracer animation, explosions, minimap, HUD, and scope updates.

The client does not decide real damage or kills. It shows feedback after server events.

## UI And HUD

The HUD is plain HTML/CSS over the WebGL canvas:

- health, kills, deaths
- weapon/ammo/nuke panels
- pickup hints
- feed messages
- boss bar
- minimap
- scope overlay
- goat ability HUD
- join/death overlay

The overlay is also the spawn gate. Hiding it requests pointer lock and sends Play.

## Deployment

Railway can run this without extra services:

1. Install dependencies.
2. Run `npm start`.
3. Provide a public domain.

`HOST` defaults to `0.0.0.0`, and Railway supplies `PORT`. Since state is in memory, scaling to multiple instances would split rooms unless a shared state layer is added later.
