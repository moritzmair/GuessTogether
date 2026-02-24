import React, { useEffect, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import socket from '../socket.js';

export default function Lobby({ session, onSessionUpdate, onGameStart }) {
  const [players, setPlayers] = useState(session.players || []);

  const joinUrl = `${window.location.origin}?join=${session.code}`;

  useEffect(() => {
    socket.on('players-updated', (updatedPlayers) => {
      setPlayers(updatedPlayers);
      onSessionUpdate({ ...session, players: updatedPlayers });
    });

    socket.on('game-started', () => onGameStart());

    // Host hat gewechselt (kein Page-Reload nötig)
    socket.on('host-changed', () => {});

    return () => {
      socket.off('players-updated');
      socket.off('game-started');
      socket.off('host-changed');
    };
  }, []);

  function startGame() {
    socket.emit('start-game');
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
              <span>{p.id === session.players?.[0]?.id ? '👑' : '👤'}</span>
              <span>{p.name}</span>
              {p.id === socket.id && (
                <span style={{ marginLeft: 'auto', fontSize: '0.75rem', color: '#4ade80' }}>Du</span>
              )}
            </li>
          ))}
        </ul>

        {session.isHost ? (
          <button onClick={startGame} disabled={players.length < 1}>
            Spiel starten
          </button>
        ) : (
          <p style={{ textAlign: 'center', color: '#aaa' }}>Warte auf Host…</p>
        )}
      </div>
    </div>
  );
}
