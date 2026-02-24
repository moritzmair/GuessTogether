import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import socket from '../socket.js';

const COLORS = ['#f87171', '#fb923c', '#facc15', '#4ade80', '#60a5fa'];

export default function Summary({ history, session, onNewGame }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);

  const finalPlayers = [...(history[history.length - 1]?.results || [])].sort((a, b) => b.totalScore - a.totalScore);

  useEffect(() => {
    if (leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '© OpenStreetMap' }).addTo(leafletMap.current);

    const bounds = L.latLngBounds([]);

    history.forEach(({ round, location, results }) => {
      const color = COLORS[(round - 1) % COLORS.length];
      bounds.extend([location.lat, location.lng]);

      const targetIcon = L.divIcon({
        html: `<div style="background:${color};color:#000;width:22px;height:22px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:bold">${round}</div>`,
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        className: ''
      });
      L.marker([location.lat, location.lng], { icon: targetIcon })
        .bindPopup(`<b>Runde ${round}</b><br>📍 ${location.label}`)
        .addTo(leafletMap.current);

      results.forEach((p) => {
        if (!p.pin) return;
        bounds.extend([p.pin.lat, p.pin.lng]);
        const playerIcon = L.divIcon({
          html: `<div style="display:flex;flex-direction:column;align-items:center;pointer-events:none">
            <div style="background:${color};width:10px;height:10px;border-radius:50%;border:2px solid #fff;opacity:0.85"></div>
            <div style="background:rgba(0,0,0,0.75);color:#fff;font-size:9px;padding:1px 4px;border-radius:3px;white-space:nowrap;margin-top:1px">${p.name}</div>
          </div>`,
          iconSize: [70, 26],
          iconAnchor: [35, 5],
          className: ''
        });
        L.marker([p.pin.lat, p.pin.lng], { icon: playerIcon })
          .bindPopup(`<b>${p.name}</b> – Runde ${round}<br>${p.dist} km entfernt (+${p.points} Pkt)`)
          .addTo(leafletMap.current);

        L.polyline([[location.lat, location.lng], [p.pin.lat, p.pin.lng]], {
          color, dashArray: '4 3', weight: 1.5, opacity: 0.5
        }).addTo(leafletMap.current);
      });
    });

    if (bounds.isValid()) leafletMap.current.fitBounds(bounds.pad(0.2));

    return () => {
      if (leafletMap.current) { leafletMap.current.remove(); leafletMap.current = null; }
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div ref={mapRef} style={{ flex: '0 0 45%' }} />
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <h2 style={{ marginBottom: 4 }}>🏆 Finale Rangliste</h2>
        <p style={{ color: '#aaa', fontSize: '0.8rem', marginBottom: 16 }}>
          {history.length} Runden gespielt
        </p>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          {history.map(({ round }) => (
            <span key={round} style={{
              background: COLORS[(round - 1) % COLORS.length],
              color: '#000', fontSize: '0.75rem', borderRadius: 4,
              padding: '2px 8px', fontWeight: 'bold'
            }}>
              Runde {round}
            </span>
          ))}
        </div>

        <ul style={{ listStyle: 'none' }}>
          {finalPlayers.map((p, i) => (
            <li key={p.id} style={{
              background: i === 0 ? '#1a3a1a' : '#1a1a1a',
              border: i === 0 ? '1px solid #4ade80' : '1px solid #333',
              borderRadius: 8, padding: '12px 16px', marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 12
            }}>
              <span style={{ fontSize: '1.4rem' }}>
                {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}
              </span>
              <div style={{ flex: 1, fontWeight: 'bold' }}>
                {p.name}
                {p.id === socket.id && (
                  <span style={{ marginLeft: 8, fontSize: '0.75rem', color: '#4ade80' }}>Du</span>
                )}
              </div>
              <div style={{ fontWeight: 'bold', color: '#4ade80', fontSize: '1.1rem' }}>
                {p.totalScore} Pkt
              </div>
            </li>
          ))}
        </ul>

        {session.isHost && (
          <button onClick={onNewGame} style={{ marginTop: 16 }}>🔄 Neues Spiel</button>
        )}
        {!session.isHost && (
          <p style={{ textAlign: 'center', color: '#aaa', marginTop: 16 }}>Warte auf Host…</p>
        )}
      </div>
    </div>
  );
}
