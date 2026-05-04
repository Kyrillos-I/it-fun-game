# Multiplayer Shooter

In-memory Express + WebSocket shooter. Rooms are created from URLs like `/r/abc123`, so you can send the deployed link to friends and play in the same room.

## Local Dev

```bash
npm install
npm start
```

Open `http://127.0.0.1:3000`. The app writes room URLs as `/r/<room-id>`.

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
