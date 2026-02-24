import React, { useState, useEffect } from 'react';
import Home from './pages/Home.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';
import Results from './pages/Results.jsx';
import Summary from './pages/Summary.jsx';
import socket from './socket.js';

export default function App() {
  const [page, setPage] = useState('home');
  const [session, setSession] = useState(null);
  const [results, setResults] = useState(null);
  const [gamePano, setGamePano] = useState(null);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    socket.on('game-started', ({ panoId, heading }) => { setGamePano({ panoId, heading }); setPage('game'); });
    socket.on('round-ended', (r) => { setResults(r); setHistory((prev) => [...prev, r]); setPage('results'); });
    socket.on('back-to-lobby', () => { setHistory([]); setPage('lobby'); });
    socket.on('host-left', () => { setPage('home'); setSession(null); });
    return () => {
      socket.off('game-started');
      socket.off('round-ended');
      socket.off('back-to-lobby');
      socket.off('host-left');
    };
  }, []);

  if (page === 'home')
    return <Home onJoined={(s) => { setSession(s); setPage('lobby'); }} />;

  if (page === 'lobby')
    return <Lobby session={session} onSessionUpdate={(s) => setSession(s)} />;

  if (page === 'game')
    return <Game session={session} panoData={gamePano} />;

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
