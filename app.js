/* Heatmap — la mappa di calore della vita di tutti i giorni.
 * Legge i GPX di GPSLogger da Google Drive (o caricati a mano),
 * li salva nel browser (IndexedDB) e li disegna sulla mappa.
 * Nessun server: tutto avviene nel browser. */
'use strict';

const CONFIG = {
  clientId: '420044332179-nrbh6dcti0mst8qal370e2rlq5obqpb6.apps.googleusercontent.com',
  // lettura di Drive + cartella nascosta dell'app (dove condividiamo i percorsi già agganciati)
  scope: 'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata',
  defaultFolder: 'GPSLogger',
  fallbackFolders: ['GPSLogger for Android'],
};

// Versione della lettura dei GPX: se cambia, i file vengono riletti da Drive
const PARSE_VERSION = 2;
// Pulizia tracce
const GAP_SPLIT_S = 5 * 60;   // oltre 5 minuti senza punti la traccia si interrompe
const MAX_JUMP_KMH = 250;     // salti più veloci di così sono errori del GPS
// Piedi / veicolo
const VEHICLE_KMH = 25;       // sopra questa velocità "di punta" è un veicolo
const MODE_WINDOW_MS = 3 * 60 * 1000; // finestra di ±3 minuti per decidere
// Disegno
const STEP = 6;               // intensità aggiunta da ogni passaggio (0-255)
const MAX_PASSES = 40;        // passaggi oltre i quali la strada è "bianca"

/* ---------------- Utilità ---------------- */

const $ = (id) => document.getElementById(id);

function haversine(a, b) {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLon = (b[1] - a[1]) * toRad;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
}

function fmtKm(km) {
  return km.toLocaleString('it-IT', { maximumFractionDigits: km < 100 ? 1 : 0 }) + ' km';
}

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignora */ } },
};

/* ---------------- Archivio locale (IndexedDB) ---------------- */

