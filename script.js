/* =========================================================
   1. ВСПОМОГАТЕЛЬНОЕ И ПАРАМЕТРЫ МОДЕЛИ
   ========================================================= */
const $ = (id) => document.getElementById(id);
const fmt = (d) => new Date(d).toISOString().slice(0,16).replace("T"," ");
const HOUR = 3600e3, DAY = 24*HOUR;

const CFG = {
  KP_THRESHOLD: 5,          // Kp >= 5 — геомагнитная буря (G1)
  KP_STEP: 3*HOUR,          // Kp задаётся на 3-часовых интервалах
  MMOD_BUFFER: 15*60e3,     // ± вокруг момента сближения считаем «опасным» (допущение модели)
  MIN_REL_SPEED: 0.5,       // км/с; отсекаем состыкованные/сопутствующие объекты
  TLE_MAX_AGE: 3*DAY,       // дальше SGP4 слишком неточен для поиска сближений
  CACHE_TTL: 2*HOUR,        // CelesTrak обновляет данные раз в ~2 часа
  WINDOW_STEP_H: 2,
  HIST_MIN: Date.UTC(2024,4,1), HIST_MAX: Date.UTC(2024,5,30,23,59,59), // допустимый период исторического режима
  CME_ARRIVAL_UNC_H: 6,     // допущение: ± неопределённость времени прихода CME (проверить на архиве)
  NASA_API_KEY: "DEMO_KEY"  // у DEMO_KEY малая квота — подставьте свой бесплатный ключ api.nasa.gov
};
const kdur = (e) => e.dur || CFG.KP_STEP;   // длительность интервала Kp-записи
const CELESTRAK = "https://celestrak.org/NORAD/elements/gp.php";
const CATALOG_GROUPS = ["active","cosmos-2251-debris","iridium-33-debris","fengyun-1c-debris","cosmos-1408-debris"];

function setStatus(text, isError=false){
  const el = $("status");
  el.textContent = text;
  el.className = isError ? "error" : "loading";
}

