// Landmaske: liegt ein Suchpunkt an (oder nahe) Land? Die Suchgebiete, v. a. Weltweit
// und Europa, bestehen zu gut einem Drittel aus Meer. Ohne Maske kostete jeder Punkt im
// Wasser eine Anfrage, und die Grobsuche mit grossem Radius landete von dort gezielt an
// der Kueste.
//
// Daten: Natural Earth 1:50 Mio. (Public Domain) ueber das npm-Paket world-atlas.
// Die Kuestenlinie ist dort um einige Kilometer vereinfacht – exakt geprueft gaelten
// Kopenhagen, Venedig oder Liberty Island als Wasser. Deshalb der Puffer: nur Punkte,
// in deren Umkreis von 5 km kein Land liegt, gelten als Wasser. Die 1:10-Mio.-Daten
// waeren 6x langsamer und haben dieselben Fehler.
// Seen zaehlen als Land – die paar Prozent Flaeche kosten nur ein paar leere Anfragen.
const { feature } = require('topojson-client');
const topo = require('world-atlas/land-50m.json');

const BUFFER_KM = 5;

function loadPolygons() {
  const geo = feature(topo, topo.objects.land);
  const geometries = geo.type === 'FeatureCollection' ? geo.features.map((f) => f.geometry) : [geo.geometry];

  const polygons = [];
  for (const g of geometries) {
    const list = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    for (const rings of list) {
      let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
      for (const [lng, lat] of rings[0]) {
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
      }
      polygons.push({ rings, minLng, minLat, maxLng, maxLat });
    }
  }
  return polygons;
}

const polygons = loadPolygons();

// Ray-Casting ueber alle Ringe: Loecher (Kaspisches Meer) heben sich so von selbst auf
function insideRings(lng, lat, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function isLand(lat, lng) {
  for (const p of polygons) {
    if (lng < p.minLng || lng > p.maxLng || lat < p.minLat || lat > p.maxLat) continue;
    if (insideRings(lng, lat, p.rings)) return true;
  }
  return false;
}

/** Punkt selbst oder einer von 8 Punkten im Umkreis von BUFFER_KM liegt an Land */
function isNearLand(lat, lng) {
  if (isLand(lat, lng)) return true;
  const dLat = BUFFER_KM / 111.32;
  const dLng = BUFFER_KM / (111.32 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    if (isLand(lat + dLat * Math.sin(a), lng + dLng * Math.cos(a))) return true;
  }
  return false;
}

module.exports = { isNearLand };
