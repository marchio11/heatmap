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
const PARSE_VERSION = 7;
const APP_VERSION = '39';
// Heatlogger scrive nel GPX precisione, modo (act) e tipo di punto (kind)
const HL_NS = 'https://github.com/marchio11/heatlogger/gpx/1';
const MAX_ACC_M = 60;         // punti meno precisi di così non vengono disegnati
// Pulizia tracce
const GAP_SPLIT_S = 5 * 60;   // oltre 5 minuti senza punti la traccia si interrompe
const MAX_JUMP_KMH = 250;     // salti più veloci di così sono errori del GPS
const BRIDGE_MAX_S = 30 * 60; // ...ma un "silenzio" fino a 30 minuti percorso a velocità da veicolo
const BRIDGE_MIN_M = 1000;    // (gallerie, GPS assente) viene collegato e poi agganciato alla strada
const PARK_MAX_M = 500;       // sosta con l'auto: se prima e dopo ci si muoveva in veicolo e si riparte
const PARK_MAX_S = 12 * 3600; // a meno di 500 m da dove ci si era fermati, i punti restano collegati
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

let statusTimer = null;
function setStatus(msg, isError = false, keep = false) {
  const el = $('status');
  el.textContent = msg || '';
  el.classList.toggle('error', !!isError);
  // i messaggi di conferma spariscono da soli dopo qualche secondo, per tenere pulito il pannello
  clearTimeout(statusTimer);
  if (msg && !isError && !keep && !msg.endsWith('…')) statusTimer = setTimeout(() => { el.textContent = ''; }, 6000);
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
  async del(name) {
    this._mem.delete(name);
    await this._tx('readwrite', (s) => s && s.delete(name));
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
    // Estensioni di Heatlogger: precisione, modo di spostamento e tipo di punto
    const ext = (name) => el.getElementsByTagNameNS(HL_NS, name)[0]?.textContent?.trim() || null;
    const acc = parseFloat(ext('acc'));
    const kind = ext('kind');
    if (kind === 'heartbeat') continue;            // battito durante le pause: non è uno spostamento
    if (isFinite(acc) && acc > MAX_ACC_M) continue; // punto troppo impreciso per la mappa
    const spd = parseFloat(ext('spd'));
    pts.push([
      Math.round(lat * 1e6) / 1e6,
      Math.round(lon * 1e6) / 1e6,
      isFinite(t) ? t : null,
      isFinite(ele) ? Math.round(ele * 10) / 10 : null,
      ext('act'),
      isFinite(spd) ? Math.round(spd * 36) / 10 : null, // velocità misurata dal GPS, km/h
      isFinite(acc) ? acc : null,
    ]);
  }
  if (pts.length && pts.every((p) => p[2] !== null)) pts.sort((a, b) => a[2] - b[2]);
  return splitSegment(dedupClose(pts));
}

// Due punti a pochi secondi di distanza (Heatlogger ne chiede uno migliore quando il primo è
// impreciso): tengo il più preciso. Il rumore tra i due darebbe velocità assurde e falsi "salti".
const CLOSE_S = 8;
function dedupClose(pts) {
  const out = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && p[2] !== null && prev[2] !== null && p[2] - prev[2] < CLOSE_S * 1000) {
      if ((p[6] ?? 99) < (prev[6] ?? 99)) out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  // Punti "a zigzag": vanno e tornano di decine di metri e il punto dopo torna vicino a quello
  // prima (es. 17/11 a Pesaro, salti di 200 m avanti e indietro ogni 50 s)
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1], p = out[i], b = out[i + 1];
      if (p[5] !== null && p[5] > 15) continue; // il GPS dice che si va veloci: non è rumore
      if (a[2] === null || b[2] === null || b[2] - a[2] > 4 * 60 * 1000) continue;
      // Senza velocità misurata (GPSLogger) serve un salto più netto per essere sicuri
      const min = p[5] === null ? 60 : 40;
      const da = haversine(a, p), db = haversine(p, b), ab = haversine(a, b);
      if (da > min && db > min && ab < 0.5 * Math.min(da, db)) { out.splice(i, 1); changed = true; i--; }
    }
  }
  // "Escursioni" impossibili: da un punto la traccia salta lontano per 1-3 punti a una velocità
  // da corsa e poi torna lì vicino. A piedi è il GPS che rimbalza tra due posizioni (riflessi su
  // edifici e porto); un vero andare e tornare a passo d'uomo non supera i 9 km/h e resta.
  for (let i = 1; i < out.length - 1; i++) {
    const a = out[i - 1];
    if (a[2] === null) continue;
    for (let j = i; j < Math.min(i + 3, out.length - 1); j++) {
      const exc = out.slice(i, j + 1), b = out[j + 1];
      const first = out[i];
      const ok = first[2] > a[2] && haversine(a, first) / ((first[2] - a[2]) / 1000) * 3.6 > 9 &&
        exc.every((p) => p[2] !== null && (p[5] === null || p[5] <= 15) && haversine(a, p) > 60);
      if (!ok) break;
      const far = Math.min(...exc.map((p) => haversine(a, p)));
      if (b[2] !== null && b[2] - a[2] < 4 * 60 * 1000 && haversine(a, b) < Math.max(40, 0.4 * far)) {
        out.splice(i, j - i + 1);
        i--;
        break;
      }
    }
  }
  for (const p of out) p.length = 6; // la precisione serviva solo qui
  return out;
}

// Divide la traccia dove ci sono pause lunghe o salti impossibili del GPS.
// Eccezione: se durante una pausa lunga ci si è spostati di almeno 1 km a velocità media
// da veicolo (es. una galleria lunga), i due punti restano collegati.
// Velocità massima nei (fino a) 3 tratti prima (dir -1) o dopo (dir +1) il punto i
function nearbySpeed(pts, i, dir) {
  let best = 0;
  for (let k = 0; k < 3; k++) {
    const a = dir < 0 ? i - k - 1 : i + k;
    const b = a + 1;
    if (a < 0 || b >= pts.length || pts[a][2] === null || pts[b][2] === null) break;
    const dt = (pts[b][2] - pts[a][2]) / 1000;
    if (!(dt > 0) || dt > GAP_SPLIT_S) break;
    const kmh = haversine(pts[a], pts[b]) / dt * 3.6;
    if (kmh <= MAX_JUMP_KMH) best = Math.max(best, kmh);
  }
  return best;
}