async function fetchText(url){
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${new URL(url).hostname}: HTTP ${r.status}`);
  return r.text();
}

// Кэш в localStorage, чтобы не долбить CelesTrak чаще, чем он обновляется
async function cached(key, force, loader){
  if (!force){
    try {
      const o = JSON.parse(localStorage.getItem(key));
      if (o && Date.now() - o.t < CFG.CACHE_TTL) return o.v;
    } catch(_){}
  }
  const v = await loader();
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch(_){}
  return v;
}

const parseUtc = (s) => {
  s = String(s).trim().replace(" ", "T");
  return Date.parse(s.endsWith("Z") ? s : s + "Z");
};

/* =========================================================
   2. КАРТА
   ========================================================= */
const map = L.map("map", { worldCopyJump:true }).setView([0,0], 2);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);
L.tileLayer.provider('Stadia.StamenTonerDark', { attribution: '' }).addTo(map);
let trackLayer = null;
let marker = null;
const conjLayer = L.layerGroup().addTo(map);

function drawTrack(points){
  if (trackLayer) map.removeLayer(trackLayer);
  if (marker) map.removeLayer(marker);
  conjLayer.clearLayers();
  if (!points.length) return;
  const latlngs = points.map(p => [p.lat, p.lon]);
  trackLayer = L.polyline(latlngs, { color:"#4ea1ff", weight:2 }).addTo(map);
  map.fitBounds(trackLayer.getBounds(), { padding:[20,20] });
  marker = L.circleMarker(latlngs[0], {
    radius:5, color:"#fff", fillColor:"#4ea1ff", fillOpacity:1
  }).addTo(map).bindTooltip("Старт");
}

// Красные маркеры: где находилась МКС в момент сближения
function drawConjunctions(satrec, events){
  (events || []).forEach(ev => {
    const t = new Date(ev.tca);
    const pv = satellite.propagate(satrec, t);
    if (!pv.position) return;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
    L.circleMarker([satellite.degreesLat(geo.latitude), satellite.degreesLong(geo.longitude)], {
      radius:6, color:"#ff6b6b", fillColor:"#ff6b6b", fillOpacity:.8
    }).addTo(conjLayer).bindTooltip(`${ev.name}: ${ev.miss.toFixed(1)} км, ${fmt(ev.tca)} UTC`);
  });
}

/* =========================================================
   3. TLE И КАТАЛОГ ОБЪЕКТОВ (CelesTrak)
   ========================================================= */
function parseTLEs(text){
  const L3 = text.split(/\r?\n/).map(s => s.trimEnd()).filter(Boolean);
  const out = [];
  for (let i=0; i+2 < L3.length; i++){
    if (L3[i+1].startsWith("1 ") && L3[i+2].startsWith("2 ")){
      out.push({ name: L3[i].replace(/^0 /,"").trim(), l1: L3[i+1], l2: L3[i+2],
                 id: L3[i+1].substring(2,7).trim() });
      i += 2;
    }
  }
  return out;
}

async function fetchTLE(force){
  return cached("tle25544", force, async () => {
    const [x] = parseTLEs(await fetchText(`${CELESTRAK}?CATNR=25544&FORMAT=TLE`));
    if (!x) throw new Error("Некорректный TLE");
    return { ...x, epochMs: tleEpochMs(x.l1), fetchedAtMs: Date.now() };
  });
}

async function fetchCatalog(force){
  const res = await Promise.allSettled(CATALOG_GROUPS.map(g =>
    cached("cat_"+g, force, () => fetchText(`${CELESTRAK}?GROUP=${g}&FORMAT=TLE`))));
  if (res[0].status !== "fulfilled") throw new Error("каталог CelesTrak недоступен");
  const byId = new Map();
  res.forEach(r => { if (r.status === "fulfilled") parseTLEs(r.value).forEach(o => byId.set(o.id, o)); });
  return [...byId.values()];
}

/* =========================================================
   3b. ИСТОРИЧЕСКИЕ ДАННЫЕ: архив орбит МКС и датированные прогнозы
   ========================================================= */
function tleEpochMs(l1){
  const yy = +l1.substring(18,20), day = +l1.substring(20,32);
  return Date.UTC(yy < 57 ? 2000+yy : 1900+yy, 0, 1) + (day-1)*DAY;
}

// Локальная копия Space-Track GP_HISTORY (создаётся fetch_space_track.py)
let orbitArchive = null;
function setArchive(list, label){
  if (!Array.isArray(list)) throw new Error("ожидался JSON-массив записей GP_HISTORY");
  const recs = list
    .filter(r => String(r.NORAD_CAT_ID || "25544") === "25544")
    .map(r => ({
      name: r.OBJECT_NAME || "ISS (ZARYA)", l1: r.TLE_LINE1, l2: r.TLE_LINE2,
      epochMs: r.EPOCH ? parseUtc(r.EPOCH) : (r.TLE_LINE1 ? tleEpochMs(r.TLE_LINE1) : NaN),
      createdMs: r.CREATION_DATE ? parseUtc(r.CREATION_DATE) : NaN   // момент публикации набора
    }))
    .filter(r => r.l1 && r.l2 && !isNaN(r.epochMs))
    .sort((a,b) => a.epochMs - b.epochMs);
  if (!recs.length) throw new Error("в архиве нет записей с TLE_LINE1/TLE_LINE2");
  orbitArchive = recs;
  $("orbitMeta").textContent =
    `${label}: наборов ${recs.length}, эпохи ${fmt(recs[0].epochMs)} — ${fmt(recs[recs.length-1].epochMs)} UTC`;
}

// replay (cutoffMs задан): только наборы, ОПУБЛИКОВАННЫЕ к отсечению; без даты публикации — непригодны.
// разбор (cutoffMs = null): набор с эпохой, ближайшей к середине окна (реконструкция).
function pickHistoricalTle(startMs, endMs, cutoffMs){
  if (!orbitArchive) return null;
  if (cutoffMs !== null){
    const ok = orbitArchive.filter(r => r.createdMs <= cutoffMs);   // NaN → false
    return ok.length ? ok[ok.length-1] : null;
  }
  const mid = (startMs + endMs) / 2;
  return orbitArchive.reduce((a,b) => Math.abs(b.epochMs-mid) < Math.abs(a.epochMs-mid) ? b : a);
}

// NASA DONKI: прогнозы прихода CME (модель ENLIL). Берём только выпуски с modelCompletionTime ≤ отсечения.
async function fetchDonkiForecasts(cutoffMs){
  const day = (ms) => new Date(ms).toISOString().slice(0,10);
  const url = `https://api.nasa.gov/DONKI/CMEAnalysis?startDate=${day(cutoffMs - 5*DAY)}&endDate=${day(cutoffMs)}`
    + `&mostAccurateOnly=false&completeEntryOnly=true&speed=0&halfAngle=0&catalog=ALL&api_key=${CFG.NASA_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("NASA DONKI: HTTP " + r.status);
  const list = await r.json();
  const latest = new Map();   // для каждого CME — последний выпуск, опубликованный ≤ отсечения
  (Array.isArray(list) ? list : []).forEach(a => (a.enlilList || []).forEach(m => {
    const issued = parseUtc(m.modelCompletionTime), arrival = parseUtc(m.estimatedShockArrivalTime);
    if (isNaN(issued) || isNaN(arrival) || issued > cutoffMs) return;
    const key = a.associatedCMEID || a.time21_5;
    if (!latest.has(key) || latest.get(key).issuedMs < issued)
      latest.set(key, { m, issuedMs:issued, arrivalMs:arrival, cme:key });
  }));
  const unc = CFG.CME_ARRIVAL_UNC_H * HOUR;
  return [...latest.values()].map(({ m, issuedMs, arrivalMs, cme }) => {
    const kps = [m.kp_18, m.kp_90, m.kp_135, m.kp_180].filter(v => v != null).map(Number).filter(Number.isFinite);
    const durH = m.estimatedDuration != null && Number.isFinite(+m.estimatedDuration) ? +m.estimatedDuration : null;
    return { t:arrivalMs - unc, dur:unc + (durH ? durH*HOUR : CFG.KP_STEP),
             kp: kps.length ? Math.max(...kps) : null,   // верхняя оценка по kp_18…kp_180
             kind:"forecast", source:"NASA CCMC DONKI (ENLIL)", issuedMs, arrivalMs, durH, cme };
  }).sort((a,b) => a.t - b.t);
}

/* =========================================================
   4. ТРАЕКТОРИЯ (satellite.js, SGP4)
   ========================================================= */
function computeTrack(satrec, startMs, hours, stepSec=60){
  const points = [];
  for (let s=0; s<=hours*3600; s+=stepSec){
    const t = new Date(startMs + s*1000);
    const pv = satellite.propagate(satrec, t);
    if (!pv.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, satellite.gstime(t));
    points.push({ time:t, lat:satellite.degreesLat(geo.latitude),
                  lon:satellite.degreesLong(geo.longitude), alt:geo.height });
  }
  return points;
}

/* =========================================================
   5. КОСМИЧЕСКАЯ ПОГОДА (Kp)
   NOAA SWPC — наблюдения + прогноз на 3 суток (текущий режим)
   GFZ Potsdam — архив Kp (исторический режим)
   ========================================================= */
function swpcRows(data){
  if (!Array.isArray(data) || !data.length) return [];
  if (!Array.isArray(data[0])) return data;
  const h = data[0];
  return data.slice(1).map(row => Object.fromEntries(h.map((k,i) => [k, row[i]])));
}

async function fetchKpNoaa(){
  const base = "https://services.swpc.noaa.gov/products/";
  const get = async (f) => swpcRows(await (await fetch(base+f)).json());
  const [obs, fc] = await Promise.allSettled([
    get("noaa-planetary-k-index.json"),
    get("noaa-planetary-k-index-forecast.json")
  ]);
  if (obs.status !== "fulfilled" && fc.status !== "fulfilled") throw new Error("NOAA SWPC недоступен");
  const byT = new Map();
  const add = (rows, kindOf) => rows.forEach(r => {
    const t = parseUtc(r.time_tag), kp = parseFloat(r.Kp ?? r.kp);
    if (!isNaN(t) && !isNaN(kp)) byT.set(t, { t, kp, kind:kindOf(r), source:"NOAA SWPC" });
  });
  if (fc.status === "fulfilled")  add(fc.value, r => String(r.observed).toLowerCase() === "predicted" ? "forecast" : "observation");
  if (obs.status === "fulfilled") add(obs.value, () => "observation"); // измеренные значения приоритетнее
  return [...byT.values()].sort((a,b) => a.t - b.t);
}

async function fetchKpGfz(startMs, endMs){
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
  const url = `https://kp.gfz.de/app/json/?start=${iso(startMs - CFG.KP_STEP)}&end=${iso(endMs)}&index=Kp`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("GFZ Potsdam: HTTP " + r.status);
  const j = await r.json();
  if (!j.datetime || !j.Kp) throw new Error("GFZ Potsdam: неожиданный формат ответа");
  return j.datetime
    .map((s,i) => ({ t:parseUtc(s), kp:parseFloat(j.Kp[i]), kind:"observation", source:"GFZ Potsdam" }))
    .filter(e => !isNaN(e.t) && !isNaN(e.kp));
}