const DB = {
  _db: null,
  _mem: new Map(), // ripiego se IndexedDB non è disponibile
  async open() {
    if (this._db) return this._db;
    this._db = await new Promise((resolve) => {
      try {
        const req = indexedDB.open('heatmap', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('files', { keyPath: 'name' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
    return this._db;
  },
  async _tx(mode, fn) {
    const db = await this.open();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('files', mode);
      const req = fn(tx.objectStore('files'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  },
  async all() {
    const r = await this._tx('readonly', (s) => s ? s.getAll() : null);
    return r || [...this._mem.values()];
  },
  async get(name) {
    const r = await this._tx('readonly', (s) => s ? s.get(name) : null);
    return r || this._mem.get(name);
  },
  async put(rec) {
    this._mem.set(rec.name, rec);
    await this._tx('readwrite', (s) => s && s.put(rec));
  },
  async clear() {
    this._mem.clear();
    await this._tx('readwrite', (s) => s && s.clear());
  },
};

/* ---------------- Lettura GPX ---------------- */

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('GPX non valido');

  // GPSLogger apre un nuovo <trkseg> a ogni riavvio della registrazione: uniamo tutti i punti
  // e lasciamo decidere le interruzioni a splitSegment (pause lunghe o salti del GPS)
  const pts = [];
  for (const el of doc.getElementsByTagName('trkpt')) {
    const lat = parseFloat(el.getAttribute('lat'));
    const lon = parseFloat(el.getAttribute('lon'));
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const timeEl = el.getElementsByTagName('time')[0];
    const eleEl = el.getElementsByTagName('ele')[0];
    const t = timeEl ? Date.parse(timeEl.textContent) : NaN;
    const ele = eleEl ? parseFloat(eleEl.textContent) : NaN;
    pts.push([
      Math.round(lat * 1e6) / 1e6,
      Math.round(lon * 1e6) / 1e6,
      isFinite(t) ? t : null,
      isFinite(ele) ? Math.round(ele * 10) / 10 : null,
    ]);
  }
  if (pts.length && pts.every((p) => p[2] !== null)) pts.sort((a, b) => a[2] - b[2]);
  return splitSegment(pts);
}

// Divide la traccia dove ci sono pause lunghe o salti impossibili del GPS.
function splitSegment(pts) {
  const out = [];
  let cur = [];
  for (const p of pts) {
    const prev = cur[cur.length - 1];
    if (prev && p[2] !== null && prev[2] !== null) {
      const dt = (p[2] - prev[2]) / 1000;
      const kmh = dt > 0 ? haversine(prev, p) / dt * 3.6 : 0;
      if (dt > GAP_SPLIT_S || kmh > MAX_JUMP_KMH) {
        if (cur.length >= 2) out.push(cur);
        cur = [];
      }
    }
    cur.push(p);
  }
  if (cur.length >= 2) out.push(cur);
  return out;
}

/* ---------------- Analisi: piedi / veicolo ---------------- */

// Per ogni tratto guarda le velocità dei ±3 minuti intorno e ne prende il 90° percentile:
// sopra i 25 km/h è un veicolo, altrimenti a piedi (corsa e sprint compresi).
function classify(pts) {
  const legs = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const d = haversine(a, b);
    const dt = a[2] !== null && b[2] !== null ? (b[2] - a[2]) / 1000 : 0;
    legs.push({ d, v: dt > 0 ? d / dt * 3.6 : null, mid: dt > 0 ? (a[2] + b[2]) / 2 : null });
  }
  const km = { walk: 0, vehicle: 0 };
  const modes = []; // per ogni tratto: 'w' a piedi, 'v' veicolo
  let lo = 0, hi = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.mid === null) { km.walk += leg.d / 1000; modes.push('w'); continue; }
    while (lo < i && (legs[lo].mid === null || legs[lo].mid < leg.mid - MODE_WINDOW_MS)) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < legs.length && legs[hi + 1].mid !== null && legs[hi + 1].mid <= leg.mid + MODE_WINDOW_MS) hi++;
    const speeds = [];
    for (let j = lo; j <= hi; j++) if (legs[j].v !== null) speeds.push(legs[j].v);
    speeds.sort((x, y) => x - y);
    const p90 = speeds[Math.floor(0.9 * (speeds.length - 1))] || 0;
    const isVehicle = p90 > VEHICLE_KMH;
    km[isVehicle ? 'vehicle' : 'walk'] += leg.d / 1000;
    modes.push(isVehicle ? 'v' : 'w');
  }
  return { km, modes };
}

// Gruppi consecutivi di tratti in veicolo, come indici dei punti [i0, i1]
function vehicleRuns(modes) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= modes.length; i++) {
    const v = modes[i] === 'v';
    if (v && start < 0) start = i;
    if (!v && start >= 0) {
      if (i - start >= 2) runs.push([start, i]); // almeno 3 punti
      start = -1;
    }
  }
  return runs;
}

function pathLength(pts, i0 = 0, i1 = pts.length - 1) {
  let d = 0;
  for (let i = i0 + 1; i <= i1; i++) d += haversine(pts[i - 1], pts[i]);
  return d;
}

/* ---------------- Aggancio alle strade (map matching) ---------------- */

// Server pubblico e gratuito di OSRM (motore di navigazione basato su OpenStreetMap).
// Riceve solo le coordinate dei tratti in veicolo, una volta sola: il risultato resta nel browser.
const OSRM_URL = 'https://router.project-osrm.org/match/v1/driving/';
const MATCH_VERSION = 2;
const MATCH_CHUNK = 90;   // il server accetta al massimo 100 punti per richiesta
// metri di tolleranza intorno a ogni punto GPS: se un punto è troppo lontano da strade percorribili
// in auto (parcheggi o strade private) il server rifiuta tutto, quindi si riprova allargando
const MATCH_RADII = [35, 70, 100];

const snapEnabled = () => store.get('snap', '1') === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function matchChunk(chunk) {
  // i tempi devono essere strettamente crescenti
  const pts = chunk.filter((p, i) => i === 0 || p[2] === null || chunk[i - 1][2] === null || p[2] - chunk[i - 1][2] >= 1000);
  if (pts.length < 2) return null;
  for (let k = 0; k < MATCH_RADII.length; k++) {
    if (k) await sleep(1100);
    const r = await osrmMatch(pts, MATCH_RADII[k]);
    if (r !== 'retry') return r;
  }
  return null;
}

async function osrmMatch(pts, radius) {
  const params = new URLSearchParams({
    overview: 'full',
    geometries: 'geojson',
    gaps: 'ignore',
    tidy: 'true',
    radiuses: pts.map(() => radius).join(';'),
  });
  if (pts.every((p) => p[2] !== null)) params.set('timestamps', pts.map((p) => Math.round(p[2] / 1000)).join(';'));
  const url = OSRM_URL + pts.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';') + '?' + params;

  const res = await fetch(url);
  let json = null;
  try { json = await res.json(); } catch { /* risposta non JSON */ }
  if (json && json.code === 'Ok' && json.matchings?.length) {
    const coords = [];
    let dist = 0;
    for (const m of json.matchings) {
      for (const [lon, lat] of m.geometry.coordinates) coords.push([lat, lon]);
      dist += m.distance;
    }
    // risultato poco credibile (giri strani molto più lunghi della traccia): meglio la traccia originale
    if (dist > 2 * pathLength(pts) + 500) return null;
    return coords;
  }
  if (json && json.code === 'NoSegment') return 'retry';
  if (json && /^(NoMatch|TooBig|InvalidInput|InvalidValue)$/.test(json.code)) return null;
  throw new Error('Server delle strade non disponibile');
}

