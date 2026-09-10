require('dotenv').config();
const express = require('express');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const { isNearLand } = require('./landMask');

// Zwei Keys, zwei Einsatzorte:
//   MAPS_KEY    – Backend, ruft die Street View Metadata API auf. Verlaesst den Server nie,
//                 laesst sich daher in der Cloud Console per IP-Adresse einschraenken.
//   BROWSER_KEY – wird ueber /api/maps-key an den Client geliefert und laedt die Maps
//                 JavaScript API. Im Browser zwangslaeufig oeffentlich, gehoert deshalb
//                 per HTTP-Referrer + API-Restriktion auf die Maps JavaScript API begrenzt.
// Ohne GOOGLE_MAPS_BROWSER_KEY faellt der Client auf den Server-Key zurueck (Dev-Komfort).
const MAPS_KEY = (process.env.GOOGLE_MAPS_API_KEY || '').trim();
const BROWSER_KEY = (process.env.GOOGLE_MAPS_BROWSER_KEY || '').trim() || MAPS_KEY;

// Antworten der Google Maps Platform, die sich durch Wiederholen nicht beheben lassen:
// Key ungueltig, API nicht aktiviert, Billing fehlt, Referrer/IP blockiert.
class GoogleApiError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GoogleApiError';
    this.status = status;
  }
}

const SETUP_HINT = [
  'Im Google-Cloud-Projekt des Keys pruefen:',
  '  1. Abrechnungskonto verknuepft     https://console.cloud.google.com/billing',
  '  2. "Street View Static API" aktiv  – liefert die Panorama-Metadaten (Server)',
  '  3. "Maps JavaScript API" aktiv     – zeigt das Panorama (Browser)',
  '  4. Key-Restriktionen erlauben genau diese APIs und diesen Host',
].join('\n');

// Beim Start einmal echt gegen die API sprechen. Ohne diese Probe faellt ein toter Key
// erst in der ersten Runde auf – dort aber als "Kein Street View gefunden", nach 40
// vergeblichen Requests und ohne Googles eigentliche Fehlermeldung.
async function checkApiKey() {
  if (!MAPS_KEY) {
    throw new Error(`GOOGLE_MAPS_API_KEY fehlt in server/.env\n\n${SETUP_HINT}`);
  }

  let meta;
  try {
    meta = await fetchNearestPanorama(48.8584, 2.2945, 1000); // Eiffelturm: Panorama garantiert
  } catch (err) {
    if (err instanceof GoogleApiError) {
      throw new Error(`Google lehnt den API-Key ab (${err.status}):\n  ${err.message}\n\n${SETUP_HINT}`);
    }
    throw err;
  }

  if (meta.status !== 'OK') {
    // Netzwerkproblem o. ae. – kein Grund den Server nicht zu starten
    console.warn(`[api] Probe-Request lieferte "${meta.status}" – Server startet trotzdem.`);
    return;
  }
  console.log(`[api] Google Maps OK (Street View Metadata erreichbar)${BROWSER_KEY === MAPS_KEY ? ' – Hinweis: Browser nutzt denselben Key, siehe GOOGLE_MAPS_BROWSER_KEY' : ''}`);
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

// Punkte fuer einen Pin: bis 10 m volle 10.000, danach exponentiell fallend:
// 10.000 · e^(−km / scaleKm). Die Kurve bleibt lange hoch und faellt erst bei grossen
// Fehlern steil ab – das richtige Land zu treffen zaehlt, der falsche Kontinent kaum.
// scaleKm ist wie bei GeoGuessr ein Zehntel der Gebietsgroesse: weltweit 1.500 km
// (500 km → ~7.200, 1.500 km → ~3.700), im Custom-Gebiet ein Zehntel der Diagonale –
// sonst laege in einer Stadt jeder Pin bei ueber 9.900. Gleiche Formel in client/src/playArea.js.
const WORLD_SCALE_KM = 1500;

function scoreScaleKm(playArea) {
  if (!playArea) return WORLD_SCALE_KM;
  const [[south, west], [north, east]] = playArea;
  // Aequirektangulaer statt Haversine: bleibt auch bei Gebieten ueber die Datumsgrenze
  // oder mit mehr als 180° Breite richtig
  const midLat = ((south + north) / 2) * Math.PI / 180;
  const latKm = Math.abs(north - south) * 111.32;
  const lngKm = Math.min(Math.abs(east - west), 360) * 111.32 * Math.cos(midLat);
  return Math.min(WORLD_SCALE_KM, Math.max(0.2, Math.hypot(latKm, lngKm) / 10));
}

function scorePoints(km, playArea) {
  const scaleKm = scoreScaleKm(playArea);
  return Math.max(1, Math.round(10000 * Math.exp(-Math.max(0, km - 0.01) / scaleKm)));
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

// Die Panorama-Suche schickt viele Anfragen parallel – ohne Keep-Alive kostet jede
// einen eigenen TLS-Handshake.
const googleAgent = new https.Agent({ keepAlive: true, maxSockets: 25 });

// Street View Metadata abrufen – sucht Panorama im gegebenen Radius (in Metern)
// source: 'default' (alle) | 'outdoor' (kein Indoor)
// Bei OVER_QUERY_LIMIT: kurz warten und einmal wiederholen
// Wirft GoogleApiError, wenn Google die Anfrage grundsaetzlich ablehnt – solche Fehler
// gelten fuer jede weitere Anfrage genauso, Weitersuchen waere reine Verschwendung.
async function fetchNearestPanorama(lat, lng, radiusMeters = 50000, source = 'default') {
  const doFetch = () => new Promise((resolve) => {
    const url = `https://maps.googleapis.com/maps/api/streetview/metadata?location=${lat},${lng}&radius=${radiusMeters}&source=${source}&key=${MAPS_KEY}`;
    https.get(url, { agent: googleAgent }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ status: 'ERROR' }); }
      });
    }).on('error', () => resolve({ status: 'ERROR' }));
  });

  let result = await doFetch();
  if (result.status === 'OVER_QUERY_LIMIT') {
    console.warn('[api] OVER_QUERY_LIMIT – warte 1s');
    await new Promise((r) => setTimeout(r, 1000));
    result = await doFetch();
  }

  // REQUEST_DENIED: Key/Billing/API-Aktivierung/Restriktion.
  // INVALID_REQUEST: fehlerhafte Parameter – bei festen Parametern ein Bug, kein Zufall.
  // OVER_QUERY_LIMIT nach dem Retry: Kontingent erschoepft, weitere Requests helfen nicht.
  if (result.status === 'REQUEST_DENIED' || result.status === 'INVALID_REQUEST' || result.status === 'OVER_QUERY_LIMIT') {
    throw new GoogleApiError(
      result.status,
      result.error_message || `Google Maps Platform lehnt die Anfrage ab (${result.status})`
    );
  }
  return result;
}

