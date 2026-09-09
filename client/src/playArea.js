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