async function matchRun(pts) {
  const out = [];
  let matchedAny = false;
  for (let s = 0; s < pts.length - 1; s += MATCH_CHUNK - 1) {
    const chunk = pts.slice(s, s + MATCH_CHUNK);
    const coords = await matchChunk(chunk);
    await sleep(1100); // massimo una richiesta al secondo, come chiede il server
    const piece = coords || chunk.map((p) => [p[0], p[1]]);
    if (coords) matchedAny = true;
    out.push(...(out.length ? piece.slice(1) : piece));
  }
  return matchedAny ? out : null;
}

let matching = false;

async function matchPending() {
  if (matching || !snapEnabled()) return;
  matching = true;
  let worked = false;
  try {
    for (;;) {
      const todo = (await DB.all()).filter((r) => !r.match || r.match.v !== MATCH_VERSION);
      if (!todo.length) break;
      worked = true;
      let done = 0;
      for (const rec of todo) {
        setStatus(`Aggancio i percorsi in auto alle strade… ${++done}/${todo.length}`);
        const segs = [];
        for (const pts of rec.segments) {
          const runs = [];
          for (const [i0, i1] of vehicleRuns(classify(pts).modes)) {
            const coords = await matchRun(pts.slice(i0, i1 + 1));
            runs.push({ i0, i1, coords, dist: coords ? pathLength(coords) : null });
          }
          segs.push(runs);
        }
        // salva solo se nel frattempo il file non è stato aggiornato
        const fresh = await DB.get(rec.name);
        if (fresh && fresh.modifiedTime === rec.modifiedTime) {
          fresh.match = { v: MATCH_VERSION, segs };
          await DB.put(fresh);
          if (fresh.source === 'drive') store.set('cacheDirty', '1');
        }
        buildIndex(await DB.all());
        render(false);
        fillElevations();
      }
    }
    if (worked) setStatus('Percorsi in auto agganciati alle strade.');
    if (store.get('cacheDirty', '0') === '1' && canUseAppData()) {
      try { await uploadCache(); } catch { /* riprova alla prossima sincronizzazione */ }
    }
  } catch (err) {
    setStatus('Aggancio alle strade non riuscito ora, riproverò più tardi.', true);
  } finally {
    matching = false;
  }
}

/* ---------------- Indice dei dati ---------------- */

let allSegments = [];

function buildIndex(records) {
  const segs = [];
  for (const rec of records) {
    const fromName = /(\d{4})(\d{2})(\d{2})/.exec(rec.name);
    const matched = snapEnabled() && rec.match && rec.match.v === MATCH_VERSION ? rec.match.segs : null;
    rec.segments.forEach((pts, k) => {
      let day;
      if (pts[0][2] !== null) {
        const d = new Date(pts[0][2]);
        day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } else if (fromName) {
        day = `${fromName[1]}-${fromName[2]}-${fromName[3]}`;
      } else {
        day = 'senza data';
      }
      const { km } = classify(pts);
      let path = pts;
      const runs = matched && matched[k];
      if (runs && runs.length) {
        // i tratti in veicolo agganciati alle strade sostituiscono quelli GPS
        path = [];
        let i = 0;
        for (const r of runs) {
          while (i < r.i0) path.push(pts[i++]);
          if (r.coords) {
            path.push(...r.coords);
            km.vehicle += (r.dist - pathLength(pts, r.i0, r.i1)) / 1000;
          } else {
            for (let j = r.i0; j <= r.i1; j++) path.push(pts[j]);
          }
          i = r.i1 + 1;
        }
        while (i < pts.length) path.push(pts[i++]);
      }
      let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
      for (const p of path) {
        if (p[0] < minLat) minLat = p[0];
        if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLon) minLon = p[1];
        if (p[1] > maxLon) maxLon = p[1];
      }
      segs.push({
        path,
        day,
        year: day.slice(0, 4),
        bbox: [minLat, minLon, maxLat, maxLon],
        km,
      });
    });
  }
  allSegments = segs;
}