function splitSegment(pts) {
  const out = [];
  let cur = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const prev = cur[cur.length - 1];
    if (prev && p[2] !== null && prev[2] !== null) {
      const dt = (p[2] - prev[2]) / 1000;
      const d = haversine(prev, p);
      const kmh = dt > 0 ? d / dt * 3.6 : 0;
      const tunnel = dt <= BRIDGE_MAX_S && d >= BRIDGE_MIN_M && kmh >= VEHICLE_KMH;
      const parked = dt <= PARK_MAX_S && d <= PARK_MAX_M &&
        nearbySpeed(pts, i - 1, -1) >= VEHICLE_KMH && nearbySpeed(pts, i, 1) >= VEHICLE_KMH;
      if ((dt > GAP_SPLIT_S && !tunnel && !parked) || kmh > MAX_JUMP_KMH) {
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
    // Velocità: quella misurata dal GPS (Heatlogger) è molto più affidabile di distanza/tempo
    const v = b[5] ?? (dt > 0 ? d / dt * 3.6 : null);
    legs.push({ d, v: dt > 0 ? v : null, mid: dt > 0 ? (a[2] + b[2]) / 2 : null, act: b[4] || a[4] || null });
  }
  const km = { walk: 0, vehicle: 0 };
  // A piedi il rumore del GPS allunga molto la traccia: se c'è la velocità misurata,
  // un tratto non può essere più lungo di quanto quella velocità permette (con margine)
  const walkLen = (i) => {
    const a = pts[i], b = pts[i + 1], leg = legs[i];
    if (a[5] === null || b[5] === null || a[2] === null || b[2] === null) return leg.d;
    const max = Math.max(a[5], b[5]) / 3.6 * (b[2] - a[2]) / 1000 * 1.5 + 10;
    return Math.min(leg.d, max);
  };
  const modes = []; // per ogni tratto: 'w' a piedi, 'v' veicolo
  let lo = 0, hi = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    // Modo riconosciuto dal telefono (Heatlogger): ha la precedenza sulla stima dalla velocità.
    // "Fermo" non dice con che mezzo ti muovi (al semaforo in auto è "fermo"): lì decide la velocità.
    const onFoot = leg.act === 'walking' || leg.act === 'running';
    const inVehicle = leg.act === 'vehicle' || leg.act === 'bicycle';
    if (onFoot) { modes.push('w'); continue; }
    if (inVehicle) { modes.push('v'); continue; } // anche se lenta: coda, camper in salita
    if (leg.mid === null) { modes.push('w'); continue; }
    while (lo < i && (legs[lo].mid === null || legs[lo].mid < leg.mid - MODE_WINDOW_MS)) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < legs.length && legs[hi + 1].mid !== null && legs[hi + 1].mid <= leg.mid + MODE_WINDOW_MS) hi++;
    const speeds = [];
    for (let j = lo; j <= hi; j++) if (legs[j].v !== null) speeds.push(legs[j].v);
    speeds.sort((x, y) => x - y);
    const p90 = speeds[Math.floor(0.9 * (speeds.length - 1))] || 0;
    modes.push(p90 > VEHICLE_KMH ? 'v' : 'w');
  }
  smoothModes(pts, modes);
  for (let i = 0; i < legs.length; i++) {
    if (modes[i] === 'v') km.vehicle += legs[i].d / 1000;
    else km.walk += walkLen(i) / 1000;
  }
  return { km, modes };
}

// Un pezzo di meno di 2 minuti in mezzo a due pezzi dello stesso tipo prende il loro tipo
// (es. pochi secondi "a piedi" in auto). Stessa regola della dashboard Quantified Self.
const MODE_BLIP_MS = 2 * 60 * 1000;
function smoothModes(pts, modes) {
  for (let changed = true; changed;) {
    changed = false;
    const runs = []; // [inizio, fine esclusa, modo]
    for (let i = 0; i < modes.length; i++) {
      if (runs.length && runs[runs.length - 1][2] === modes[i]) runs[runs.length - 1][1] = i + 1;
      else runs.push([i, i + 1, modes[i]]);
    }
    for (let r = 1; r < runs.length - 1; r++) {
      const [a, b, m] = runs[r];
      if (runs[r - 1][2] !== runs[r + 1][2] || runs[r - 1][2] === m) continue;
      const t0 = pts[a][2], t1 = pts[b][2]; // il tratto i va dal punto i al punto i+1
      if (t0 === null || t1 === null || t1 - t0 >= MODE_BLIP_MS) continue;
      for (let i = a; i < b; i++) modes[i] = runs[r - 1][2];
      changed = true;
      break;
    }
  }
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
const OSRM_ROUTE_URL = 'https://router.project-osrm.org/route/v1/driving/';
const MATCH_VERSION = 7;
const MATCH_CHUNK = 90;   // il server accetta al massimo 100 punti per richiesta
// metri di tolleranza intorno a ogni punto GPS: se un punto è troppo lontano da strade percorribili
// in auto (parcheggi o strade private) il server rifiuta tutto, quindi si riprova allargando
const MATCH_RADII = [35, 70, 100];

const snapEnabled = () => store.get('snap', '1') === '1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function matchChunk(chunk) {
  // i tempi devono essere strettamente crescenti
  const pts = chunk.filter((p, i) => i === 0 || p[2] === null || chunk[i - 1][2] === null || p[2] - chunk[i - 1][2] >= 1000);
  if (pts.length < 2) return { why: 'pochi punti' };
  let r;
  for (let k = 0; k < MATCH_RADII.length; k++) {
    if (k) await sleep(1100);
    r = await osrmMatch(pts, MATCH_RADII[k]);
    if (r.why !== 'NoSegment') break;
  }
  if (r.coords) return r;
  // Piano B: percorso stradale che passa per i punti GPS (ogni punto viene portato sulla strada
  // più vicina, senza limiti di distanza: funziona anche con parcheggi e strade private)
  await sleep(1100);
  const b = await osrmRoute(pts);
  return b.coords ? b : { why: `${r.why}, piano B: ${b.why}` };
}

async function osrmRoute(pts, maxRatio = 1.6) {
  const params = new URLSearchParams({ overview: 'full', geometries: 'geojson', continue_straight: 'false' });
  const url = OSRM_ROUTE_URL + pts.map((p) => `${p[1].toFixed(6)},${p[0].toFixed(6)}`).join(';') + '?' + params;
  const res = await fetch(url);
  let json = null;
  try { json = await res.json(); } catch { /* risposta non JSON */ }
  if (json && json.code === 'Ok' && json.routes?.length) {
    const route = json.routes[0];
    // passando per punti imprecisi il percorso può fare giri strani: in quel caso meglio la traccia GPS
    if (route.distance > maxRatio * pathLength(pts) + 300) return { why: 'percorso poco credibile' };
    return { coords: route.geometry.coordinates.map(([lon, lat]) => [lat, lon]) };
  }
  if (json && json.code) return { why: json.code };
  throw new Error('Server delle strade non disponibile');
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
    if (dist > 2 * pathLength(pts) + 500) return { why: 'percorso poco credibile' };
    return { coords };
  }
  if (json && json.code && json.code !== 'Ok') return { why: json.code };
  throw new Error('Server delle strade non disponibile');
}

async function matchRun(pts) {
  const out = [];
  let matchedAny = false;
  let why = null;
  for (let s = 0; s < pts.length - 1; s += MATCH_CHUNK - 1) {
    const chunk = pts.slice(s, s + MATCH_CHUNK);
    const { coords, why: w } = await matchChunk(chunk);
    await sleep(1100); // massimo una richiesta al secondo, come chiede il server
    const piece = coords || chunk.map((p) => [p[0], p[1]]);
    if (coords) matchedAny = true;
    else why = w;
    out.push(...(out.length ? piece.slice(1) : piece));
  }
  return { coords: matchedAny ? out : null, why };
}

