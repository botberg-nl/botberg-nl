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
const customParseFormat = require('dayjs/plugin/customParseFormat');
dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const TZ = 'Europe/Amsterdam';
const OUT = 'tvgids.json';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Zenders: site_id zoals tvgids.nl ze gebruikt + weergavenaam.
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

// Parseert een gidspagina voor 1 dag. dateBase = dayjs (Europe/Amsterdam) van die dag.
function parseDay(html, dateBase) {
  const $ = cheerio.load(html);
  const items = $('.guide__guide .program').toArray();
  const progs = [];
  let date = dateBase;
  let prevStart = null;

  for (const el of items) {
    const $el = $(el);
    const title = $el.find('.program__title').text().trim();
    const time = $el.find('.program__starttime').clone().children().remove().end().text().trim();
    if (!title || !/^\d{1,2}:\d{2}$/.test(time)) continue;

    let start = dayjs.tz(`${date.format('YYYY-MM-DD')} ${time}`, 'YYYY-MM-DD HH:mm', TZ);
    // Loopt de lijst over middernacht? Dan volgende dag.
    if (prevStart && start.isBefore(prevStart)) {
      date = date.add(1, 'day');
      start = start.add(1, 'day');
    }
    prevStart = start;
    progs.push({ title, start });
  }
  return progs;
}

async function fetchChannel(ch, today, tomorrow) {
  const all = [];
  // Pagina van vandaag (zonder datum-pad) en morgen (met datum-pad).
  const urls = [
    { url: `https://www.tvgids.nl/gids/${ch.site_id}`, date: today },
    { url: `https://www.tvgids.nl/gids/${tomorrow.format('DD-MM-YYYY')}/${ch.site_id}`, date: tomorrow },
  ];
  for (const { url, date } of urls) {
    try {
      const html = await getHTML(url);
      all.push(...parseDay(html, date));
    } catch (e) {
      console.warn(`${ch.name}: ${url} faalde: ${e.message}`);
    }
  }
  // Sorteer en bepaal eindtijd = start van volgende programma.
  all.sort((a, b) => a.start.valueOf() - b.start.valueOf());
  for (let i = 0; i < all.length; i++) {
    all[i].stop = all[i + 1] ? all[i + 1].start : all[i].start.add(30, 'minute');
  }
  return all;
}

async function main() {
  const now = dayjs().tz(TZ);
  const windowEnd = now.add(2, 'hour');
  const today = now.startOf('day');
  const tomorrow = today.add(1, 'day');

  const channels = {};
  let totalKept = 0;

  for (const ch of CHANNELS) {
    let progs = [];
    try {
      progs = await fetchChannel(ch, today, tomorrow);
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

  const output = {
    generated: now.utc().toISOString(),
    windowHours: 2,
    channels,
  };
  fs.writeFileSync(OUT, JSON.stringify(output, null, 2));
  console.log(`tvgids.json geschreven: ${totalKept} programma's over ${CHANNELS.length} zenders.`);
}

main().catch(e => {
  console.error('Onverwachte fout:', e);
  process.exit(1);
});
