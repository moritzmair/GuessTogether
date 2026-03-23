import React, { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import socket from '../socket.js';

const MODES = [
  { id: 'weltweit', label: '🌍 Weltweit' },
  { id: 'europa', label: '🇪🇺 Europa' },
  { id: 'grossstaedte', label: '🏙️ Großstädte' },
  { id: 'beruehmt', label: '🏛️ Berühmte Orte' },
  { id: 'custom', label: '✏️ Custom' },
];

const PANORAMA_FILTERS = [
  { id: 'all',         label: '🌐 Alle Panoramen',        desc: 'Straße, Indoor, Nutzer-Fotos' },
  { id: 'outdoor',     label: '🚶 Kein Indoor',            desc: 'Nur Außenaufnahmen' },
  { id: 'google_only', label: '🚗 Nur Google Street View', desc: 'Offizielles Google-Kameramobil' },
];

export default function Lobby({ session, onSessionUpdate }) {
  const [players, setPlayers] = useState(session.players || []);
  const [mode, setMode] = useState('weltweit');
  const [panoramaFilter, setPanoramaFilter] = useState('all');
  const [pinCountdown, setPinCountdown] = useState(30);
  const [countdownEnabled, setCountdownEnabled] = useState(false);
  const customMapRef = useRef(null);
  const customMapInstance = useRef(null);

  const joinUrl = `${window.location.origin}?join=${session.code}`;

  useEffect(() => {
    socket.on('players-updated', (updatedPlayers) => {
      setPlayers(updatedPlayers);
      onSessionUpdate({ ...session, players: updatedPlayers });
    });
    return () => { socket.off('players-updated'); };
  }, []);

  useEffect(() => {
    if (mode !== 'custom') {
      if (customMapInstance.current) {
        customMapInstance.current.remove();
        customMapInstance.current = null;
      }
      return;
    }
    if (!customMapRef.current || customMapInstance.current) return;
    const map = L.map(customMapRef.current).setView([50, 10], 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);
    customMapInstance.current = map;
    return () => {
      if (customMapInstance.current) {
        customMapInstance.current.remove();
        customMapInstance.current = null;
      }
    };
  }, [mode]);

  function startGame() {
    const countdown = countdownEnabled ? pinCountdown : 0;
    if (mode === 'custom' && customMapInstance.current) {
      const b = customMapInstance.current.getBounds();
      socket.emit('start-game', {
        mode: 'custom',
        panoramaFilter,
        customBounds: {
          lat: [b.getSouth(), b.getNorth()],
          lng: [b.getWest(), b.getEast()],
        },
        pinCountdown: countdown,
      });
    } else {
      socket.emit('start-game', { mode, panoramaFilter, pinCountdown: countdown });
    }
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
            <div style={{ marginBottom: 4 }}>
              <p style={{ fontSize: '0.75rem', color: '#888', marginBottom: 6 }}>Spielgebiet</p>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setMode(m.id)}
                    style={{
                      flex: '1 1 auto', margin: 0, padding: '6px 0', fontSize: '0.8rem',
                      background: mode === m.id ? '#4ade80' : '#2a2a2a',
                      color: mode === m.id ? '#111' : '#fff',
                      border: mode === m.id ? 'none' : '1px solid #444',
                    }}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: '0.75rem', color: '#888', marginBottom: 6 }}>Panorama-Filter</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {PANORAMA_FILTERS.map((f) => (
                  <button
                    key={f.id}
                    onClick={() => setPanoramaFilter(f.id)}
                    style={{
                      margin: 0,
                      padding: '8px 12px',
                      fontSize: '0.82rem',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      background: panoramaFilter === f.id ? '#4ade80' : '#2a2a2a',
                      color: panoramaFilter === f.id ? '#111' : '#fff',
                      border: panoramaFilter === f.id ? 'none' : '1px solid #444',
                    }}
                  >
                    <span style={{ fontWeight: panoramaFilter === f.id ? 700 : 400 }}>{f.label}</span>
                    <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: 8 }}>{f.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {mode === 'custom' && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: 6 }}>
                  Karte zoomen & verschieben – der sichtbare Ausschnitt wird als Spielgebiet genutzt
                </div>
                <div ref={customMapRef} style={{ width: '100%', height: 260, borderRadius: 8, overflow: 'hidden' }} />
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, background: '#1a1a2e', borderRadius: 8, padding: '10px 14px' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1, margin: 0 }}>
                <input
                  type="checkbox"
                  checked={countdownEnabled}
                  onChange={(e) => setCountdownEnabled(e.target.checked)}
                  style={{ width: 'auto', margin: 0 }}
                />
                <span style={{ fontSize: '0.85rem', color: '#ccc' }}>⏱ Countdown nach erstem Pin</span>
              </label>
              {countdownEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="number"
                    min={5}
                    max={300}
                    value={pinCountdown}
                    onChange={(e) => setPinCountdown(Math.max(5, Number(e.target.value)))}
                    style={{ width: 64, margin: 0, padding: '4px 8px', fontSize: '0.85rem', textAlign: 'center' }}
                  />
                  <span style={{ fontSize: '0.8rem', color: '#888' }}>Sek.</span>
                </div>
              )}
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
