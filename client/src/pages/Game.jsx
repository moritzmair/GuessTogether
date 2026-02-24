import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import socket from '../socket.js';

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
});

export default function Game({ session, imageUrl, onRoundEnd }) {
  const mapRef = useRef(null);
  const leafletMap = useRef(null);
  const markerRef = useRef(null);

  const image = imageUrl || `/api/image/${session.code}`;
  const [pin, setPin] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [pinCount, setPinCount] = useState(0);
  const [totalPlayers, setTotalPlayers] = useState(session.players?.length || 0);
  const [mapExpanded, setMapExpanded] = useState(false);

  const isHost = session.isHost;

  // Karte nur für Spieler initialisieren
  useEffect(() => {
    if (isHost) return;
    if (leafletMap.current) return;

    leafletMap.current = L.map(mapRef.current, { zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(leafletMap.current);

    leafletMap.current.on('click', (e) => {
      const { lat, lng } = e.latlng;
      setPin({ lat, lng });
      if (markerRef.current) markerRef.current.remove();
      markerRef.current = L.marker([lat, lng]).addTo(leafletMap.current);
    });

    return () => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
  }, [isHost]);

  useEffect(() => {
    socket.on('pin-placed', ({ pinCount: pc, totalPlayers: tp }) => {
      setPinCount(pc);
      setTotalPlayers(tp);
    });
    socket.on('round-ended', (data) => onRoundEnd(data));
    return () => {
      socket.off('pin-placed');
      socket.off('round-ended');
    };
  }, []);

  useEffect(() => {
    if (!isHost && leafletMap.current) {
      setTimeout(() => leafletMap.current.invalidateSize(), 200);
    }
  }, [mapExpanded, isHost]);

  function submitPin() {
    if (!pin) return;
    socket.emit('place-pin', { lat: pin.lat, lng: pin.lng });
    setSubmitted(true);
  }

  // Host-Ansicht: nur Street View Bild
  if (isHost) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden', background: '#000' }}>
        <img
          src={image}
          alt="Street View"
          style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
        />
        <div style={{
          position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.7)',
          borderRadius: 6, padding: '4px 10px', fontSize: '0.8rem', color: '#fff'
        }}>
          🌍 Wo bin ich? – {pinCount}/{totalPlayers} Pins gesetzt
        </div>
      </div>
    );
  }

  // Spieler-Ansicht: Bild + Karte + Pin
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

      <div style={{ flex: mapExpanded ? '0 0 30%' : '0 0 45%', position: 'relative', overflow: 'hidden' }}>
        <img
          src={image}
          alt="Wo bin ich?"
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
        <div style={{
          position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.7)',
          borderRadius: 6, padding: '4px 10px', fontSize: '0.8rem', color: '#fff'
        }}>
          🌍 Wo bin ich?
        </div>
        {submitted && (
          <div style={{
            position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
            background: 'rgba(74,222,128,0.9)', borderRadius: 6, padding: '4px 12px',
            fontSize: '0.85rem', color: '#111', fontWeight: 'bold'
          }}>
            ✅ Pin gesetzt – warte auf andere ({pinCount}/{totalPlayers})
          </div>
        )}
      </div>

      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

        <button
          onClick={() => setMapExpanded((v) => !v)}
          style={{
            position: 'absolute', top: 8, right: 8, zIndex: 1000,
            width: 'auto', padding: '6px 12px', fontSize: '0.75rem',
            background: 'rgba(0,0,0,0.7)', color: '#fff', borderRadius: 6, margin: 0
          }}
        >
          {mapExpanded ? '⬆ Kleiner' : '⬇ Größer'}
        </button>

        {!submitted && (
          <div style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1000, width: '80%' }}>
            <button onClick={submitPin} disabled={!pin} style={{ margin: 0, opacity: pin ? 1 : 0.5 }}>
              📍 Pin bestätigen
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