/* ---------------- Livello heatmap ---------------- */

// Tavolozza: viola tenue → rosso → arancio → giallo → bianco
const PALETTE = [
  [0.00, 80, 30, 150, 0.30],
  [0.15, 150, 40, 210, 0.70],
  [0.35, 255, 50, 80, 0.90],
  [0.60, 255, 140, 30, 1.00],
  [0.85, 255, 228, 80, 1.00],
  [1.00, 255, 255, 255, 1.00],
];

const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 4);
  for (let v = 1; v < 256; v++) {
    const passes = v / STEP;
    const t = Math.min(1, Math.log1p(passes) / Math.log1p(MAX_PASSES));
    let k = 0;
    while (k < PALETTE.length - 2 && t > PALETTE[k + 1][0]) k++;
    const a = PALETTE[k], b = PALETTE[k + 1];
    const f = Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0])));
    const fade = Math.min(1, passes); // i bordi sfumati restano tenui
    lut[v * 4] = a[1] + (b[1] - a[1]) * f;
    lut[v * 4 + 1] = a[2] + (b[2] - a[2]) * f;
    lut[v * 4 + 2] = a[3] + (b[3] - a[3]) * f;
    lut[v * 4 + 3] = 255 * (a[4] + (b[4] - a[4]) * f) * fade;
  }
  return lut;
})();

const HeatLayer = L.Layer.extend({
  initialize() { this._segs = []; },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create('canvas', 'heat-canvas leaflet-zoom-hide');
    this._acc = document.createElement('canvas');
    map.getPanes().overlayPane.appendChild(this._canvas);
    map.on('moveend resize', this._reset, this);
    this._reset();
  },

  onRemove(map) {
    map.off('moveend resize', this._reset, this);
    L.DomUtil.remove(this._canvas);
  },

  setSegments(segs) {
    this._segs = segs;
    if (this._map) this._reset();
  },

  _reset() {
    const map = this._map;
    const size = map.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
    for (const c of [this._canvas, this._acc]) {
      c.width = Math.round(size.x * dpr);
      c.height = Math.round(size.y * dpr);
    }
    this._canvas.style.width = size.x + 'px';
    this._canvas.style.height = size.y + 'px';
    this._draw(dpr);
  },

  _draw(dpr) {
    const map = this._map;
    const W = this._acc.width, H = this._acc.height;
    const out = this._canvas.getContext('2d');
    out.clearRect(0, 0, W, H);
    if (!this._segs.length || !W || !H) return;

    // 1) ogni traccia aggiunge "luce" in modo additivo
    const acc = this._acc.getContext('2d', { willReadFrequently: true });
    acc.globalCompositeOperation = 'source-over';
    acc.fillStyle = '#000';
    acc.fillRect(0, 0, W, H);
    acc.globalCompositeOperation = 'lighter';
    acc.strokeStyle = `rgb(${STEP},${STEP},${STEP})`;
    const z = map.getZoom();
    acc.lineWidth = (z >= 16 ? 3 : z >= 13 ? 2.2 : 1.6) * dpr;
    acc.lineJoin = 'round';
    acc.lineCap = 'round';

    const b = map.getBounds().pad(0.05);
    const s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();

    for (const seg of this._segs) {
      const [minLat, minLon, maxLat, maxLon] = seg.bbox;
      if (maxLat < s || minLat > n || maxLon < w || minLon > e) continue;
      acc.beginPath();
      let lx = null, ly = null;
      for (const p of seg.path) {
        const pt = map.latLngToContainerPoint([p[0], p[1]]);
        const x = pt.x * dpr, y = pt.y * dpr;
        if (lx === null) acc.moveTo(x, y);
        else if (Math.abs(x - lx) + Math.abs(y - ly) >= 1) acc.lineTo(x, y);
        else continue;
        lx = x; ly = y;
      }
      acc.stroke();
    }

    // 2) l'intensità accumulata diventa colore
    const src = acc.getImageData(0, 0, W, H).data;
    const img = out.createImageData(W, H);
    const dst = img.data;
    for (let i = 0; i < src.length; i += 4) {
      const v = src[i];
      if (!v) continue;
      const o = v * 4;
      dst[i] = LUT[o];
      dst[i + 1] = LUT[o + 1];
      dst[i + 2] = LUT[o + 2];
      dst[i + 3] = LUT[o + 3];
    }
    out.putImageData(img, 0, 0);
  },
});

