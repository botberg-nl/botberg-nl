// Haalt de Nederlandse TV-gids op door tvgids.nl/gids/{zender} te scrapen
// (zelfde aanpak als de iptv-org/epg grabber) en schrijft tvgids.json met de
// programma's voor de komende 2 uur op een set hoofdzenders.
//
// Draait server-side in een GitHub Action, dus geen CORS-beperkingen.
// Bij een fout blijft een bestaand tvgids.json staan (script eindigt met code 1
// zonder te schrijven), zodat de site nooit zonder data komt te zitten.

const fs = require('fs');
const cheerio = require('cheerio');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = 'Europe/Amsterdam';
const OUT = 'tvgids.json';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const CHANNELS = [
  { site_id: 'npo1', name: 'NPO 1' },
  { site_id: 'npo2', name: 'NPO 2' },
  { site_id: 'npo3', name: 'NPO 3' },
  { site_id: 'rtl4', name: 'RTL 4' },
  { site_id: 'rtl5', name: 'RTL 5' },
  { site_id: 'rtl7', name: 'RTL 7' },
  { site_id: 'rtl8', name: 'RTL 8' },
  { site_id: 'sbs6', name: 'SBS 6' },
  { site_id: 'net5', name: 'NET 5' },
  { site_id: 'veronica', name: 'Veronica' },
];

async function getHTML(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, 'Accept-Language': 'nl-NL,nl;q=0.9' },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

// Koppel "HH:mm" aan de dag (gisteren/vandaag/morgen) die het dichtst bij nu ligt.
// Robuust voor een gids die over middernacht loopt; voor het venster van 2 uur
// rond nu levert dit altijd de juiste absolute datum op.
function anchor(timeStr, now) {
  const [h, m] = timeStr.split(':').map(Number);
  let best = null;
  let bestDiff = Infinity;
  for (const off of [-1, 0, 1]) {
    const cand = now.startOf('day').add(off, 'day').hour(h).minute(m).second(0).millisecond(0);
    const diff = Math.abs(cand.diff(now));
    if (diff < bestDiff) {
      bestDiff = diff;
      best = cand;
    }
  }
  return best;
}

// Haalt alle (titel, starttijd) uit een gidspagina.
function parseTimes(html) {
  const $ = cheerio.load(html);
  const out = [];
  $('.guide__guide .program').each((i, el) => {
    const $el = $(el);
    const title = $el.find('.program__title').text().trim();
    const time = $el.find('.program__starttime').clone().children().remove().end().text().trim();
    if (title && /^\d{1,2}:\d{2}$/.test(time)) out.push({ title, time });
  });
  return out;
}

async function fetchChannel(ch, now, tomorrowPath) {
  const raw = [];
  // Vandaag (zonder datum-pad) en morgen (met datum-pad) voor dekking rond middernacht.
  const urls = [
    `https://www.tvgids.nl/gids/${ch.site_id}`,
    `https://www.tvgids.nl/gids/${tomorrowPath}/${ch.site_id}`,
  ];
  for (const url of urls) {
    try {
      const html = await getHTML(url);
      raw.push(...parseTimes(html));
    } catch (e) {
      console.warn(`${ch.name}: ${url} faalde: ${e.message}`);
    }
  }

  // Anker elke tijd op de dichtstbijzijnde dag, ontdubbel en sorteer.
  const seen = new Set();
  const progs = [];
  for (const { title, time } of raw) {
    const start = anchor(time, now);
    const key = start.valueOf() + '|' + title;
    if (seen.has(key)) continue;
    seen.add(key);
    progs.push({ title, start });
  }
  progs.sort((a, b) => a.start.valueOf() - b.start.valueOf());
  for (let i = 0; i < progs.length; i++) {
    progs[i].stop = progs[i + 1] ? progs[i + 1].start : progs[i].start.add(30, 'minute');
  }
  return progs;
}

async function main() {
  const now = dayjs().tz(TZ);
  const windowEnd = now.add(2, 'hour');
  const tomorrowPath = now.add(1, 'day').format('DD-MM-YYYY');

  const channels = {};
  let totalKept = 0;

  for (const ch of CHANNELS) {
    let progs = [];
    try {
      progs = await fetchChannel(ch, now, tomorrowPath);
    } catch (e) {
      console.warn(`${ch.name}: ${e.message}`);
    }
    // Houd programma's die nog lopen of binnen 2 uur beginnen.
    const kept = progs.filter(p => p.stop.isAfter(now) && p.start.isBefore(windowEnd));
    channels[ch.name] = kept.map(p => ({
      title: p.title,
      start: p.start.utc().toISOString(),
      end: p.stop.utc().toISOString(),
    }));
    totalKept += kept.length;
  }

  if (totalKept === 0) {
    console.error('Geen programma-data gevonden. tvgids.json blijft ongewijzigd.');
    process.exit(1);
  }

  const output = { generated: now.utc().toISOString(), windowHours: 2, channels };
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`tvgids.json geschreven: ${totalKept} programma's over ${CHANNELS.length} zenders.`);
}

main().catch(e => {
  console.error('Onverwachte fout:', e);
  process.exit(1);
});
