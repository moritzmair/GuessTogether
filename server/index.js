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
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=48.8584,2.2945&key=${MAPS_KEY}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.status === 'REQUEST_DENIED') {
            reject(new Error(`API-Key ungültig oder Street View Static API nicht aktiviert: ${json.error_message || json.status}`));
          } else {
            console.log(`✅ Google Maps API Key OK (Status: ${json.status})`);
            resolve();
          }
        } catch {
          reject(new Error('Ungültige Antwort von Google Maps API'));
        }
      });
    }).on('error', reject);
  });
}

const app = express();
app.use(cors());
app.use(express.json());

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

// Street View Metadata abrufen
function fetchMetadata(lat, lng) {
  return new Promise((resolve) => {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=50000&key=${MAPS_KEY}`;
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
async function fetchAutoHeading(lat, lng) {
  const meta1 = await fetchMetadata(lat, lng);
  if (meta1.status !== 'OK') return 0;

  const { lat: plat, lng: plng } = meta1.location;
  const offsets = [[0.001, 0], [0, 0.001], [-0.001, 0], [0, -0.001]];

  let bestHeading = null;
  for (const [dlat, dlng] of offsets) {
    const meta2 = await fetchMetadata(plat + dlat, plng + dlng);
    if (meta2.status === 'OK' && meta2.pano_id !== meta1.pano_id) {
      const h = Math.round(bearing(plat, plng, meta2.location.lat, meta2.location.lng));
      if (bestHeading === null) bestHeading = h;
    }
  }
  return bestHeading ?? 0;
}

function svUrl(lat, lng, heading) {
  return `https://maps.googleapis.com/maps/api/streetview?size=2048x2048&location=${lat},${lng}&heading=${heading}&pitch=0&fov=120&source=outdoor&key=${MAPS_KEY}`;
}

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
    const r = REGIONS[Math.floor(Math.random() * REGIONS.length)];
    const lat = r.lat[0] + Math.random() * (r.lat[1] - r.lat[0]);
    const lng = r.lng[0] + Math.random() * (r.lng[1] - r.lng[0]);
    const meta = await fetchMetadata(lat, lng);
    if (meta.status === 'OK') {
      return { lat: meta.location.lat, lng: meta.location.lng, label: `${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}` };
    }
  }
  throw new Error('Kein Street View gefunden');
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/api/image/:code', (req, res) => {
  const session = sessions[req.params.code];
  if (!session || !session.location) return res.status(404).send('Nicht gefunden');
  const url = session.location.image;
  https.get(url, (gRes) => {
    res.setHeader('Content-Type', gRes.headers['content-type'] || 'image/jpeg');
    gRes.pipe(res);
  }).on('error', () => res.status(502).send('Bildfehler'));
});

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Session erstellen (Host) – kein Name nötig
  socket.on('create-session', (_, cb) => {
    const code = makeCode();
    sessions[code] = {
      code,
      host: socket.id,
      players: [],
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

    const base = await randomStreetViewLocation();
    const heading = await fetchAutoHeading(base.lat, base.lng);

    session.round = (session.round || 0) + 1;
    session.location = { ...base, image: svUrl(base.lat, base.lng, heading) };
    session.phase = 'game';
    session.pins = {};

    io.to(code).emit('game-started', { image: `/api/image/${code}?r=${session.round}` });
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
        const points = Math.max(0, 5000 - dist * 2);
        p.score += points;
        return { id: p.id, name: p.name, dist, points, totalScore: p.score, pin: pin || null };
      });

      results.sort((a, b) => b.points - a.points);
      session.phase = 'results';

      io.to(code).emit('round-ended', {
        results,
        location: { lat: session.location.lat, lng: session.location.lng, label: session.location.label }
      });
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
      // Host disconnected → Session löschen
      delete sessions[code];
      io.to(code).emit('host-left');
      console.log('host left, session deleted:', code);
      return;
    }

    session.players = session.players.filter((p) => p.id !== socket.id);
    if (session.players.length === 0) {
      delete sessions[code];
      console.log('session deleted (leer):', code);
    } else {
      io.to(code).emit('players-updated', session.players);
    }
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
checkApiKey()
  .then(() => server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`)))
  .catch((err) => { console.error(`\n❌ Server-Start abgebrochen: ${err.message}\n`); process.exit(1); });
