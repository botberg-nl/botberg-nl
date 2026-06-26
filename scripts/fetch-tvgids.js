// Haalt de Nederlandse TV-gids op en schrijft tvgids.json met de
// programma's voor de komende 2 uur op een set hoofdzenders.
//
// Bron: json.tvgids.nl (v4). Draait server-side in een GitHub Action,
// dus geen CORS-beperkingen. Defensief geschreven: als de bron faalt of
// een onverwacht formaat heeft, blijft een eventueel bestaand tvgids.json
// staan en eindigt het script zonder de build te breken.

const fs = require('fs');

// Zenders die we tonen (namen zoals tvgids.nl ze gebruikt).
const WANTED = [
  'NPO 1', 'NPO 2', 'NPO 3',
  'RTL 4', 'RTL 5', 'RTL 7', 'RTL 8',
  'SBS6', 'Net5', 'Veronica', 'NET 5',
];

const OUT = 'tvgids.json';
const TIMEOUT = 20000;

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'botberg-weather-dashboard/1.0' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} voor ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Probeert uit een willekeurig programma-object de relevante velden te halen,
// ongeacht de exacte sleutelnamen die de API gebruikt.
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function toDate(v) {
  if (v === undefined) return null;
  // Unix timestamp (seconden)?
  if (typeof v === 'number' || /^\d+$/.test(String(v))) {
    const n = Number(v);
    return new Date(n > 1e12 ? n : n * 1000);
  }
  const d = new Date(v);
  return isNaN(d) ? null : d;
}

function normalizeProgram(p) {
  const title = pick(p, ['titel', 'title', 'name', 'programma']);
  const start = toDate(pick(p, ['datum_start', 'starttime', 'start', 'db_startdate', 'begin']));
  const end = toDate(pick(p, ['datum_end', 'endtime', 'end', 'db_enddate', 'eind']));
  const channel = pick(p, ['channel', 'kanaal', 'zender', 'channel_id']);
  if (!title || !start) return null;
  return { title: String(title), start, end, channel };
}

// Loopt recursief door de respons en verzamelt alles wat op een programma lijkt.
function collectPrograms(node, acc) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectPrograms(item, acc);
    return;
  }
  if (typeof node === 'object') {
    const norm = normalizeProgram(node);
    if (norm) acc.push({ raw: node, norm });
    for (const key of Object.keys(node)) {
      const v = node[key];
      if (v && typeof v === 'object') collectPrograms(v, acc);
    }
  }
}

async function main() {
  // Zenderlijst (id -> naam), best effort.
  let channelMap = {};
  try {
    const channels = await getJSON('https://json.tvgids.nl/v4/channels');
    const list = Array.isArray(channels) ? channels : Object.values(channels);
    for (const c of list) {
      const id = pick(c, ['id', 'channel_id', 'code']);
      const name = pick(c, ['name', 'naam', 'title']);
      if (id !== undefined && name) channelMap[String(id)] = String(name);
    }
  } catch (e) {
    console.warn('Kon zenderlijst niet ophalen:', e.message);
  }

  // Programma's van vandaag en morgen (venster kan over middernacht lopen).
  const all = [];
  for (const day of [0, 1]) {
    try {
      const data = await getJSON(`https://json.tvgids.nl/v4/programs/?day=${day}`);
      collectPrograms(data, all);
    } catch (e) {
      console.warn(`Kon programma's voor dag ${day} niet ophalen:`, e.message);
    }
  }

  if (all.length === 0) {
    console.error('Geen programma-data ontvangen. tvgids.json blijft ongewijzigd.');
    process.exit(1);
  }

  const now = new Date();
  const windowEnd = new Date(now.getTime() + 2 * 60 * 60 * 1000);

  // Resolve channel naam.
  const byChannel = {};
  for (const { norm } of all) {
    let name = channelMap[String(norm.channel)] || norm.channel;
    if (name === undefined || name === null) continue;
    name = String(name);

    // Filter op gewenste zenders (case-insensitive, soepel).
    const match = WANTED.find(w => w.toLowerCase().replace(/\s/g, '') === name.toLowerCase().replace(/\s/g, ''));
    if (!match) continue;

    // Binnen het venster van komende 2 uur (programma loopt nog of begint zo).
    const endOk = norm.end ? norm.end > now : true;
    const startOk = norm.start < windowEnd;
    if (!(endOk && startOk)) continue;

    (byChannel[match] = byChannel[match] || []).push({
      title: norm.title,
      start: norm.start.toISOString(),
      end: norm.end ? norm.end.toISOString() : null,
    });
  }

  for (const k of Object.keys(byChannel)) {
    byChannel[k].sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  const output = {
    generated: now.toISOString(),
    windowHours: 2,
    channels: byChannel,
  };

  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`tvgids.json geschreven: ${Object.keys(byChannel).length} zenders.`);
}

main().catch(e => {
  console.error('Onverwachte fout:', e);
  process.exit(1);
});
