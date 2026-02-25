require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

function checkApiKey() {
  return new Promise((resolve, reject) => {
    if (!MAPS_KEY) {
      reject(new Error('GOOGLE_MAPS_API_KEY fehlt in server/.env'));
      return;
    }
    resolve();
  });
}

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _, next) => { console.log(`→ ${req.method} ${req.url}`); next(); });

const path = require('path');
const clientDist = path.join(__dirname, 'public');
app.use(express.static(clientDist));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const sessions = {};

// Haversine-Distanz in km
function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Kompassrichtung von (lat1,lng1) nach (lat2,lng2) in Grad
function bearing(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLng = toRad(lng2 - lng1);
  const y = Math.sin(dLng) * Math.cos(toRad(lat2));
  const x =
    Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
    Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLng);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

// Street View Metadata abrufen – sucht Panorama im gegebenen Radius (in Metern)
function fetchNearestPanorama(lat, lng, radiusMeters = 50000) {
  return new Promise((resolve) => {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${radiusMeters}&key=${MAPS_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'ERROR' }); }
      });
    }).on('error', () => resolve({ status: 'ERROR' }));
  });
}

// Fahrtrichtung ermitteln: benachbartes Panorama suchen und Bearing berechnen
async function fetchAutoHeading(lat, lng, pano_id) {
  const offsets = [[0.001, 0], [0, 0.001], [-0.001, 0], [0, -0.001]];
  let bestHeading = null;
  for (const [dlat, dlng] of offsets) {
    const meta2 = await fetchNearestPanorama(lat + dlat, lng + dlng, 100);
    if (meta2.status === 'OK' && meta2.pano_id !== pano_id) {
      const h = Math.round(bearing(lat, lng, meta2.location.lat, meta2.location.lng));
      if (bestHeading === null) bestHeading = h;
    }
  }
  return bestHeading ?? 0;
}

const TOTAL_ROUNDS = 5;

function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

const REGIONS = [
  { lat: [35, 70],  lng: [-10, 40]  },  // Europa
  { lat: [25, 50],  lng: [-125, -65] }, // Nordamerika
  { lat: [-35, 5],  lng: [-75, -35] },  // Südamerika
  { lat: [-35, 37], lng: [10, 50]   },  // Afrika
  { lat: [5, 55],   lng: [60, 145]  },  // Asien
  { lat: [-45, -10],lng: [110, 155] },  // Australien
];