/* ---------------- Mappa e interfaccia ---------------- */

const map = L.map('map', { zoomControl: false, worldCopyJump: true }).setView([42.5, 12.5], 6);
L.control.zoom({ position: 'bottomright' }).addTo(map);
// Mappa standard di OpenStreetMap (gratuita, senza chiave), scurita via CSS (.dark-tiles)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  className: 'dark-tiles',
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map);
const heat = new HeatLayer().addTo(map);

/* ---------------- Record: punto più alto e più lontano da casa ---------------- */

// Le quote arrivano dal modello del terreno Copernicus tramite Open-Meteo (gratis, senza chiave):
// più affidabili dell'altitudine GPS. Ogni "cella" di circa 50 m viene chiesta una volta sola.
const ELEV_CELL = 2000;
const cellKey = (p) => Math.round(p[0] * ELEV_CELL) + ',' + Math.round(p[1] * ELEV_CELL);
let elevCache = {};
try { elevCache = JSON.parse(store.get('elev', '{}')) || {}; } catch { elevCache = {}; }
let elevBusy = false;

async function fillElevations() {
  if (elevBusy) return;
  elevBusy = true;
  try {
    const missing = new Map();
    for (const seg of allSegments) {
      for (const p of seg.path) {
        const k = cellKey(p);
        if (!(k in elevCache) && !missing.has(k)) missing.set(k, p);
      }
    }
    const list = [...missing.entries()];
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100);
      const url = 'https://api.open-meteo.com/v1/elevation?latitude=' +
        batch.map(([, p]) => p[0].toFixed(5)).join(',') + '&longitude=' +
        batch.map(([, p]) => p[1].toFixed(5)).join(',');
      const res = await fetch(url);
      if (!res.ok) throw new Error('quote non disponibili');
      const json = await res.json();
      batch.forEach(([k], n) => {
        const e = json.elevation && json.elevation[n];
        if (typeof e === 'number' && isFinite(e)) elevCache[k] = Math.round(e);
      });
      store.set('elev', JSON.stringify(elevCache));
      if (list.length > 300) setStatus(`Calcolo le quote… ${Math.min(i + 100, list.length)}/${list.length}`);
      await sleep(250);
    }
    if (list.length) renderRecords();
  } catch { /* riprova alla prossima apertura */ } finally {
    elevBusy = false;
  }
}

function getHome() {
  try {
    const h = JSON.parse(store.get('home', 'null'));
    return Array.isArray(h) && h.length === 2 ? h : null;
  } catch { return null; }
}

function setHome(latlng, share = true) {
  store.set('home', JSON.stringify([+latlng[0].toFixed(5), +latlng[1].toFixed(5)]));
  renderRecords();
  if (share) {
    store.set('cacheDirty', '1');
    if (canUseAppData()) uploadCache().catch(() => {});
  }
}

