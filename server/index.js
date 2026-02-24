require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const cors = require('cors');

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// Startup: API-Key prüfen via Metadata-Endpoint (kein Bild-Quota)
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

// In-Memory Sessions
const sessions = {};

function svUrl(lat, lng, heading = 0, pitch = 0) {
  return `https://maps.googleapis.com/maps/api/streetview?size=800x500&location=${lat},${lng}&heading=${heading}&pitch=${pitch}&key=${MAPS_KEY}`;
}

// Beispiel-Locations (lat, lng, streetViewUrl)
const LOCATIONS = [
  { lat: 48.8584,  lng: 2.2945,    label: 'Paris, Frankreich',  image: svUrl(48.8584,  2.2945,    151, -1) },
  { lat: 40.6892,  lng: -74.0445,  label: 'New York, USA',      image: svUrl(40.6892,  -74.0445,  70,   0) },
  { lat: 51.5007,  lng: -0.1246,   label: 'London, UK',         image: svUrl(51.5007,  -0.1246,   90,  10) },
  { lat: 35.6762,  lng: 139.6503,  label: 'Tokyo, Japan',       image: svUrl(35.6762,  139.6503,  200,  0) },
  { lat: -33.8688, lng: 151.2093,  label: 'Sydney, Australien', image: svUrl(-33.8688, 151.2093,  0,    0) }
];

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

// 6-stelligen Code generieren
function makeCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

app.get('/health', (_, res) => res.json({ ok: true }));

// Proxy-Endpoint: Bild wird serverseitig von Google geladen → kein API-Key im Browser
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

  // Session erstellen (Host)
  socket.on('create-session', ({ name }, cb) => {
    const code = makeCode();
    sessions[code] = {
      code,
      host: socket.id,
      players: [{ id: socket.id, name, score: 0 }],
      phase: 'lobby', // lobby | game | results
      location: null,
      pins: {}
    };
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;
    cb({ code, players: sessions[code].players });
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

    // Alle in der Lobby informieren
    io.to(code).emit('players-updated', session.players);
    cb({ code, players: session.players, isHost: false });
    console.log(`${name} joined ${code}`);
  });

  // Spiel starten (nur Host)
  socket.on('start-game', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;

    const location = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
    session.location = location;
    session.phase = 'game';
    session.pins = {};

    // Proxy-URL statt direkter Google-URL → API-Key bleibt serverseitig
    io.to(code).emit('game-started', { image: `/api/image/${code}` });
    console.log('game started:', code, location.label);
  });

  // Spieler setzt Pin
  socket.on('place-pin', ({ lat, lng }) => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.phase !== 'game') return;

    session.pins[socket.id] = { lat, lng };

    // Warten bis alle Pins gesetzt
    const totalPlayers = session.players.length;
    const pinCount = Object.keys(session.pins).length;

    io.to(code).emit('pin-placed', { playerId: socket.id, pinCount, totalPlayers });

    if (pinCount >= totalPlayers) {
      // Ergebnisse berechnen
      const results = session.players.map((p) => {
        const pin = session.pins[p.id];
        const dist = pin
          ? Math.round(distanceKm(session.location.lat, session.location.lng, pin.lat, pin.lng))
          : 99999;
        const points = Math.max(0, 5000 - dist * 2);
        p.score += points;
        return {
          id: p.id,
          name: p.name,
          dist,
          points,
          totalScore: p.score,
          pin: pin || null
        };
      });

      results.sort((a, b) => b.points - a.points);
      session.phase = 'results';

      io.to(code).emit('round-ended', {
        results,
        location: {
          lat: session.location.lat,
          lng: session.location.lng,
          label: session.location.label
        }
      });
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session) return;

    session.players = session.players.filter((p) => p.id !== socket.id);

    if (session.players.length === 0) {
      delete sessions[code];
      console.log('session deleted:', code);
    } else {
      if (session.host === socket.id) {
        session.host = session.players[0].id;
        io.to(code).emit('host-changed', session.host);
      }
      io.to(code).emit('players-updated', session.players);
    }
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3001;
checkApiKey()
  .then(() => server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`)))
  .catch((err) => { console.error(`\n❌ Server-Start abgebrochen: ${err.message}\n`); process.exit(1); });
