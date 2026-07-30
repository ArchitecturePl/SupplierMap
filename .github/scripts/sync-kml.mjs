// Runs inside GitHub Actions (server-side) — no browser, no CORS restriction.
const MID = '14yOcErr3NwLSEdEjup9eeUiRr7Bm_1I';
const url = `https://www.google.com/maps/d/kml?mid=${MID}&forcekml=1`;

const res = await fetch(url);
if (!res.ok) throw new Error('Fetch failed: HTTP ' + res.status);
const xml = await res.text();
if (xml.indexOf('<kml') === -1) throw new Error('Response was not KML (map may not be public)');

const tag = (str, name) => {
  const m = str.match(new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
};
const blocks = (str, name) => {
  const re = new RegExp(`<(?:\\w+:)?${name}[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${name}>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(str))) out.push(m[1]);
  return out;
};

const folders = blocks(xml, 'Folder');
const data = folders.map(f => {
  const name = tag(f, 'name');
  const items = blocks(f, 'Placemark').map(pm => {
    const nm = tag(pm, 'name');
    const coord = tag(pm, 'coordinates');
    if (coord) {
      const [lng, lat] = coord.split(',').map(s => Number(s.trim()));
      if (isFinite(lat) && isFinite(lng)) return { name: nm, lat, lng };
    }
    const address = tag(pm, 'address');
    if (address) return { name: nm, lat: undefined, lng: undefined, approx: true, address };
    return null;
  }).filter(Boolean);
  return { name, items };
}).filter(f => f.items.length);

const total = data.reduce((a, f) => a + f.items.length, 0);
console.log(`Parsed ${data.length} categories, ${total} points`);

const fs = await import('fs');
fs.writeFileSync('data.json', JSON.stringify({ syncedAt: new Date().toISOString(), categories: data }, null, 0));
