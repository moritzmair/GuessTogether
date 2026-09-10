import React, { useState, useEffect } from 'react';
import socket, { REQUEST_TIMEOUT_MS, OFFLINE_MSG } from '../socket.js';

const ADJECTIVES = ['crazy', 'slow', 'fast', 'wild', 'lazy', 'tiny', 'brave', 'lucky', 'silly', 'sneaky', 'grumpy', 'happy', 'dark', 'bold', 'swift'];
const ANIMALS = ['rabbit', 'horse', 'fox', 'bear', 'wolf', 'eagle', 'shark', 'tiger', 'panda', 'koala', 'lion', 'hawk', 'deer', 'duck', 'owl'];

function randomName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}-${animal}`;
}

export default function Home({ onJoined, savedSessions = [], onRejoin, onSolo }) {
  const [name, setName] = useState(() => randomName());
  const [joinCode, setJoinCode] = useState('');
  // Code-Eingabe auf der Startseite – ohne sie ging Beitreten nur per QR-Code oder Link
  const [codeInput, setCodeInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('join');
    if (!code) return;
    const upper = code.toUpperCase();

    // Passendes savedSession? → auto-rejoin ohne Namenseingabe
    const matching = savedSessions.find((s) => s.code === upper && s.name);
    if (matching) {
      setLoading(true);
      // Klappt das nicht (Reconnect-Frist abgelaufen), normal mit demselben Namen beitreten
      onRejoin(matching, (msg) => {
        setLoading(false);
        setName(matching.name);
        setJoinCode(upper);
        setError(msg);
      });
      return;
    }

    setJoinCode(upper);
  }, []);

  function rejoin(saved) {
    setLoading(true);
    setError('');
    onRejoin(saved, (msg) => { setLoading(false); setError(msg); });
  }

  function createSession() {
    setLoading(true);
    setError('');
    socket.timeout(REQUEST_TIMEOUT_MS).emit('create-session', {}, (err, res) => {
      setLoading(false);
      if (err) return setError(OFFLINE_MSG);
      if (res.error) return setError(res.error);
      onJoined({ ...res, isHost: true });
    });
  }

  function joinSession() {
    if (!name.trim()) return setError('Bitte Namen eingeben');
    setLoading(true);
    setError('');
    socket.timeout(REQUEST_TIMEOUT_MS).emit('join-session', { name: name.trim(), code: joinCode }, (err, res) => {
      setLoading(false);
      if (err) return setError(OFFLINE_MSG);
      if (res.error) return setError(res.error);
      onJoined({ ...res, isHost: false, name: res.name });
    });
  }

  function enterCode() {
    const code = codeInput.trim().toUpperCase();
    if (!code) return setError('Bitte den Code vom Bildschirm eingeben');
    setError('');
    setJoinCode(code);
  }

  function backToStart() {
    setJoinCode('');
    setError('');
    window.history.replaceState(null, '', window.location.pathname);
  }

  if (loading) {
    return (
      <div className="center">
        <div style={{ color: '#aaa', fontSize: '1rem' }}>Verbinde…</div>
      </div>
    );
  }

  if (joinCode) {
    return (
      <div className="center">
        <div className="card" style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🌍</div>
            <h1 style={{ margin: 0, fontSize: '1.8rem' }}>GuessTogether</h1>
            <p style={{ color: '#aaa', fontSize: '0.9rem', marginTop: 6 }}>
              Session <strong style={{ color: '#4ade80', letterSpacing: 2 }}>{joinCode}</strong> beitreten
            </p>
          </div>

          <label>Dein Name</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') joinSession(); }}
              placeholder="Spielername"
              maxLength={20}
              style={{ flex: 1, margin: 0 }}
            />
            <button
              type="button"
              onClick={() => setName(randomName())}
              title="Neuen Zufallsnamen generieren"
              style={{ margin: 0, padding: '6px 10px', flexShrink: 0, width: 'auto', background: '#2a2a3e', fontSize: '1rem', lineHeight: 1 }}
            >
              🎲
            </button>
          </div>

          <button
            onClick={joinSession}
            style={{ width: '100%', marginTop: 16, fontSize: '1.05rem', padding: '13px', background: '#4a9eff' }}
          >
            🚀 Beitreten
          </button>

          {error && <p className="error">{error}</p>}

          <button
            onClick={backToStart}
            style={{ width: '100%', marginTop: 12, background: '#2a2a3e', color: '#bbb', fontWeight: 'normal', fontSize: '0.9rem' }}
          >
            ← Zur Startseite
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <div className="card" style={{ width: '100%', maxWidth: 480 }}>
        <div style={{ textAlign: 'center', marginBottom: 28 }}>
          <div style={{ fontSize: '3rem', marginBottom: 8 }}>🌍</div>
          <h1 style={{ margin: 0, fontSize: '2rem' }}>GuessTogether</h1>
          <p style={{ color: '#aaa', fontSize: '0.95rem', marginTop: 8 }}>Gemeinsam die Welt erraten</p>
        </div>

        {savedSessions.length > 0 && (
          <div style={{
            background: '#1a2a1a', border: '1px solid #4ade80', borderRadius: 10,
            padding: '14px 16px', marginBottom: 24,
          }}>
            <div style={{ color: '#4ade80', fontWeight: 'bold', fontSize: '0.85rem', marginBottom: 10 }}>
              🔄 {savedSessions.length === 1 ? 'Laufendes Spiel gefunden' : 'Laufende Spiele gefunden'}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {savedSessions.map((s) => (
                <div
                  key={`${s.code}:${s.isHost ? 'host' : s.name}`}
                  style={{ display: 'flex', alignItems: 'center', gap: 10 }}
                >
                  <span style={{ fontSize: '1.1rem' }}>{s.isHost ? '🖥️' : '👤'}</span>
                  <div style={{ flex: 1 }}>
                    <span style={{ color: '#e0e0e0', fontSize: '0.9rem', fontWeight: 'bold' }}>
                      {s.isHost ? 'Host' : s.name}
                    </span>
                    <span style={{ color: '#888', fontSize: '0.8rem', marginLeft: 8 }}>
                      Session {s.code}
                    </span>
                  </div>
                  <button
                    onClick={() => rejoin(s)}
                    style={{ margin: 0, padding: '6px 14px', background: '#4ade80', color: '#111', fontWeight: 'bold', fontSize: '0.8rem', width: 'auto', flexShrink: 0 }}
                  >
                    Beitreten
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Modus-Auswahl */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 20 }}>
          {/* Solo */}
          <button
            onClick={onSolo}
            style={{
              width: '100%', fontSize: '1.05rem', padding: '14px',
              background: 'linear-gradient(135deg, #6c3fd4 0%, #4a9eff 100%)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10
            }}
          >
            <span style={{ fontSize: '1.3rem' }}>🕹️</span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 'bold' }}>Solo spielen</div>
              <div style={{ fontSize: '0.75rem', opacity: 0.85, fontWeight: 'normal' }}>Alleine – Street View & Karte auf einem Gerät</div>
            </div>
          </button>

          {/* Multiplayer */}
          <button
            onClick={createSession}
            style={{
              width: '100%', fontSize: '1.05rem', padding: '14px', background: '#4a9eff',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10
            }}
          >
            <span style={{ fontSize: '1.3rem' }}>🖥️</span>
            <div style={{ textAlign: 'left' }}>
              <div style={{ fontWeight: 'bold' }}>Multiplayer – Session erstellen</div>
              <div style={{ fontSize: '0.75rem', opacity: 0.85, fontWeight: 'normal' }}>Host am großen Bildschirm, Spieler per Handy</div>
            </div>
          </button>

          {/* Mitspielen per Code */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={codeInput}
              onChange={(e) => { setCodeInput(e.target.value.toUpperCase()); setError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') enterCode(); }}
              placeholder="Code vom Bildschirm"
              maxLength={8}
              autoCapitalize="characters"
              autoComplete="off"
              style={{ flex: 1, margin: 0, letterSpacing: codeInput ? 3 : 0, textTransform: 'uppercase' }}
            />
            <button
              onClick={enterCode}
              style={{ margin: 0, width: 'auto', flexShrink: 0, background: '#2a2a3e', color: '#fff' }}
            >
              Mitspielen
            </button>
          </div>
        </div>

        {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

        {/* Multiplayer-Anleitung */}
        <div style={{ background: '#1a1a2e', borderRadius: 12, padding: 16, marginBottom: 8 }}>
          <h3 style={{ margin: '0 0 12px 0', color: '#e0e0e0', fontSize: '0.8rem', textTransform: 'uppercase', letterSpacing: 1 }}>
            Multiplayer – So funktioniert's
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {[
              { icon: '📺', text: 'Session auf großem Bildschirm erstellen (TV, Laptop, Tablet)' },
              { icon: '📱', text: 'QR-Code scannen, Link teilen oder Code eingeben – Spieler treten bei' },
              { icon: '▶️', text: 'Host startet die Runde und steuert das Spiel' },
              { icon: '📍', text: 'Spieler tippen auf die Karte, wo sie den Ort vermuten' },
            ].map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: '1.2rem', flexShrink: 0 }}>{step.icon}</span>
                <span style={{ color: '#bbb', fontSize: '0.85rem', lineHeight: 1.5 }}>{step.text}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