// Fahrtrichtung ermitteln: bricht nach erstem Treffer ab (spart API-Calls)
// Die Blickrichtung ist Kosmetik – schlaegt die Abfrage fehl, startet die Runde trotzdem.
async function fetchAutoHeading(lat, lng, pano_id) {
  const offsets = [[0.001, 0], [0, 0.001], [-0.001, 0], [0, -0.001]];
  for (const [dlat, dlng] of offsets) {
    let meta2;
    try {
      meta2 = await fetchNearestPanorama(lat + dlat, lng + dlng, 100);
    } catch (err) {
      console.warn(`[api] Heading-Abfrage fehlgeschlagen (${err.message}) – nutze 0°`);
      return 0;
    }
    if (meta2.status === 'OK' && meta2.pano_id !== pano_id) {
      return Math.round(bearing(lat, lng, meta2.location.lat, meta2.location.lng));
    }
  }
  return 0;
}

// Gefundenes Panorama um die Blickrichtung ergaenzen
async function locateRound(base) {
  return { ...base, heading: await fetchAutoHeading(base.lat, base.lng, base.pano_id) };
}

const TOTAL_ROUNDS = 5;

// Ohne 0/O und 1/I/L – der Code wird vom Fernseher abgelesen und abgetippt
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  let code;
  do {
    code = Array.from(crypto.randomBytes(5), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  } while (sessions[code]);
  return code;
}

const normalizeCode = (code) => String(code || '').trim().toUpperCase();

