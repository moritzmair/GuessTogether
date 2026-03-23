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

// Grace-Period bevor ein Spieler wirklich entfernt wird (Tab-Wechsel, Bildschirm sperren, Tab schließen)
const RECONNECT_GRACE_MS = 120_000; // 2 Minuten – genug Zeit um Tab wieder zu öffnen
const pendingDisconnects = {}; // key: `${code}:${name}` oder `host:${code}`

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
// source: 'default' (alle) | 'outdoor' (kein Indoor)
function fetchNearestPanorama(lat, lng, radiusMeters = 50000, source = 'default') {
  return new Promise((resolve) => {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${radiusMeters}&source=${source}&key=${MAPS_KEY}`;
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

function regionsToBounds(regions) {
  const minLat = Math.min(...regions.map((r) => r.lat[0]));
  const maxLat = Math.max(...regions.map((r) => r.lat[1]));
  const minLng = Math.min(...regions.map((r) => r.lng[0]));
  const maxLng = Math.max(...regions.map((r) => r.lng[1]));
  return [[minLat, minLng], [maxLat, maxLng]];
}

const FAMOUS_PLACES = [
  [48.8584, 2.2945],   [41.8902, 12.4922],  [41.4036, 2.1744],   [51.5007, -0.1246],
  [52.5163, 13.3777],  [37.9715, 23.7257],  [37.1760, -3.5881],  [48.8606, 2.3376],
  [48.8530, 2.3499],   [48.8738, 2.2950],   [41.9009, 12.4833],  [41.8986, 12.4769],
  [41.9022, 12.4539],  [50.9413, 6.9583],   [47.5575, 10.7498],  [50.0910, 14.4010],
  [50.0865, 14.4114],  [37.8199, -122.4783],[40.6892, -74.0445], [40.7580, -73.9855],
  [40.7484, -73.9856], [34.1341, -118.3215],[36.1147, -115.1728],[43.0799, -79.0747],
  [-13.1631, -72.5450],[-22.9519, -43.2105],[-25.6953, -54.4367],[20.6843, -88.5678],
  [19.6925, -98.8438], [35.6586, 139.7454], [35.6595, 139.7004], [34.9671, 135.7727],
  [35.3606, 138.7274], [31.2400, 121.4900], [40.4319, 116.5704], [39.9163, 116.3972],
  [25.1972, 55.2744],  [25.1124, 55.1390],  [30.3285, 35.4444],  [29.9792, 31.1342],
  [27.1751, 78.0421],  [28.6129, 77.2295],  [-33.8568, 151.2153],[-33.8523, 151.2108],
  [36.4618, 25.3753],  [51.1789, -1.8262],  [55.9486, -3.1999],  [51.5014, -0.1419],
  [51.5055, -0.0754],  [52.3676, 4.9041],   [51.8833, 4.6356],   [43.7396, 7.4278],
  [43.7230, 10.3966],  [45.4341, 12.3388],  [43.7730, 11.2560],  [42.6507, 18.0944],
  [39.7217, 21.6306],  [47.5622, 13.6493],  [47.4963, 19.0398],  [55.7539, 37.6208],
  [59.9401, 30.3288],  [41.0086, 28.9802],  [41.0054, 28.9768],  [-33.9628, 18.4098],
  [-17.9243, 25.8572], [13.4125, 103.8667], [-8.6215, 115.0865], [1.2839, 103.8607],
  [3.1579, 101.7116],  [38.6431, 34.8289],  [52.9715, -9.4309],  [55.2308, -6.5116],
  [44.1461, 9.6439],   [48.6360, -1.5115],  [48.0793, 7.3585],   [43.5081, 16.4402],
  [50.4501, 30.5234],  [46.9480, 7.4474],   [47.3769, 8.5417],   [48.2082, 16.3738],
  [47.8099, 13.0550],  [48.1351, 11.5820],  [53.5753, 10.0153],  [52.5170, 13.3889],
  [43.2965, 5.3698],   [43.6965, 7.2705],   [37.3891, -5.9845],  [40.4153, -3.6893],
  [38.6916, -9.2160],  [41.1579, -8.6291],  [53.3498, -6.2603],  [55.6761, 12.5683],
  [59.9139, 10.7522],  [60.1699, 24.9384],  [26.9239, 75.8267],  [-25.3444, 131.0369],
  [46.0207, 14.5112],  [22.3193, 114.1694], [1.3521, 103.8198],  [33.7490, -84.3880],
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

// panoramaFilter: 'all' | 'outdoor' | 'google_only'
async function randomStreetViewLocation(mode = 'weltweit', customBounds = null, panoramaFilter = 'all', usedPanoIds = new Set(), maxTries = 150) {
  // 'outdoor' und 'google_only' schließen Indoor-Panoramen per API-Source-Parameter aus
  const source = (panoramaFilter === 'outdoor' || panoramaFilter === 'google_only') ? 'outdoor' : 'default';

  if (mode === 'beruehmt') {
    for (let i = 0; i < maxTries; i++) {
      const [seedLat, seedLng] = FAMOUS_PLACES[Math.floor(Math.random() * FAMOUS_PLACES.length)];
      const meta = await fetchNearestPanorama(seedLat, seedLng, 3000, source);
      if (meta.status !== 'OK' || !meta.pano_id) continue;
      if (usedPanoIds.has(meta.pano_id)) continue;
      console.log(`[beruehmt] Panorama bei (${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}) nach ${i + 1} Versuch(en)`);
      return { lat: meta.location.lat, lng: meta.location.lng, pano_id: meta.pano_id, label: `${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}` };
    }
    throw new Error('Kein Street View gefunden');
  }

  if (mode === 'grossstaedte') {
    for (let i = 0; i < maxTries; i++) {
      const [seedLat, seedLng] = CITIES[Math.floor(Math.random() * CITIES.length)];
      const jLat = seedLat + (Math.random() - 0.5) * 0.05;
      const jLng = seedLng + (Math.random() - 0.5) * 0.05;
      const meta = await fetchNearestPanorama(jLat, jLng, 2000, source);
      if (meta.status !== 'OK' || !meta.pano_id) continue;
      if (panoramaFilter === 'google_only' && !meta.copyright?.startsWith('© Google')) {
        console.log(`[grossstaedte] Übersprungen (nicht Google): "${meta.copyright}"`);
        continue;
      }
      if (usedPanoIds.has(meta.pano_id)) continue;
      console.log(`[grossstaedte] Panorama bei (${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}) nach ${i + 1} Versuch(en) [filter: ${panoramaFilter}]`);
      return { lat: meta.location.lat, lng: meta.location.lng, pano_id: meta.pano_id, label: `${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}` };
    }
    throw new Error('Kein Street View gefunden');
  }

  const regions = mode === 'custom' && customBounds ? [customBounds]
    : mode === 'europa' ? REGIONS_EUROPA
    : REGIONS_WELTWEIT;
  for (let i = 0; i < maxTries; i++) {
    const r = regions[Math.floor(Math.random() * regions.length)];
    const seedLat = r.lat[0] + Math.random() * (r.lat[1] - r.lat[0]);
    const seedLng = r.lng[0] + Math.random() * (r.lng[1] - r.lng[0]);
    const meta = await fetchNearestPanorama(seedLat, seedLng, 10000, source);
    if (meta.status !== 'OK' || !meta.pano_id) {
      console.log(`[${mode}] Versuch ${i + 1}: kein Panorama bei (${seedLat.toFixed(3)}, ${seedLng.toFixed(3)})`);
      continue;
    }
    if (panoramaFilter === 'google_only' && !meta.copyright?.startsWith('© Google')) {
      console.log(`[${mode}] Versuch ${i + 1}: Übersprungen (nicht Google): "${meta.copyright}"`);
      continue;
    }
    if (usedPanoIds.has(meta.pano_id)) {
      console.log(`[${mode}] Versuch ${i + 1}: Panorama bereits benutzt, überspringe`);
      continue;
    }
    console.log(`[${mode}] Panorama bei (${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}) nach ${i + 1} Versuch(en) [filter: ${panoramaFilter}]`);
    return { lat: meta.location.lat, lng: meta.location.lng, pano_id: meta.pano_id, label: `${meta.location.lat.toFixed(4)}, ${meta.location.lng.toFixed(4)}` };
  }
  throw new Error('Kein Street View gefunden');
}

// Runde abschließen
function finishRound(session, code) {
  if (session.phase !== 'game') return;

  if (session.countdownTimer) {
    clearTimeout(session.countdownTimer);
    session.countdownTimer = null;
  }

  const nonSpectators = session.players.filter((p) => !p.spectator);

  const results = nonSpectators.map((p) => {
    const pin = session.pins[p.id];
    const dist = pin
      ? distanceKm(session.location.lat, session.location.lng, pin.lat, pin.lng)
      : 99999;
    const points = pin ? Math.max(1, Math.round(10000 / (1 + dist / 10))) : 0;
    p.score += points;
    return { id: p.id, name: p.name, dist, points, totalScore: p.score, pin: pin || null, left: p.temporarilyGone || false };
  });

  const activeIds = new Set(nonSpectators.map((p) => p.id));
  const leftResults = (session.leftThisRound || [])
    .filter((p) => !activeIds.has(p.id))
    .map((p) => ({
      id: p.id, name: p.name, dist: 99999, points: 0, totalScore: p.score, pin: null, left: true
    }));

  results.sort((a, b) => (a.left ? 1 : 0) - (b.left ? 1 : 0) || b.points - a.points || a.dist - b.dist);
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

// Aktive Spieler (nicht temporarilyGone) für Clients – Spectators werden mitgesendet
function activePlayers(session) {
  return session.players.filter((p) => !p.temporarilyGone);
}

async function doStartGame(session, code, mode, customBounds, panoramaFilter, pinCountdown) {
  if (session.round >= TOTAL_ROUNDS) {
    session.round = 0;
    session.players.forEach((p) => (p.score = 0));
    session.leftThisRound = [];
    session.usedPanoIds = new Set();
  }

  if (session.countdownTimer) {
    clearTimeout(session.countdownTimer);
    session.countdownTimer = null;
  }

  if (pinCountdown !== undefined) session.pinCountdown = pinCountdown;

  const gameMode = mode || session.mode || 'weltweit';
  const filter = panoramaFilter || session.panoramaFilter || 'all';
  session.mode = gameMode;
  session.panoramaFilter = filter;
  if (customBounds) session.customBounds = customBounds;

  const base = await randomStreetViewLocation(gameMode, session.customBounds || null, filter, session.usedPanoIds || new Set());
  const heading = await fetchAutoHeading(base.lat, base.lng, base.pano_id);

  const cb = session.customBounds;
  let mapBounds = null;
  if (gameMode === 'custom' && cb) {
    mapBounds = [[cb.lat[0], cb.lng[0]], [cb.lat[1], cb.lng[1]]];
  } else {
    const modeRegions = gameMode === 'europa' ? REGIONS_EUROPA : null;
    if (modeRegions) mapBounds = regionsToBounds(modeRegions);
  }
  session.mapBounds = mapBounds;

  if (!session.usedPanoIds) session.usedPanoIds = new Set();
  session.usedPanoIds.add(base.pano_id);

  session.round = (session.round || 0) + 1;
  session.location = { ...base, heading };
  session.phase = 'game';
  session.pins = {};
  session.readyPlayers = new Set();
  session.players.forEach((p) => { p.temporarilyGone = false; p.spectator = false; });

  io.to(code).emit('game-started', {
    panoId: session.location.pano_id,
    heading: session.location.heading,
    players: activePlayers(session),
    mapBounds,
  });
  console.log('game started:', code, base.label);
}

app.get('/health', (_, res) => res.json({ ok: true }));

app.get('/api/maps-key', (_, res) => res.json({ key: MAPS_KEY }));

// Solo-Modus: Neue Runde starten – gibt Panorama-Daten zurück ohne Session
app.get('/api/solo/start-round', async (req, res) => {
  const mode = req.query.mode || 'weltweit';
  const panoramaFilter = req.query.panoramaFilter || 'all';
  let customBounds = null;
  if (req.query.customBounds) {
    try { customBounds = JSON.parse(req.query.customBounds); } catch (_) {}
  }
  try {
    const base = await randomStreetViewLocation(mode, customBounds, panoramaFilter);
    const heading = await fetchAutoHeading(base.lat, base.lng, base.pano_id);

    let mapBounds = null;
    if (mode === 'custom' && customBounds) {
      mapBounds = [[customBounds.lat[0], customBounds.lng[0]], [customBounds.lat[1], customBounds.lng[1]]];
    } else if (mode === 'europa') {
      mapBounds = regionsToBounds(REGIONS_EUROPA);
    }

    res.json({
      panoId: base.pano_id,
      heading,
      location: { lat: base.lat, lng: base.lng, label: base.label },
      mapBounds,
    });
  } catch (err) {
    console.error('[solo] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Session erstellen (Host) – kein Name nötig
  socket.on('create-session', (_, cb) => {
    const code = makeCode();
    const hostSecret = Math.random().toString(36).substring(2, 18);
    sessions[code] = {
      code,
      host: socket.id,
      hostSecret,
      players: [],
      leftThisRound: [],
      phase: 'lobby',
      location: null,
      pins: {},
      round: 0,
      usedPanoIds: new Set(),
      pinCountdown: 30,
    };
    socket.join(code);
    socket.data.code = code;
    cb({ code, players: [], hostSecret });
    console.log('session created:', code);
  });

  // Session beitreten
  socket.on('join-session', ({ code, name }, cb) => {
    const session = sessions[code];
    if (!session) return cb({ error: 'Session nicht gefunden' });
    if (session.players.some((p) => p.name === name)) return cb({ error: 'Name bereits vergeben' });

    const isSpectator = session.phase !== 'lobby';
    const player = { id: socket.id, name, score: 0 };
    if (isSpectator) player.spectator = true;
    session.players.push(player);
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    io.to(code).emit('players-updated', activePlayers(session));
    const resp = { code, players: activePlayers(session), isHost: false, spectator: isSpectator };
    if (isSpectator && session.phase === 'game' && session.location) {
      resp.panoId = session.location.pano_id;
      resp.heading = session.location.heading;
      resp.mapBounds = session.mapBounds || null;
    }
    cb(resp);
    console.log(`${name} joined ${code}${isSpectator ? ' (spectator)' : ''}`);
  });

  // Wiederbeitreten nach Verbindungsunterbrechung
  socket.on('rejoin-session', ({ code, name, isHost, hostSecret }, cb) => {
    const session = sessions[code];
    if (!session) return cb({ error: 'Session nicht mehr vorhanden' });

    if (isHost) {
      if (session.hostSecret !== hostSecret) return cb({ error: 'Ungültige Host-Credentials' });

      // Laufenden Host-Disconnect-Timer abbrechen
      const key = `host:${code}`;
      if (pendingDisconnects[key]) {
        clearTimeout(pendingDisconnects[key].timer);
        delete pendingDisconnects[key];
      }

      session.host = socket.id;
      socket.join(code);
      socket.data.code = code;

      const resp = { code, players: activePlayers(session), phase: session.phase };
      if (session.phase === 'game' && session.location) {
        resp.panoId = session.location.pano_id;
        resp.heading = session.location.heading;
        resp.mapBounds = session.mapBounds || null;
      }
      if (session.phase === 'results' && session.currentRoundData) {
        resp.roundData = session.currentRoundData;
      }
      console.log('host rejoined:', code);
      return cb(resp);
    }

    // Spieler-Rejoin: Timer stoppen oder Spieler aus leftThisRound wiederholen
    const key = `${code}:${name}`;
    const pending = pendingDisconnects[key];

    if (pending) {
      clearTimeout(pending.timer);
      delete pendingDisconnects[key];
    }

    let player = session.players.find((p) => p.name === name);

    if (player) {
      // Spieler ist noch drin (temporarilyGone), Socket aktualisieren
      const oldId = player.id;
      if (session.pins[oldId]) {
        session.pins[socket.id] = session.pins[oldId];
        delete session.pins[oldId];
      }
      player.id = socket.id;
      player.temporarilyGone = false;
    } else if (pending?.player) {
      // Grace-Period abgelaufen aber pending-Daten noch da – wiederherstellen
      const restored = { ...pending.player, id: socket.id, temporarilyGone: false };
      session.players.push(restored);
      // Aus leftThisRound entfernen falls reingeschoben
      session.leftThisRound = (session.leftThisRound || []).filter((p) => p.name !== name);
      player = restored;
    } else {
      return cb({ error: 'Reconnect-Fenster abgelaufen. Bitte neu beitreten.' });
    }

    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    const resp = {
      code, players: activePlayers(session), phase: session.phase, isHost: false, name
    };
    if (session.phase === 'game' && session.location) {
      resp.panoId = session.location.pano_id;
      resp.heading = session.location.heading;
      resp.alreadyPinned = !!session.pins[socket.id];
      resp.mapBounds = session.mapBounds || null;
    }
    if (session.phase === 'results' && session.currentRoundData) {
      resp.roundData = session.currentRoundData;
    }

    io.to(code).emit('players-updated', activePlayers(session));
    cb(resp);
    console.log('player rejoined:', name, code);
  });

  // Spiel starten (nur Host) – Auto-Heading via Metadata API
  socket.on('start-game', async ({ mode, customBounds, panoramaFilter, pinCountdown } = {}) => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;
    await doStartGame(session, code, mode, customBounds, panoramaFilter, pinCountdown);
  });

  // Spieler signalisiert Bereitschaft für nächste Runde (per Name – socketId kann sich ändern)
  socket.on('player-ready', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.phase !== 'results') return;
    if (socket.id === session.host) return;

    const player = session.players.find((p) => p.id === socket.id);
    if (!player) return;

    if (!session.readyPlayers) session.readyPlayers = new Set();
    session.readyPlayers.add(player.name);

    io.to(code).emit('ready-updated', [...session.readyPlayers]);

    // Alle aktiven Spieler bereit → nächste Runde automatisch starten
    const active = session.players.filter((p) => !p.temporarilyGone && !p.spectator);
    if (active.length > 0 && active.every((p) => session.readyPlayers.has(p.name))) {
      doStartGame(session, code, null);
    }
  });

  // Spieler setzt Pin (Host + Spectators nehmen nicht teil)
  socket.on('place-pin', ({ lat, lng }) => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.phase !== 'game') return;
    if (socket.id === session.host) return;
    const placing = session.players.find((p) => p.id === socket.id);
    if (placing?.spectator) return;

    session.pins[socket.id] = { lat, lng };

    const allActive = session.players.filter((p) => !p.spectator);
    const totalPlayers = allActive.length;
    const pinCount = allActive.filter((p) => session.pins[p.id]).length;

    io.to(code).emit('pin-placed', { playerId: socket.id, pinCount, totalPlayers });

    // Countdown starten wenn erster Pin und Countdown-Setting aktiv
    const isFirstPin = pinCount === 1;
    if (isFirstPin && session.pinCountdown > 0 && !session.countdownTimer) {
      session.countdownTimer = setTimeout(() => {
        session.countdownTimer = null;
        finishRound(session, code);
      }, session.pinCountdown * 1000);
      io.to(code).emit('countdown-started', { seconds: session.pinCountdown });
    }

    if (allActive.length > 0 && allActive.every((p) => session.pins[p.id])) {
      finishRound(session, code);
    }
  });

  // Zurück zur Lobby (nur Host) – setzt Spiel vollständig zurück
  socket.on('back-to-lobby', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;
    if (session.countdownTimer) { clearTimeout(session.countdownTimer); session.countdownTimer = null; }
    session.phase = 'lobby';
    session.pins = {};
    session.location = null;
    session.round = 0;
    session.leftThisRound = [];
    session.customBounds = null;
    session.players.forEach((p) => { p.score = 0; p.spectator = false; p.temporarilyGone = false; });
    session.usedPanoIds = new Set();
    io.to(code).emit('back-to-lobby');
  });

  // Disconnect
  socket.on('disconnect', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session) return;

    // Host-Disconnect mit Grace-Period
    if (session.host === socket.id) {
      const key = `host:${code}`;
      clearTimeout(pendingDisconnects[key]?.timer);
      const timer = setTimeout(() => {
        delete pendingDisconnects[key];
        if (!sessions[code]) return;
        delete sessions[code];
        io.to(code).emit('host-left');
        console.log('host left (grace expired):', code);
      }, RECONNECT_GRACE_MS);
      pendingDisconnects[key] = { timer, code };
      console.log('host disconnected (grace period):', code);
      return;
    }

    const leavingPlayer = session.players.find((p) => p.id === socket.id);
    if (!leavingPlayer) return;

    const key = `${code}:${leavingPlayer.name}`;
    clearTimeout(pendingDisconnects[key]?.timer);

    // Spieler als temporär weg markieren – nicht sofort entfernen
    leavingPlayer.temporarilyGone = true;

    // Host über den Disconnect informieren (mit temporarilyGone-Flag im Payload)
    io.to(code).emit('players-updated', session.players.filter((p) => !p.spectator));

    // Grace-Period starten – danach Spieler wirklich entfernen
    // KEIN sofortiges Runden-Ende: temporarilyGone-Spieler zählen noch als "ausstehend"
    const timer = setTimeout(() => {
      delete pendingDisconnects[key];
      const sess = sessions[code];
      if (!sess) return;

      sess.players = sess.players.filter((p) => p.id !== leavingPlayer.id);

      if ((sess.phase === 'game' || sess.phase === 'results') && leavingPlayer) {
        if (!sess.leftThisRound) sess.leftThisRound = [];
        if (!sess.leftThisRound.some((p) => p.id === leavingPlayer.id)) {
          sess.leftThisRound.push(leavingPlayer);
        }
      }

      if (sess.players.length === 0) {
        delete sessions[code];
        console.log('session deleted (leer):', code);
        return;
      }

      // Jetzt Runden-Ende prüfen: Grace abgelaufen, Spieler ist raus
      if (sess.phase === 'game') {
        const allActive = sess.players.filter((p) => !p.spectator);
        if (allActive.length > 0 && allActive.every((p) => sess.pins[p.id])) {
          finishRound(sess, code);
          return;
        }
      }

      io.to(code).emit('player-left', {
        name: leavingPlayer.name,
        players: activePlayers(sess)
      });

      if (sess.phase === 'results' && sess.currentRoundData && leavingPlayer) {
        sess.currentRoundData = {
          ...sess.currentRoundData,
          results: sess.currentRoundData.results.map((p) =>
            p.id === leavingPlayer.id ? { ...p, left: true } : p
          )
        };
        io.to(code).emit('results-updated', sess.currentRoundData);
      }

      console.log('player left (grace expired):', leavingPlayer.name);
    }, RECONNECT_GRACE_MS);

    pendingDisconnects[key] = { timer, code, player: leavingPlayer };
    console.log('player disconnected (grace period):', leavingPlayer.name);
  });
});

const PORT = process.env.PORT || 3001;
checkApiKey()
  .then(() => server.listen(PORT, () => console.log(`Server läuft auf Port ${PORT}`)))
  .catch((err) => { console.error(`\n❌ Server-Start abgebrochen: ${err.message}\n`); process.exit(1); });
