require('dotenv').config();
const https = require('https');

const key = process.env.GOOGLE_MAPS_API_KEY;
if (!key) { console.error('❌ GOOGLE_MAPS_API_KEY fehlt in .env'); process.exit(1); }

// Test 1: Metadata (kein Bild-Quota)
const metaUrl = `https://maps.googleapis.com/maps/api/streetview/metadata?location=48.8584,2.2945&key=${key}`;
console.log('1️⃣  Metadata-Check...');
https.get(metaUrl, (res) => {
  let body = '';
  res.on('data', (d) => (body += d));
  res.on('end', () => {
    const json = JSON.parse(body);
    console.log('   Status:', json.status);
    if (json.error_message) console.log('   Fehler:', json.error_message);
    if (json.status === 'OK') console.log('   Location gefunden:', json.location);
  });
}).on('error', (e) => console.error('Netzwerkfehler:', e.message));

// Test 2: Echtes Bild
const imgUrl = `https://maps.googleapis.com/maps/api/streetview?size=400x300&location=48.8584,2.2945&heading=151&pitch=-1&key=${key}`;
console.log('2️⃣  Bild-Request...');
https.get(imgUrl, (res) => {
  console.log('   HTTP-Status:', res.statusCode);
  console.log('   Content-Type:', res.headers['content-type']);
  const len = res.headers['content-length'];
  console.log('   Content-Length:', len ? `${len} Bytes` : 'unbekannt');

  if (res.headers['content-type']?.includes('image')) {
    console.log('   ✅ Bild erfolgreich zurückgegeben');
  } else {
    let body = '';
    res.on('data', (d) => (body += d));
    res.on('end', () => console.log('   ❌ Kein Bild – Antwort:', body.substring(0, 300)));
  }
  res.resume();
}).on('error', (e) => console.error('Netzwerkfehler:', e.message));