const recLayer = L.layerGroup().addTo(map);
const recPoints = { high: null, far: null };
const emojiIcon = (e) => L.divIcon({ className: 'rec-icon', html: e, iconSize: [30, 30], iconAnchor: [15, 15] });
const fmtDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? new Date(d + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' }) : d;

function renderRecords() {
  recLayer.clearLayers();
  const home = getHome();
  let high = null, far = null;
  for (const seg of currentSegments()) {
    for (const p of seg.path) {
      const e = elevCache[cellKey(p)];
      if (e !== undefined && (!high || e > high.e)) high = { e, p, day: seg.day };
      if (home) {
        const d = haversine(home, p);
        if (!far || d > far.d) far = { d, p, day: seg.day };
      }
    }
  }
  recPoints.high = high;
  recPoints.far = far;

  $('high').textContent = high ? high.e.toLocaleString('it-IT') + ' m' : '–';
  $('far').textContent = !home ? 'imposta casa' : far ? fmtKm(far.d / 1000) : '–';

  if (home) {
    L.marker(home, { icon: emojiIcon('🏠'), keyboard: false }).bindTooltip('Casa').addTo(recLayer);
  }
  if (far && far.d > 200) {
    L.marker([far.p[0], far.p[1]], { icon: emojiIcon('📍') })
      .bindTooltip(`Il punto più lontano da casa: ${fmtKm(far.d / 1000)}<br>${fmtDay(far.day)}`).addTo(recLayer);
  }
  if (high) {
    L.marker([high.p[0], high.p[1]], { icon: emojiIcon('⛰️') })
      .bindTooltip(`Il punto più alto: ${high.e.toLocaleString('it-IT')} m s.l.m.<br>${fmtDay(high.day)}`).addTo(recLayer);
  }
}

function goTo(rec) {
  if (!rec) return;
  map.setView([rec.p[0], rec.p[1]], Math.max(map.getZoom(), 14));
  if (window.innerWidth <= 600) $('panel').classList.add('collapsed');
}
$('recHigh').addEventListener('click', () => goTo(recPoints.high));
$('recFar').addEventListener('click', () => {
  if (!getHome()) return pickHome();
  goTo(recPoints.far);
});

function pickHome() {
  setStatus('Tocca la mappa nel punto in cui si trova casa tua.');
  document.body.classList.add('picking');
  if (window.innerWidth <= 600) $('panel').classList.add('collapsed');
  map.once('click', (e) => {
    document.body.classList.remove('picking');
    setHome([e.latlng.lat, e.latlng.lng]);
    setStatus('Casa impostata 🏠');
  });
}
$('setHome').addEventListener('click', pickHome);

function currentSegments() {
  const y = $('year').value;
  return y === 'all' ? allSegments : allSegments.filter((s) => s.year === y);
}

function refreshYears() {
  const sel = $('year');
  const prev = store.get('year', '');
  const years = [...new Set(allSegments.map((s) => s.year))].sort().reverse();
  sel.innerHTML = '';
  for (const y of years) sel.add(new Option(y === 'senz' ? 'Senza data' : y, y));
  sel.add(new Option('Tutti gli anni', 'all'));
  const thisYear = String(new Date().getFullYear());
  sel.value = [prev, thisYear, years[0], 'all'].find((v) => v && [...sel.options].some((o) => o.value === v));
}

function render(fit) {
  const segs = currentSegments();
  heat.setSegments(segs);

  let walk = 0, vehicle = 0;
  const days = new Set();
  for (const s of segs) { walk += s.km.walk; vehicle += s.km.vehicle; days.add(s.day); }
  $('kmWalk').textContent = segs.length ? fmtKm(walk) : '–';
  $('kmVehicle').textContent = segs.length ? fmtKm(vehicle) : '–';
  $('days').textContent = segs.length ? days.size : '–';
  renderRecords();

  if (fit && segs.length) {
    let b = null;
    for (const s of segs) {
      const sb = L.latLngBounds([s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]);
      b = b ? b.extend(sb) : sb;
    }
    map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
  }
}

async function reloadFromDb(fit) {
  buildIndex(await DB.all());
  refreshYears();
  render(fit);
  matchPending();
  fillElevations();
}

$('year').addEventListener('change', () => { store.set('year', $('year').value); render(true); });
$('toggle').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

const folderInput = $('folder');
folderInput.value = store.get('folder', CONFIG.defaultFolder);
folderInput.addEventListener('change', () => store.set('folder', folderInput.value.trim() || CONFIG.defaultFolder));

const snapInput = $('snap');
snapInput.checked = snapEnabled();
snapInput.addEventListener('change', async () => {
  store.set('snap', snapInput.checked ? '1' : '0');
  await reloadFromDb(false);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Cancellare i dati salvati in questo browser? I file su Drive non vengono toccati.')) return;
  await DB.clear();
  await reloadFromDb(false);
  setStatus('Dati locali cancellati.');
});

/* ---------------- Caricamento manuale ---------------- */

async function importFiles(files) {
  let ok = 0, bad = 0;
  for (const f of files) {
    if (!/\.gpx$/i.test(f.name)) continue;
    try {
      const segments = parseGpx(await f.text());
      await DB.put({ name: f.name, source: 'local', modifiedTime: new Date(f.lastModified).toISOString(), segments });
      ok++;
    } catch { bad++; }
  }
  await reloadFromDb(true);
  setStatus(`Caricati ${ok} file` + (bad ? `, ${bad} non leggibili` : '') + '.', bad > 0 && ok === 0);
}

$('fileInput').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });

