import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { loadGoogleMaps, onGoogleAuthFailure } from '../googleMaps.js';
import { drawPlayArea, isInsidePlayArea, nearestWorldCopy, normalizeLng, scorePoints, scoreExamples } from '../playArea.js';
import { escapeHtml, formatDistance } from '../format.js';
import { loadSettings, saveSettings } from '../settings.js';

const MODES = [
  { id: 'weltweit',    label: '🌍 Weltweit' },
  { id: 'europa',      label: '🇪🇺 Europa' },
  { id: 'grossstaedte',label: '🏙️ Großstädte' },
  { id: 'beruehmt',   label: '🏛️ Berühmte Orte' },
  { id: 'custom',      label: '✏️ Custom' },
];

const PANORAMA_SOURCES = [
  { id: 'google', label: '🚗 Nur Google Street View', desc: 'Offizielle Aufnahmen, korrekt verortet' },
  { id: 'all',    label: '👥 Auch Nutzer-Panoramen',  desc: 'Mehr Orte, oft falsch verortet' },
];

const TOTAL_ROUNDS = 5;

delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export default function SoloGame({ onBack }) {
  // phases: 'setup' | 'loading' | 'playing' | 'roundResult' | 'summary'
  const [settings]                          = useState(loadSettings);
  const [phase, setPhase]                   = useState('setup');
  const [mode, setMode]                     = useState(settings.mode || 'weltweit');
  const [panoramaSource, setPanoramaSource] = useState(settings.panoramaSource || 'google');
  const [outdoorOnly, setOutdoorOnly]       = useState(settings.outdoorOnly ?? true);
  const [round, setRound]                   = useState(0);
  const [totalScore, setTotalScore]         = useState(0);
  const [history, setHistory]               = useState([]);
  const [currentRound, setCurrentRound]     = useState(null);
  const [pin, setPin]                       = useState(null);
  const [panoError, setPanoError]           = useState(null);
  const [loadError, setLoadError]           = useState(null);
  const [roundResult, setRoundResult]       = useState(null);
  // Custom-Bounds werden beim Start einmalig gespeichert, damit alle Folgerunden
  // dieselben Bounds nutzen – auch nachdem die Custom-Map-Instanz zerstört wurde.
  const [savedCustomBounds, setSavedCustomBounds] = useState(null);
  // Aktueller Ausschnitt der Custom-Karte – nur fuer die Punkte-Beispiele im Setup
  const [customArea, setCustomArea]         = useState(null);
  const [areaHint, setAreaHint]             = useState(false);
  const [showAbortConfirm, setShowAbortConfirm] = useState(false);

  const panoRef           = useRef(null);
  const svInstanceRef     = useRef(null);
  const gameMapRef        = useRef(null);
  const gameLeaflet       = useRef(null);
  const markerRef         = useRef(null);
  const resultMapRef      = useRef(null);
  const resultLeaflet     = useRef(null);
  const customMapRef      = useRef(null);
  const customMapInstance = useRef(null);
  const pinRef            = useRef(null); // gleiche Ref für Click-Handler-Closure
  const usedPanosRef      = useRef([]);   // Orte dieses Spiels – der Server meidet sie
  // Runde, die gerade geladen wird – "Erneut versuchen" muss genau diese laden. Vorher
  // lud es die vorige Nummer erneut, dann wurden es insgesamt 6 Runden.
  const loadingRoundRef   = useRef(1);

  useEffect(() => {
    saveSettings({ mode, panoramaSource, outdoorOnly });
  }, [mode, panoramaSource, outdoorOnly]);

  // Custom-Bounds-Karte
  useEffect(() => {
    if (phase !== 'setup') return;
    if (mode !== 'custom') {
      if (customMapInstance.current) {
        customMapInstance.current.remove();
        customMapInstance.current = null;
      }
      return;
    }
    if (!customMapRef.current || customMapInstance.current) return;
    const view = loadSettings().customView;
    const map = L.map(customMapRef.current).setView(view?.center || [50, 10], view?.zoom || 5);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
    }).addTo(map);
    customMapInstance.current = map;
    const syncArea = () => {
      const b = map.getBounds();
      setCustomArea([[b.getSouth(), b.getWest()], [b.getNorth(), b.getEast()]]);
      const c = map.getCenter();
      saveSettings({ customView: { center: [c.lat, c.lng], zoom: map.getZoom() } });
    };
    map.on('moveend', syncArea);
    syncArea();
    return () => {
      if (customMapInstance.current) {
        customMapInstance.current.remove();
        customMapInstance.current = null;
      }
    };
  }, [mode, phase]);

  // Street View initialisieren
  useEffect(() => {
    if (phase !== 'playing' || !currentRound || !panoRef.current) return;
    let cancelled = false;
    setPanoError(null);

    if (svInstanceRef.current) {
      svInstanceRef.current.setVisible(false);
      svInstanceRef.current = null;
      if (panoRef.current) panoRef.current.innerHTML = '';
    }

    const unsubscribe = onGoogleAuthFailure((msg) => { if (!cancelled) setPanoError(msg); });

    (async () => {
      let maps;
      try {
        maps = await loadGoogleMaps();
      } catch (err) {
        if (!cancelled) setPanoError(err.message);
        return;
      }
      if (cancelled) return;
      const sv = new maps.StreetViewPanorama(panoRef.current, {
        pano: currentRound.panoId,
        pov: { heading: currentRound.heading, pitch: 0 },
        zoom: 1,
        disableDefaultUI: true,
        clickToGo: false,
        linksControl: false,
        panControl: false,
        zoomControl: true,
        scrollwheel: true,
        motionTracking: false,
        motionTrackingControl: false,
        showRoadLabels: false,
      });
      svInstanceRef.current = sv;
      sv.addListener('status_changed', () => {
        if (!cancelled && sv.getStatus() !== 'OK') {
          setPanoError(`Street View nicht verfügbar für dieses Panorama (${sv.getStatus()})`);
        }
      });
    })();
    return () => { cancelled = true; unsubscribe(); };
  }, [phase, currentRound]);

  // Spielkarte initialisieren
  useEffect(() => {
    if (phase !== 'playing' || !gameMapRef.current) return;
    if (gameLeaflet.current) return;

    gameLeaflet.current = L.map(gameMapRef.current, { zoomControl: true }).setView([20, 0], 2);
    L.tileLayer('https://tile.openstreetmap.de/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
    }).addTo(gameLeaflet.current);

    if (currentRound?.mapBounds) {
      gameLeaflet.current.fitBounds(currentRound.mapBounds, { padding: [10, 10] });
    }

    const playArea = currentRound?.playArea || null;
    drawPlayArea(gameLeaflet.current, playArea);

    gameLeaflet.current.on('click', (e) => {
      const { lat, lng } = e.latlng;
      if (!isInsidePlayArea(lat, lng, playArea)) {
        setAreaHint(true);
        setTimeout(() => setAreaHint(false), 1800);
        return;
      }
      // Klick auf einer Nachbarkopie der Weltkarte liefert Laengen jenseits ±180
      pinRef.current = { lat, lng: normalizeLng(lng) };
      setPin({ lat, lng });
      if (markerRef.current) markerRef.current.remove();
      markerRef.current = L.marker([lat, lng]).addTo(gameLeaflet.current);
    });

    return () => {
      if (gameLeaflet.current) { gameLeaflet.current.remove(); gameLeaflet.current = null; }
      markerRef.current = null;
    };
  }, [phase]);

  // Ergebniskarte initialisieren
  useEffect(() => {
    if (phase !== 'roundResult' || !resultMapRef.current || !roundResult || !currentRound) return;
    if (resultLeaflet.current) return;

    const loc = currentRound.location;
    resultLeaflet.current = L.map(resultMapRef.current).setView([loc.lat, loc.lng], 4);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
    }).addTo(resultLeaflet.current);

    const bounds = L.latLngBounds([[loc.lat, loc.lng]]);

    const targetIcon = L.divIcon({
      html: '<div style="background:#f87171;width:16px;height:16px;border-radius:50%;border:3px solid #fff;"></div>',
      iconSize: [16, 16],
      className: '',
    });
    L.marker([loc.lat, loc.lng], { icon: targetIcon })
      .bindPopup(`<b>📍 Lösung:</b> ${escapeHtml(loc.label)}`)
      .addTo(resultLeaflet.current)
      .openPopup();

    if (roundResult.pin) {
      const pinPos = [roundResult.pin.lat, nearestWorldCopy(roundResult.pin.lng, loc.lng)];
      bounds.extend(pinPos);
      const playerIcon = L.divIcon({
        html: `<div style="display:flex;flex-direction:column;align-items:center;pointer-events:none">
          <div style="background:#4ade80;width:12px;height:12px;border-radius:50%;border:2px solid #fff;"></div>
          <div style="background:rgba(0,0,0,0.75);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;white-space:nowrap;margin-top:2px">Du</div>
        </div>`,
        iconSize: [80, 30],
        iconAnchor: [40, 6],
        className: '',
      });
      L.marker(pinPos, { icon: playerIcon })
        .bindPopup(`Dein Pin – ${formatDistance(roundResult.dist)}`)
        .addTo(resultLeaflet.current);

      L.polyline(
        [[loc.lat, loc.lng], pinPos],
        { color: '#4ade80', dashArray: '6 4', weight: 2, opacity: 0.7 }
      ).addTo(resultLeaflet.current);
    }

    resultLeaflet.current.fitBounds(bounds.pad(0.3));

    return () => {
      if (resultLeaflet.current) { resultLeaflet.current.remove(); resultLeaflet.current = null; }
    };
  }, [phase, roundResult]);

  // ─── Runde laden ──────────────────────────────────────────────────────────
  // customBoundsOverride: wird nur beim Erstaufruf übergeben (bevor Map zerstört wird)
  async function startRound(nextRound, customBoundsOverride = null) {
    loadingRoundRef.current = nextRound;
    setPhase('loading');
    setLoadError(null);
    setPin(null);
    pinRef.current = null;
    if (gameLeaflet.current)   { gameLeaflet.current.remove();   gameLeaflet.current   = null; }
    if (resultLeaflet.current) { resultLeaflet.current.remove(); resultLeaflet.current = null; }

    // Folgerunden: gespeicherte Bounds aus State verwenden
    const cb = customBoundsOverride ?? savedCustomBounds;
    let url = `/api/solo/start-round?mode=${mode}`
      + `&googleOnly=${panoramaSource === 'google' ? 1 : 0}&outdoorOnly=${outdoorOnly ? 1 : 0}`;
    if (mode === 'custom' && cb) {
      url += `&customBounds=${encodeURIComponent(JSON.stringify(cb))}`;
    }
    if (usedPanosRef.current.length) {
      url += `&used=${encodeURIComponent(JSON.stringify(usedPanosRef.current))}`;
    }

    try {
      let res;
      try {
        res = await fetch(url);
      } catch (_) {
        throw new Error('Server nicht erreichbar – bitte Verbindung prüfen.');
      }
      // Ein Proxy-/Gateway-Fehler liefert HTML statt JSON – nicht als "Unexpected token" anzeigen
      const data = await res.json().catch(() => ({ error: `Server-Fehler (HTTP ${res.status})` }));
      if (data.error) throw new Error(data.error);
      usedPanosRef.current.push({ pano_id: data.panoId, lat: data.location.lat, lng: data.location.lng });
      setCurrentRound(data);
      setRound(nextRound);
      setPhase('playing');
    } catch (err) {
      setLoadError(err.message);
    }
  }

  function handleStartGame() {
    // Custom-Bounds JETZT lesen, solange die Map-Instanz noch lebt
    let cb = null;
    if (mode === 'custom' && customMapInstance.current) {
      const b = customMapInstance.current.getBounds();
      cb = { lat: [b.getSouth(), b.getNorth()], lng: [b.getWest(), b.getEast()] };
    }
    setSavedCustomBounds(cb);
    usedPanosRef.current = [];
    setRound(0);
    setTotalScore(0);
    setHistory([]);
    startRound(1, cb);
  }

  function submitPin() {
    const p = pinRef.current;
    const loc = currentRound.location;
    const dist = p ? distanceKm(loc.lat, loc.lng, p.lat, p.lng) : null;
    const points = p ? scorePoints(dist, currentRound.playArea) : 0;
    const newTotal = totalScore + points;
    setTotalScore(newTotal);
    const entry = { round, dist, points, totalScore: newTotal, pin: p, location: loc };
    setRoundResult({ dist, points, pin: p });
    setHistory((prev) => [...prev, entry]);
    setPhase('roundResult');
  }

  function handleNextRound() {
    if (round >= TOTAL_ROUNDS) {
      setPhase('summary');
    } else {
      startRound(round + 1);
    }
  }

  // Solo-Spiel abbrechen -> zurueck ins Hauptmenue. Karten muessen explizit
  // abgeraeumt werden, sonst bleiben die Leaflet-Instanzen haengen.
  function handleAbort() {
    if (gameLeaflet.current)   { gameLeaflet.current.remove();   gameLeaflet.current   = null; }
    if (resultLeaflet.current) { resultLeaflet.current.remove(); resultLeaflet.current = null; }
    if (svInstanceRef.current) { svInstanceRef.current.setVisible(false); svInstanceRef.current = null; }
    markerRef.current = null;
    pinRef.current = null;
    onBack();
  }

  function handleRestart() {
    setRound(0);
    setTotalScore(0);
    setHistory([]);
    setCurrentRound(null);
    setRoundResult(null);
    setPin(null);
    setSavedCustomBounds(null);
    pinRef.current = null;
    if (gameLeaflet.current)   { gameLeaflet.current.remove();   gameLeaflet.current   = null; }
    if (resultLeaflet.current) { resultLeaflet.current.remove(); resultLeaflet.current = null; }
    setPhase('setup');
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SETUP
  // ══════════════════════════════════════════════════════════════════════════
  if (phase === 'setup') {
    return (
      <div className="center" style={{ padding: 16 }}>
        <div className="card" style={{ width: '100%', maxWidth: 480 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <button
              onClick={onBack}
              style={{ margin: 0, padding: '6px 12px', background: '#2a2a3e', fontSize: '0.9rem', width: 'auto' }}
            >
              ← Zurück
            </button>
            <h1 style={{ margin: 0, fontSize: '1.5rem' }}>🕹️ Solo-Modus</h1>
          </div>

          {/* Spielgebiet */}
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: '0.75rem', color: '#888', marginBottom: 6 }}>Spielgebiet</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  style={{
                    flex: '1 1 auto', margin: 0, padding: '6px 0', fontSize: '0.8rem',
                    background: mode === m.id ? '#4a9eff' : '#2a2a2a',
                    color: '#fff',
                    border: mode === m.id ? 'none' : '1px solid #444',
                  }}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Panorama-Quelle */}
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: '0.75rem', color: '#888', marginBottom: 6 }}>Panorama-Quelle</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {PANORAMA_SOURCES.map((f) => (
                <button
                  key={f.id}
                  onClick={() => setPanoramaSource(f.id)}
                  style={{
                    margin: 0, padding: '8px 12px', fontSize: '0.82rem', textAlign: 'left',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: panoramaSource === f.id ? '#4a9eff' : '#2a2a2a',
                    color: '#fff',
                    border: panoramaSource === f.id ? 'none' : '1px solid #444',
                  }}
                >
                  <span style={{ fontWeight: panoramaSource === f.id ? 700 : 400 }}>{f.label}</span>
                  <span style={{ fontSize: '0.7rem', opacity: 0.7, marginLeft: 8 }}>{f.desc}</span>
                </button>
              ))}
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: '8px 0 0' }}>
              <input
                type="checkbox"
                checked={outdoorOnly}
                onChange={(e) => setOutdoorOnly(e.target.checked)}
                style={{ width: 'auto', margin: 0 }}
              />
              <span style={{ fontSize: '0.85rem', color: '#ccc' }}>🚪 Keine Indoor-Aufnahmen</span>
            </label>
          </div>

          {/* Custom Map */}
          {mode === 'custom' && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: '0.8rem', color: '#aaa', marginBottom: 6 }}>
                Karte zoomen & verschieben – sichtbarer Ausschnitt wird Spielgebiet
              </div>
              <div
                ref={customMapRef}
                style={{ width: '100%', height: 240, borderRadius: 8, overflow: 'hidden' }}
              />
            </div>
          )}

          {/* Info-Banner */}
          <div style={{
            background: '#1a1a2e', borderRadius: 10, padding: '12px 16px', marginBottom: 20,
            fontSize: '0.85rem', color: '#aaa', lineHeight: 1.7,
          }}>
            <span style={{ color: '#4a9eff', fontWeight: 'bold' }}>{TOTAL_ROUNDS} Runden</span>
            {' '}· Street View · Pin auf der Karte setzen
            <br />
            <span style={{ fontSize: '0.78rem' }}>
              📊 <strong style={{ color: '#bbb' }}>Punkte:</strong> ≤ 10 m → 10.000
              {scoreExamples(mode === 'custom' ? customArea : null)
                .map((e) => `  ·  ${e.label} → ${e.points.toLocaleString()}`)}
              {mode === 'custom' && <><br />Maßstab passt sich dem gewählten Ausschnitt an</>}
            </span>
          </div>

          <button
            onClick={handleStartGame}
            style={{ width: '100%', fontSize: '1.05rem', padding: '13px', background: '#4a9eff' }}
          >
            🚀 Solo spielen
          </button>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LOADING
  // ══════════════════════════════════════════════════════════════════════════
  if (phase === 'loading') {
    return (
      <div className="center">
        {loadError ? (
          <div className="card" style={{ textAlign: 'center', maxWidth: 360 }}>
            <div style={{ fontSize: '2rem', marginBottom: 12 }}>⚠️</div>
            <p style={{ color: '#f87171', marginBottom: 16 }}>{loadError}</p>
            <button onClick={() => startRound(loadingRoundRef.current)} style={{ marginBottom: 8 }}>🔄 Erneut versuchen</button>
            <button onClick={onBack} style={{ background: '#2a2a3e' }}>← Zurück</button>
          </div>
        ) : (
          <div style={{ textAlign: 'center', color: '#aaa' }}>
            <div style={{ fontSize: '2.5rem', marginBottom: 12 }}>🌍</div>
            <div>Suche Street View Standort…</div>
          </div>
        )}
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PLAYING
  // ══════════════════════════════════════════════════════════════════════════
  if (phase === 'playing') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh', overflow: 'hidden' }}>

        {/* Street View – obere Hälfte */}
        <div style={{ flex: '0 0 55%', position: 'relative', background: '#000' }}>
          <div ref={panoRef} style={{ width: '100%', height: '100%' }} />
          {panoError && (
            <div style={{
              position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 8,
              alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center',
              color: '#fff', background: '#111',
            }}>
              <div style={{ fontSize: '1rem' }}>⚠️ Street View konnte nicht geladen werden</div>
              <div style={{ fontSize: '0.8rem', color: '#f87171', maxWidth: 560, lineHeight: 1.5 }}>
                {panoError}
              </div>
            </div>
          )}

          {/* Runden-Badge + Beenden */}
          <div style={{
            position: 'absolute', top: 8, left: 8, zIndex: 10,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <div style={{
              background: 'rgba(0,0,0,0.72)',
              borderRadius: 6, padding: '4px 10px', fontSize: '0.8rem', color: '#fff',
            }}>
              🕹️ Solo &nbsp;·&nbsp; Runde {round}/{TOTAL_ROUNDS} &nbsp;·&nbsp; {totalScore.toLocaleString()} Pkt
            </div>
            <button
              onClick={() => setShowAbortConfirm(true)}
              style={{
                background: 'rgba(180,30,30,0.85)', border: 'none', borderRadius: 6,
                padding: '4px 10px', fontSize: '0.78rem', color: '#fff', cursor: 'pointer',
                fontWeight: 'bold', margin: 0, width: 'auto',
              }}
            >
              ✕ Beenden
            </button>
          </div>

          {showAbortConfirm && (
            <div style={{
              position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.72)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
            }}>
              <div style={{
                background: '#1e1e2e', borderRadius: 10, padding: '24px 28px', maxWidth: 320,
                textAlign: 'center', color: '#fff', boxShadow: '0 4px 24px rgba(0,0,0,0.6)',
              }}>
                <div style={{ fontSize: '1.3rem', marginBottom: 8 }}>⏹ Solo-Spiel beenden?</div>
                <div style={{ fontSize: '0.85rem', color: '#aaa', marginBottom: 20 }}>
                  Zurück zum Hauptmenü. Die {totalScore.toLocaleString()} Punkte aus
                  {' '}{history.length} gespielten Runden gehen verloren.
                </div>
                <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
                  <button
                    onClick={() => setShowAbortConfirm(false)}
                    style={{
                      background: 'rgba(255,255,255,0.12)', border: 'none', borderRadius: 6,
                      padding: '8px 18px', color: '#fff', cursor: 'pointer', fontSize: '0.9rem', margin: 0,
                    }}
                  >
                    Weiterspielen
                  </button>
                  <button
                    onClick={handleAbort}
                    style={{
                      background: '#b41e1e', border: 'none', borderRadius: 6,
                      padding: '8px 18px', color: '#fff', cursor: 'pointer', fontSize: '0.9rem',
                      fontWeight: 'bold', margin: 0,
                    }}
                  >
                    Ja, beenden
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Karte – untere Hälfte */}
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <div ref={gameMapRef} style={{ width: '100%', height: '100%' }} />
          {!pin && !areaHint && (
            <div style={{
              position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.65)', borderRadius: 6, padding: '4px 12px',
              fontSize: '0.78rem', color: '#ccc', pointerEvents: 'none', zIndex: 1000, whiteSpace: 'nowrap',
            }}>
              {currentRound?.playArea
                ? 'Tippe ins markierte Gebiet um einen Pin zu setzen'
                : 'Tippe auf die Karte um einen Pin zu setzen'}
            </div>
          )}
          {areaHint && (
            <div style={{
              position: 'absolute', bottom: 8, left: '50%', transform: 'translateX(-50%)',
              background: 'rgba(220,50,50,0.9)', borderRadius: 6, padding: '4px 12px',
              fontSize: '0.78rem', color: '#fff', fontWeight: 'bold',
              pointerEvents: 'none', zIndex: 1000, whiteSpace: 'nowrap',
            }}>
              ⛔ Außerhalb des Spielgebiets
            </div>
          )}
        </div>

        {/* Footer */}
        <div style={{
          padding: '10px 16px',
          paddingBottom: 'max(10px, env(safe-area-inset-bottom, 10px))',
          background: 'rgba(18,18,30,0.97)',
          flexShrink: 0,
        }}>
          <button
            onClick={submitPin}
            disabled={!pin}
            style={{ margin: 0, width: '100%', opacity: pin ? 1 : 0.5 }}
          >
            📍 Pin bestätigen
          </button>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // ROUND RESULT
  // ══════════════════════════════════════════════════════════════════════════
  if (phase === 'roundResult' && roundResult && currentRound) {
    const loc    = currentRound.location;
    const isLast = round >= TOTAL_ROUNDS;
    const distFmt = roundResult.dist == null ? null : formatDistance(roundResult.dist);
    const accent = roundResult.points >= 5000 ? '#4ade80' : '#4a9eff';

    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100dvh' }}>
        {/* Ergebniskarte */}
        <div ref={resultMapRef} style={{ flex: '0 0 40%' }} />

        {/* Scrollbarer Inhalt */}
        <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
          <h2 style={{ textAlign: 'center', marginBottom: 16 }}>
            📍 {loc.label}
          </h2>

          {/* Score-Box */}
          <div style={{
            background: '#1a1a2e', border: `1px solid ${accent}`,
            borderRadius: 10, padding: '14px 20px', textAlign: 'center', marginBottom: 16,
          }}>
            {roundResult.pin ? (
              <>
                <div style={{ fontSize: '2rem', fontWeight: 'bold', color: accent }}>
                  +{roundResult.points.toLocaleString()} Pkt
                </div>
                <div style={{ color: '#aaa', fontSize: '0.9rem', marginTop: 4 }}>
                  📏 {distFmt} entfernt
                </div>
              </>
            ) : (
              <>
                <div style={{ fontSize: '1.5rem', color: '#f87171' }}>Kein Pin gesetzt</div>
                <div style={{ color: '#aaa', fontSize: '0.9rem', marginTop: 4 }}>0 Punkte</div>
              </>
            )}
            <div style={{ color: '#666', fontSize: '0.78rem', marginTop: 8 }}>
              Runde {round}/{TOTAL_ROUNDS} &nbsp;·&nbsp; Gesamt:{' '}
              <strong style={{ color: '#e0e0e0' }}>{totalScore.toLocaleString()} Pkt</strong>
            </div>
          </div>

          {/* Runden-Mini-Übersicht */}
          <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
            {Array.from({ length: TOTAL_ROUNDS }, (_, i) => {
              const h = history[i];
              return (
                <div key={i} style={{
                  flex: '1 1 auto', padding: '6px 4px', borderRadius: 6, textAlign: 'center',
                  background: h ? '#1a2a1a' : '#1a1a1a',
                  border: `1px solid ${h ? '#4ade80' : '#333'}`,
                  fontSize: '0.75rem', color: h ? '#4ade80' : '#555',
                }}>
                  <div style={{ opacity: 0.6 }}>{i + 1}</div>
                  <div style={{ fontWeight: 'bold' }}>{h ? `+${h.points.toLocaleString()}` : '–'}</div>
                </div>
              );
            })}
          </div>

          <button
            onClick={handleNextRound}
            style={{
              width: '100%', fontWeight: 'bold',
              background: isLast ? '#4ade80' : '#4a9eff',
              color: isLast ? '#111' : '#fff',
            }}
          >
            {isLast ? '📊 Zusammenfassung' : '▶ Nächste Runde'}
          </button>

          <button
            onClick={handleAbort}
            style={{ width: '100%', background: '#2a2a3e', color: '#bbb', fontWeight: 'normal' }}
          >
            ✕ Spiel beenden
          </button>
        </div>
      </div>
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ══════════════════════════════════════════════════════════════════════════
  if (phase === 'summary') {
    const maxPossible = TOTAL_ROUNDS * 10000;
    const pct    = Math.round((totalScore / maxPossible) * 100);
    const medal  = pct >= 80 ? '🥇' : pct >= 55 ? '🥈' : pct >= 30 ? '🥉' : '🌍';

    return (
      <div className="center" style={{ padding: 16 }}>
        <div className="card" style={{ width: '100%', maxWidth: 480 }}>
          <div style={{ textAlign: 'center', marginBottom: 24 }}>
            <div style={{ fontSize: '3.5rem', marginBottom: 8 }}>{medal}</div>
            <h1 style={{ margin: 0, fontSize: '1.8rem' }}>Zusammenfassung</h1>
            <div style={{ fontSize: '2.4rem', fontWeight: 'bold', color: '#4ade80', marginTop: 10 }}>
              {totalScore.toLocaleString()} Pkt
            </div>
            <div style={{ color: '#888', fontSize: '0.85rem', marginTop: 4 }}>
              {pct}% von {maxPossible.toLocaleString()} möglichen Punkten
            </div>
          </div>

          <ul style={{ listStyle: 'none', marginBottom: 24, padding: 0 }}>
            {history.map((h, i) => {
              const df = h.dist == null ? null : formatDistance(h.dist);
              return (
                <li key={i} style={{
                  background: '#1a1a1a', border: '1px solid #333', borderRadius: 8,
                  padding: '10px 14px', marginBottom: 8,
                  display: 'flex', alignItems: 'center', gap: 12,
                }}>
                  <span style={{ color: '#555', width: 20, textAlign: 'center', flexShrink: 0 }}>{i + 1}.</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.85rem', color: '#bbb', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {h.location.label}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#555', marginTop: 2 }}>
                      {h.pin ? `${df} entfernt` : 'Kein Pin gesetzt'}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontWeight: 'bold', color: '#4ade80' }}>+{h.points.toLocaleString()}</div>
                  </div>
                </li>
              );
            })}
          </ul>

          <button
            onClick={handleRestart}
            style={{ width: '100%', background: '#4a9eff', marginBottom: 10 }}
          >
            🔄 Nochmal spielen
          </button>
          <button
            onClick={onBack}
            style={{ width: '100%', background: '#2a2a3e' }}
          >
            🏠 Hauptmenü
          </button>
        </div>
      </div>
    );
  }

  return null;
}
