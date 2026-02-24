import React, { useState } from 'react';
import Home from './pages/Home.jsx';
import Lobby from './pages/Lobby.jsx';
import Game from './pages/Game.jsx';
import Results from './pages/Results.jsx';

// Globaler State wird als Props durchgereicht (kein Redux nötig für MVP)
export default function App() {
  const [page, setPage] = useState('home'); // home | lobby | game | results
  const [session, setSession] = useState(null);
  // session = { code, players, isHost, name }

  const [results, setResults] = useState(null);
  // results = { results[], location }

  if (page === 'home')
    return <Home onJoined={(s) => { setSession(s); setPage('lobby'); }} />;

  if (page === 'lobby')
    return (
      <Lobby
        session={session}
        onSessionUpdate={(s) => setSession(s)}
        onGameStart={() => setPage('game')}
      />
    );

  if (page === 'game')
    return (
      <Game
        session={session}
        onRoundEnd={(r) => { setResults(r); setPage('results'); }}
      />
    );

  if (page === 'results')
    return (
      <Results
        results={results}
        session={session}
        onRestart={() => setPage('lobby')}
      />
    );

  return null;
}
