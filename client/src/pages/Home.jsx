import React, { useState } from 'react';
import socket from '../socket.js';

const ADJECTIVES = ['crazy', 'slow', 'fast', 'wild', 'lazy', 'tiny', 'brave', 'lucky', 'silly', 'sneaky', 'grumpy', 'happy', 'dark', 'bold', 'swift'];
const ANIMALS = ['rabbit', 'horse', 'fox', 'bear', 'wolf', 'eagle', 'shark', 'tiger', 'panda', 'koala', 'lion', 'hawk', 'deer', 'duck', 'owl'];

function randomName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}-${animal}`;
}

export default function Home({ onJoined }) {
  const [name, setName] = useState(() => randomName());
  const [joinCode, setJoinCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('join');
    if (code) setJoinCode(code.toUpperCase());
  }, []);

  function createSession() {
    setLoading(true);
    socket.emit('create-session', {}, (res) => {
      setLoading(false);
      if (res.error) return setError(res.error);
      onJoined({ ...res, isHost: true });
    });
  }

  function joinSession() {
    if (!name.trim()) return setError('Bitte Namen eingeben');
    setLoading(true);
    socket.emit('join-session', { name: name.trim(), code: joinCode }, (res) => {
      setLoading(false);
      if (res.error) return setError(res.error);
      onJoined({ ...res, isHost: false, name: name.trim() });
    });
  }

  if (joinCode) {
    return (
      <div className="center">
        <div className="card" style={{ width: '100%', maxWidth: 400 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 8 }}>🌍</div>
            <h1 style={{ margin: 0, fontSize: '1.8rem' }}>GuessTogether</h1>
            <p style={{ color: '#aaa', fontSize: '0.9rem', marginTop: 6 }}>Du wurdest eingeladen!</p>
          </div>

          <label>Dein Name</label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setError(''); }}
              placeholder="Spielername"
              maxLength={20}
              style={{ flex: 1, margin: 0 }}
            />
            <button
              type="button"
              onClick={() => setName(randomName())}
              title="Neuen Zufallsnamen generieren"
              style={{ margin: 0, padding: '5px 8px', flexShrink: 0, background: '#2a2a3e', fontSize: '0.9rem', lineHeight: 1 }}
            >
              🎲
            </button>
          </div>

          <button
            onClick={joinSession}
            disabled={loading}
            style={{ width: '100%', marginTop: 16, fontSize: '1.05rem', padding: '13px', background: '#4a9eff' }}
          >
            {loading ? 'Beitreten...' : '🚀 Beitreten'}
          </button>

          {error && <p className="error">{error}</p>}
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

        <div style={{ background: '#1a1a2e', borderRadius: 12, padding: 20, marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 16px 0', color: '#e0e0e0', fontSize: '0.85rem', textTransform: 'uppercase', letterSpacing: 1 }}>
            So funktioniert's
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {[
              { icon: '📺', text: 'Session auf großem Bildschirm erstellen (TV, Laptop, Tablet)' },
              { icon: '📱', text: 'QR-Code scannen oder Link teilen – Spieler treten bei' },
              { icon: '▶️', text: 'Host startet die Runde und steuert das Spiel' },
              { icon: '📍', text: 'Spieler tippen auf die Karte, wo sie den Ort vermuten' },
            ].map((step, i) => (
              <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                <span style={{ fontSize: '1.3rem', flexShrink: 0 }}>{step.icon}</span>
                <span style={{ color: '#bbb', fontSize: '0.9rem', lineHeight: 1.5 }}>{step.text}</span>
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={createSession}
          disabled={loading}
          style={{ width: '100%', fontSize: '1.1rem', padding: '14px', background: '#4a9eff' }}
        >
          {loading ? 'Erstelle Session...' : '🖥️ Session erstellen'}
        </button>

        <p style={{ color: '#555', fontSize: '0.8rem', textAlign: 'center', marginTop: 16, marginBottom: 0 }}>
          Spieler treten über QR-Code oder Link bei
        </p>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
