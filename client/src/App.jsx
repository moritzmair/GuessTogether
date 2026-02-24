import React, { useState, useEffect } from 'react';
import Home from './pages/Home.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';
import Results from './pages/Results.jsx';
import socket from './socket.js';

export default function App() {
  const [page, setPage] = useState('home');
  const [session, setSession] = useState(null);
  const [results, setResults] = useState(null);
  const [gameImage, setGameImage] = useState(null);

  useEffect(() => {
    socket.on('back-to-lobby', () => setPage('lobby'));
    socket.on('host-left', () => { setPage('home'); setSession(null); });
    return () => {
      socket.off('back-to-lobby');
      socket.off('host-left');
    };
  }, []);

  if (page === 'home')
    return <Home onJoined={(s) => { setSession(s); setPage('lobby'); }} />;

  if (page === 'lobby')
    return (
      <Lobby
        session={session}
        onSessionUpdate={(s) => setSession(s)}
        onGameStart={(img) => { setGameImage(img); setPage('game'); }}
      />
    );

  if (page === 'game')
    return (
      <Game
        session={session}
        imageUrl={gameImage}
        onRoundEnd={(r) => { setResults(r); setPage('results'); }}
      />
    );

  if (page === 'results')
    return (
      <Results
        results={results}
        session={session}
        onRestart={() => socket.emit('back-to-lobby')}
      />
    );

  return null;
}