/* =========================================================
   6. MMOD — реальный поиск сближений МКС с каталогом объектов
   Метод: SGP4-пропагация МКС и объектов каталога, грубый шаг 30 с,
   затем уточнение момента наибольшего сближения (TCA) поиском минимума.
   ВАЖНО: это скрининг по публичным TLE (ошибка — километры), а не CDM.
   ========================================================= */
const MU = 398600.4418, RE = 6378.137;
function band(rec){ // перигей/апогей над поверхностью, км
  const a = Math.cbrt(MU / Math.pow(rec.no/60, 2));
  return { per: a*(1-rec.ecco) - RE, apo: a*(1+rec.ecco) - RE };
}

// Код воркера (выполняется в отдельном потоке, чтобы не вешать интерфейс)
function conjunctionWorker(){
  importScripts("https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js");
  self.onmessage = (e) => {
    const { iss, objects, startMs, endMs, stepSec, coarseKm, thresholdKm, minRelSpeed } = e.data;
    const issRec = satellite.twoline2satrec(iss[0], iss[1]);
    const st = (rec, ms) => {
      const pv = satellite.propagate(rec, new Date(ms));
      return pv && pv.position && pv.velocity ? pv : null;
    };
    const dist = (a, b) => Math.hypot(a.position.x-b.position.x, a.position.y-b.position.y, a.position.z-b.position.z);
    const stepMs = stepSec*1000;
    const n = Math.floor((endMs-startMs)/stepMs) + 1;
    const issPos = new Float64Array(n*3);
    for (let i=0; i<n; i++){
      const p = st(issRec, startMs + i*stepMs).position;
      issPos[3*i]=p.x; issPos[3*i+1]=p.y; issPos[3*i+2]=p.z;
    }
    const events = [];
    objects.forEach((o, k) => {
      const rec = satellite.twoline2satrec(o[1], o[2]);
      const d = new Float64Array(n);
      for (let i=0; i<n; i++){
        const pv = st(rec, startMs + i*stepMs);
        d[i] = pv ? Math.hypot(pv.position.x-issPos[3*i], pv.position.y-issPos[3*i+1], pv.position.z-issPos[3*i+2]) : Infinity;
      }
      for (let i=0; i<n; i++){
        if (!(d[i] < coarseKm)) continue;
        if (i>0 && !(d[i] < d[i-1])) continue;
        if (i<n-1 && !(d[i] <= d[i+1])) continue;
        let lo = startMs + Math.max(0,i-1)*stepMs, hi = startMs + Math.min(n-1,i+1)*stepMs;
        const f = (t) => { const a=st(rec,t), b=st(issRec,t); return a&&b ? dist(a,b) : Infinity; };
        for (let it=0; it<30; it++){
          const m1 = lo+(hi-lo)/3, m2 = hi-(hi-lo)/3;
          if (f(m1) < f(m2)) hi = m2; else lo = m1;
        }
        const t = (lo+hi)/2, a = st(rec,t), b = st(issRec,t);
        if (!a || !b || t < startMs || t > endMs) continue;
        const miss = dist(a,b);
        const rel = Math.hypot(a.velocity.x-b.velocity.x, a.velocity.y-b.velocity.y, a.velocity.z-b.velocity.z);
        if (miss <= thresholdKm && rel >= minRelSpeed)
          events.push({ name:o[0], id:o[3], tca:t, miss, rel });
      }
      if (k % 20 === 0) self.postMessage({ type:"progress", done:k, total:objects.length });
    });
    self.postMessage({ type:"done", events });
  };
}

