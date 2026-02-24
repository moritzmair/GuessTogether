import React, { useEffect, useRef } from 'react';
import L from 'leaflet';
import socket from '../socket.js';

export default function Results({ results, session, onNextRound, onNewGame, onShowSummary }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);

  const { results: players, location, round, totalRounds } = results;

  // Ergebniskarte mit Pins und Zielpunkt
  useEffect(() => {
    if (leafletMap.current) return;
    leafletMap.current = L.map(mapRef.current).setView([location.lat, location.lng], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(leafletMap.current);

    const bounds = L.latLngBounds([[location.lat, location.lng]]);

    // Zielpunkt (rot)
    const targetIcon = L.divIcon({
      html: '<div style="background:#f87171;width:16px;height:16px;border-radius:50%;border:3px solid #fff;"></div>',
      iconSize: [16, 16],
      className: ''
    });
    L.marker([location.lat, location.lng], { icon: targetIcon })
      .bindPopup(`<b>📍 Lösung:</b> ${location.label}`)
      .addTo(leafletMap.current)
      .openPopup();

    // Spieler-Pins mit Linien zum Ziel
    players.forEach((p) => {
      if (!p.pin) return;
      bounds.extend([p.pin.lat, p.pin.lng]);
      const playerIcon = L.divIcon({
        html: `<div style="display:flex;flex-direction:column;align-items:center;pointer-events:none">
          <div style="background:#4ade80;width:12px;height:12px;border-radius:50%;border:2px solid #fff;"></div>
          <div style="background:rgba(0,0,0,0.75);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;white-space:nowrap;margin-top:2px">${p.name}</div>
        </div>`,
        iconSize: [80, 30],
        iconAnchor: [40, 6],
        className: ''
      });
      L.marker([p.pin.lat, p.pin.lng], { icon: playerIcon })
        .bindPopup(`<b>${p.name}</b><br>${p.dist} km entfernt`)
        .addTo(leafletMap.current);

      L.polyline(
        [[location.lat, location.lng], [p.pin.lat, p.pin.lng]],
        { color: '#4ade80', dashArray: '6 4', weight: 2, opacity: 0.7 }
      ).addTo(leafletMap.current);
    });

    leafletMap.current.fitBounds(bounds.pad(0.3));

    return () => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>

      {/* Ergebniskarte */}
      <div ref={mapRef} style={{ flex: '0 0 40%' }} />

      {/* Rangliste */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        <h2 style={{ textAlign: 'center', marginBottom: 4 }}>
          📍 Lösung: {location.label}
        </h2>
        <p style={{ textAlign: 'center', color: '#aaa', fontSize: '0.8rem', marginBottom: 16 }}>
          ({location.lat.toFixed(4)}, {location.lng.toFixed(4)})
        </p>

        <h2 style={{ marginBottom: 12 }}>🏆 Rangliste</h2>
        <ul style={{ listStyle: 'none' }}>
          {players.map((p, i) => (
            <li
              key={p.id}
              style={{
                background: i === 0 ? '#1a3a1a' : '#1a1a1a',
                border: i === 0 ? '1px solid #4ade80' : '1px solid #333',
                borderRadius: 8,
                padding: '12px 16px',
                marginBottom: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 12
              }}
            >
              <span style={{ fontSize: '1.4rem' }}>
                {i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}.`}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 'bold' }}>
                  {p.name}
                  {p.id === socket.id && (
                    <span style={{ marginLeft: 8, fontSize: '0.75rem', color: '#4ade80' }}>Du</span>
                  )}
                </div>
                <div style={{ fontSize: '0.8rem', color: '#aaa' }}>
                  {p.dist === 99999 ? 'Kein Pin' : `${p.dist.toLocaleString()} km entfernt`}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontWeight: 'bold', color: '#4ade80' }}>+{p.points} Pkt</div>
                <div style={{ fontSize: '0.75rem', color: '#aaa' }}>Gesamt: {p.totalScore}</div>
              </div>
            </li>
          ))}
        </ul>

        <p style={{ textAlign: 'center', color: '#aaa', marginTop: 8, fontSize: '0.85rem' }}>
          Runde {round} / {totalRounds}
        </p>

        {round < totalRounds && session.isHost && (
          <button onClick={onNextRound} style={{ marginTop: 16 }}>
            ▶ Nächste Runde
          </button>
        )}
        {round < totalRounds && !session.isHost && (
          <p style={{ textAlign: 'center', color: '#aaa', marginTop: 16 }}>
            Warte auf Host…
          </p>
        )}
        {round >= totalRounds && (
          <button onClick={onShowSummary} style={{ marginTop: 16 }}>
            📊 Zusammenfassung anzeigen
          </button>
        )}
      </div>
    </div>
  );
}
