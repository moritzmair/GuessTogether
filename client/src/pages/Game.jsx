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

export default function Game({ session, panoData, alreadyPinned = false, isSpectator = false }) {
  const mapRef = useRef(null);
  const panoRef = useRef(null);
  const svInstanceRef = useRef(null);
  const leafletMap = useRef(null);
  const markerRef = useRef(null);
  const submittedRef = useRef(alreadyPinned);

  const [pin, setPin] = useState(null);
  const [submitted, setSubmitted] = useState(alreadyPinned);
  const [pinCount, setPinCount] = useState(0);
  const [panoError, setPanoError] = useState(false);
  const [leftNotice, setLeftNotice] = useState(null);
  const [players, setPlayers] = useState(session.players || []);
  const [pinnedIds, setPinnedIds] = useState(new Set());

  const activeSeatCount = players.filter((p) => !p.spectator).length;
  const [totalPlayers, setTotalPlayers] = useState(activeSeatCount);

  const isHost = session.isHost;

  // Street View Panorama für Host initialisieren
  useEffect(() => {
    if (!isHost || !panoData || !panoRef.current) return;
    let cancelled = false;
    setPanoError(false);

    if (svInstanceRef.current) {
      svInstanceRef.current.setVisible(false);
      svInstanceRef.current = null;
      panoRef.current.innerHTML = '';
    }

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
      svInstanceRef.current = sv;
      sv.addListener('status_changed', () => {
        if (!cancelled && sv.getStatus() !== 'OK') setPanoError(true);
      });
    })();
    return () => { cancelled = true; };
  }, [isHost, panoData]);

  // Karte für Spieler + Spectators initialisieren
  useEffect(() => {
    if (isHost) return;
    if (leafletMap.current) return;

    leafletMap.current = L.map(mapRef.current, { zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(leafletMap.current);

    if (panoData?.mapBounds) {
      leafletMap.current.fitBounds(panoData.mapBounds, { padding: [10, 10] });
    } else {
      leafletMap.current.setView([20, 0], 2);
    }

    if (!isSpectator) {
      leafletMap.current.on('click', (e) => {
        if (submittedRef.current) return;
        const { lat, lng } = e.latlng;
        setPin({ lat, lng });
        if (markerRef.current) markerRef.current.remove();
        markerRef.current = L.marker([lat, lng]).addTo(leafletMap.current);
      });
    }

    return () => {
      if (leafletMap.current) {
        leafletMap.current.remove();
        leafletMap.current = null;
      }
    };
  }, [isHost, isSpectator]);

  useEffect(() => {
    socket.on('pin-placed', ({ playerId, pinCount: pc, totalPlayers: tp }) => {
      setPinCount(pc);
      setTotalPlayers(tp);
      if (playerId) setPinnedIds((prev) => new Set([...prev, playerId]));
    });
    socket.on('player-left', ({ name, players: updated }) => {
      setPlayers(updated);
      setTotalPlayers(updated.filter((p) => !p.spectator).length);
      setLeftNotice(`${name} hat das Spiel verlassen`);
      setTimeout(() => setLeftNotice(null), 3000);
    });
    socket.on('players-updated', (updated) => {
      setPlayers(updated);
      // inkl. temporarilyGone für korrekten Gesamtzähler
      setTotalPlayers(updated.filter((p) => !p.spectator).length);
    });
    return () => {
      socket.off('pin-placed');
      socket.off('player-left');
      socket.off('players-updated');
    };
  }, []);

  function submitPin() {
    if (!pin) return;
    socket.emit('place-pin', { lat: pin.lat, lng: pin.lng });
    submittedRef.current = true;
    setSubmitted(true);
  }

  // Host-Ansicht
  if (isHost) {
    const activePlayers = players.filter((p) => !p.spectator);
    const spectators = players.filter((p) => p.spectator);
    const sortedPlayers = [...activePlayers].sort((a, b) => b.score - a.score);

    return (
      <div style={{ position: 'relative', width: '100vw', height: '100vh', background: '#000' }}>
        <div ref={panoRef} style={{ width: '100%', height: '100%' }} />
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
        <div style={{
          position: 'absolute', top: 8, right: 8, background: 'rgba(0,0,0,0.75)',
          borderRadius: 8, padding: '8px 12px', fontSize: '0.8rem', color: '#fff', zIndex: 10,
          minWidth: 160
        }}>
          {sortedPlayers.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, opacity: p.temporarilyGone ? 0.45 : 1 }}>
              <span style={{ opacity: 0.6, width: 16 }}>{i + 1}.</span>
              <span style={{ flex: 1 }}>{p.name}</span>
              <span style={{ opacity: 0.7, marginRight: 4 }}>{p.score}</span>
              <span>{p.temporarilyGone ? '❌' : pinnedIds.has(p.id) ? '✅' : '⏳'}</span>
            </div>
          ))}
          {spectators.length > 0 && (
            <>
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.15)', margin: '6px 0 4px' }} />
              {spectators.map((p) => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, opacity: 0.6 }}>
                  <span style={{ width: 16 }}>👁</span>
                  <span style={{ flex: 1 }}>{p.name}</span>
                  <span style={{ fontSize: '0.7rem', color: '#aaa' }}>nächste Runde</span>
                </div>
              ))}
            </>
          )}
        </div>
        {leftNotice && (
          <div style={{
            position: 'absolute', bottom: 8, right: 8, background: 'rgba(220,50,50,0.85)',
            borderRadius: 6, padding: '4px 10px', fontSize: '0.8rem', color: '#fff', zIndex: 10
          }}>
            👋 {leftNotice}
          </div>
        )}
      </div>
    );
  }

  // Spieler-Ansicht
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden' }}>
      <div style={{ flex: 1, position: 'relative', overflow: 'hidden', minHeight: 0 }}>
        <div ref={mapRef} style={{ width: '100%', height: '100%' }} />

        {isSpectator && (
          <div style={{
            position: 'absolute', top: 0, left: 0, right: 0, background: 'rgba(0,0,0,0.75)',
            padding: '8px 16px', fontSize: '0.85rem', color: '#facc15', textAlign: 'center', zIndex: 1001
          }}>
            👁 Du bist Beobachter – ab der nächsten Runde spielst du mit
          </div>
        )}

        {leftNotice && (
          <div style={{
            position: 'absolute', top: 8, right: 8, background: 'rgba(220,50,50,0.85)',
            borderRadius: 6, padding: '4px 10px', fontSize: '0.8rem', color: '#fff', zIndex: 1001
          }}>
            👋 {leftNotice}
          </div>
        )}
      </div>

      <div style={{
        padding: '10px 16px',
        paddingBottom: 'max(10px, env(safe-area-inset-bottom, 10px))',
        background: 'rgba(18,18,30,0.95)',
        flexShrink: 0,
      }}>
        {isSpectator ? (
          <div style={{
            background: 'rgba(250,204,21,0.15)', border: '1px solid #facc15',
            borderRadius: 6, padding: '10px 16px', fontSize: '0.85rem', color: '#facc15', textAlign: 'center'
          }}>
            👁 Beobachter-Modus – nächste Runde dabei
          </div>
        ) : submitted ? (
          <div style={{
            background: 'rgba(74,222,128,0.9)', borderRadius: 6, padding: '10px 16px',
            fontSize: '0.85rem', color: '#111', fontWeight: 'bold', textAlign: 'center'
          }}>
            ✅ Pin gesetzt – warte auf andere ({pinCount}/{totalPlayers})
          </div>
        ) : (
          <button onClick={submitPin} disabled={!pin} style={{ margin: 0, width: '100%', opacity: pin ? 1 : 0.5 }}>
            📍 Pin bestätigen
          </button>
        )}
      </div>
    </div>
  );
}
