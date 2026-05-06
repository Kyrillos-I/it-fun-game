# Multiplayer Shooter

In-memory Express + WebSocket shooter. Rooms are created from URLs like `/r/abc123`, so you can send the deployed link to friends and play in the same room.

## Local Dev

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`. The app writes room URLs as `/r/<room-id>`.

## Controls

- `WASD`: move
- `Mouse`: aim
- `Click`: fire
- `Right click`, `Q`, or `Command`: scope/aim down sights
- `Space`: jump
- `Shift`: sprint
- `E`: pick up the nearest floor weapon
- `F`: use a held nuke

Move into a ladder and hold `W` to climb up or `S`/backward movement to climb down.

Players start with an infinite-ammo pistol. Sniper, shotgun, machine gun, and bazooka pickups spawn on the floor with limited ammo. When a limited weapon runs out, you switch back to the pistol.

On join and respawn, choose one powerup: double speed, +0.5 damage, or +0.5 health. Killing another player heals you back to max health.

Bots spawn periodically and chase players. A boss spawns every two minutes; killing it drops a nuke pickup.

Rounds last 5 minutes or end when someone reaches 25 kills. The HUD includes a minimap, boss health bar, hit marker, kill banners, and active boost timers. Floor boosts include heal, armor, speed, damage, and jump.

## Let Friends Join From Your Device

`127.0.0.1` only works on your own computer. Other people need a URL that reaches your machine.

### Same Wi-Fi

Run the server on all network interfaces:

```bash
HOST=0.0.0.0 npm start
```

Find your local IP address, then send friends on the same Wi-Fi a link like:

```text
http://YOUR_LOCAL_IP:3000/r/room-name
```

Example:

```text
http://192.168.1.25:3000/r/arena
```

### Outside Your Wi-Fi

Use a tunnel service such as ngrok or Cloudflare Tunnel. Start this app locally, then expose port `3000` with the tunnel. Send friends the tunnel HTTPS URL, for example:

```text
https://your-tunnel-url/r/arena
```

This avoids router setup and usually works even if your home network blocks inbound traffic.

### Port Forwarding

You can also forward router port `3000` to your computer and send friends:

```text
http://YOUR_PUBLIC_IP:3000/r/arena
```

This is more fragile and exposes your machine directly. A tunnel or Railway deploy is safer for casual play.

## Railway Deploy

1. Push this folder to GitHub.
2. Create a Railway project from the repo.
3. Railway will run `npm install` and `npm start`.
4. In Railway variables, you usually only need:

```bash
NODE_ENV=production
```

`HOST` already defaults to `0.0.0.0`, which is what Railway needs. Railway injects `PORT` automatically, so do not set `PORT` unless Railway tells you to.

After deploy, go to the service settings in Railway, generate a public domain, open that URL, copy the room link in-game, and send it to friends.

Rooms and scores are in memory. Restarting the Railway service clears active rooms.