// Viaggi della Cronologia Google: un punto ogni 1-5 minuti, troppo pochi per l'aggancio.
// Si chiede il percorso stradale che passa per tutti i punti (con più tolleranza sulle curve).
const ROUTE_V = 2; // 2: i blocchi scartati si riprovano tratto per tratto
async function routeRun(pts) {
  // Oltre 90 km/h si è in autostrada o superstrada: i punti intermedi (spesso un po' spostati)
  // verrebbero agganciati alla statale accanto (es. SS16 lungo l'A14). Si tolgono e il server
  // sceglie da solo la strada veloce tra punti più distanti.
  const v = (x, y) => haversine(x, y) / Math.max(1, (y[2] - x[2]) / 1000) * 3.6;
  pts = pts.slice();
  for (let i = 1; i < pts.length - 1; i++) {
    if (v(pts[i - 1], pts[i]) > 90 && v(pts[i], pts[i + 1]) > 90 && haversine(pts[i - 1], pts[i + 1]) < 20000) { pts.splice(i, 1); i--; }
  }
  const out = [];
  let routedAny = false, why = null;
  for (let s = 0; s < pts.length - 1; s += 49) {
    const chunk = pts.slice(s, s + 50);
    const r = await osrmRoute(chunk, 2.2);
    await sleep(1100);
    let piece = r.coords;
    if (!piece) {
      // Blocco scartato (es. valichi alpini: coi tornanti la strada è 2-3 volte la linea d'aria):
      // riprovo tratto per tratto, con più tolleranza ma su distanze brevi (12-13/8/2025)
      piece = [[chunk[0][0], chunk[0][1]]];
      let ok = 0;
      for (let i = 1; i < chunk.length; i++) {
        const a = chunk[i - 1], b = chunk[i];
        let leg = null;
        if (haversine(a, b) > 300) {
          const rr = await osrmRoute([a, b], 3.5);
          await sleep(1100);
          leg = rr.coords;
        }
        if (leg) { piece.push(...leg.slice(1)); ok++; } else piece.push([b[0], b[1]]);
      }
      if (ok) routedAny = true;
      why = r.why;
    } else {
      routedAny = true;
    }
    out.push(...(out.length ? piece.slice(1) : piece));
  }
  return { coords: routedAny ? out : null, why, rv: ROUTE_V };
}

// L'aggancio vale solo se fatto con la stessa versione e sulla stessa lettura del file GPX
function matchValid(rec) {
  const m = rec.match;
  return !!m && m.v === MATCH_VERSION && m.pv === (rec.pv ?? null) &&
    m.n === rec.segments.length && Array.isArray(m.segs) && m.segs.length === rec.segments.length;
}

let matching = false;
let matchRetry = null;

// Durante un aggancio lungo (es. Cronologia Google) tiene lo schermo acceso:
// a schermo spento il telefono sospende la pagina e le richieste falliscono
let wakeLock = null;
const awake = new Set(); // chi sta lavorando: 'match', 'elev'
async function keepAwake(on, who = 'match') {
  if (on) awake.add(who); else awake.delete(who);
  try {
    if (awake.size && !wakeLock && navigator.wakeLock && document.visibilityState === 'visible') {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else if (!awake.size && wakeLock) {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { wakeLock = null; }
}
// Tornando sull'app (schermo riacceso) riprende subito il lavoro rimasto
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    clearTimeout(matchRetry); matchPending();
    clearTimeout(elevRetry); fillElevations();
  }
});

// Ogni tratto in auto ha una "firma" (inizio, fine, numero di punti): se un file viene riscaricato
// (es. quello di oggi, che GPSLogger aggiorna ogni ora) i tratti già agganciati si riusano
// invece di richiederli al server. Va cambiato MATCH_ALGO solo se cambia il modo di agganciare.
const MATCH_ALGO = 1;
const runKey = (p) => `${MATCH_ALGO}|${p[0][2]}|${p[p.length - 1][2]}|${p.length}|${p[0][0]},${p[0][1]}`;

// percorso della Cronologia ricostruito solo in parte con la versione precedente: si rifà
const stale = (run) => run.k && run.k[0] === 'R' && (run.why || !run.coords) && (run.rv || 1) < ROUTE_V;

function knownRuns(records) {
  const known = new Map();
  for (const r of records) {
    const runs = [...(r.match?.segs || []).flat(), ...(r.oldRuns || [])];
    for (const run of runs) if (run && run.k && run.coords && !stale(run)) known.set(run.k, run);
  }
  return known;
}

