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

> Client: `http://localhost:5173` · Server: `http://localhost:3001`

## Docker

```bash
docker build -t guesstogether .
docker run -p 3001:3001 -e GOOGLE_MAPS_API_KEY=dein_key guesstogether
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