// Namen landen in Listen und Karten-Labels aller Mitspieler – nur Text, begrenzte Laenge
function cleanName(name) {
  return typeof name === 'string' ? name.replace(/\s+/g, ' ').trim().slice(0, 20) : '';
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

// Panorama-Auswahl des Hosts. Fehlt ein Wert, gilt die strenge Variante.
//   googleOnly  – nur offizielle Google-Aufnahmen, keine Nutzer-Uploads
//   outdoorOnly – keine Indoor-Panoramen (per source=outdoor der Metadata-API)
function panoramaOptions({ googleOnly, outdoorOnly } = {}) {
  return { googleOnly: googleOnly !== false, outdoorOnly: outdoorOnly !== false };
}

// Offizielle Google-Aufnahme oder Nutzer-Upload (Photosphere)? Die Metadata-API kann
// danach nicht filtern (source=google → INVALID_REQUEST), also an der Antwort erkennen:
//   Google: copyright "© Google", pano_id mit 22 Zeichen
//   Nutzer: copyright "© <Name>",  pano_id "CAoS…" mit 36 bzw. 44 Zeichen
// Nutzer-Uploads sind oft falsch verortet – Bild und Loesung passen dann nicht zusammen.
function isOfficialGooglePano(meta) {
  return !!meta.copyright?.startsWith('© Google') && /^[\w-]{22}$/.test(meta.pano_id);
}

// Custom-Bounds ({ lat: [sued, nord], lng: [west, ost] }) → Leaflet-Bounds
function boundsToPlayArea(cb) {
  return [[cb.lat[0], cb.lng[0]], [cb.lat[1], cb.lng[1]]];
}

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const jitter = (v, span) => v + (Math.random() - 0.5) * span;

// Suchpunkte im offenen Wasser gar nicht erst abfragen (siehe landMask.js). Findet sich
// in 200 Zuegen kein Punkt an Land, ist das Gebiet laut Maske reines Wasser – etwa eine
// kleine Insel, die in den groben Kuestendaten fehlt. Dann ab sofort ungefiltert suchen.
function onLand(nextSeed) {
  let masked = true;
  return () => {
    if (masked) {
      for (let i = 0; i < 200; i++) {
        const seed = nextSeed();
        if (isNearLand(seed.lat, seed.lng)) return seed;
      }
      masked = false;
    }
    return nextSeed();
  };
}

// Liefert pro Versuch einen Suchpunkt samt Suchradius in Metern.
// Beruehmt/Grossstaedte streuen nur wenige Kilometer um Punkte an Land – dort braucht es
// keine Maske, die Kuestendaten waeren auf diese Entfernung ohnehin zu grob.
function seedGenerator(mode, customBounds) {
  if (mode === 'beruehmt') {
    // Leicht streuen: direkt am Wahrzeichen ist fast immer ein Nutzer-Panorama das
    // naechste – mit "nur Google" wuerde sonst jedes Mal derselbe Treffer verworfen.
    return () => {
      const [lat, lng] = pick(FAMOUS_PLACES);
      return { lat: jitter(lat, 0.01), lng: jitter(lng, 0.01), radius: 3000 };
    };
  }
  if (mode === 'grossstaedte') {
    return () => {
      const [lat, lng] = pick(CITIES);
      return { lat: jitter(lat, 0.05), lng: jitter(lng, 0.05), radius: 2000 };
    };
  }
  if (mode === 'custom' && customBounds) {
    const [[south, west], [north, east]] = boundsToPlayArea(customBounds);
    // Radius an die Gebietsgroesse koppeln: 10 km Suchradius in einem Stadtteil
    // landen meist ausserhalb und verbrennen nur Versuche.
    const halfDiagonalM = distanceKm(south, west, north, east) * 500;
    const radius = Math.round(Math.min(10000, Math.max(50, halfDiagonalM)));
    return onLand(() => ({
      lat: south + Math.random() * (north - south),
      // Nach Schwenken ueber die Datumsgrenze liefert Leaflet Laengen jenseits ±180,
      // darauf antwortet Google nur mit NOT_FOUND.
      lng: normalizeLng(west + Math.random() * (east - west)),
      radius,
    }));
  }
  const regions = mode === 'europa' ? REGIONS_EUROPA : REGIONS_WELTWEIT;
  return onLand(() => {
    const r = pick(regions);
    return {
      lat: r.lat[0] + Math.random() * (r.lat[1] - r.lat[0]),
      lng: r.lng[0] + Math.random() * (r.lng[1] - r.lng[0]),
      radius: 10000,
    };
  });
}

// Warum taugt der Treffer nicht? null = passt.
// radius = tatsaechlich verwendeter Suchradius; seed.radius (modusabhaengig) bestimmt
// weiterhin den Mindestabstand zu frueheren Orten.
function rejectReason(meta, seed, radius, playArea, googleOnly, usedPanos) {
  if (meta.status !== 'OK' || !meta.pano_id) {
    return `kein Panorama bei (${seed.lat.toFixed(3)}, ${seed.lng.toFixed(3)})`;
  }
  const { lat, lng } = meta.location;
  // Google liefert vereinzelt Panoramen weit jenseits des Radius (beobachtet: 470 km
  // bei 5 km Radius) – falsch verortete Nutzer-Uploads.
  const distM = distanceKm(seed.lat, seed.lng, lat, lng) * 1000;
  if (distM > radius * 1.1 + 50) {
    return `Panorama ${Math.round(distM)} m vom Suchpunkt, Radius nur ${radius} m`;
  }
  // Der Suchradius reicht ueber den Gebietsrand hinaus – der Treffer selbst muss drin liegen
  if (!isInsidePlayArea(lat, lng, playArea)) {
    return `ausserhalb des Spielgebiets (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
  }
  if (googleOnly && !isOfficialGooglePano(meta)) {
    return `kein offizielles Google-Panorama ("${meta.copyright}")`;
  }
  // Orte aus diesem Spiel meiden – nicht nur dieselbe pano_id, auch Nachbar-Panoramen
  // derselben Stelle (anderes Aufnahmedatum, ein paar Meter weiter). Der Mindestabstand
  // richtet sich nach dem Suchradius, damit kleine Custom-Gebiete nicht sofort ausgehen.
  const minSpacingM = Math.min(1000, seed.radius / 3);
  const near = usedPanos.find((u) =>
    u.pano_id === meta.pano_id || distanceKm(u.lat, u.lng, lat, lng) * 1000 < minSpacingM
  );
  if (near) {
    return near.pano_id === meta.pano_id
      ? 'Panorama bereits benutzt'
      : `zu nah an einem Ort aus diesem Spiel (< ${Math.round(minSpacingM)} m)`;
  }
  return null;
}

// Die Metadata-API liefert zu einem Punkt immer das *naechstgelegene* Panorama. Mit
// grossem Suchradius gewinnt damit jedes Panorama mit der Flaeche, der es am naechsten
// liegt: ein einsamer Feldweg hat Quadratkilometer fuer sich, eine Stadtstrasse ein paar
// hundert Quadratmeter – es kam fast immer Land heraus. Eine Liste aller Panoramen zum
// Ziehen bietet Google nicht an.
// Deshalb zuerst mit kleinem Radius suchen: ein Zufallspunkt trifft nur, wenn er direkt
// an einer Strasse mit Aufnahmen liegt, jedes Panorama hat also ungefaehr dieselbe Chance
// und Staedte mit ihren vielen Strassen kommen entsprechend oft dran. Das kostet mehr
// Anfragen (gemessen bei 50 m: ~2 % Treffer weltweit, ~7 % Europa, in Staedten fast
// jede), Metadata-Anfragen sind aber kostenlos und laufen parallel. Findet das nichts
// (duenn abgedecktes Gebiet), folgt die Suche mit dem modusabhaengigen grossen Radius.
const SEARCH_BATCH = 20;
const SEARCH_PHASES = [
  { name: 'Feinsuche', radius: 50, batches: 10 },
  { name: 'Grobsuche', radius: null, batches: 2 }, // null = seed.radius
];

// usedPanos: [{ pano_id, lat, lng }] – bereits gespielte Orte dieses Spiels
async function randomStreetViewLocation(mode = 'weltweit', customBounds = null, panorama = panoramaOptions(), usedPanos = []) {
  const { googleOnly, outdoorOnly } = panorama;
  const source = outdoorOnly ? 'outdoor' : 'default';
  const playArea = mode === 'custom' && customBounds ? boundsToPlayArea(customBounds) : null;
  const nextSeed = seedGenerator(mode, customBounds);
  const tag = `[${mode}${googleOnly ? ' · nur Google' : ''}${outdoorOnly ? ' · outdoor' : ''}]`;

  let requests = 0;
  for (const phase of SEARCH_PHASES) {
    for (let b = 0; b < phase.batches; b++) {
      const seeds = Array.from({ length: SEARCH_BATCH }, nextSeed);
      const metas = await Promise.all(seeds.map((s) =>
        fetchNearestPanorama(s.lat, s.lng, phase.radius ?? s.radius, source)));
      requests += seeds.length;

      // Alle Suchpunkte sind unabhaengig gezogen – der erste brauchbare ist so zufaellig wie jeder andere
      for (let i = 0; i < seeds.length; i++) {
        const reason = rejectReason(metas[i], seeds[i], phase.radius ?? seeds[i].radius, playArea, googleOnly, usedPanos);
        if (reason) {
          // Leere Suchpunkte sind in der Feinsuche die Regel, nur echte Verwerfungen loggen
          if (metas[i].status === 'OK') console.log(`${tag} ${phase.name}: ${reason}`);
          continue;
        }
        const { lat, lng } = metas[i].location;
        console.log(`${tag} Panorama bei (${lat.toFixed(4)}, ${lng.toFixed(4)}) – ${phase.name}, ${requests} Anfragen`);
        return { lat, lng, pano_id: metas[i].pano_id, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
      }
    }
    console.log(`${tag} ${phase.name} ohne Treffer nach ${requests} Anfragen`);
  }
  const tips = [playArea && 'größeres Gebiet wählen', googleOnly && 'Nutzer-Panoramen zulassen'].filter(Boolean);
  throw new Error(`Kein Street View gefunden (Modus "${mode}", ${requests} Anfragen)${tips.length ? ` – ${tips.join(' oder ')}` : ''}`);
}

function normalizeLng(lng) {
  return ((lng + 180) % 360 + 360) % 360 - 180;
}

// Liegt der Punkt im Spielgebiet? Ohne Gebiet ist alles erlaubt.
// Spiegelt isInsidePlayArea() aus client/src/playArea.js – dort wird der Klick schon
// abgefangen, hier zaehlt es wirklich: ein manipulierter Client kaeme sonst durch.
// Dient ausserdem beim Suchen als Grenze fuer das Panorama selbst.
function isInsidePlayArea(lat, lng, playArea) {
  if (!playArea) return true;
  const [[south, west], [north, east]] = playArea;
  if (lat < Math.min(south, north) || lat > Math.max(south, north)) return false;
  if (Math.abs(east - west) >= 360) return true;
  const l = normalizeLng(lng), w = normalizeLng(west), e = normalizeLng(east);
  return w <= e ? l >= w && l <= e : l >= w || l <= e;
}

// Runde abschließen
function finishRound(session, code) {
  if (session.phase !== 'game') return;
  clearCountdown(session);

  const nonSpectators = session.players.filter((p) => !p.spectator);

  const results = nonSpectators.map((p) => {
    // Gesetzt, aber nicht bestaetigt (Countdown abgelaufen, Host hat aufgeloest) zaehlt trotzdem
    const pin = session.pins[p.id] || session.draftPins?.[p.id];
    const dist = pin
      ? distanceKm(session.location.lat, session.location.lng, pin.lat, pin.lng)
      : 99999;
    const points = pin ? scorePoints(dist, session.playArea) : 0;
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
  session.history.push(roundData);

  io.to(code).emit('round-ended', roundData);
}

// Aktive Spieler (nicht temporarilyGone) für Clients – Spectators werden mitgesendet
function activePlayers(session) {
  return session.players.filter((p) => !p.temporarilyGone);
}

function clearCountdown(session) {
  clearTimeout(session.countdownTimer);
  session.countdownTimer = null;
  session.countdownEndsAt = null;
}

// Alles, was ein Client fuer die laufende Runde braucht – beim Rundenstart und beim
// (Wieder-)Beitreten mitten in der Runde, damit Countdown und Pin-Stand stimmen.
function gameState(session, socketId = null) {
  const seats = session.players.filter((p) => !p.spectator);
  return {
    panoId: session.location.pano_id,
    heading: session.location.heading,
    mapBounds: session.mapBounds || null,
    playArea: session.playArea || null,
    round: session.round,
    totalRounds: TOTAL_ROUNDS,
    pinnedIds: seats.filter((p) => session.pins[p.id]).map((p) => p.id),
    totalPlayers: seats.length,
    countdownLeft: session.countdownEndsAt
      ? Math.max(0, Math.ceil((session.countdownEndsAt - Date.now()) / 1000))
      : null,
    alreadyPinned: !!(socketId && session.pins[socketId]),
  };
}

// Stand fuer (Wieder-)Beitretende: Phase, laufende Runde bzw. letztes Ergebnis und alle
// bisherigen Runden – sonst ist die Zusammenfassung nach einem Reload leer.
function sessionState(session, socketId) {
  const state = { code: session.code, players: activePlayers(session), phase: session.phase, history: session.history };
  if (session.phase === 'game' && session.location) state.game = gameState(session, socketId);
  if (session.phase === 'results' && session.currentRoundData) state.roundData = session.currentRoundData;
  return state;
}

async function doStartGame(session, code, mode, customBounds, panorama, pinCountdown) {
  if (session.round >= TOTAL_ROUNDS) {
    session.round = 0;
    session.players.forEach((p) => (p.score = 0));
    session.leftThisRound = [];
    session.usedPanos = [];
    session.history = [];
  }

  clearCountdown(session);

  if (pinCountdown !== undefined) session.pinCountdown = pinCountdown;

  const gameMode = mode || session.mode || 'weltweit';
  session.mode = gameMode;
  // Folgerunden (player-ready) kommen ohne Einstellungen – dann gilt die gespeicherte
  if (panorama || !session.panorama) session.panorama = panoramaOptions(panorama);
  if (customBounds) session.customBounds = customBounds;

  const location = await locateRound(
    await randomStreetViewLocation(gameMode, session.customBounds || null, session.panorama, session.usedPanos || [])
  );

  const cb = session.customBounds;
  // mapBounds = Zoom-Hilfe fuer die Rate-Karte.
  // playArea  = verbindliche Grenze fuer Pins. Nur im Custom-Modus gesetzt: dort ist der
  //             gewaehlte Ausschnitt exakt das Spielgebiet. Bei "europa" ist mapBounds
  //             nur die Huellbox ueber 10 Teilregionen und damit deutlich groesser als
  //             das tatsaechliche Gebiet – als harte Grenze waere sie schlicht falsch.
  let mapBounds = null;
  let playArea = null;
  if (gameMode === 'custom' && cb) {
    mapBounds = boundsToPlayArea(cb);
    playArea = mapBounds;
  } else {
    const modeRegions = gameMode === 'europa' ? REGIONS_EUROPA : null;
    if (modeRegions) mapBounds = regionsToBounds(modeRegions);
  }
  session.mapBounds = mapBounds;
  session.playArea = playArea;

  if (!session.usedPanos) session.usedPanos = [];
  session.usedPanos.push({ pano_id: location.pano_id, lat: location.lat, lng: location.lng });

  session.round = (session.round || 0) + 1;
  session.location = location;
  session.phase = 'game';
  session.pins = {};
  session.draftPins = {};
  session.readyPlayers = new Set();
  session.players.forEach((p) => { p.temporarilyGone = false; p.spectator = false; });

  io.to(code).emit('game-started', { ...gameState(session), players: activePlayers(session) });
  console.log('game started:', code, location.label);
}

// doStartGame kann scheitern (Google lehnt ab, kein Panorama gefunden). Ohne diesen
// Wrapper wurde daraus eine unbehandelte Promise-Rejection und die Lobby wartete stumm.
async function startGameSafe(session, code, mode, customBounds, panorama, pinCountdown) {
  // Die Suche dauert bis zu einigen Sekunden, die Phase bleibt solange unveraendert.
  // Ein zweiter Trigger (Doppelklick, Host "Naechste Runde" + letzter Spieler bereit)
  // wuerde sonst parallel suchen – mit derselben Liste benutzter Orte, also moeglicherweise
  // doppeltem Ort, und die Runde zaehlte zweimal hoch.
  if (session.starting) return;
  session.starting = true;
  // Alle Clients zeigen "Suche Ort…" – auch wenn der Start automatisch (alle bereit) kam
  io.to(code).emit('game-loading');
  try {
    await doStartGame(session, code, mode, customBounds, panorama, pinCountdown);
  } catch (err) {
    const isGoogle = err instanceof GoogleApiError;
    if (isGoogle) console.error(`[game] Google Maps ${err.status}: ${err.message}\n${SETUP_HINT}`);
    else console.error('[game] Rundenstart fehlgeschlagen:', err.message);

    // Phase bleibt, wie sie war (Lobby oder Ergebnis der letzten Runde) – von dort kann
    // es erneut versucht werden. Frueher sprang sie hier auf 'lobby': mitten im Spiel
    // hingen die Spieler dann auf der Ergebnisseite und "Bereit" wurde ignoriert.
    // "Bereit" zuruecksetzen, damit ein erneutes Bereit-Melden wieder einen Start ausloest.
    session.readyPlayers = new Set();
    io.to(code).emit('ready-updated', []);
    io.to(code).emit('game-error', {
      message: isGoogle
        ? `Google Maps lehnt die Anfrage ab (${err.status}): ${err.message}`
        : err.message,
      code: isGoogle ? err.status : 'NO_PANORAMA',
    });
  } finally {
    session.starting = false;
  }
}

app.get('/health', (_, res) => res.json({ ok: true }));

// Der Browser-Key ist oeffentlich – er steht zwangslaeufig im ausgelieferten Frontend.
// Geschuetzt wird er nicht durch Geheimhaltung, sondern durch die Referrer- und
// API-Restriktionen des Keys in der Cloud Console.
app.get('/api/maps-key', (_, res) => res.json({ key: BROWSER_KEY, configured: !!BROWSER_KEY }));

// Solo-Modus: Neue Runde starten – gibt Panorama-Daten zurück ohne Session
app.get('/api/solo/start-round', async (req, res) => {
  const mode = req.query.mode || 'weltweit';
  const panorama = panoramaOptions({
    googleOnly: req.query.googleOnly !== '0',
    outdoorOnly: req.query.outdoorOnly !== '0',
  });
  let customBounds = null;
  if (req.query.customBounds) {
    try { customBounds = JSON.parse(req.query.customBounds); } catch (_) {}
  }
  // Orte der bisherigen Runden – der Server merkt sich im Solo-Modus nichts,
  // deshalb schickt der Client sie mit.
  let usedPanos = [];
  if (req.query.used) {
    try {
      usedPanos = JSON.parse(req.query.used)
        .filter((u) => typeof u?.pano_id === 'string' && Number.isFinite(u.lat) && Number.isFinite(u.lng))
        .slice(0, 50);
    } catch (_) {}
  }
  try {
    const loc = await locateRound(await randomStreetViewLocation(mode, customBounds, panorama, usedPanos));

    let mapBounds = null;
    let playArea = null;
    if (mode === 'custom' && customBounds) {
      mapBounds = boundsToPlayArea(customBounds);
      playArea = mapBounds;
    } else if (mode === 'europa') {
      mapBounds = regionsToBounds(REGIONS_EUROPA);
    }

    res.json({
      panoId: loc.pano_id,
      heading: loc.heading,
      location: { lat: loc.lat, lng: loc.lng, label: loc.label },
      mapBounds,
      playArea,
    });
  } catch (err) {
    if (err instanceof GoogleApiError) {
      console.error(`[solo] Google Maps ${err.status}: ${err.message}\n${SETUP_HINT}`);
      return res.status(502).json({
        error: `Google Maps lehnt die Anfrage ab (${err.status}): ${err.message}`,
        code: err.status,
      });
    }
    console.error('[solo] Fehler:', err.message);
    res.status(500).json({ error: err.message });
  }
});

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  // Session erstellen (Host) – kein Name nötig
  socket.on('create-session', (_, cb) => {
    const code = makeCode();
    const hostSecret = crypto.randomBytes(16).toString('hex');
    sessions[code] = {
      code,
      host: socket.id,
      hostSecret,
      players: [],
      leftThisRound: [],
      phase: 'lobby',
      location: null,
      pins: {},
      draftPins: {},
      history: [],
      round: 0,
      usedPanos: [],
      pinCountdown: 30,
    };
    socket.join(code);
    socket.data.code = code;
    cb({ code, players: [], hostSecret });
    console.log('session created:', code);
  });

  // Session beitreten
  socket.on('join-session', ({ code, name } = {}, cb) => {
    code = normalizeCode(code);
    name = cleanName(name);
    const session = sessions[code];
    if (!session) return cb({ error: `Keine Session mit dem Code „${code}“ gefunden` });
    if (!name) return cb({ error: 'Bitte Namen eingeben' });
    if (session.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return cb({ error: 'Name bereits vergeben' });
    }

    const isSpectator = session.phase !== 'lobby';
    const player = { id: socket.id, name, score: 0 };
    if (isSpectator) player.spectator = true;
    session.players.push(player);
    socket.join(code);
    socket.data.code = code;
    socket.data.name = name;

    io.to(code).emit('players-updated', activePlayers(session));
    cb({ ...sessionState(session, socket.id), isHost: false, name, spectator: isSpectator });
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

      console.log('host rejoined:', code);
      return cb(sessionState(session, socket.id));
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
      for (const pins of [session.pins, session.draftPins || {}]) {
        if (pins[oldId]) {
          pins[socket.id] = pins[oldId];
          delete pins[oldId];
        }
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

    io.to(code).emit('players-updated', activePlayers(session));
    cb({ ...sessionState(session, socket.id), isHost: false, name, spectator: !!player.spectator });
    console.log('player rejoined:', name, code);
  });

  // Spiel starten (nur Host) – Auto-Heading via Metadata API
  socket.on('start-game', async ({ mode, customBounds, panorama, pinCountdown } = {}) => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;
    await startGameSafe(session, code, mode, customBounds, panorama, pinCountdown);
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
      startGameSafe(session, code, null);
    }
  });

  // Spieler setzt Pin (Host + Spectators nehmen nicht teil)
  socket.on('place-pin', ({ lat, lng, draft } = {}) => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.phase !== 'game') return;
    if (socket.id === session.host) return;
    const placing = session.players.find((p) => p.id === socket.id);
    if (placing?.spectator) return;
    if (typeof lat !== 'number' || typeof lng !== 'number' || !isFinite(lat) || !isFinite(lng)) return;
    if (!isInsidePlayArea(lat, lng, session.playArea)) {
      console.warn(`[game] Pin ausserhalb des Spielgebiets verworfen (${placing?.name}: ${lat}, ${lng})`);
      return;
    }

    // Vorgemerkt (Karte angetippt, noch nicht bestaetigt): zaehlt nur, falls die Runde
    // endet, bevor bestaetigt wurde – sonst ginge der Pin beim Countdown-Ende verloren.
    if (draft) {
      if (!session.draftPins) session.draftPins = {};
      session.draftPins[socket.id] = { lat, lng };
      return;
    }

    session.pins[socket.id] = { lat, lng };

    const allActive = session.players.filter((p) => !p.spectator);
    const totalPlayers = allActive.length;
    const pinCount = allActive.filter((p) => session.pins[p.id]).length;

    io.to(code).emit('pin-placed', { playerId: socket.id, pinCount, totalPlayers });

    // Countdown starten wenn erster Pin und Countdown-Setting aktiv
    const isFirstPin = pinCount === 1;
    if (isFirstPin && session.pinCountdown > 0 && !session.countdownTimer) {
      session.countdownEndsAt = Date.now() + session.pinCountdown * 1000;
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

  // Host loest die Runde vorzeitig auf – z. B. wenn ein Handy eingeschlafen ist und sonst
  // alle bis zum Ende der Reconnect-Frist warten muessten. Vorgemerkte Pins zaehlen.
  socket.on('end-round', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;
    finishRound(session, code);
  });

  // Lobby verlassen (Zurueck-Button). Host → Session aufloesen, alle Spieler landen
  // auf der Startseite. Spieler → nur sich selbst austragen.
  socket.on('leave-session', () => {
    const code = socket.data.code;
    const session = sessions[code];
    socket.leave(code);
    socket.data.code = null;
    if (!session) return;

    if (session.host === socket.id) {
      clearCountdown(session);
      delete sessions[code];
      io.to(code).emit('host-left');
      console.log('host left (lobby):', code);
      return;
    }

    session.players = session.players.filter((p) => p.id !== socket.id);
    io.to(code).emit('players-updated', activePlayers(session));
    console.log('player left (lobby):', socket.data.name, code);
  });

  // Zurück zur Lobby (nur Host) – setzt Spiel vollständig zurück
  socket.on('back-to-lobby', () => {
    const code = socket.data.code;
    const session = sessions[code];
    if (!session || session.host !== socket.id) return;
    clearCountdown(session);
    session.phase = 'lobby';
    session.pins = {};
    session.draftPins = {};
    session.history = [];
    session.location = null;
    session.round = 0;
    session.leftThisRound = [];
    session.customBounds = null;
    session.mapBounds = null;
    session.playArea = null;
    session.players.forEach((p) => { p.score = 0; p.spectator = false; p.temporarilyGone = false; });
    session.usedPanos = [];
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
        // Letzter History-Eintrag ist in der Ergebnisphase genau diese Runde
        sess.history[sess.history.length - 1] = sess.currentRoundData;
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
