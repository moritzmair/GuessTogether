// Anzeige-Helfer fuer Ergebnisse (Multiplayer + Solo)

/** 0.35 → "350 m", 4.27 → "4,3 km", 1234.5 → "1.235 km" */
export function formatDistance(km) {
  if (km < 1) return `${Math.round(km * 1000)} m`;
  return `${km.toLocaleString(undefined, { maximumFractionDigits: km < 10 ? 1 : 0 })} km`;
}

// Leaflet-Labels und -Popups sind rohes HTML. Spielernamen darin ungefiltert =
// jeder Name wie "<svg onload=…>" liefe bei allen Mitspielern als Code.
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
