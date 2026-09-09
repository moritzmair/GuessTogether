// Zentrales Laden der Maps JavaScript API.
//
// Vorher luden Game.jsx und SoloGame.jsx das Script jeweils selbst. Zwei Probleme:
// Beim Wechsel zwischen den Seiten konnte es doppelt injiziert werden (Google warnt
// dann und Teile der API brechen), und ein abgelehnter Key blieb unsichtbar – Google
// meldet Auth-Fehler nicht ueber script.onerror, sondern ueber window.gm_authFailure.
// Ohne diesen Hook blieb einfach ein schwarzes Panorama stehen.

let loadPromise = null;
let authFailure = null;
const authListeners = new Set();

function notifyAuthFailure() {
  authFailure =
    'Google Maps hat den API-Key abgelehnt. Meist fehlt die Abrechnung im Cloud-Projekt, ' +
    'die "Maps JavaScript API" ist nicht aktiviert, oder die Referrer-Restriktion des Keys ' +
    'erlaubt diese Domain nicht.';
  authListeners.forEach((fn) => fn(authFailure));
}

/** Aktueller Auth-Fehler oder null. */
export function googleAuthFailure() {
  return authFailure;
}

/** Auf Auth-Fehler horchen; gibt die Abmelde-Funktion zurueck. */
export function onGoogleAuthFailure(fn) {
  if (authFailure) fn(authFailure);
  authListeners.add(fn);
  return () => authListeners.delete(fn);
}

/**
 * Laedt die Maps JavaScript API genau einmal und liefert window.google.maps.
 * Mehrfache Aufrufe teilen sich dasselbe Promise.
 */
export function loadGoogleMaps() {
  if (window.google?.maps?.StreetViewPanorama) {
    return Promise.resolve(window.google.maps);
  }
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    const res = await fetch('/api/maps-key');
    if (!res.ok) throw new Error(`Maps-Key nicht abrufbar (HTTP ${res.status})`);
    const { key, configured } = await res.json();
    if (!configured || !key) {
      throw new Error('Kein Google-Maps-Key konfiguriert – GOOGLE_MAPS_BROWSER_KEY oder GOOGLE_MAPS_API_KEY in server/.env setzen.');
    }

    // Google ruft diesen globalen Hook bei ungueltigem Key / fehlender Abrechnung /
    // blockiertem Referrer auf. Einziger Weg, den Fehler im Frontend zu bemerken.
    window.gm_authFailure = notifyAuthFailure;

    await new Promise((resolve, reject) => {
      const callbackName = '__ggMapsReady';
      window[callbackName] = () => { delete window[callbackName]; resolve(); };

      const s = document.createElement('script');
      // loading=async ist die von Google empfohlene Bootstrap-Variante;
      // libraries=streetView laedt gezielt nur das, was das Spiel braucht.
      s.src = 'https://maps.googleapis.com/maps/api/js'
        + `?key=${encodeURIComponent(key)}`
        + '&v=weekly&loading=async&libraries=streetView'
        + `&callback=${callbackName}`;
      s.async = true;
      s.onerror = () => reject(new Error('Maps JavaScript API konnte nicht geladen werden (Netzwerk/Blocker?)'));
      document.head.appendChild(s);
    });

    if (!window.google?.maps?.StreetViewPanorama) {
      throw new Error('Maps JavaScript API geladen, aber StreetViewPanorama fehlt.');
    }
    return window.google.maps;
  })();

  // Fehlgeschlagenen Versuch nicht cachen – der naechste Anlauf soll neu laden duerfen
  loadPromise.catch(() => { loadPromise = null; });
  return loadPromise;
}