async function matchPending() {
  if (matching || !snapEnabled()) return;
  matching = true;
  let worked = false;
  try {
    for (;;) {
      const all = await DB.all();
      const covered = hiddenTimeline(all);
      const todo = all.filter((r) => (!matchValid(r) || (r.source === 'timeline' && r.match.segs.flat().some((x) => x && stale(x)))) && !covered(r));
      if (!todo.length) break;
      const known = knownRuns(all);
      let done = 0;
      for (const rec of todo) {
        done++;
        const segs = [];
        const tl = rec.source === 'timeline';
        for (const pts of rec.segments) {
          const runs = [];
          for (const [i0, i1] of tl ? [[0, pts.length - 1]] : vehicleRuns(classify(pts).modes)) {
            const part = pts.slice(i0, i1 + 1);
            const k = (tl ? 'R2' : '') + runKey(part); // R2: con i punti d'autostrada sfoltiti
            const old = known.get(k);
            if (old) { runs.push({ i0, i1, k, coords: old.coords, why: old.why || null, rv: old.rv, dist: old.dist }); continue; }
            worked = true;
            keepAwake(true);
            setStatus(`Aggancio alle strade i percorsi in auto del ${dayLabel(rec.name)}…` + (todo.length > 1 ? ` (${done}/${todo.length})` : ''));
            const { coords, why, rv } = await (tl ? routeRun(part) : matchRun(part));
            runs.push({ i0, i1, k, coords, why, rv, dist: coords ? pathLength(coords) : null });
          }
          segs.push(runs);
        }
        // salva solo se nel frattempo il file non è stato aggiornato
        const fresh = await DB.get(rec.name);
        if (fresh && recVer(fresh) === recVer(rec)) {
          fresh.match = { v: MATCH_VERSION, pv: fresh.pv ?? null, n: fresh.segments.length, segs };
          delete fresh.oldRuns;
          await DB.put(fresh);
          if (fresh.source === 'drive') store.set('cacheDirty', '1');
          if (fresh.source === 'timeline') markTimelineDirty();
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
    // a ricostruzione finita la Cronologia va su Drive (non a ogni viaggio: il file è grande)
    if (store.get('tlDirty', '0') === '1' && canUseAppData()) {
      try { await syncTimeline(true); } catch { /* riprova alla prossima sincronizzazione */ }
    }
  } catch (err) {
    // server occupato o pagina sospesa: si riprova da soli tra poco (e subito al ritorno sull'app)
    setStatus('Server delle strade non raggiungibile: riprovo tra un minuto. Quello già fatto è salvato.', true, true);
    clearTimeout(matchRetry);
    matchRetry = setTimeout(matchPending, 60_000);
  } finally {
    keepAwake(false);
    matching = false;
    renderDiag(currentSegments());
  }
}

/* ---------------- Indice dei dati ---------------- */

let allSegments = [];

function bboxOf(path) {
  let minLat = 90, minLon = 180, maxLat = -90, maxLon = -180;
  for (const p of path) {
    if (p[0] < minLat) minLat = p[0];
    if (p[0] > maxLat) maxLat = p[0];
    if (p[1] < minLon) minLon = p[1];
    if (p[1] > maxLon) maxLon = p[1];
  }
  return [minLat, minLon, maxLat, maxLon];
}

// Divide una traccia in pezzi "a piedi" e "in veicolo" (per il filtro della mappa).
// Nei pezzi in veicolo i tratti agganciati alle strade sostituiscono i punti GPS.
function splitByMode(pts, modes, runs, day, timeline = false) {
  const raw = timeline ? new Set(pts.map((q) => q[0] + ',' + q[1])) : null;
  const pieces = [];
  let s = 0;
  for (let i = 1; i <= modes.length; i++) {
    if (i < modes.length && modes[i] === modes[s]) continue;
    const e = i; // pezzo dai punti s..e (tratti s..e-1)
    const m = modes[s] === 'v' ? 'v' : 'w';
    let path = [];
    if (m === 'v' && runs && runs.length) {
      let j = s;
      for (const r of runs) {
        if (!r.coords || r.i0 < s || r.i1 > e || r.i0 < j) continue;
        while (j < r.i0) path.push(pts[j++]);
        path.push(...r.coords);
        j = r.i1 + 1;
      }
      while (j <= e) path.push(pts[j++]);
    } else {
      path = pts.slice(s, e + 1);
    }
    // Cronologia: dove la ricostruzione sulle strade non è riuscita, due punti veri lontani
    // non si uniscono con una riga dritta (es. 18/10/2025: 8 km in linea d'aria sui monti)
    const parts = [path];
    if (raw) {
      parts.length = 0;
      let cur = [];
      for (const q of path) {
        const prev = cur[cur.length - 1];
        if (prev && raw.has(prev[0] + ',' + prev[1]) && raw.has(q[0] + ',' + q[1]) && haversine(prev, q) > 1000) { parts.push(cur); cur = []; }
        cur.push(q);
      }
      parts.push(cur);
    }
    for (const pp of parts) if (pp.length >= 2) pieces.push({ m, path: pp, day, bbox: bboxOf(pp) });
    s = i;
  }
  return pieces;
}

// Filtro della mappa: a piedi / in veicolo (all'apertura sempre entrambi)
const show = { w: false, v: true, t: true }; // all'apertura: solo veicoli
const visiblePieces = (segs) => segs.flatMap((s) => s.timeline && !show.t ? [] : s.pieces.filter((p) => show[p.m]));

// Cronologia Google: solo i viaggi in auto, uno per "segmento", raggruppati per giorno
const TL_PREFIX = 'cronologia-';
const TL_VEHICLES = new Set(['IN_PASSENGER_VEHICLE', 'IN_VEHICLE', 'IN_CAR', 'DRIVING', 'MOTORCYCLING', 'IN_TAXI']);

// Pulizia di un viaggio della Cronologia (modifica l'array). Se cambia, alzare TL_CLEAN:
// i viaggi già caricati vengono ripuliti da soli all'apertura.
const TL_CLEAN = 6;
function cleanTrip(clean) {
  const v = (x, y) => haversine(x, y) / Math.max(1, (y[2] - x[2]) / 1000) * 3.6;
  for (let changed = true; changed;) {
    changed = false;
    for (let i = 1; i < clean.length - 1 && !changed; i++) {
      // 1) punto impossibile: oltre 180 km/h sia per arrivarci sia per ripartire
      const a = clean[i - 1], q = clean[i], b = clean[i + 1];
      if (v(a, q) > 180 && v(q, b) > 180 && v(a, b) < 180) { clean.splice(i, 1); changed = true; break; }
      // 2) "andata e ritorno" impossibile: 1-2 punti lontani e poi di nuovo quasi al punto di prima
      //    (es. 11/7 al Passo di Pennes: punti sparsi verso Vipiteno e in fondo alla valle)
      for (let k = 1; k <= 2 && i + k < clean.length; k++) {
        const seq = clean.slice(i - 1, i + k + 1);
        const via = pathLength(seq), direct = haversine(seq[0], seq[seq.length - 1]);
        if (via > 3 * direct + 3000) { clean.splice(i, k); changed = true; break; }
      }
    }
  }
  // 3) primo o ultimo punto irraggiungibile (es. 12/7: "fine viaggio" al parcheggio, a 575 km/h)
  while (clean.length > 2 && v(clean[clean.length - 2], clean[clean.length - 1]) > 180) clean.pop();
  while (clean.length > 2 && v(clean[0], clean[1]) > 180) clean.shift();
  return clean;
}

// "Viaggio in auto" che per tutto il tempo va a passo d'uomo: è una camminata etichettata male
// (es. 18/10/2025, escursione al Falterona: 10 km in un'ora, velocità tipica 4 km/h)
function isSlowTrip(t) {
  if (t.length < 3 || pathLength(t) < 1000) return false;
  const sp = [];
  for (let i = 1; i < t.length; i++) sp.push(haversine(t[i - 1], t[i]) / Math.max(1, (t[i][2] - t[i - 1][2]) / 1000) * 3.6);
  sp.sort((a, b) => a - b);
  // anche la media di tutto il viaggio deve essere da pedone: in coda in città si sta sopra i 10 km/h
  const avg = pathLength(t) / Math.max(1, (t[t.length - 1][2] - t[0][2]) / 1000) * 3.6;
  return sp[Math.floor(sp.length * 0.8)] < 15 && avg < 10;
}

// Un "viaggio" con dentro una sosta lunga (es. notte in camper al passo) si divide in due;
// i pezzi corti attaccati alla sosta sono quasi sempre a piedi (si parte per un sentiero)
const STOP_MS = 20 * 60 * 1000, STOP_M = 200, AFTER_STOP_MIN_M = 2000;
const WALK_IN_TRIP_KMH = 7, WALK_IN_TRIP_MS = 10 * 60 * 1000;
function splitTrip(trip) {
  // Tratti a passo d'uomo per almeno 10 minuti dentro un viaggio (es. 23/5 a Castelluccio:
  // 40 minuti a 2-4 km/h intorno al Colle Moretta): si trattano come una sosta
  const slowEnd = new Map(); // indice d'inizio → indice di fine del tratto lento
  for (let i = 0; i < trip.length - 1;) {
    let j = i;
    while (j + 1 < trip.length &&
      haversine(trip[j], trip[j + 1]) / Math.max(1, (trip[j + 1][2] - trip[j][2]) / 1000) * 3.6 < WALK_IN_TRIP_KMH) j++;
    if (j > i && trip[j][2] - trip[i][2] >= WALK_IN_TRIP_MS) slowEnd.set(i, j);
    i = Math.max(j, i + 1);
  }
  const parts = [];
  let cur = [trip[0]];
  if (slowEnd.has(0)) { parts.push({ pts: cur, stopAfter: true }); cur = [trip[slowEnd.get(0)]]; }
  for (let i = slowEnd.has(0) ? slowEnd.get(0) + 1 : 1; i < trip.length; i++) {
    if (slowEnd.has(i)) {
      cur.push(trip[i]);
      parts.push({ pts: cur, stopAfter: true });
      cur = [trip[slowEnd.get(i)]];
      i = slowEnd.get(i);
      continue;
    }
    // sosta: dal punto i in avanti si resta entro 200 m per almeno 20 minuti
    let j = i;
    while (j + 1 < trip.length && haversine(trip[i], trip[j + 1]) <= STOP_M) j++;
    if (j > i && trip[j][2] - trip[i][2] >= STOP_MS) {
      cur.push(trip[i]);
      parts.push({ pts: cur, stopAfter: true });
      cur = [trip[j]];
      i = j;
      continue;
    }
    cur.push(trip[i]);
  }
  parts.push({ pts: cur, stopAfter: false });
  return parts.filter((pc, n) => {
    const nearStop = pc.stopAfter || n > 0;
    return pc.pts.length >= 2 && pathLength(pc.pts) >= (parts.length > 1 && nearStop ? AFTER_STOP_MIN_M : 300);
  }).map((pc) => pc.pts);
}

// Ripulisce i viaggi caricati con una versione precedente della pulizia
async function upgradeTimeline() {
  for (const rec of await DB.all()) {
    if (rec.source !== 'timeline' || (rec.tlv || 1) >= TL_CLEAN) continue;
    markTimelineDirty();
    const segments = rec.segments.flatMap((t) => { const c = cleanTrip(t.slice()); return c.length >= 2 ? splitTrip(c).filter((x) => !isSlowTrip(x)) : []; });
    const oldRuns = [...(rec.match?.segs || []).flat(), ...(rec.oldRuns || [])].filter((r) => r && r.k && r.coords);
    if (!segments.length) { await DB.del(rec.name); continue; }
    await DB.put({ name: rec.name, source: 'timeline', ver: rec.ver + '+c' + TL_CLEAN, modifiedTime: rec.modifiedTime, pv: rec.pv, tlv: TL_CLEAN, segments, oldRuns });
  }
}

function parseTimeline(text) {
  const json = JSON.parse(text);
  const segsIn = Array.isArray(json) ? json : json.semanticSegments;
  if (!Array.isArray(segsIn)) throw new Error('Non è un file della Cronologia di Google Maps');
  const ll = (str) => {
    const m = /(-?[\d.]+)°?\s*,\s*(-?[\d.]+)/.exec(str || '');
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : null;
  };
  const path = [];
  for (const sg of segsIn) {
    for (const q of sg.timelinePath || []) {
      const p = ll(q.point), t = Date.parse(q.time);
      if (p && isFinite(t)) path.push([p[0], p[1], t, String(q.time).slice(0, 10).replace(/-/g, '')]);
    }
  }
  path.sort((a, b) => a[2] - b[2]);
  const times = path.map((p) => p[2]);
  const lower = (t) => { let lo = 0, hi = times.length; while (lo < hi) { const m = (lo + hi) >> 1; if (times[m] < t) lo = m + 1; else hi = m; } return lo; };
  const days = new Map();
  let trips = 0;
  for (const sg of segsIn) {
    const a = sg.activity;
    if (!a || !TL_VEHICLES.has(a.topCandidate?.type)) continue;
    const t0 = Date.parse(sg.startTime), t1 = Date.parse(sg.endTime);
    if (!isFinite(t0) || !isFinite(t1)) continue;
    const pts = [];
    const start = ll(a.start?.latLng), end = ll(a.end?.latLng);
    if (start) pts.push([start[0], start[1], t0]);
    for (let i = lower(t0 - 60000); i < path.length && path[i][2] <= t1 + 60000; i++) pts.push(path[i]);
    if (end) pts.push([end[0], end[1], t1]);
    pts.sort((x, y) => x[2] - y[2]);
    const clean = [];
    for (const p of pts) {
      const prev = clean[clean.length - 1];
      if (prev && ((prev[0] === p[0] && prev[1] === p[1]) || p[2] - prev[2] < 1000)) continue; // doppioni nello stesso istante
      clean.push([Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, p[2], null, 'vehicle', null]);
    }
    cleanTrip(clean);
    if (clean.length < 2) continue;
    const day = sg.startTime.slice(0, 10).replace(/-/g, '');
    for (const part of splitTrip(clean)) {
      if (isSlowTrip(part)) continue;
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(part);
      trips++;
    }
  }
  // Tragitti "orfani": punti che Google non ha messo in nessuna attività (es. 13/6, da Falzarego
  // al Giau dentro una "visita") ma che si muovono come un'auto. Recuperati con regole prudenti.
  const spans = [];
  for (const sg of segsIn) {
    const t0 = Date.parse(sg.startTime), t1 = Date.parse(sg.endTime);
    // gli spostamenti di tipo "sconosciuto" (frequenti nei backup vecchi) si valutano come gli orfani
    const known = sg.activity && sg.activity.topCandidate?.type !== 'UNKNOWN_ACTIVITY_TYPE';
    if (known && isFinite(t0) && isFinite(t1) && t1 - t0 >= 60000) spans.push([t0 - 60000, t1 + 60000]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]); else merged.push(sp.slice());
  }
  let m = 0;
  const groups = [];
  let cur = [];
  for (const p of path) {
    while (m < merged.length && merged[m][1] < p[2]) m++;
    if (m < merged.length && merged[m][0] <= p[2]) continue; // dentro un'attività: già considerato
    const prev = cur[cur.length - 1];
    if (prev && p[2] - prev[2] > 10 * 60000) { groups.push(cur); cur = []; }
    if (!prev || prev[0] !== p[0] || prev[1] !== p[1]) cur.push(p);
  }
  groups.push(cur);
  for (const g of groups) {
    if (g.length < 3) continue;
    const clean = [];
    for (const p of g) {
      const prev = clean[clean.length - 1];
      if (prev && p[2] - prev[2] < 1000) continue;
      clean.push([Math.round(p[0] * 1e6) / 1e6, Math.round(p[1] * 1e6) / 1e6, p[2], null, 'vehicle', null]);
    }
    cleanTrip(clean);
    if (clean.length < 3) continue;
    for (const part of splitTrip(clean)) {
      const sp = [];
      for (let i = 1; i < part.length; i++) {
        const kmh = haversine(part[i - 1], part[i]) / Math.max(1, (part[i][2] - part[i - 1][2]) / 1000) * 3.6;
        if (kmh > 3) sp.push(kmh);
      }
      sp.sort((a, b) => a - b);
      const med = sp.length ? sp[sp.length >> 1] : 0;
      const reach = Math.max(...part.map((p) => haversine(part[0], p))); // rimbalzi sul posto: non ci si allontana
      if (part.length < 3 || pathLength(part) < 2000 || reach < 1000 || med < 20 || med > 140) continue; // a piedi, treno, aereo…
      const first = g.find((p) => p[2] === part[0][2]);
      const day = first ? first[3] : new Date(part[0][2]).toISOString().slice(0, 10).replace(/-/g, '');
      if (!days.has(day)) days.set(day, []);
      days.get(day).push(part);
      trips++;
    }
  }
  // Raccordi: l'auto non si teletrasporta. Se un viaggio finisce e il successivo riparte poco
  // lontano (es. 13-14/6: parcheggio del Giau → Rifugio Piezza), in mezzo ci è passata per forza.
  const all = [...days.entries()].flatMap(([day, ts]) => ts.map((t) => ({ day, t }))).sort((a, b) => a.t[0][2] - b.t[0][2]);
  for (let i = 1; i < all.length; i++) {
    const a = all[i - 1].t, b = all[i].t;
    const end = a[a.length - 1], start = b[0];
    const gap = haversine(end, start), dt = start[2] - end[2];
    if (gap < 300 || gap > 2000 || dt <= 0 || dt > 36 * 3600 * 1000) continue;
    const link = [[end[0], end[1], end[2] + 1000, null, 'vehicle', null], [start[0], start[1], start[2] - 1000, null, 'vehicle', null]];
    days.get(all[i].day).push(link);
    trips++;
  }
  return { days, trips };
}

// Nei giorni registrati con GPSLogger la Cronologia non serve (e sarebbe un doppione)
function hiddenTimeline(records) {
  const gpxDays = new Set();
  for (const rec of records) {
    if (rec.source === 'timeline') continue;
    for (const pts of rec.segments) {
      if (pts[0][2] === null) continue;
      const d = new Date(pts[0][2]);
      gpxDays.add(`${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`);
    }
  }
  return (rec) => rec.source === 'timeline' && gpxDays.has(rec.name.slice(TL_PREFIX.length));
}

function buildIndex(records) {
  const segs = [];
  const covered = hiddenTimeline(records);
  for (const rec of records) {
    const timeline = rec.source === 'timeline';
    if (covered(rec)) continue;
    const fromName = /(\d{4})(\d{2})(\d{2})/.exec(rec.name);
    const matched = snapEnabled() && matchValid(rec) ? rec.match.segs : null;
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
      // raccordo della Cronologia non ricostruibile sulle strade: meglio niente che una linea dritta
      if (timeline && pts.length === 2 && !(matched && matched[k] && matched[k][0] && matched[k][0].coords)) return;
      const { km, modes } = classify(pts);
      let path = pts;
      let runs = matched && matched[k];
      // protezione: un aggancio che non corrisponde ai punti viene ignorato (verrà rifatto)
      if (runs && runs.some((r) => r.i1 >= pts.length || r.i0 > r.i1)) runs = null;
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
      segs.push({
        path,
        timeline,
        raw: timeline ? pts : null,
        // Cronologia: le quote sono chieste per i punti veri, non per i percorsi ricostruiti
        pieces: splitByMode(pts, modes, runs, day, timeline),
        runs: runs || [],
        day,
        year: day.slice(0, 4),
        bbox: bboxOf(path),
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
// Le quote stanno in un database a parte del browser (IndexedDB): nel "localStorage" (5 MB)
// col vecchio backup non ci stavano più e venivano richieste ogni volta (20/11)
let elevCache = {};
const ElevDB = {
  _db: null,
  async open() {
    if (this._db !== null) return this._db;
    this._db = await new Promise((resolve) => {
      try {
        const req = indexedDB.open('heatmap-elev', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('cells');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(false);
      } catch { resolve(false); }
    });
    return this._db;
  },
  async load() {
    const db = await this.open();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction('cells', 'readonly');
      const req = tx.objectStore('cells').openCursor();
      req.onsuccess = () => { const c = req.result; if (c) { elevCache[c.key] = c.value; c.continue(); } else resolve(); };
      req.onerror = () => resolve();
    });
  },
  async putMany(entries) {
    const db = await this.open();
    if (!db || !entries.length) return;
    await new Promise((resolve) => {
      const tx = db.transaction('cells', 'readwrite');
      const st = tx.objectStore('cells');
      for (const [k, v] of entries) st.put(v, k);
      tx.oncomplete = tx.onerror = () => resolve();
    });
  },
};
let elevLoaded = null;
function loadElevations() {
  if (!elevLoaded) elevLoaded = (async () => {
    // trasloco dal vecchio posto
    try {
      const old = JSON.parse(store.get('elev', 'null'));
      if (old && typeof old === 'object') { await ElevDB.putMany(Object.entries(old)); localStorage.removeItem('elev'); }
    } catch { /* niente da traslocare */ }
    await ElevDB.load();
  })();
  return elevLoaded;
}
let elevBusy = false;
let elevRetry = null;

// Dove chiedere la quota, a "zoom progressivo" (Open-Meteo gratuito conta ogni posizione:
// max 600 al minuto, 5.000 all'ora, 10.000 al giorno): lungo i percorsi, che stanno sulle strade,
// 1) un punto ogni 10 km; 2) sopra i 1.200 m, uno ogni km nei 10 km intorno;
// 3) sui punti più alti sopra i 1.800 m (le cime dei colli), uno ogni 100 m nel km intorno.
const ELEV_COARSE = 10000, ELEV_MID = 1000, ELEV_FINE = 100, ELEV_HILLS = 1200, ELEV_HIGH = 1800;
function samplePath(path, step, keep = () => true, fromStart = true) {
  const out = [];
  let acc = fromStart ? step : 0;
  for (let i = 0; i < path.length; i++) {
    if (i) acc += haversine(path[i - 1], path[i]);
    if (acc >= step && keep(path[i])) { out.push(path[i]); acc = 0; }
  }
  return out;
}
function elevationTargets() {
  const missing = new Map();
  const want = (p) => { const k = cellKey(p); if (!(k in elevCache) && !missing.has(k)) missing.set(k, p); };
  const elev = (p) => elevCache[cellKey(p)] ?? -9999;
  for (const seg of allSegments) {
    for (const pc of seg.pieces) {
      // niente punto di partenza (quasi sempre casa o lavoro): basta l'arrivo, che conta (es. parcheggi in cima ai colli)
      const coarse = samplePath(pc.path, ELEV_COARSE, () => true, false);
      coarse.forEach(want);
      want(pc.path[pc.path.length - 1]);
      const hills = [...coarse, pc.path[pc.path.length - 1]].filter((p) => elev(p) >= ELEV_HILLS);
      if (!hills.length) continue;
      const mid = samplePath(pc.path, ELEV_MID, (p) => hills.some((h) => haversine(h, p) <= ELEV_COARSE));
      mid.forEach(want);
      // cime: punti da 1 km più alti dei vicini
      const peaks = mid.filter((p, i) => elev(p) >= ELEV_HIGH && elev(p) >= elev(mid[i - 1] || p) && elev(p) >= elev(mid[i + 1] || p));
      if (peaks.length) samplePath(pc.path, ELEV_FINE, (p) => peaks.some((h) => haversine(h, p) <= ELEV_MID)).forEach(want);
    }
  }
  return missing;
}

async function fillElevations() {
  if (elevBusy) return;
  elevBusy = true;
  try {
    await loadElevations();
   let doneLocs = 0;
   for (let round = 0; round < 4; round++) {
    const list = [...elevationTargets().entries()];
    if (!list.length) break;
    for (let i = 0; i < list.length; i += 100) {
      const batch = list.slice(i, i + 100);
      const url = 'https://api.open-meteo.com/v1/elevation?latitude=' +
        batch.map(([, p]) => p[0].toFixed(5)).join(',') + '&longitude=' +
        batch.map(([, p]) => p[1].toFixed(5)).join(',');
      if (i === 0 && list.length > 300) keepAwake(true, 'elev');
      const res = await fetch(url);
      if (!res.ok) throw new Error('quote non disponibili');
      const json = await res.json();
      const got = [];
      batch.forEach(([k], n) => {
        const e = json.elevation && json.elevation[n];
        elevCache[k] = typeof e === 'number' && isFinite(e) ? Math.round(e) : -9999; // -9999: mare/sconosciuto
        got.push([k, elevCache[k]]);
      });
      await ElevDB.putMany(got);
      doneLocs += batch.length;
      if (list.length > 300) setStatus(`Calcolo le quote… ${doneLocs} fatte, ${list.length - i - batch.length} ancora in questo giro`);
      if ((i / 100) % 10 === 9) renderRecords(); // il record si aggiorna strada facendo
      // Open-Meteo gratuito: ogni posizione conta come una chiamata, max 600 al minuto
      await sleep(11000);
    }
    renderRecords();
    if (list.length > 300) setStatus('Quote calcolate: punto più alto aggiornato.');
   }
  } catch {
    // limite del servizio (orario o giornaliero) o pagina sospesa: riprovo tra 10 minuti
    // (quello già fatto è salvato)
    setStatus('Quote: limite del servizio gratuito raggiunto, riprendo da solo tra 10 minuti.');
    clearTimeout(elevRetry);
    elevRetry = setTimeout(fillElevations, 10 * 60_000);
  } finally {
    keepAwake(false, 'elev');
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
  for (const seg of visiblePieces(currentSegments())) {
    for (const p of seg.path) {
      const e = elevCache[cellKey(p)];
      if (e !== undefined && e > -9000 && (!high || e > high.e)) high = { e, p, day: seg.day };
    }
    for (const p of seg.path) {
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
  setStatus('Tocca la mappa nel punto in cui si trova casa tua.', false, true);
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
  sel.add(new Option('Sempre (tutti gli anni)', 'all'));
  for (const y of years) sel.add(new Option(y === 'senz' ? 'Senza data' : y, y));
  const thisYear = String(new Date().getFullYear());
  sel.value = [prev, thisYear, years[0], 'all'].find((v) => v && [...sel.options].some((o) => o.value === v));
}

function render(fit) {
  const segs = currentSegments();
  heat.setSegments(visiblePieces(segs));

  let walk = 0, vehicle = 0, tl = 0;
  const days = new Set();
  for (const s of segs) {
    if (s.timeline) { tl += s.km.vehicle; if (show.t) days.add(s.day); continue; }
    walk += s.km.walk; vehicle += s.km.vehicle; days.add(s.day);
  }
  const hasTl = allSegments.some((s) => s.timeline);
  $('rowTimeline').hidden = !hasTl;
  $('clearTimeline').hidden = !hasTl;
  $('kmWalk').textContent = segs.length ? fmtKm(walk) : '–';
  $('kmVehicle').textContent = segs.length ? fmtKm(vehicle) : '–';
  $('kmTimeline').textContent = fmtKm(tl);
  $('days').textContent = days.size || '–';
  renderRecords();
  renderDiag(segs);

  if (fit && segs.length) {
    let b = null;
    for (const s of segs) {
      const sb = L.latLngBounds([s.bbox[0], s.bbox[1]], [s.bbox[2], s.bbox[3]]);
      b = b ? b.extend(sb) : sb;
    }
    map.fitBounds(b, { padding: [30, 30], maxZoom: 16 });
  }
}

// Riepilogo dell'aggancio alle strade (in Impostazioni), utile per capire cosa non va
function renderDiag(segs) {
  let ok = 0, ko = 0;
  const reasons = {};
  for (const s of segs) {
    for (const r of s.runs || []) {
      if (r.coords) ok++;
      else { ko++; reasons[r.why || 'sconosciuto'] = (reasons[r.why || 'sconosciuto'] || 0) + 1; }
    }
  }
  const why = Object.entries(reasons).map(([k, n]) => `${k} ×${n}`).join(', ');
  $('diag').textContent = snapEnabled()
    ? `Tratti in auto: ${ok} agganciati, ${ko} no` + (ko ? ` (${why})` : '') + (matching ? ' — elaborazione in corso…' : '')
    : 'Aggancio alle strade disattivato.';
}

async function reloadFromDb(fit) {
  await loadElevations();
  await upgradeTimeline();
  buildIndex(await DB.all());
  refreshYears();
  render(fit);
  matchPending();
  fillElevations();
}

$('ver').textContent = APP_VERSION;

for (const [id, m] of [['showWalk', 'w'], ['showVehicle', 'v'], ['showTimeline', 't']]) {
  $(id).addEventListener('change', (e) => { show[m] = e.target.checked; render(false); });
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

async function importTimeline(f) {
  try {
    const { days, trips } = parseTimeline(await f.text());
    if (!trips) throw new Error('nessun viaggio in auto trovato');
    // Si possono caricare più file (es. il backup del vecchio telefono): i viaggi si sommano,
    // quelli già presenti (stessa ora di partenza) non vengono duplicati
    const ver = 'tl-' + f.size + '-' + f.lastModified;
    markTimelineDirty();
    for (const [day, segments] of days) {
      const name = TL_PREFIX + day;
      const old = await DB.get(name);
      if (old && old.source === 'timeline') {
        // doppione solo se coincidono partenza e arrivo (13/6: il tragitto Falzarego-Giau parte alla
        // stessa ora di un finto "viaggio" di zero minuti e veniva scartato)
        const tripKey = (t) => t[0][2] + '-' + t[t.length - 1][2];
        const known = new Set(old.segments.map(tripKey));
        const added = segments.filter((t) => !known.has(tripKey(t)));
        if (!added.length) continue;
        const merged = [...old.segments, ...added].sort((a, b) => a[0][2] - b[0][2]);
        const oldRuns = [...(old.match?.segs || []).flat(), ...(old.oldRuns || [])].filter((r) => r && r.k && r.coords);
        await DB.put({ name, source: 'timeline', ver: old.ver + '+' + ver, modifiedTime: ver, pv: PARSE_VERSION, tlv: TL_CLEAN, segments: merged, oldRuns });
      } else {
        await DB.put({ name, source: 'timeline', ver, modifiedTime: ver, pv: PARSE_VERSION, tlv: TL_CLEAN, segments });
      }
    }
    await reloadFromDb(true);
    setStatus(`Cronologia Google: ${trips} viaggi in auto in ${days.size} giorni. Ricostruisco i percorsi sulle strade…`, false, true);
  } catch (err) {
    setStatus('Cronologia Google non leggibile: ' + err.message, true);
  }
}

async function removeTimeline() {
  for (const r of await DB.all()) if (r.source === 'timeline') await DB.del(r.name);
  markTimelineDirty();
}

$('clearTimeline').addEventListener('click', async () => {
  if (!confirm('Togliere dalla mappa tutti i viaggi della Cronologia Google, anche dalla copia su Drive (quindi da tutti i dispositivi)? I file GPX non vengono toccati.')) return;
  await removeTimeline();
  if (canUseAppData()) syncTimeline().catch(() => {});
  await reloadFromDb(false);
  setStatus('Cronologia Google rimossa.');
});

async function importFiles(files) {
  let ok = 0, bad = 0;
  for (const f of files) {
    if (/\.json$/i.test(f.name)) { await importTimeline(f); continue; }
    if (!/\.gpx$/i.test(f.name)) continue;
    try {
      const segments = parseGpx(await f.text());
      await DB.put({ name: f.name, source: 'local', modifiedTime: new Date(f.lastModified).toISOString(), segments });
      ok++;
    } catch { bad++; }
  }
  if (ok || bad) {
    await reloadFromDb(true);
    setStatus(`Caricati ${ok} file` + (bad ? `, ${bad} non leggibili` : '') + '.', bad > 0 && ok === 0);
  }
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
  const saved = JSON.parse(store.get('gtoken', 'null'));
  if (saved && saved.exp > Date.now() + 60000 && saved.scope) token = saved;
} catch { /* ignora */ }

function getToken() {
  return new Promise((resolve, reject) => {
    if (token && token.exp > Date.now() + 60000) return resolve(token.value);
    if (!window.google?.accounts?.oauth2) return reject(new Error('Libreria Google non ancora caricata, riprova tra un attimo.'));
    if (!tokenClient) {
      // con l'account già noto Google non chiede più quale usare: la finestrella si apre e si chiude da sola
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: CONFIG.clientId, scope: CONFIG.scope, callback: () => {},
        login_hint: store.get('ghint', '') || undefined,
      });
    }
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error('Accesso non riuscito: ' + resp.error));
      token = { value: resp.access_token, exp: Date.now() + resp.expires_in * 1000, scope: resp.scope || '' };
      store.set('gtoken', JSON.stringify(token));
      store.set('gAuthorized', '1');
      resolve(token.value);
    };
    tokenClient.error_callback = (err) => reject(new Error(err?.type === 'popup_closed' ? 'Accesso annullato.' : 'Accesso non riuscito.'));
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

const recVer = (r) => r.ver || r.modifiedTime;
const fileVer = (f) => f.md5Checksum || f.modifiedTime;
const dayLabel = (name) => {
  const m = /(\d{4})(\d{2})(\d{2})/.exec(name);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' }) : name;
};

const tokenValid = () => !!token && token.exp > Date.now() + 60000;
const canUseAppData = () => tokenValid() && /drive\.appdata/.test(token.scope);

async function drive(path, params, asText, opts = {}, base = 'https://www.googleapis.com/drive/v3/') {
  const url = new URL(base + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { ...opts, headers: { ...(opts.headers || {}), Authorization: 'Bearer ' + token.value } });
  if (res.status === 401) {
    token = null;
    store.set('gtoken', 'null');
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
    if (rec.source !== 'drive' || matchValid(rec)) continue;
    const e = cache.entries[rec.name];
    if (e && e.v === MATCH_VERSION && (e.ver || e.modifiedTime) === recVer(rec) && e.pv === (rec.pv ?? null) &&
        e.n === rec.segments.length) {
      rec.match = { v: e.v, pv: e.pv, n: e.n, segs: e.segs };
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
    if (rec.source !== 'drive' || !matchValid(rec)) continue;
    cache.entries[rec.name] = { v: rec.match.v, pv: rec.match.pv, n: rec.match.n, ver: recVer(rec), modifiedTime: rec.modifiedTime, segs: rec.match.segs };
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

/* ---------- Cronologia Google condivisa tra dispositivi (cartella nascosta su Drive) ---------- */

// Tutta la Cronologia già pulita e ricostruita sulle strade, compressa: sugli altri dispositivi
// si scarica pronta invece di ricaricare i file e rifare un'ora di ricostruzione.
const TL_FILE = 'timeline.json.gz';
const markTimelineDirty = () => store.set('tlDirty', '1');

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}
async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).text();
}

async function findTimelineFile() {
  const files = await listAll(`name = '${TL_FILE}' and trashed = false`, 'id,name,modifiedTime', 'appDataFolder');
  return files[0] || null;
}

async function syncTimeline(fromMatch = false) {
  if (!canUseAppData() || typeof CompressionStream === 'undefined' || (matching && !fromMatch)) return false;
  const file = await findTimelineFile();
  const local = (await DB.all()).filter((r) => r.source === 'timeline');
  const up = 'https://www.googleapis.com/upload/drive/v3/';
  const dirty = store.get('tlDirty', '0') === '1' || (!file && local.length && !store.get('tlSync', ''));

  if (dirty) {
    // le modifiche fatte qui (caricamento, ricostruzione, pulizia, rimozione) vanno su Drive
    if (!local.length) {
      if (file) await drive('files/' + file.id, {}, true, { method: 'DELETE' });
      store.set('tlSync', ''); store.set('tlDirty', '0');
      return false;
    }
    setStatus('Salvo la Cronologia su Drive…');
    const recs = local.map((r) => ({ name: r.name, ver: r.ver, modifiedTime: r.modifiedTime, pv: r.pv, tlv: r.tlv, segments: r.segments, match: r.match }));
    const blob = await gzip(JSON.stringify({ v: 1, updated: new Date().toISOString(), records: recs }));
    let res;
    if (file) {
      res = await drive('files/' + file.id, { uploadType: 'media', fields: 'id,modifiedTime' }, false,
        { method: 'PATCH', headers: { 'Content-Type': 'application/gzip' }, body: blob }, up);
    } else {
      const boundary = 'heatmap' + Math.random().toString(36).slice(2);
      const body = new Blob([
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
        JSON.stringify({ name: TL_FILE, parents: ['appDataFolder'] }) +
        `\r\n--${boundary}\r\nContent-Type: application/gzip\r\n\r\n`, blob, `\r\n--${boundary}--`]);
      res = await drive('files', { uploadType: 'multipart', fields: 'id,modifiedTime' }, false,
        { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body }, up);
    }
    store.set('tlSync', res.modifiedTime || ''); store.set('tlDirty', '0');
    setStatus(`Cronologia salvata su Drive (${(blob.size / 1048576).toFixed(1)} MB): la ritrovi su ogni dispositivo.`);
    return false;
  }

  if (file && file.modifiedTime !== store.get('tlSync', '')) {
    // un altro dispositivo l'ha aggiornata: la prendo da lì, già pronta
    setStatus('Scarico la Cronologia da Drive…', false, true);
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`, { headers: { Authorization: 'Bearer ' + token.value } });
    if (!res.ok) throw new Error(`Errore Drive (${res.status})`);
    const data = JSON.parse(await gunzip(await res.arrayBuffer()));
    for (const r of local) await DB.del(r.name);
    for (const r of data.records || []) await DB.put({ ...r, source: 'timeline' });
    store.set('tlSync', file.modifiedTime);
    setStatus(`Cronologia scaricata da Drive: ${(data.records || []).length} giorni.`);
    return true;
  }
  return false;
}

async function syncDrive() {
  const btn = $('sync');
  if (btn.disabled) return;
  btn.disabled = true;
  $('quickSync').classList.add('spinning');
  try {
    setStatus('Accesso a Google…');
    await getToken();
    btn.textContent = 'Sincronizza Drive';
    if (!store.get('ghint', '')) {
      try {
        const about = await drive('about', { fields: 'user(emailAddress)' });
        if (about.user?.emailAddress) store.set('ghint', about.user.emailAddress); // resta solo in questo browser
      } catch { /* non indispensabile */ }
    }

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
      files.push(...await listAll(`'${f.id}' in parents and trashed = false and name contains '.gpx'`, 'id,name,modifiedTime,md5Checksum'));
    }
    files = files.filter((f) => /\.gpx$/i.test(f.name));

    const known = new Map((await DB.all()).map((r) => [r.name, r]));
    const todo = files.filter((f) => {
      const r = known.get(f.name);
      // si riscarica solo se il contenuto è cambiato davvero (GPSLogger a volte ricarica file identici)
      return !r || r.source !== 'drive' || recVer(r) !== fileVer(f) || r.pv !== PARSE_VERSION;
    });
    const updatedNames = todo.map((f) => dayLabel(f.name));

    let done = 0, bad = 0;
    const worker = async () => {
      while (todo.length) {
        const f = todo.shift();
        try {
          const text = await drive('files/' + f.id, { alt: 'media' }, true);
          // i tratti già agganciati della versione precedente del file restano a disposizione
          const prev = known.get(f.name);
          const oldRuns = [...(prev?.match?.segs || []).flat(), ...(prev?.oldRuns || [])].filter((r) => r && r.k && r.coords);
          await DB.put({ name: f.name, source: 'drive', modifiedTime: f.modifiedTime, ver: fileVer(f), pv: PARSE_VERSION, segments: parseGpx(text), oldRuns });
        } catch (err) {
          if (/Sessione Google scaduta/.test(err.message)) throw err;
          bad++;
        }
        done++;
        setStatus(`Scarico i file aggiornati… ${done}/${total}`);
      }
    };
    const total = todo.length;
    await Promise.all([worker(), worker(), worker(), worker()]);

    try { await applyRemoteCache(); } catch { /* si aggancia da qui */ }
    let tlChanged = false;
    try { tlChanged = await syncTimeline(); } catch { /* riprova alla prossima sincronizzazione */ }

    await reloadFromDb(total > 0 || tlChanged);
    if (!tlChanged) setStatus(total
      ? `Aggiornato: ${updatedNames.slice(0, 4).join(', ')}${total > 4 ? ` e altri ${total - 4}` : ''}` + (bad ? ` (${bad} con errori)` : '') + '.'
      : 'Già tutto aggiornato ✓');
    store.set('lastSync', new Date().toISOString());
  } catch (err) {
    setStatus(err.message || 'Errore durante la sincronizzazione.', true);
  } finally {
    btn.disabled = false;
    $('quickSync').classList.remove('spinning');
  }
}

$('sync').addEventListener('click', syncDrive);
$('quickSync').addEventListener('click', (e) => { e.stopPropagation(); syncDrive(); });

/* ---------------- Avvio ---------------- */

(async () => {
  await reloadFromDb(true);
  // sul telefono il pannello parte chiuso, così si vede la mappa
  if (allSegments.length && window.innerWidth <= 600) $('panel').classList.add('collapsed');
  if (!allSegments.length) $('settings').open = true; // primo avvio: mostra subito i pulsanti
  if (!allSegments.length) setStatus('Accedi a Google Drive oppure trascina qui i tuoi file GPX.', false, true);
  if (store.get('gAuthorized', '0') === '1') $('sync').textContent = 'Sincronizza Drive';
  if (tokenValid()) {
    // sessione ancora valida: sincronizza da solo quando la libreria Google è pronta
    const wait = setInterval(() => {
      if (window.google?.accounts?.oauth2) { clearInterval(wait); syncDrive(); }
    }, 300);
    setTimeout(() => clearInterval(wait), 10000);
  }
})();
