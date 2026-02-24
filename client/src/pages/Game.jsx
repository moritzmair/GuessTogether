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

export default function Game({ session, panoData }) {
  const mapRef = useRef(null);
  const panoRef = useRef(null);
  const leafletMap = useRef(null);
  const markerRef = useRef(null);

  const [pin, setPin] = useState(null);
  const [submitted, setSubmitted] = useState(false);
  const [pinCount, setPinCount] = useState(0);
  const [totalPlayers, setTotalPlayers] = useState(session.players?.length || 0);
  const [panoError, setPanoError] = useState(false);

  const isHost = session.isHost;

  // Street View Panorama für Host initialisieren
  useEffect(() => {
    if (!isHost || !panoData || !panoRef.current) return;
    let cancelled = false;
    setPanoError(false);
    (async () => {
      if (!window.google?.maps?.StreetViewPanorama) {
        const { key } = await fetch('/api/maps-key').then((r) => r.json());
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&callback=Function.prototype`;
          s.async = true; s.onload = resolve; s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      if (cancelled) return;
      const sv = new window.google.maps.StreetViewPanorama(panoRef.current, {
        pano: panoData.panoId,
        pov: { heading: panoData.heading, pitch: 0 },
        zoom: 1,
        disableDefaultUI: true,
        clickToGo: false,
        linksControl: false,
        panControl: false,
        zoomControl: false,
        scrollwheel: false,
        motionTracking: false,
        motionTrackingControl: false,
        showRoadLabels: false,
      });
      sv.addListener('status_changed', () => {
        if (!cancelled && sv.getStatus() !== 'OK') setPanoError(true);
      });
    })();
    return () => { cancelled = true; };
  }, [isHost, panoData]);

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
    return () => {
      socket.off('pin-placed');
    };
  }, []);

  function submitPin() {
    if (!pin) return;
    socket.emit('place-pin', { lat: pin.lat, lng: pin.lng });
    setSubmitted(true);
  }

  // Host-Ansicht: Street View Panorama (gesperrt)
  if (isHost) {
    return (
      <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000' }}>
        <div ref={panoRef} style={{ width: '100%', height: '100%' }} />
        {/* Overlay blockiert Maus/Touch → kein Panning */}
        <div style={{ position: 'absolute', inset: 0 }} />
        {panoError && (
          <div style={{
            position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#fff', fontSize: '1.1rem', background: '#111', zIndex: 5
          }}>
            ⚠️ Street View nicht verfügbar für diesen Standort
          </div>
        )}
        <div style={{
          position: 'absolute', top: 8, left: 8, background: 'rgba(0,0,0,0.7)',
          borderRadius: 6, padding: '4px 10px', fontSize: '0.8rem', color: '#fff', zIndex: 10
        }}>
          🌍 Wo bin ich? – {pinCount}/{totalPlayers} Pins gesetzt
        </div>
      </div>
    );
  }

  // Spieler-Ansicht: nur Karte
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
        <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

        {submitted ? (
          <div style={{
            position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', zIndex: 1000,
            background: 'rgba(74,222,128,0.9)', borderRadius: 6, padding: '8px 16px',
            fontSize: '0.85rem', color: '#111', fontWeight: 'bold', whiteSpace: 'nowrap'
          }}>
            ✅ Pin gesetzt – warte auf andere ({pinCount}/{totalPlayers})
          </div>
        ) : (
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