function findConjunctions(tle, catalog, startMs, endMs, thresholdKm){
  const issBand = band(satellite.twoline2satrec(tle.l1, tle.l2));
  const margin = thresholdKm + 10;
  // Отбираем только объекты, чья орбита по высоте пересекается с орбитой МКС
  const objects = catalog.filter(o => {
    if (o.id === "25544") return false;
    const b = band(satellite.twoline2satrec(o.l1, o.l2));
    return b.per <= issBand.apo + margin && b.apo >= issBand.per - margin;
  }).map(o => [o.name, o.l1, o.l2, o.id]);

  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([`(${conjunctionWorker})()`], { type:"text/javascript" }));
    const w = new Worker(url);
    const finish = () => { w.terminate(); URL.revokeObjectURL(url); };
    w.onmessage = (e) => {
      if (e.data.type === "progress")
        setStatus(`Поиск сближений: ${Math.round(100*e.data.done/e.data.total)}% (объектов: ${e.data.total})...`);
      else { finish(); resolve({ events:e.data.events, checked:objects.length }); }
    };
    w.onerror = (e) => { finish(); reject(new Error("ошибка воркера: " + (e.message || "неизвестно"))); };
    w.postMessage({ iss:[tle.l1, tle.l2], objects, startMs, endMs, stepSec:30, coarseKm:260,
                    thresholdKm, minRelSpeed:CFG.MIN_REL_SPEED });
  });
}

/* =========================================================
   7. АНАЛИЗ: пересечение рисков с окном ВКД
   ========================================================= */
// Длина объединения интервалов внутри [ws, we], в минутах (без двойного счёта)
function unionMinutes(ws, we, intervals){
  const parts = intervals
    .map(i => [Math.max(ws, i.from), Math.min(we, i.to)])
    .filter(p => p[1] > p[0]).sort((a,b) => a[0]-b[0]);
  let sum = 0, cur = null;
  for (const p of parts){
    if (!cur || p[0] > cur[1]){ if (cur) sum += cur[1]-cur[0]; cur = [...p]; }
    else cur[1] = Math.max(cur[1], p[1]);
  }
  if (cur) sum += cur[1]-cur[0];
  return sum / 60000;
}

function windowScore(riskMinutes, durationMin, comp){
  if (comp === 0) return { label:"Нет данных", cls:"unknown" };
  const ratio = riskMinutes / durationMin;
  if (ratio === 0) return { label:"Хорошо", cls:"good" };
  if (ratio < 0.15) return { label:"Приемлемо", cls:"warn" };
  if (ratio < 0.40) return { label:"Рискованно", cls:"warn" };
  return { label:"Не рекомендуется", cls:"bad" };
}

