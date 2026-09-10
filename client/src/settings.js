// Spiel-Einstellungen (Modus, Panorama-Quelle, Countdown, Custom-Ausschnitt) im
// localStorage – vorher stand nach jedem "Neues Spiel" und jedem Reload alles wieder
// auf Standard, auch der muehsam eingestellte Kartenausschnitt.
const KEY = 'gg_settings';

export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch (_) {
    return {};
  }
}

export function saveSettings(patch) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadSettings(), ...patch }));
  } catch (_) {}
}
