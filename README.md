# Bubble Splitter Online

Online co-op arcade game for 2–4 players, each on their own phone. 10 levels. Players swipe to move and tap to shoot, and they split the bouncing bubbles together. Each player has their own score and lives.

## Files

```
server.js         Node.js game server (rooms, physics, levels, scoring)
public/index.html The game page players open on their phones
package.json      Dependencies (just "ws")
```

The server runs the whole game, so every player sees the same bubbles. Each phone only sends where its player moved and when it fired.

## Run on your computer

You need Node.js 18 or newer: https://nodejs.org

```bash
npm install
npm start
```

Open http://localhost:3000 in a browser.

**Play with phones on the same Wi-Fi:** find your computer's local IP address (for example `192.168.1.20`), then open `http://192.168.1.20:3000` on each phone.

## Put it online (free) so friends anywhere can play

### Option A: Render.com
1. Put this folder in a GitHub repository.
2. On https://render.com create a **New → Web Service** and pick the repository.
3. Build command: `npm install`. Start command: `npm start`.
4. Deploy. You'll get a link like `https://bubble-splitter.onrender.com`. Share it.

(On Render's free plan, the server sleeps when nobody is playing. The first visit after that takes about 30 seconds to wake it up.)

### Option B: Railway.app
1. Go to https://railway.app → **New Project → Deploy from GitHub repo**.
2. Railway detects Node automatically. Under Settings → Networking, click **Generate Domain**.

Both services provide `PORT` automatically, and the server already uses it.

## How to play

1. One player enters a name and taps **Create Room**. They get a 4-letter code.
2. Friends enter the code and tap **Join**, or open the invite link.
3. The host taps **Start Game**.

- **Swipe** left or right to move. **Tap** to shoot. While swiping, a tap with a second finger also shoots.
- Keyboard: ← → or A/D to move, Space to shoot.
- Each player has 3 lives. A player who loses all lives watches until the next level, then comes back with 1 life.
- The game is over when everyone is out. The host can retry the level (everyone's score is halved) or go back to the lobby.
- Power-ups: **2** double shot · **❄** freeze (everyone) · **◎** shield · **♥** extra life.