/* =========================================================
   8. ТАЙМЛАЙН (Chart.js): Kp + число сближений по часам
   ========================================================= */
let timelineChart = null;
function drawTimeline(kpRange, mmod, startMs, hours){
  const labels = [], kpData = [], conjData = [];
  for (let h=0; h<=hours; h++){
    const t0 = startMs + h*HOUR, t1 = t0 + HOUR;
    labels.push(new Date(t0).toISOString().slice(5,16).replace("T"," "));
    const k = kpRange.find(e => e.t <= t0 && e.t + kdur(e) > t0);
    kpData.push(k && Number.isFinite(k.kp) ? k.kp : null);
    conjData.push(mmod ? mmod.filter(ev => ev.tca >= t0 && ev.tca < t1).length : null);
  }
  if (timelineChart) timelineChart.destroy();
  timelineChart = new Chart($("timeline").getContext("2d"), {
    type: "line",
    data: { labels, datasets: [
      { label:"Kp-индекс", data:kpData, borderColor:"#f1c40f", backgroundColor:"rgba(241,196,15,0.15)",
        stepped:true, spanGaps:true, yAxisID:"y" },
      { type:"bar", label:"Сближения (шт/час)", data:conjData, backgroundColor:"#ff6b6b", yAxisID:"y2" }
    ]},
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ labels:{ color:"#e7ecf5" } } },
      scales:{
        x:{ ticks:{ color:"#8b97b5", maxTicksLimit:12 }, grid:{ color:"#26304f" } },
        y:{ min:0, max:9, ticks:{ color:"#8b97b5" }, grid:{ color:"#26304f" } },
        y2:{ position:"right", min:0, suggestedMax:3, ticks:{ color:"#8b97b5", stepSize:1 }, grid:{ display:false } }
      }
    }
  });
}

/* =========================================================
   9. ПРЕДУПРЕЖДЕНИЯ
   ========================================================= */
function renderWarnings(ctx){
  const { kpRange, kpErr, kpSource, mmod, mmodNote, thrKm, replay, cutoffMs } = ctx;
  const items = [];
  const KP_LIMITS = "Kp — косвенный (прокси) показатель геомагнитной обстановки: он не измеряет радиацию на МКС и не описывает солнечные протонные события (шкала S) — это другое явление.";

  if (kpErr) {
    items.push({ risk:false, title:"Данные Kp недоступны", period:"—", source:kpSource, kind:"observation",
      rule:"—", confidence:kpErr, limits:KP_LIMITS });
  } else if (replay) {
    if (!kpRange.length) items.push({
      risk:false, title:"До момента отсечения прогнозов прихода CME на этот интервал не найдено",
      period:"на всём интервале", source:kpSource, kind:"forecast",
      rule:`Выпуски с отметкой публикации ≤ ${fmt(cutoffMs)} UTC`,
      confidence:"ограничена: покрыты только бури от CME; бури от высокоскоростных потоков не покрыты", limits:KP_LIMITS });
    kpRange.forEach(e => {
      const known = Number.isFinite(e.kp);
      const chk = e.check == null ? "проверка по факту: данных GFZ нет"
        : `проверка по факту (GFZ, в расчёт не входит): max Kp = ${e.check}`;
      items.push({
        risk: known && e.kp >= CFG.KP_THRESHOLD,
        title: known ? `Ожидается приход CME: верхняя оценка Kp ${e.kp}` : "Ожидается приход CME, оценка Kp в выпуске не указана",
        period: `приход ${fmt(e.arrivalMs)} UTC (±${CFG.CME_ARRIVAL_UNC_H} ч), длительность ${e.durH ?? "не указана"} ч · выпуск ${fmt(e.issuedMs)} UTC · ${chk}`,
        source: kpSource, kind:"forecast",
        rule: `Kp ≥ ${CFG.KP_THRESHOLD} (максимум по kp_18…kp_180 модели ENLIL)`,
        confidence: "низкая–средняя: модельный прогноз, время прихода известно с ошибкой в часы",
        limits: KP_LIMITS });
    });
  } else if (!kpRange.length) {
    items.push({ risk:false, title:"Нет данных Kp на выбранный интервал", period:"—", source:kpSource,
      kind:"observation", rule:"—", confidence:"данных нет — оценка невозможна", limits:KP_LIMITS });
  } else {
    const risky = kpRange.filter(e => e.kp >= CFG.KP_THRESHOLD);
    const isFc = (list) => list.some(e => e.kind === "forecast");
    if (risky.length){
      items.push({
        risk:true, title:`Геомагнитная активность: Kp до ${Math.max(...risky.map(e => e.kp))}`,
        period:`${fmt(risky[0].t)} — ${fmt(risky[risky.length-1].t + CFG.KP_STEP)} UTC`,
        source:kpSource, kind:isFc(risky) ? "forecast" : "observation",
        rule:`Kp ≥ ${CFG.KP_THRESHOLD} — геомагнитная буря`,
        confidence: isFc(risky) ? "средняя (прогноз NOAA)" : "высокая (измерения)", limits:KP_LIMITS
      });
    } else {
      items.push({
        risk:false, title:"Геомагнитная активность в норме", period:"на всём интервале",
        source:kpSource, kind:isFc(kpRange) ? "forecast" : "observation",
        rule:`Kp < ${CFG.KP_THRESHOLD}`, confidence:isFc(kpRange) ? "средняя (часть интервала — прогноз)" : "высокая (измерения)",
        limits:KP_LIMITS
      });
    }
  }

  if (!mmod) {
    items.push({ risk:false, title:"Сближения не рассчитаны", period:"—", source:"CelesTrak + SGP4",
      kind:"calculation", rule:"—", confidence:mmodNote });
  } else if (!mmod.length) {
    items.push({ risk:false, title:`Сближений ближе ${thrKm} км не найдено`, period:"на всём интервале",
      source:"CelesTrak + SGP4", kind:"calculation", rule:`Расстояние < ${thrKm} км`,
      confidence:"низкая–средняя (скрининг по TLE)",
      limits:"Видны только каталогизированные объекты; мелкие фрагменты не отслеживаются, поэтому отсутствие сближений не означает отсутствия MMOD-риска." });
  } else {
    mmod.forEach(ev => items.push({
      risk:true, title:`Сближение с ${ev.name} (NORAD ${ev.id}): ${ev.miss.toFixed(1)} км`,
      period:`${fmt(ev.tca)} UTC · относ. скорость ${ev.rel.toFixed(1)} км/с`,
      source:"расчёт SGP4 по каталогу CelesTrak", kind:"calculation",
      rule:`Расстояние < ${thrKm} км; риск ±${CFG.MMOD_BUFFER/60000} мин от момента сближения`,
      confidence:"низкая–средняя (погрешность TLE — километры; это не CDM)",
      limits:"Сближение относится к станции и отслеживаемому объекту; это не вероятность попадания фрагмента в космонавта. Интервал ±15 мин — допущение модели."
    }));
  }

  const badge = { observation:"obs", forecast:"forecast", calculation:"calc" };
  $("warnings").innerHTML = items.map(it => `
    <div class="warning ${it.risk ? "risk":""}">
      <div class="head">
        <strong>${it.title}</strong>
        <span class="badge ${badge[it.kind]}">${it.kind}</span>
      </div>
      <div>Период: ${it.period}</div>
      <div class="src">Источник: ${it.source} · Правило: ${it.rule} · Уверенность: ${it.confidence}</div>
      ${it.limits ? `<div class="src">Ограничения: ${it.limits}</div>` : ""}
    </div>`).join("");
}