let dragDepth = 0;
window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('dragging'); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  importFiles([...e.dataTransfer.files]);
});

/* ---------------- Google Drive ---------------- */

let tokenClient = null;
let token = null;
try {
  const saved = JSON.parse(sessionStorage.getItem('gtoken') || 'null');
  if (saved && saved.exp > Date.now() + 60000 && saved.scope) token = saved;
} catch { /* ignora */ }

function getToken() {
  return new Promise((resolve, reject) => {
    if (token && token.exp > Date.now() + 60000) return resolve(token.value);
    if (!window.google?.accounts?.oauth2) return reject(new Error('Libreria Google non ancora caricata, riprova tra un attimo.'));
    if (!tokenClient) {
      tokenClient = google.accounts.oauth2.initTokenClient({ client_id: CONFIG.clientId, scope: CONFIG.scope, callback: () => {} });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error('Accesso non riuscito: ' + resp.error));
      token = { value: resp.access_token, exp: Date.now() + resp.expires_in * 1000, scope: resp.scope || '' };
      try { sessionStorage.setItem('gtoken', JSON.stringify(token)); } catch { /* ignora */ }
      resolve(token.value);
    };
    tokenClient.error_callback = (err) => reject(new Error(err?.type === 'popup_closed' ? 'Accesso annullato.' : 'Accesso non riuscito.'));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

const tokenValid = () => !!token && token.exp > Date.now() + 60000;
const canUseAppData = () => tokenValid() && /drive\.appdata/.test(token.scope);

async function drive(path, params, asText, opts = {}, base = 'https://www.googleapis.com/drive/v3/') {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token.value } });
  if (res.status === 401) {
    token = null;
    try { sessionStorage.removeItem('gtoken'); } catch { /* ignora */ }
    throw new Error('Sessione Google scaduta: premi di nuovo il pulsante.');
  }
  if (!res.ok) throw new Error(`Errore Drive (${res.status})`);
  return asText ? res.text() : res.json();
}

