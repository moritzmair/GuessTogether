import L from 'leaflet';

// Spielgebiet = [[sued, west], [nord, ost]] (Leaflet-Bounds), oder null wenn unbegrenzt.
// Gesetzt nur im Custom-Modus, wo der gewaehlte Ausschnitt exakt das Spielgebiet ist.

export function normalizeLng(lng) {
  return ((lng + 180) % 360 + 360) % 360 - 180;
}

/** Liegt der Punkt im Spielgebiet? Ohne Gebiet ist alles erlaubt. */
export function isInsidePlayArea(lat, lng, playArea) {
  if (!playArea) return true;
  const [[south, west], [north, east]] = playArea;

  if (lat < Math.min(south, north) || lat > Math.max(south, north)) return false;

  // Beim Herauszoomen kann der Ausschnitt die ganze Erde umspannen – dann liegt
  // jede Laenge drin und die Normalisierung unten wuerde faelschlich einschraenken.
  if (Math.abs(east - west) >= 360) return true;

  const l = normalizeLng(lng);
  const w = normalizeLng(west);
  const e = normalizeLng(east);
  // Nach dem Normalisieren kann w > e sein: das Gebiet laeuft ueber die Datumsgrenze.
  return w <= e ? l >= w && l <= e : l >= w || l <= e;
}

// ── Punkte ──────────────────────────────────────────────────────────────────
// Bis 10 m volle 10.000, danach exponentiell fallend: 10.000 · e^(−km / scaleKm).
// Die Kurve bleibt lange hoch und faellt erst bei grossen Fehlern steil ab – das
// richtige Land zu treffen zaehlt, der falsche Kontinent kaum. scaleKm ist wie bei
// GeoGuessr ein Zehntel der Gebietsgroesse: weltweit 1.500 km (500 km → ~7.200,
// 1.500 km → ~3.700), im Custom-Gebiet ein Zehntel der Diagonale – sonst laege in
// einer Stadt jeder Pin bei ueber 9.900. Gleiche Formel wie in server/index.js.
const WORLD_SCALE_KM = 1500;

/** Massstab der Punktekurve in km */
export function scoreScaleKm(playArea) {
  if (!playArea) return WORLD_SCALE_KM;
  const [[south, west], [north, east]] = playArea;
  // Aequirektangulaer statt Haversine: bleibt auch bei Gebieten ueber die Datumsgrenze
  // oder mit mehr als 180° Breite richtig
  const midLat = ((south + north) / 2) * Math.PI / 180;
  const latKm = Math.abs(north - south) * 111.32;
  const lngKm = Math.min(Math.abs(east - west), 360) * 111.32 * Math.cos(midLat);
  return Math.min(WORLD_SCALE_KM, Math.max(0.2, Math.hypot(latKm, lngKm) / 10));
}

export function scorePoints(km, playArea) {
  const scaleKm = scoreScaleKm(playArea);
  return Math.max(1, Math.round(10000 * Math.exp(-Math.max(0, km - 0.01) / scaleKm)));
}

// Auf den naechsten 1-2-5-Wert runden, damit die Beispiele lesbar bleiben
function niceKm(km) {
  const exp = 10 ** Math.floor(Math.log10(km));
  return [1, 2, 5, 10].map((m) => m * exp).reduce((best, v) =>
    (Math.abs(Math.log(v / km)) < Math.abs(Math.log(best / km)) ? v : best));
}

/** Drei Beispielwerte fuer die Anzeige vor Spielstart: [{ label, points }] */
export function scoreExamples(playArea) {
  const scaleKm = scoreScaleKm(playArea);
  return [scaleKm / 15, scaleKm / 3, (scaleKm * 4) / 3].map((km) => {
    // Unter 20 m waere es nur eine Wiederholung von "≤ 10 m → 10.000"
    const nice = niceKm(Math.max(0.02, km));
    const label = nice < 1 ? `${Math.round(nice * 1000)} m` : `${nice.toLocaleString()} km`;
    return { label, points: scorePoints(nice, playArea) };
  });
}

/**
 * Zeichnet das Spielgebiet: alles ausserhalb wird abgedunkelt, das Gebiet selbst
 * bekommt einen gestrichelten Rahmen. Gibt die Layer-Gruppe zurueck (oder null).
 */
export function drawPlayArea(map, playArea) {
  if (!map || !playArea) return null;
  const [[south, west], [north, east]] = playArea;

  const layer = L.layerGroup().addTo(map);

  // Maske mit Loch: aussen ein weit ueberstehendes Rechteck (deckt auch benachbarte
  // Weltkopien beim seitlichen Schwenken ab), innen das Spielgebiet als Aussparung.
  const MAX_LAT = 85.05; // Mercator-Grenze
  const outer = [
    [-MAX_LAT, west - 720], [MAX_LAT, west - 720],
    [MAX_LAT, east + 720],  [-MAX_LAT, east + 720],
  ];
  const hole = [[south, west], [north, west], [north, east], [south, east]];

  // interactive: false ist wichtig – sonst schluckt die Maske die Klicks auf die Karte
  L.polygon([outer, hole], {
    stroke: false, fillColor: '#000', fillOpacity: 0.5, interactive: false,
  }).addTo(layer);

  L.rectangle([[south, west], [north, east]], {
    color: '#4ade80', weight: 2, dashArray: '6 4', fill: false, interactive: false,
  }).addTo(layer);

  return layer;
}