/* =========================================================
   10. ТАБЛИЦА ОКОН
   ========================================================= */
function renderWindows(windows, durationMin){
  const tbody = document.querySelector("#windowsTable tbody");
  if (!windows.length){
    tbody.innerHTML = '<tr><td colspan="5" style="color:var(--muted);">Нет окон.</td></tr>';
    return;
  }
  const best = windows[0].comp > 0 ? windows[0] : null; // отсортировано: полнота данных, затем риск
  const compLabel = ["нет данных", "частичная", "полная"];
  tbody.innerHTML = windows.map(w => {
    const score = windowScore(w.risky, durationMin, w.comp);
    const isBest = w === best;
    return `
      <tr class="${isBest ? "selected":""}">
        <td>${fmt(w.start)}</td>
        <td>${fmt(w.end)}</td>
        <td>${w.risky.toFixed(0)}</td>
        <td>${compLabel[w.comp]}</td>
        <td><span class="pill ${score.cls}">${score.label}${isBest?" ★":""}</span></td>
      </tr>`;
  }).join("");
}

/* =========================================================
   11. ГЛАВНЫЙ СЦЕНАРИЙ
   ========================================================= */
async function run(force=false){
  const mode = $("mode").value, hist = mode === "historical";
  const replay = hist && $("histKind").value === "replay";
  const startStr = $("start").value;
  const startMs = startStr ? Date.parse(startStr+"Z") : (hist ? Date.UTC(2024, 4, 10) : Date.now());
  const durationH = Math.max(1, Math.min(8,  parseInt($("duration").value)     || 4));
  const searchH   = Math.max(1, Math.min(24, parseInt($("searchWindow").value) || 24));
  const thrKm     = Math.max(1, Math.min(25, parseFloat($("conjThreshold").value) || 5));
  const durationMin = durationH*60, totalH = searchH + durationH, endMs = startMs + totalH*HOUR;

  // Ограничение дат и момент отсечения (исторический режим)
  let cutoffMs = null;
  if (hist){
    const inRange = (ms) => ms >= CFG.HIST_MIN && ms <= CFG.HIST_MAX;
    if (!inRange(startMs)){
      setStatus("Исторический режим: начало ВКД должно быть в пределах 1 мая — 30 июня 2024 (UTC).", true); return;
    }
    if (replay){
      const cs = $("cutoff").value;
      cutoffMs = cs ? Date.parse(cs+"Z") : startMs;
      if (!inRange(cutoffMs)){
        setStatus("Момент отсечения должен быть в пределах 1 мая — 30 июня 2024 (UTC).", true); return;
      }
      if (cutoffMs > startMs){
        setStatus("Момент отсечения не может быть позже начала ВКД.", true); return;
      }
    }
  }

  // Орбита: в историческом режиме — только из архива, текущий TLE не подставляется
  let tle = null;
  if (!hist){
    setStatus("Загрузка TLE МКС...");
    try { tle = await fetchTLE(force); }
    catch(e){ setStatus("Ошибка TLE: "+e.message, true); return; }
  } else {
    tle = pickHistoricalTle(startMs, endMs, cutoffMs);
  }
  const satrec = tle ? satellite.twoline2satrec(tle.l1, tle.l2) : null;
  const ageMs = tle ? Math.max(Math.abs(startMs - tle.epochMs), Math.abs(endMs - tle.epochMs)) : Infinity;
  const tleOk = !!tle && ageMs <= CFG.TLE_MAX_AGE;
  const farNote = tleOk ? "" : " · ⚠ эпоха далеко от окна: траектория приблизительная";
  if (!hist){
    $("tleMeta").textContent =
      `Источник: CelesTrak (NORAD 25544) · Эпоха TLE: ${fmt(tle.epochMs)} UTC · Получено: ${fmt(tle.fetchedAtMs)} UTC` + farNote;
  } else if (!tle){
    $("tleMeta").textContent = orbitArchive
      ? "⚠ В архиве нет набора элементов, пригодного для этого запроса (для replay нужен набор, опубликованный ≤ отсечения). Траектория не показывается; текущий TLE не подставляется."
      : "⚠ Архив орбит МКС не загружен (блок «Архив орбит» слева). Траектория не показывается; текущий TLE на историческую дату не подставляется.";
  } else {
    $("tleMeta").textContent =
      `Архив GP_HISTORY · эпоха ${fmt(tle.epochMs)} UTC · публикация: ${isNaN(tle.createdMs) ? "неизвестна" : fmt(tle.createdMs)+" UTC"} · `
      + (replay ? "строгий replay: только наборы, опубликованные ≤ момента отсечения"
                : "разбор: набор выбран по ближайшей эпохе (реконструкция, дата публикации не ограничена)") + farNote;
  }

  // Kp
  setStatus("Загрузка индекса Kp...");
  let kpSource, kpAll = [], kpErr = null, kpCoverAll = false;
  try {
    if (!hist){ kpSource = "NOAA SWPC"; kpAll = await fetchKpNoaa(); }
    else if (!replay){ kpSource = "GFZ Potsdam (архив, разбор)"; kpAll = await fetchKpGfz(startMs, endMs); }
    else {
      kpSource = "NASA CCMC DONKI (прогнозы, выпуск ≤ отсечения)";
      kpAll = await fetchDonkiForecasts(cutoffMs);
      kpCoverAll = true;   // выпуски получены: «событий не ожидалось» ≠ «нет данных»
      try {                // факт — только для проверки, в расчёт не входит
        const obs = await fetchKpGfz(startMs - DAY, endMs + DAY);
        kpAll.forEach(e => {
          const o = obs.filter(g => g.t < e.t + kdur(e) && g.t + CFG.KP_STEP > e.t);
          e.check = o.length ? Math.max(...o.map(g => g.kp)) : null;
        });
      } catch(_){}
    }
  } catch(e){ kpErr = e.message; }
  const kpRange = kpAll.filter(e => e.t < endMs && e.t + kdur(e) > startMs);

  // Траектория
  setStatus("Расчёт траектории...");
  drawTrack(satrec ? computeTrack(satrec, startMs, totalH, 60) : []);

  // Сближения (MMOD)
  let mmod = null, mmodNote = "", checked = 0;
  if (hist){
    mmodNote = "в историческом режиме сближения не рассчитываются: нет архивных TLE объектов каталога на эту дату (нужен GP_HISTORY по всему каталогу)";
  } else if (!tleOk){
    mmodNote = `TLE (эпоха ${fmt(tle.epochMs)} UTC) слишком далёк от выбранной даты`;
  } else {
    try {
      setStatus("Загрузка каталога объектов CelesTrak...");
      const catalog = await fetchCatalog(force);
      const res = await findConjunctions(tle, catalog, startMs, endMs, thrKm);
      checked = res.checked;
      mmod = res.events
        .map(ev => ({ ...ev, from: ev.tca - CFG.MMOD_BUFFER, to: ev.tca + CFG.MMOD_BUFFER }))
        .sort((a,b) => a.tca - b.tca);
    } catch(e){ mmodNote = "расчёт не выполнен: " + e.message; }
  }
  drawConjunctions(satrec, mmod);

  // Сравнение окон
  setStatus("Сравнение окон...");
  const iv = (e) => ({ from:e.t, to:e.t + kdur(e) });
  const kpIntervals = kpAll.map(iv);
  const riskIntervals = [
    ...kpAll.filter(e => e.kp >= CFG.KP_THRESHOLD).map(iv),
    ...(mmod || []).map(e => ({ from:e.from, to:e.to }))
  ];
  const windows = [];
  for (let off=0; off<=searchH; off+=CFG.WINDOW_STEP_H){
    const ws = startMs + off*HOUR, we = ws + durationH*HOUR;
    const kpFull = kpCoverAll ? !kpErr : unionMinutes(ws, we, kpIntervals) >= durationMin*0.99;
    windows.push({
      start:ws, end:we, risky:unionMinutes(ws, we, riskIntervals),
      comp:(kpFull ? 1 : 0) + (mmod ? 1 : 0)
    });
  }
  windows.sort((a,b) => b.comp - a.comp || a.risky - b.risky);

  drawTimeline(kpRange, mmod, startMs, totalH);
  renderWindows(windows, durationMin);
  renderWarnings({ kpRange, kpErr, kpSource, mmod, mmodNote, thrKm, replay, cutoffMs });

  // Карточки
  const kpVals = kpRange.map(e => e.kp).filter(Number.isFinite);
  if (kpVals.length){
    const nFc = kpRange.filter(e => e.kind === "forecast").length;
    $("kpValue").textContent = Math.max(...kpVals).toFixed(1);
    $("kpMeta").textContent = `Максимум за интервал · ${kpSource} · записей: ${kpRange.length}, из них прогноз: ${nFc}`;
  } else {
    $("kpValue").textContent = "—";
    $("kpMeta").textContent = kpErr || (replay ? "прогнозов с оценкой Kp до отсечения нет" : "нет данных");
  }
  $("mmodValue").textContent = mmod ? mmod.length : "—";
  $("mmodMeta").textContent = mmod
    ? `Расчёт SGP4 по каталогу CelesTrak · проверено объектов: ${checked} · порог ${thrKm} км`
    : mmodNote;

  const best = windows[0] && windows[0].comp > 0 ? windows[0] : null;
  const modeLabel = !hist ? "текущая обстановка" : replay ? `replay, отсечение ${fmt(cutoffMs)} UTC` : "исторический разбор";
  setStatus(
    `Режим: ${modeLabel}. ` +
    (best ? `Окон: ${windows.length}. Лучшее: ${fmt(best.start)} UTC.`
          : "Данных для оценки окон недостаточно.")
    + (kpErr ? ` Kp: ${kpErr}.` : ""),
    !best || !!kpErr
  );
}

