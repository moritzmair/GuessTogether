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

const REGIONS_WELTWEIT = [
  { lat: [35, 70],  lng: [-10, 40]  },
  { lat: [25, 50],  lng: [-125, -65] },
  { lat: [-35, 5],  lng: [-75, -35] },
  { lat: [-35, 37], lng: [10, 50]   },
  { lat: [5, 55],   lng: [60, 145]  },
  { lat: [-45, -10],lng: [110, 155] },
];

const REGIONS_EUROPA = [
  { lat: [36, 44], lng: [-9, 3]   },  // Iberische Halbinsel
  { lat: [42, 51], lng: [-5, 8]   },  // Frankreich, Benelux
  { lat: [50, 59], lng: [-8, 2]   },  // Britische Inseln
  { lat: [46, 55], lng: [6, 19]   },  // D, A, CH, CZ, SK
  { lat: [55, 71], lng: [4, 28]   },  // Skandinavien
  { lat: [37, 47], lng: [7, 18]   },  // Italien
  { lat: [54, 70], lng: [20, 30]  },  // Polen, Baltikum, Finnland
  { lat: [38, 47], lng: [13, 28]  },  // Balkan
  { lat: [44, 52], lng: [22, 40]  },  // Ukraine, Rumänien, Ungarn
  { lat: [35, 42], lng: [20, 28]  },  // Griechenland
];

const CITIES = [
  [40.7128,-74.006],[51.5074,-0.1278],[48.8566,2.3522],[52.52,13.405],[41.9028,12.4964],
  [40.4168,-3.7038],[38.7223,-9.1393],[50.8503,4.3517],[47.3769,8.5417],[59.9139,10.7522],
  [55.6761,12.5683],[53.3498,-6.2603],[48.2082,16.3738],[50.0755,14.4378],[54.6872,25.2797],
  [35.6762,139.6503],[22.3193,114.1694],[1.3521,103.8198],[37.5665,126.978],[31.2304,121.4737],
  [39.9042,116.4074],[28.6139,77.209],[19.076,72.8777],[13.7563,100.5018],[3.139,101.6869],
  [-33.8688,151.2093],[53.4808,-2.2426],[-23.5505,-46.6333],[-34.6037,-58.3816],[19.4326,-99.1332],
  [30.0444,31.2357],[6.5244,3.3792],[-1.2921,36.8219],[33.5731,-7.5898],[25.2048,55.2708],
  [35.6892,51.389],[41.0082,28.9784],[55.7558,37.6173],[50.45,30.5234],[44.8176,20.4633],
];

async function randomStreetViewLocation(mode = 'weltweit', maxTries = 100) {
  if (mode === 'grossstaedte') {
    for (let i = 0; i < maxTries; i++) {
      const [seedLat, seedLng] = CITIES[Math.floor(Math.random() * CITIES.length)];
      const jLat = seedLat + (Math.random() - 0.5) * 0.05;
      const jLng = seedLng + (Math.random() - 0.5) * 0.05;
      const meta = await fetchNearestPanorama(jLat, jLng, 2000);
      if (meta.status !== 'OK' || !meta.pano_id) continue;
      console.log(`[grossstaedte] Panorama bei (${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}) nach ${i + 1} Versuch(en)`);
      return { lat: meta.location.lat, lng: meta.location.lng, pano_id: meta.pano_id, label: `${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}` };
    }
    throw new Error('Kein Street View gefunden');
  }

  const regions = mode === 'europa' ? REGIONS_EUROPA : REGIONS_WELTWEIT;
  for (let i = 0; i < maxTries; i++) {
    const r = regions[Math.floor(Math.random() * regions.length)];
    const seedLat = r.lat[0] + Math.random() * (r.lat[1] - r.lat[0]);
    const seedLng = r.lng[0] + Math.random() * (r.lng[1] - r.lng[0]);
    const meta = await fetchNearestPanorama(seedLat, seedLng, 10000);
    if (meta.status !== 'OK' || !meta.pano_id) {
      console.log(`[${mode}] Versuch ${i + 1}: kein Panorama bei (${seedLat.toFixed(3)}, ${seedLng.toFixed(3)})`);
      continue;
    }
    console.log(`[${mode}] Panorama bei (${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}) nach ${i + 1} Versuch(en)`);
    return { lat: meta.location.lat, lng: meta.location.lng, pano_id: meta.pano_id, label: `${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}` };
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
  socket.on('start-game', async ({ mode } = {}) => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;

    if (session.round >= TOTAL_ROUNDS) {
      session.round = 0;
      session.players.forEach((p) => (p.score = 0));
      session.leftThisRound = [];
    }

    const gameMode = mode || session.mode || 'weltweit';
    session.mode = gameMode;

    const base = await randomStreetViewLocation(gameMode);
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
          ? distanceKm(session.location.lat, session.location.lng, pin.lat, pin.lng)
          : 99999;
        const points = pin ? Math.max(1, Math.round(10000 / (1 + dist / 10))) : 0;
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
            ? distanceKm(session.location.lat, session.location.lng, pin.lat, pin.lng)
            : 99999;
          const points = pin ? Math.max(1, Math.round(10000 / (1 + dist / 10))) : 0;
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
