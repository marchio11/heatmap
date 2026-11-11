/* Heatmap — la mappa di calore della vita di tutti i giorni.
 * Legge i GPX di GPSLogger da Google Drive (o caricati a mano),
 * li salva nel browser (IndexedDB) e li disegna sulla mappa.
 * Nessun server: tutto avviene nel browser. */
'use strict';

const CONFIG = {
  clientId: '420044332179-nrbh6dcti0mst8qal370e2rlq5obqpb6.apps.googleusercontent.com',
  scope: 'https://www.googleapis.com/auth/drive.readonly',
  defaultFolder: 'GPSLogger',
  fallbackFolders: ['GPSLogger for Android'],
};

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

  const segments = [];
  const trksegs = doc.getElementsByTagName('trkseg');
  const groups = trksegs.length ? Array.from(trksegs) : [doc];

  for (const g of groups) {
    const pts = [];
    for (const el of g.getElementsByTagName('trkpt')) {
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
    segments.push(...splitSegment(pts));
  }
  return segments;
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
  let lo = 0, hi = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.mid === null) { km.walk += leg.d / 1000; continue; }
    while (lo < i && (legs[lo].mid === null || legs[lo].mid < leg.mid - MODE_WINDOW_MS)) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < legs.length && legs[hi + 1].mid !== null && legs[hi + 1].mid <= leg.mid + MODE_WINDOW_MS) hi++;
    const speeds = [];
    for (let j = lo; j <= hi; j++) if (legs[j].v !== null) speeds.push(legs[j].v);
    speeds.sort((x, y) => x - y);
    const p90 = speeds[Math.floor(0.9 * (speeds.length - 1))] || 0;
    km[p90 > VEHICLE_KMH ? 'vehicle' : 'walk'] += leg.d / 1000;
  }
  return km;
}

/* ---------------- Indice dei dati ---------------- */

let allSegments = [];

function buildIndex(records) {
  const segs = [];
  for (const rec of records) {
    const fromName = /(\d{4})(\d{2})(\d{2})/.exec(rec.name);
    for (const pts of rec.segments) {
      let day;
      if (pts[0][2] !== null) {
        const d = new Date(pts[0][2]);
        day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      } else if (fromName) {
        day = `${fromName[1]}-${fromName[2]}-${fromName[3]}`;
      } else {
        day = 'senza data';
      }
      let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
      for (const p of pts) {
        if (p[0] < minLat) minLat = p[0];
        if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLon) minLon = p[1];
        if (p[1] > maxLon) maxLon = p[1];
      }
      segs.push({
        pts,
        day,
        year: day.slice(0, 4),
        bbox: [minLat, minLon, maxLat, maxLon],
        km: classify(pts),
      });
    }
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
      for (const p of seg.pts) {
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
L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
  subdomains: 'abcd',
  maxZoom: 20,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>',
}).addTo(map);
const heat = new HeatLayer().addTo(map);

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
}

$('year').addEventListener('change', () => { store.set('year', $('year').value); render(true); });
$('toggle').addEventListener('click', () => $('panel').classList.toggle('collapsed'));

const folderInput = $('folder');
folderInput.value = store.get('folder', CONFIG.defaultFolder);
folderInput.addEventListener('change', () => store.set('folder', folderInput.value.trim() || CONFIG.defaultFolder));

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
  if (saved && saved.exp > Date.now() + 60000) token = saved;
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
      token = { value: resp.access_token, exp: Date.now() + resp.expires_in * 1000 };
      try { sessionStorage.setItem('gtoken', JSON.stringify(token)); } catch { /* ignora */ }
      resolve(token.value);
    };
    tokenClient.error_callback = (err) => reject(new Error(err?.type === 'popup_closed' ? 'Accesso annullato.' : 'Accesso non riuscito.'));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

async function drive(path, params, asText) {
  const url = new URL('https://www.googleapis.com/drive/v3/' + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token.value } });
  if (res.status === 401) {
    token = null;
    try { sessionStorage.removeItem('gtoken'); } catch { /* ignora */ }
    throw new Error('Sessione Google scaduta: premi di nuovo il pulsante.');
  }
  if (!res.ok) throw new Error(`Errore Drive (${res.status})`);
  return asText ? res.text() : res.json();
}

async function listAll(q, fields) {
  const out = [];
  let pageToken = '';
  do {
    const params = { q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces: 'drive' };
    if (pageToken) params.pageToken = pageToken;
    const r = await drive('files', params);
    out.push(...r.files);
    pageToken = r.nextPageToken || '';
  } while (pageToken);
  return out;
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
      return !r || r.source !== 'drive' || r.modifiedTime !== f.modifiedTime;
    });

    let done = 0, bad = 0;
    const worker = async () => {
      while (todo.length) {
        const f = todo.shift();
        try {
          const text = await drive('files/' + f.id, { alt: 'media' }, true);
          await DB.put({ name: f.name, source: 'drive', modifiedTime: f.modifiedTime, segments: parseGpx(text) });
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
