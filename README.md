# 🌍 GuessTogether

Multiplayer GeoGuessing-Spiel. Host zeigt Street View auf dem TV, Spieler raten auf dem Handy.

## Setup

```bash
# Dependencies
npm run install:all

# Google Maps API Key
cp server/.env.example server/.env
# → GOOGLE_MAPS_API_KEY in server/.env eintragen

# Dev
npm run dev
```

### Google Cloud einrichten

Im Cloud-Projekt des Keys müssen **beide** APIs aktiviert und ein **Abrechnungskonto
verknüpft** sein – ohne Billing lehnt Google *jede* Anfrage mit `REQUEST_DENIED` ab,
auch die kostenlosen Metadata-Aufrufe.

| API | Wofür | Wo |
|---|---|---|
| Street View Static API | Panorama-Suche (Metadata) | Server |
| Maps JavaScript API | Panorama anzeigen | Browser |

Empfohlen sind zwei getrennte Keys:

- `GOOGLE_MAPS_API_KEY` – Server, verlässt das Backend nie → auf die Server-IP einschränken
- `GOOGLE_MAPS_BROWSER_KEY` – wird ans Frontend ausgeliefert und ist damit öffentlich
  → per HTTP-Referrer auf die eigene Domain und auf die Maps JavaScript API einschränken

Ohne `GOOGLE_MAPS_BROWSER_KEY` nutzt der Client den Server-Key (nur für Dev sinnvoll).

Der Server prüft den Key beim Start mit einem echten Request und bricht mit
Googles Originalmeldung ab, wenn etwas fehlt.

> Client: `http://localhost:5173` · Server: `http://localhost:3001`

## Docker

```bash
docker build -t guesstogether .
docker run -p 3001:3001 \
  -e GOOGLE_MAPS_API_KEY=dein_server_key \
  -e GOOGLE_MAPS_BROWSER_KEY=dein_browser_key \
  guesstogether
```

## Spielablauf

1. **Host** öffnet die App auf TV/Laptop → Session erstellen
2. **Spieler** scannen QR-Code oder nutzen den Link → Namen wählen → Beitreten
3. Host wählt Modus und startet die Runde
4. Spieler tippen auf die Weltkarte wo sie den Street-View-Ort vermuten
5. Nach allen Pins → Ergebnisse → nächste Runde oder neues Spiel

## Modi

| Modus | Gebiet |
|---|---|
| 🌍 Weltweit | Global |
| 🇪🇺 Europa | Europa |
| 🏙️ Großstädte | Weltstädte |
| 🦔 Darmstadt | Darmstadt |
| 🏛️ Wiesbaden | Wiesbaden |

## Features

- **Reconnect** – Tab geschlossen? Einfach wieder aufmachen, 2-Minuten-Grace-Period
- **Rejoin-Banner** – Startseite zeigt laufende Session wenn localStorage-Eintrag vorhanden
- **Auto-Rejoin** – Join-Link erneut öffnen = direkt zurück ins Spiel (kein Name nötig)
- **Beobachter** – Während laufendem Spiel beitreten → ab nächster Runde voller Spieler