/* =========================================================
   12. ИНИЦИАЛИЗАЦИЯ
   ========================================================= */
function initForm(){
  // поле подписано «UTC», поэтому заполняем именно UTC-временем
  const now = new Date();
  now.setUTCMinutes(0, 0, 0);
  $("start").value = now.toISOString().slice(0,16);
}
initForm();

$("runBtn").addEventListener("click", () => {
  run().catch(e => setStatus("Ошибка: "+e.message, true));
});
$("reloadBtn").addEventListener("click", () => {
  setStatus("Принудительное обновление...");
  run(true).catch(e => setStatus("Ошибка: "+e.message, true));
});

function onModeChange(){
  const h = $("mode").value === "historical", st = $("start");
  $("histBox").style.display = h ? "" : "none";
  $("cutoffBox").style.display = h && $("histKind").value === "replay" ? "" : "none";
  if (h){
    st.min = "2024-05-01T00:00"; st.max = "2024-06-30T23:59";
    const v = Date.parse(st.value + "Z");
    if (!st.value || v < CFG.HIST_MIN || v > CFG.HIST_MAX) st.value = "2024-05-10T00:00";
  } else if (st.min){
    st.removeAttribute("min"); st.removeAttribute("max"); initForm();
  }
}
$("mode").addEventListener("change", onModeChange);
$("histKind").addEventListener("change", onModeChange);
onModeChange();

$("orbitFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try { setArchive(JSON.parse(await f.text()), f.name); }
  catch(err){ $("orbitMeta").textContent = "Ошибка архива: " + err.message; }
});
// Автоподхват архива орбит:
// 1) data/iss_gp_history.js (подключён тегом <script>, работает и при открытии index.html с диска);
// 2) data/iss_gp_history.json (работает, если страница открыта через сервер).
if (Array.isArray(window.ISS_GP_HISTORY)){
  try { setArchive(window.ISS_GP_HISTORY, "data/iss_gp_history.js"); }
  catch(err){ $("orbitMeta").textContent = "Ошибка архива: " + err.message; }
} else {
  fetch("data/iss_gp_history.json").then(r => r.ok ? r.json() : Promise.reject())
    .then(j => setArchive(j, "data/iss_gp_history.json")).catch(() => {});
}
