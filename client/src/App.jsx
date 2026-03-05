import React, { useState, useEffect, useRef } from 'react';
import Home from './pages/Home.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';
import Results from './pages/Results.jsx';
import Summary from './pages/Summary.jsx';
import socket from './socket.js';

const SESSION_KEY = 'gg_session';

function saveSession(session) {
  if (!session) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      code: session.code,
      name: session.name,
      isHost: session.isHost,
      hostSecret: session.hostSecret,
    }));
  } catch (_) {}
}

function clearSession() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
}

export default function App() {
  const [page, setPage] = useState('home');
  const [session, setSession] = useState(null);
  const [results, setResults] = useState(null);
  const [gamePano, setGamePano] = useState(null);
  const [history, setHistory] = useState([]);
  const [alreadyPinned, setAlreadyPinned] = useState(false);
  // Verhindert Rejoin-Versuch beim allerersten connect-Event
  const initialConnectDone = useRef(false);

  // Session-Daten speichern wenn sich Session oder Page ändert
  useEffect(() => {
    if (session && page !== 'home') {
      saveSession(session);
    } else if (page === 'home') {
      clearSession();
    }
  }, [session, page]);

  // Reconnect-Handler: nach Verbindungsabbruch automatisch zurückbeitreten
  useEffect(() => {
    const handleConnect = () => {
      // Ersten connect-Event überspringen (frische Verbindung beim Laden)
      if (!initialConnectDone.current) {
        initialConnectDone.current = true;
        // Trotzdem versuchen, aus sessionStorage wiederherzustellen (z. B. nach Page-Refresh)
      }

      let saved;
      try { saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || ''); }
      catch (_) { return; }
      if (!saved?.code) return;

      socket.emit('rejoin-session', {
        code: saved.code,
        name: saved.name,
        isHost: saved.isHost,
        hostSecret: saved.hostSecret,
      }, (res) => {
        if (res.error) {
          clearSession();
          setPage('home');
          setSession(null);
          return;
        }

        setSession((s) => ({ ...(s || {}), ...saved, players: res.players }));

        if (res.phase === 'game' && res.panoId) {
          setGamePano({ panoId: res.panoId, heading: res.heading });
          setAlreadyPinned(res.alreadyPinned || false);
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
    socket.on('game-started', ({ panoId, heading, players }) => {
      setGamePano({ panoId, heading });
      setAlreadyPinned(false);
      if (players) setSession((s) => ({ ...s, players }));
      setPage('game');
    });
    socket.on('round-ended', (r) => { setResults(r); setHistory((prev) => [...prev, r]); setPage('results'); });
    socket.on('results-updated', (r) => { setResults(r); setHistory((prev) => prev.map((h) => h.round === r.round ? r : h)); });
    socket.on('back-to-lobby', () => { setHistory([]); setPage('lobby'); });
    socket.on('host-left', () => { clearSession(); setPage('home'); setSession(null); });
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

  if (page === 'home')
    return <Home onJoined={(s) => { setSession(s); setPage('lobby'); }} />;

  if (page === 'lobby')
    return <Lobby session={session} onSessionUpdate={(s) => setSession(s)} />;

  if (page === 'game')
    return <Game session={session} panoData={gamePano} alreadyPinned={alreadyPinned} />;

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
