import React, { useState } from 'react';
import socket from '../socket.js';

export default function Home({ onJoined }) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

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
    if (!code.trim()) return setError('Bitte Code eingeben');
    setLoading(true);
    socket.emit('join-session', { name: name.trim(), code: code.trim().toUpperCase() }, (res) => {
      setLoading(false);
      if (res.error) return setError(res.error);
      onJoined({ ...res, isHost: false, name: name.trim() });
    });
  }

  React.useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const joinCode = params.get('join');
    if (joinCode) setCode(joinCode.toUpperCase());
  }, []);

  return (
    <div className="center">
      <div className="card" style={{ width: '100%' }}>
        <h1>🌍 GuessTogether</h1>

        <div style={{ marginTop: 8 }}>
          <h2>Neue Session (Host)</h2>
          <p style={{ color: '#aaa', fontSize: '0.85rem', marginBottom: 12 }}>
            Als Host zeigst du das Bild – du spielst nicht mit.
          </p>
          <button onClick={createSession} disabled={loading}>
            Session erstellen
          </button>
        </div>

        <div style={{ marginTop: 24 }}>
          <h2>Beitreten</h2>
          <label>Dein Name</label>
          <input
            value={name}
            onChange={(e) => { setName(e.target.value); setError(''); }}
            placeholder="z.B. Marco"
            maxLength={20}
          />
          <label>Session-Code</label>
          <input
            value={code}
            onChange={(e) => { setCode(e.target.value.toUpperCase()); setError(''); }}
            placeholder="Z.B. AB3X7Q"
            maxLength={6}
          />
          <button onClick={joinSession} disabled={loading}>
            Beitreten
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