async function randomStreetViewLocation(maxTries = 100) {
  for (let i = 0; i < maxTries; i++) {
    // Schritt 1: Zufällige Position innerhalb einer Region wählen
    const r = REGIONS[Math.floor(Math.random() * REGIONS.length)];
    const seedLat = r.lat[0] + Math.random() * (r.lat[1] - r.lat[0]);
    const seedLng = r.lng[0] + Math.random() * (r.lng[1] - r.lng[0]);

    // Schritt 2: Prüfen ob im Radius von 50 km ein Panorama verfügbar ist
    const meta = await fetchNearestPanorama(seedLat, seedLng, 10000);
    if (meta.status !== 'OK' || !meta.pano_id) {
      console.log(`Versuch ${i + 1}: kein Panorama bei (${seedLat.toFixed(3)}, ${seedLng.toFixed(3)})`);
      continue;
    }

    // Schritt 3: Panorama gefunden – Daten zurückgeben
    console.log(`Panorama gefunden bei (${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}) nach ${i + 1} Versuch(en)`);
    return {
      lat: meta.location.lat,
      lng: meta.location.lng,
      pano_id: meta.pano_id,
      label: `${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}`
    };
  }
  throw new Error('Kein Street View gefunden');
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/api/maps-key', (_, res) => res.json({ key: MAPS_KEY }));

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Session erstellen (Host) – kein Name nötig
  socket.on('create-session', (_, cb) => {
    const code = makeCode();
    sessions[code] = {
      code,
      host: socket.id,
      players: [],
      leftThisRound: [],
      phase: 'lobby',
      location: null,
      pins: {},
      round: 0
    };
    socket.join(code);
    socket.data.code = code;
    cb({ code, players: [] });
    console.log('session created:', code);
  });

  // Session beitreten
  socket.on('join-session', ({ code, name }, cb) => {
    const session = sessions[code];
    if (!session) return cb({ error: 'Session nicht gefunden' });
    if (session.phase !== 'lobby') return cb({ error: 'Spiel läuft bereits' });
    if (session.players.some((p) => p.name === name)) return cb({ error: 'Name bereits vergeben' });

    session.players.push({ id: socket.id, name, score: 0 });
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    io.to(code).emit('players-updated', session.players);
    cb({ code, players: session.players, isHost: false });
    console.log(`${name} joined ${code}`);
  });

  // Spiel starten (nur Host) – Auto-Heading via Metadata API
  socket.on('start-game', async () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;

    if (session.round >= TOTAL_ROUNDS) {
      session.round = 0;
      session.players.forEach((p) => (p.score = 0));
      session.leftThisRound = [];
    }

    const base = await randomStreetViewLocation();
    const heading = await fetchAutoHeading(base.lat, base.lng, base.pano_id);

    session.round = (session.round || 0) + 1;
    session.location = { ...base, heading };
    session.phase = 'game';
    session.pins = {};

    io.to(code).emit('game-started', { panoId: session.location.pano_id, heading: session.location.heading, players: session.players });
    console.log('game started:', code, base.label);
  });

  // Spieler setzt Pin (Host nimmt nicht teil)
  socket.on('place-pin', ({ lat, lng }) => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.phase !== 'game') return;
    if (socket.id === session.host) return; // Host darf keinen Pin setzen

    session.pins[socket.id] = { lat, lng };

    const totalPlayers = session.players.length;
    const pinCount = Object.keys(session.pins).length;

    io.to(code).emit('pin-placed', { playerId: socket.id, pinCount, totalPlayers });

    if (pinCount >= totalPlayers) {
      const results = session.players.map((p) => {
        const pin = session.pins[p.id];
        const dist = pin
          ? Math.round(distanceKm(session.location.lat, session.location.lng, pin.lat, pin.lng))
          : 99999;
        const points = pin ? Math.max(1, Math.round(10000 / (1 + dist / 50))) : 0;
        p.score += points;
        return { id: p.id, name: p.name, dist, points, totalScore: p.score, pin: pin || null };
      });

      const leftResults = session.leftThisRound.map((p) => ({
        id: p.id, name: p.name, dist: 99999, points: 0, totalScore: p.score, pin: null, left: true
      }));

      results.sort((a, b) => b.points - a.points || a.dist - b.dist);
      session.phase = 'results';

      const roundData = {
        results: [...results, ...leftResults],
        location: { lat: session.location.lat, lng: session.location.lng, label: session.location.label },
        round: session.round,
        totalRounds: TOTAL_ROUNDS
      };
      session.currentRoundData = roundData;

      io.to(code).emit('round-ended', roundData);
    }
  });

  // Zurück zur Lobby (nur Host)
  socket.on('back-to-lobby', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;
    session.phase = 'lobby';
    session.pins = {};
    session.location = null;
    io.to(code).emit('back-to-lobby');
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session) return;

    if (session.host === socket.id) {
      delete sessions[code];
      io.to(code).emit('host-left');
      console.log('host left, session deleted:', code);
      return;
    }

    const leavingPlayer = session.players.find((p) => p.id === socket.id);
    session.players = session.players.filter((p) => p.id !== socket.id);

    // Bei laufender Runde: für Ergebnisanzeige merken
    if ((session.phase === 'game' || session.phase === 'results') && leavingPlayer) {
      if (!session.leftThisRound) session.leftThisRound = [];
      session.leftThisRound.push(leavingPlayer);
    }

    if (session.players.length === 0) {
      delete sessions[code];
      console.log('session deleted (leer):', code);
      return;
    }

    io.to(code).emit('player-left', {
      name: leavingPlayer?.name || socket.id,
      players: session.players
    });

    // Während Spielphase: prüfen ob alle verbliebenen Spieler schon gepinnt haben
    if (session.phase === 'game') {
      const pinCount = Object.keys(session.pins).length;
      const activePlayers = session.players.length;

      if (activePlayers > 0 && pinCount >= activePlayers) {
        const results = session.players.map((p) => {
          const pin = session.pins[p.id];
          const dist = pin
            ? Math.round(distanceKm(session.location.lat, session.location.lng, pin.lat, pin.lng))
            : 99999;
          const points = pin ? Math.max(1, Math.round(10000 / (1 + dist / 50))) : 0;
          p.score += points;
          return { id: p.id, name: p.name, dist, points, totalScore: p.score, pin: pin || null };
        });

        const leftResults = (session.leftThisRound || []).map((p) => ({
          id: p.id, name: p.name, dist: 99999, points: 0, totalScore: p.score, pin: null, left: true
        }));

        results.sort((a, b) => b.points - a.points || a.dist - b.dist);
        session.phase = 'results';

        const roundData = {
          results: [...results, ...leftResults],
          location: { lat: session.location.lat, lng: session.location.lng, label: session.location.label },
          round: session.round,
          totalRounds: TOTAL_ROUNDS
        };
        session.currentRoundData = roundData;
        io.to(code).emit('round-ended', roundData);
      }
    }

    // Während Results-Phase: currentRoundData aktualisieren und neu emittieren
    if (session.phase === 'results' && session.currentRoundData && leavingPlayer) {
      session.currentRoundData = {
        ...session.currentRoundData,
        results: session.currentRoundData.results.map((p) =>
          p.id === leavingPlayer.id ? { ...p, left: true } : p
        )
      };
      io.to(code).emit('results-updated', session.currentRoundData);
    }

    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
checkApiKey()
  .then(() => server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`)))
  .catch((err) => { console.error(`\n❌ Server-Start abgebrochen: ${err.message}\n`); process.exit(1); });
