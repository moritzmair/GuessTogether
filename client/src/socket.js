import { io } from 'socket.io-client';

// Proxy via Vite leitet /socket.io weiter an :3001
const socket = io({ autoConnect: true });

// Anfragen mit Antwort (Session erstellen/beitreten) brechen nach dieser Zeit ab –
// ohne Timeout blieb die Startseite bei totem Server ewig auf "Verbinde…" stehen.
export const REQUEST_TIMEOUT_MS = 8000;
export const OFFLINE_MSG = 'Server nicht erreichbar – bitte Verbindung prüfen und erneut versuchen.';

export default socket;
