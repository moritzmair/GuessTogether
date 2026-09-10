import React, { useState, useEffect, useRef } from 'react';
import Home from './pages/Home.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';
import Results from './pages/Results.jsx';
import Summary from './pages/Summary.jsx';
import SoloGame from './pages/SoloGame.jsx';
import socket, { REQUEST_TIMEOUT_MS, OFFLINE_MSG } from './socket.js';

const SESSIONS_KEY = 'gg_sessions';

function sessionMapKey(s) {
  return `${s.code}:${s.isHost ? 'host' : s.name}`;
}

const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 Minuten

function saveSession(session) {
  if (!session) return;
  try {
    const map = loadAllSessions();
    map[sessionMapKey(session)] = {
      code: session.code,
      name: session.name,
      isHost: !!session.isHost,
      hostSecret: session.hostSecret,
      savedAt: Date.now(),
    };
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(map));
  } catch (_) {}
}

function clearSession(session) {
  if (!session) return;
  try {
    const map = loadAllSessions();
    delete map[sessionMapKey(session)];
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(map));
  } catch (_) {}
}

function loadAllSessions() {
  try {
    const map = JSON.parse(localStorage.getItem(SESSIONS_KEY) || '{}');
    const now = Date.now();
    // Abgelaufene Sessions direkt bereinigen
    let changed = false;
    for (const key of Object.keys(map)) {
      if (map[key].savedAt && now - map[key].savedAt > SESSION_MAX_AGE_MS) {
        delete map[key];
        changed = true;
      }
    }
    if (changed) localStorage.setItem(SESSIONS_KEY, JSON.stringify(map));
    return map;
  } catch (_) { return {}; }
}

export default function App() {
  const [page, setPage] = useState('home');
  const [session, setSession] = useState(null);
  const [results, setResults] = useState(null);
  const [gamePano, setGamePano] = useState(null);
  const [history, setHistory] = useState([]);
  const [isSpectator, setIsSpectator] = useState(false);
  const [savedSessions, setSavedSessions] = useState(() => Object.values(loadAllSessions()));
  const pageRef = useRef('home');
  const sessionRef = useRef(null);

  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { sessionRef.current = session; }, [session]);

  useEffect(() => {
    if (session && page !== 'home') {
      saveSession(session);
    }
  }, [session, page]);

  // Stand vom Server nach (Wieder-)Beitritt uebernehmen und die passende Seite oeffnen.
  // history kommt vom Server, damit die Zusammenfassung auch nach einem Reload oder
  // spaetem Beitritt alle Runden kennt.
  function applyServerState(res) {
    setHistory(res.history || []);
    setIsSpectator(!!res.spectator);
    if (res.phase === 'game' && res.game) {
      setGamePano(res.game);
      setPage('game');
    } else if (res.phase === 'results' && res.roundData) {
      setResults(res.roundData);
      setPage('results');
    } else {
      setPage('lobby');
    }
  }

  // Reconnect-Handler: nur wenn bereits in einer Session (nicht auf Home)
  useEffect(() => {
    const handleConnect = () => {
      if (pageRef.current === 'home' || pageRef.current === 'soloGame') return;
      const s = sessionRef.current;
      if (!s?.code) return;

      socket.emit('rejoin-session', {
        code: s.code,
        name: s.name,
        isHost: s.isHost,
        hostSecret: s.hostSecret,
      }, (res) => {
        if (res.error) {
          clearSession(s);
          setSavedSessions(Object.values(loadAllSessions()));
          setPage('home');
          setSession(null);
          return;
        }
        setSession((prev) => ({ ...(prev || {}), players: res.players }));
        applyServerState(res);
      });
    };

    socket.on('connect', handleConnect);
    return () => socket.off('connect', handleConnect);
  }, []);

  useEffect(() => {
    const onGameStarted = ({ players, ...state }) => {
      setGamePano(state);
      setIsSpectator(false);
      if (players) setSession((s) => ({ ...s, players }));
      setPage('game');
    };
    const onRoundEnded = (r) => {
      setResults(r);
      setHistory((prev) => [...prev.filter((h) => h.round !== r.round), r]);
      setPage('results');
    };
    const onResultsUpdated = (r) => {
      setResults(r);
      setHistory((prev) => prev.map((h) => (h.round === r.round ? r : h)));
    };
    const onBackToLobby = () => { setHistory([]); setPage('lobby'); };
    const onHostLeft = () => {
      clearSession(sessionRef.current);
      setSavedSessions(Object.values(loadAllSessions()));
      setPage('home');
      setSession(null);
    };
    const onPlayersUpdated = (players) => setSession((s) => (s ? { ...s, players } : s));

    // Mit Handler abmelden – socket.off(event) ohne Handler entfernt auch die Listener
    // der Seiten (und umgekehrt), dann verpasst App z. B. Spielerlisten-Updates.
    const handlers = {
      'game-started': onGameStarted,
      'round-ended': onRoundEnded,
      'results-updated': onResultsUpdated,
      'back-to-lobby': onBackToLobby,
      'host-left': onHostLeft,
      'players-updated': onPlayersUpdated,
    };
    Object.entries(handlers).forEach(([event, fn]) => socket.on(event, fn));
    return () => Object.entries(handlers).forEach(([event, fn]) => socket.off(event, fn));
  }, []);

  // onFail(message): Home zeigt den Fehler an, statt ewig auf "Verbinde…" zu stehen
  function handleRejoin(saved, onFail) {
    socket.timeout(REQUEST_TIMEOUT_MS).emit('rejoin-session', {
      code: saved.code,
      name: saved.name,
      isHost: saved.isHost,
      hostSecret: saved.hostSecret,
    }, (err, res) => {
      if (err) return onFail?.(OFFLINE_MSG);
      if (res.error) {
        clearSession(saved);
        setSavedSessions(Object.values(loadAllSessions()));
        return onFail?.(res.error);
      }
      setSession({ ...saved, players: res.players });
      applyServerState(res);
    });
  }

  function handleLeaveSession() {
    clearSession(sessionRef.current);
    setSavedSessions(Object.values(loadAllSessions()));
    // Sonst liest Home den ?join=-Link erneut aus und zeigt wieder den Beitritts-Dialog
    window.history.replaceState(null, '', window.location.pathname);
    setPage('home');
    setSession(null);
  }

  if (page === 'home')
    return (
      <Home
        savedSessions={savedSessions}
        onRejoin={handleRejoin}
        onSolo={() => setPage('soloGame')}
        onJoined={(s) => {
          setSession(s);
          applyServerState(s);
        }}
      />
    );

  if (page === 'soloGame')
    return <SoloGame onBack={() => setPage('home')} />;

  if (page === 'lobby')
    return <Lobby session={session} onSessionUpdate={(s) => setSession(s)} onLeave={handleLeaveSession} />;

  // key: neue Runde = neue Instanz. Sonst behielt ein Handy, das waehrend einer Runde
  // einschlief und erst in der naechsten aufwachte, "Pin gesetzt" aus der alten Runde.
  if (page === 'game')
    return <Game key={gamePano.panoId} session={session} panoData={gamePano} isSpectator={isSpectator} />;

  if (page === 'results')
    return (
      <Results
        key={results.round}
        results={results}
        session={session}
        onNextRound={() => socket.emit('start-game')}
        onShowSummary={() => setPage('summary')}
      />
    );

  if (page === 'summary')
    return (
      <Summary
        history={history}
        session={session}
        onNewGame={() => socket.emit('back-to-lobby')}
      />
    );

  return null;
}
