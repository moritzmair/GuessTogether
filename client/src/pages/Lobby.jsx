import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import socket from '../socket.js';

const MODES = [
  { id: 'weltweit', label: '🌍 Weltweit' },
  { id: 'europa', label: '🇪🇺 Europa' },
  { id: 'grossstaedte', label: '🏙️ Großstädte' },
  { id: 'darmstadt', label: '🦔 Darmstadt' },
];

export default function Lobby({ session, onSessionUpdate }) {
  const [players, setPlayers] = useState(session.players || []);
  const [mode, setMode] = useState('weltweit');

  const joinUrl = `${window.location.origin}?join=${session.code}`;

  useEffect(() => {
    socket.on('players-updated', (updatedPlayers) => {
      setPlayers(updatedPlayers);
      onSessionUpdate({ ...session, players: updatedPlayers });
    });

    return () => {
      socket.off('players-updated');
    };
  }, []);

  function startGame() {
    socket.emit('start-game', { mode });
  }

  return (
    <div className="center" style={{ padding: 16 }}>
      <div className="card" style={{ width: '100%', maxWidth: 480 }}>
        <h1>🎮 Lobby</h1>

        <div style={{ textAlign: 'center', marginBottom: 16 }}>
          <p style={{ color: '#aaa', fontSize: '0.85rem' }}>Session-Code</p>
          <p style={{ fontSize: '2.5rem', fontWeight: 'bold', letterSpacing: 8, color: '#4ade80' }}>
            {session.code}
          </p>
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 20 }}>
          <div style={{ background: '#fff', padding: 12, borderRadius: 8 }}>
            <QRCodeSVG value={joinUrl} size={160} />
          </div>
        </div>

        <p style={{ textAlign: 'center', fontSize: '0.8rem', color: '#888', marginBottom: 20, wordBreak: 'break-all' }}>
          {joinUrl}
        </p>

        <h2>Spieler ({players.length})</h2>
        {players.length === 0 ? (
          <p style={{ color: '#555', fontSize: '0.85rem', marginBottom: 20 }}>
            Noch niemand beigetreten…
          </p>
        ) : (
          <ul style={{ listStyle: 'none', marginBottom: 20 }}>
            {players.map((p) => (
              <li
                key={p.id}
                style={{
                  padding: '8px 12px',
                  marginTop: 6,
                  background: '#2a2a2a',
                  borderRadius: 6,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8
                }}
              >
                <span>👤</span>
                <span>{p.name}</span>
                {p.id === socket.id && (
                  <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#4ade80' }}>Du</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {session.isHost ? (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  style={{
                    flex: 1, margin: 0, padding: '6px 0', fontSize: '0.8rem',
                    background: mode === m.id ? '#4ade80' : '#2a2a2a',
                    color: mode === m.id ? '#111' : '#fff',
                    border: mode === m.id ? 'none' : '1px solid #444',
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button onClick={startGame} disabled={players.length < 1}>
              Spiel starten ({players.length} Spieler)
            </button>
          </>
        ) : (
          <p style={{ textAlign: 'center', color: '#aaa' }}>Warte auf Host…</p>
        )}
      </div>
    </div>
  );
}