async function listAll(q, fields, spaces = 'drive') {
  const out = [];
  let pageToken = '';
  do {
    const params = { q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces };
    if (pageToken) params.pageToken = pageToken;
    const r = await drive('files', params);
    out.push(...r.files);
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
}

/* ---------- Percorsi agganciati condivisi tra dispositivi (cartella nascosta su Drive) ---------- */

const CACHE_NAME = 'match-cache.json';

async function findCacheFile() {
  const files = await listAll(`name = '${CACHE_NAME}' and trashed = false`, 'id,name', 'appDataFolder');
  return files[0] || null;
}

async function downloadCache(file) {
  if (!file) return { entries: {} };
  try {
    const data = JSON.parse(await drive('files/' + file.id, { alt: 'media' }, true));
    return data && data.entries ? data : { entries: {} };
  } catch { return { entries: {} }; }
}

// Usa i percorsi già agganciati da un altro dispositivo
async function applyRemoteCache() {
  if (!canUseAppData()) return 0;
  const cache = await downloadCache(await findCacheFile());
  if (!getHome() && Array.isArray(cache.home)) setHome(cache.home, false);
  let applied = 0;
  for (const rec of await DB.all()) {
    if (rec.source !== 'drive' || (rec.match && rec.match.v === MATCH_VERSION)) continue;
    const e = cache.entries[rec.name];
    if (e && e.v === MATCH_VERSION && e.modifiedTime === rec.modifiedTime) {
      rec.match = { v: e.v, segs: e.segs };
      await DB.put(rec);
      applied++;
    }
  }
  return applied;
}

// Salva su Drive i percorsi agganciati da questo dispositivo, unendoli a quelli già presenti
async function uploadCache() {
  if (!canUseAppData()) return;
  const file = await findCacheFile();
  const cache = await downloadCache(file);
  for (const rec of await DB.all()) {
    if (rec.source !== 'drive' || !rec.match || rec.match.v !== MATCH_VERSION) continue;
    cache.entries[rec.name] = { v: rec.match.v, modifiedTime: rec.modifiedTime, segs: rec.match.segs };
  }
  if (getHome()) cache.home = getHome();
  cache.updated = new Date().toISOString();
  const body = JSON.stringify(cache);
  const up = 'https://www.googleapis.com/upload/drive/v3/';
  if (file) {
    await drive('files/' + file.id, { uploadType: 'media' }, false,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body }, up);
  } else {
    const boundary = 'heatmap' + Math.random().toString(36).slice(2);
    const multipart =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: CACHE_NAME, parents: ['appDataFolder'] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` + body + `\r\n--${boundary}--`;
    await drive('files', { uploadType: 'multipart' }, false,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart }, up);
  }
  store.set('cacheDirty', '0');
}

async function syncDrive() {
  const btn = $('sync');
  btn.disabled = true;
  try {
    setStatus('Accesso a Google…');
    await getToken();
    btn.textContent = 'Sincronizza Drive';

    const names = [folderInput.value.trim() || CONFIG.defaultFolder, ...CONFIG.fallbackFolders];
    let folders = [];
    for (const name of names) {
      const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      folders = await listAll(`name = '${esc}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`, 'id,name');
      if (folders.length) break;
    }
    if (!folders.length) throw new Error(`Cartella "${names[0]}" non trovata su Drive.`);

    setStatus('Cerco i file GPX…');
    let files = [];
    for (const f of folders) {
      files.push(...await listAll(`'${f.id}' in parents and trashed = false and name contains '.gpx'`, 'id,name,modifiedTime'));
    }
    files = files.filter((f) => /\.gpx$/i.test(f.name));

    const known = new Map((await DB.all()).map((r) => [r.name, r]));
    const todo = files.filter((f) => {
      const r = known.get(f.name);
      return !r || r.source !== 'drive' || r.modifiedTime !== f.modifiedTime || r.pv !== PARSE_VERSION;
    });

    let done = 0, bad = 0;
    const worker = async () => {
      while (todo.length) {
        const f = todo.shift();
        try {
          const text = await drive('files/' + f.id, { alt: 'media' }, true);
          await DB.put({ name: f.name, source: 'drive', modifiedTime: f.modifiedTime, pv: PARSE_VERSION, segments: parseGpx(text) });
        } catch (err) {
          if (/Sessione Google scaduta/.test(err.message)) throw err;
          bad++;
        }
        done++;
        setStatus(`Scarico i file… ${done}/${done + todo.length}`);
      }
    };
    const total = todo.length;
    await Promise.all([worker(), worker(), worker(), worker()]);

    try { await applyRemoteCache(); } catch { /* si aggancia da qui */ }

    await reloadFromDb(total > 0);
    setStatus(`Sincronizzato: ${files.length} file su Drive, ${total} aggiornati` + (bad ? `, ${bad} con errori` : '') + '.');
    store.set('lastSync', new Date().toISOString());
  } catch (err) {
    setStatus(err.message || 'Errore durante la sincronizzazione.', true);
  } finally {
    btn.disabled = false;
  }
}

$('sync').addEventListener('click', syncDrive);

/* ---------------- Avvio ---------------- */

(async () => {
  await reloadFromDb(true);
  // sul telefono il pannello parte chiuso, così si vede la mappa
  if (allSegments.length && window.innerWidth <= 600) $('panel').classList.add('collapsed');
  if (!allSegments.length) setStatus('Accedi a Google Drive oppure trascina qui i tuoi file GPX.');
  if (token) {
    $('sync').textContent = 'Sincronizza Drive';
    // sessione ancora valida: sincronizza da solo quando la libreria Google è pronta
    const wait = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(wait); syncDrive(); }
    }, 300);
    setTimeout(() => clearInterval(wait), 10000);
  }
})();
