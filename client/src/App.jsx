import React, { useState, useEffect, useRef } from 'react';
import Home from './pages/Home.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';
import Results from './pages/Results.jsx';
import Summary from './pages/Summary.jsx';
import SoloGame from './pages/SoloGame.jsx';
import socket from './socket.js';

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
  const [alreadyPinned, setAlreadyPinned] = useState(false);
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

  // Reconnect-Handler: nur wenn bereits in einer Session (nicht auf Home)
  useEffect(() => {
    const handleConnect = () => {
      if (pageRef.current === 'home') return;
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
          setPage('home');
          setSession(null);
          return;
        }
        setSession((prev) => ({ ...(prev || {}), players: res.players }));
        if (res.phase === 'game' && res.panoId) {
          setGamePano({ panoId: res.panoId, heading: res.heading, mapBounds: res.mapBounds || null });
          setAlreadyPinned(res.alreadyPinned || false);
          setIsSpectator(false);
          setPage('game');
        } else if (res.phase === 'results' && res.roundData) {
          setResults(res.roundData);
          setPage('results');
        } else {
          setPage('lobby');
        }
      });
    };

    socket.on('connect', handleConnect);
    return () => socket.off('connect', handleConnect);
  }, []);

  useEffect(() => {
    socket.on('game-started', ({ panoId, heading, players, mapBounds }) => {
      setGamePano({ panoId, heading, mapBounds: mapBounds || null });
      setAlreadyPinned(false);
      setIsSpectator(false);
      if (players) setSession((s) => ({ ...s, players }));
      setPage('game');
    });
    socket.on('round-ended', (r) => { setResults(r); setHistory((prev) => [...prev, r]); setPage('results'); });
    socket.on('results-updated', (r) => { setResults(r); setHistory((prev) => prev.map((h) => h.round === r.round ? r : h)); });
    socket.on('back-to-lobby', () => { setHistory([]); setPage('lobby'); });
    socket.on('host-left', () => {
      clearSession(sessionRef.current);
      setSavedSessions(Object.values(loadAllSessions()));
      setPage('home');
      setSession(null);
    });
    socket.on('players-updated', (players) => {
      setSession((s) => s ? { ...s, players } : s);
    });
    return () => {
      socket.off('game-started');
      socket.off('round-ended');
      socket.off('results-updated');
      socket.off('back-to-lobby');
      socket.off('host-left');
      socket.off('players-updated');
    };
  }, []);

  function handleRejoin(saved) {
    socket.emit('rejoin-session', {
      code: saved.code,
      name: saved.name,
      isHost: saved.isHost,
      hostSecret: saved.hostSecret,
    }, (res) => {
      if (res.error) {
        clearSession(saved);
        setSavedSessions(Object.values(loadAllSessions()));
        return;
      }
      setSession({ ...saved, players: res.players });
      if (res.phase === 'game' && res.panoId) {
        setGamePano({ panoId: res.panoId, heading: res.heading, mapBounds: res.mapBounds || null });
        setAlreadyPinned(res.alreadyPinned || false);
        setIsSpectator(false);
        setPage('game');
      } else if (res.phase === 'results' && res.roundData) {
        setResults(res.roundData);
        setPage('results');
      } else {
        setPage('lobby');
      }
    });
  }

  function handleLeaveSession() {
    clearSession(sessionRef.current);
    setSavedSessions(Object.values(loadAllSessions()));
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
          setIsSpectator(s.spectator || false);
          if (s.spectator && s.panoId) {
            setGamePano({ panoId: s.panoId, heading: s.heading, mapBounds: s.mapBounds || null });
            setAlreadyPinned(false);
            setPage('game');
          } else {
            setPage('lobby');
          }
        }}
      />
    );

  if (page === 'soloGame')
    return <SoloGame onBack={() => setPage('home')} />;

  if (page === 'lobby')
    return <Lobby session={session} onSessionUpdate={(s) => setSession(s)} />;

  if (page === 'game')
    return <Game session={session} panoData={gamePano} alreadyPinned={alreadyPinned} isSpectator={isSpectator} />;

  if (page === 'results')
    return (
      <Results
        results={results}
        session={session}
        onNextRound={() => socket.emit('start-game')}
        onNewGame={() => socket.emit('back-to-lobby')}
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
