/* =========================================================
   1. ВСПОМОГАТЕЛЬНОЕ
   ========================================================= */
const $ = (id) => document.getElementById(id);
const fmt = (d) => new Date(d).toISOString().slice(0,16).replace("T"," ");

function setStatus(text, isError=false){
  const el = $("status");
  el.textContent = text;
  el.className = isError ? "error" : "loading";
}

/* =========================================================
   2. КАРТА
   ========================================================= */
const map = L.map("map", { worldCopyJump:true }).setView([0,0], 2);
L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
  attribution: "&copy; OpenStreetMap &copy; CARTO"
}).addTo(map);
let trackLayer = null;
let marker = null;

function drawTrack(points){
  if (trackLayer) map.removeLayer(trackLayer);
  if (marker) map.removeLayer(marker);
  if (!points.length) return;
  const latlngs = points.map(p => [p.lat, p.lon]);
  trackLayer = L.polyline(latlngs, { color:"#4ea1ff", weight:2 }).addTo(map);
  map.fitBounds(trackLayer.getBounds(), { padding:[20,20] });
  marker = L.circleMarker(latlngs[0], {
    radius:5, color:"#fff", fillColor:"#4ea1ff", fillOpacity:1
  }).addTo(map).bindTooltip("Старт");
}

/* =========================================================
   3. ЗАГРУЗКА TLE (CelesTrak)
   ========================================================= */
async function fetchTLE(){
  const url = "https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE";
  const r = await fetch(url);
  if (!r.ok) throw new Error("CelesTrak недоступен");
  const text = await r.text();
  const lines = text.split("\n").map(l=>l.trim()).filter(Boolean);
  if (lines.length < 3) throw new Error("Некорректный TLE");
  return {
    name: lines[0],
    line1: lines[1],
    line2: lines[2],
    epoch: lines[1].substring(18,32),
    source: url,
    fetchedAt: new Date()
  };
}

/* =========================================================
   4. РАСЧЁТ ТРАЕКТОРИИ (satellite.js, SGP4)
   ========================================================= */
function computeTrack(tle, startDate, hours, stepSec=60){
  const satrec = satellite.twoline2rv(tle.line1, tle.line2);
  const points = [];
  const total = hours*3600;
  for (let s=0; s<=total; s+=stepSec){
    const t = new Date(startDate.getTime() + s*1000);
    const gmst = satellite.gstime(t);
    const pv = satellite.propagate(satrec, t);
    if (!pv.position) continue;
    const geo = satellite.eciToGeodetic(pv.position, gmst);
    points.push({
      time: t,
      lat: satellite.degreesLat(geo.latitude),
      lon: satellite.degreesLong(geo.longitude),
      alt: geo.height
    });
  }
  return points;
}

/* =========================================================
   5. КОСМИЧЕСКАЯ ПОГОДА (NOAA SWPC)
   ========================================================= */
async function fetchKp(){
  const url = "https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json";
  const r = await fetch(url);
  if (!r.ok) throw new Error("NOAA SWPC недоступен");
  const data = await r.json();
  const header = data[0];
  const rows = data.slice(1);
  return rows.map(row => {
    const rec = {};
    header.forEach((h,i)=>rec[h]=row[i]);
    const t = new Date(rec.time_tag.replace(" ","T")+"Z");
    return {
      time: t,
      kp: parseFloat(rec.Kp || rec.kp || 0),
      source: "NOAA SWPC",
      kind: "observation"
    };
  }).filter(x => !isNaN(x.kp));
}

/* =========================================================
   6. MMOD — упрощённо (заглушка с порогом по Kp/времени)
   В реальном проекте — CelesTrak SOCRATES API.
   ========================================================= */
function syntheticMMOD(track){
  // Для демо: помечаем 2 случайных окна как "риск сближения"
  // В финале заменить на реальный SOCRATES.
  const step = Math.floor(track.length/3);
  return [
    { from: track[step]?.time, to: track[step+5]?.time, value: 0.8,
      threshold: 0.5, source: "demo (SOCRATES placeholder)", kind: "forecast" },
    { from: track[2*step]?.time, to: track[2*step+5]?.time, value: 0.3,
      threshold: 0.5, source: "demo (SOCRATES placeholder)", kind: "forecast" }
  ].filter(x => x.from && x.to);
}

/* =========================================================
   7. АНАЛИЗ: пересечение событий с окном ВКД
   ========================================================= */
function intersectMinutes(winStart, winEnd, events, thresholdKey="threshold"){
  let risky = 0;
  let matched = [];
  events.forEach(ev => {
    const thr = ev[thresholdKey];
    if (ev.value < thr) return;
    const t0 = Math.max(winStart.getTime(), new Date(ev.from).getTime());
    const t1 = Math.min(winEnd.getTime(), new Date(ev.to).getTime());
    if (t1 > t0){
      risky += (t1 - t0) / 60000;
      matched.push(ev);
    }
  });
  return { risky, matched };
}

function windowScore(riskMinutes, durationMin){
  const ratio = riskMinutes / durationMin;
  if (ratio === 0) return { label:"Хорошо", cls:"good" };
  if (ratio < 0.15) return { label:"Приемлемо", cls:"warn" };
  if (ratio < 0.40) return { label:"Рискованно", cls:"warn" };
  return { label:"Не рекомендуется", cls:"bad" };
}

/* =========================================================
   8. ТАЙМЛАЙН (Chart.js)
   ========================================================= */
let timelineChart = null;
function drawTimeline(kpEvents, track, startDate, hours){
  const labels = [];
  const kpData = [];
  const trackSet = new Set(track.map(p => p.time.toISOString().slice(0,16)));

  for (let h=0; h<=hours; h++){
    const t = new Date(startDate.getTime() + h*3600*1000);
    const key = t.toISOString().slice(0,16);
    labels.push(t.toISOString().slice(11,16));
    const kp = kpEvents.find(e => e.time.toISOString().slice(0,16) === key);
    kpData.push(kp ? kp.kp : null);
  }

  if (timelineChart) timelineChart.destroy();
  const ctx = $("timeline").getContext("2d");
  timelineChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "Kp-индекс",
          data: kpData,
          borderColor: "#f1c40f",
          backgroundColor: "rgba(241,196,15,0.15)",
          spanGaps: true,
          tension: 0.3
        }
      ]
    },
    options: {
      responsive:true, maintainAspectRatio:false,
      plugins:{ legend:{ labels:{ color:"#e7ecf5" } } },
      scales:{
        x:{ ticks:{ color:"#8b97b5" }, grid:{ color:"#26304f" } },
        y:{ min:0, max:9, ticks:{ color:"#8b97b5" }, grid:{ color:"#26304f" } }
      }
    }
  });
}

/* =========================================================
   9. ПРЕДУПРЕЖДЕНИЯ
   ========================================================= */
function renderWarnings(kpEvents, mmodEvents, windows){
  const box = $("warnings");
  const items = [];

  // Kp предупреждения: Kp >= 5
  const kpRisk = kpEvents.filter(e => e.kp >= 5);
  if (kpRisk.length){
    const first = kpRisk[0], last = kpRisk[kpRisk.length-1];
    items.push({
      risk:true, title:`Геомагнитная активность: Kp до ${Math.max(...kpRisk.map(e=>e.kp))}`,
      period:`${fmt(first.time)} — ${fmt(last.time)} UTC`,
      source:"NOAA SWPC", kind:"observation",
      rule:"Kp ≥ 5 — геомагнитная буря",
      confidence:"средняя (один источник, без прогноза)"
    });
  } else {
    items.push({
      risk:false, title:"Геомагнитная активность в норме",
      period:"на всём интервале",
      source:"NOAA SWPC", kind:"observation",
      rule:"Kp < 5", confidence:"средняя"
    });
  }

  // MMOD
  mmodEvents.forEach(ev => {
    if (ev.value >= ev.threshold){
      items.push({
        risk:true, title:"Возможное сближение с объектом",
        period:`${fmt(ev.from)} — ${fmt(ev.to)} UTC`,
        source:ev.source, kind:ev.kind,
        rule:`Порог ${ev.threshold}`,
        confidence:"низкая (демо-источник, требует замены на SOCRATES)"
      });
    }
  });

  if (!items.length){
    box.innerHTML = '<div style="color:var(--muted);font-size:13px;">Предупреждений нет.</div>';
    return;
  }

  box.innerHTML = items.map(it => `
    <div class="warning ${it.risk ? "risk":""}">
      <div class="head">
        <strong>${it.title}</strong>
        <span class="badge ${it.kind==="observation"?"obs":"forecast"}">${it.kind}</span>
      </div>
      <div>Период: ${it.period}</div>
      <div class="src">Источник: ${it.source} · Правило: ${it.rule} · Уверенность: ${it.confidence}</div>
    </div>
  `).join("");
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
  // Лучшее окно — минимальный риск
  const best = windows.reduce((a,b) => a.risky <= b.risky ? a : b);
  tbody.innerHTML = windows.map(w => {
    const score = windowScore(w.risky, durationMin);
    const isBest = w === best;
    return `
      <tr class="${isBest ? "selected":""}">
        <td>${fmt(w.start)}</td>
        <td>${fmt(w.end)}</td>
        <td>${w.risky.toFixed(0)}</td>
        <td>${w.completeness}</td>
        <td><span class="pill ${score.cls}">${score.label}${isBest?" ★":""}</span></td>
      </tr>
    `;
  }).join("");
}

/* =========================================================
   11. ГЛАВНЫЙ СЦЕНАРИЙ
   ========================================================= */
async function run(){
  setStatus("Загрузка TLE...");
  let tle;
  try { tle = await fetchTLE(); }
  catch(e){ setStatus("Ошибка TLE: "+e.message, true); return; }

  $("tleMeta").textContent =
    `Источник: ${tle.source} · Эпоха: ${tle.epoch} · Получено: ${tle.fetchedAt.toISOString()}`;

  setStatus("Загрузка космической погоды...");
  let kpEvents = [];
  try { kpEvents = await fetchKp(); }
  catch(e){ setStatus("Ошибка NOAA: "+e.message, true); }

  // Параметры запроса
  const mode = $("mode").value;
  const startStr = $("start").value;
  let startDate = startStr ? new Date(startStr+"Z") : new Date();
  if (mode === "historical" && !startStr){
    startDate = new Date("2024-05-10T00:00:00Z"); // пример: сильная буря мая 2024
  }
  const durationH = Math.max(1, Math.min(8, parseInt($("duration").value)||4));
  const searchH   = Math.max(1, Math.min(24, parseInt($("searchWindow").value)||24));
  const durationMin = durationH*60;

  setStatus("Расчёт траектории...");
  const track = computeTrack(tle, startDate, searchH + durationH, 60);
  drawTrack(track);

  setStatus("Формирование событий...");
  const mmod = syntheticMMOD(track);

  // Сравнение окон: сдвигаем старт каждые 2 часа в пределах searchH
  const stepH = 2;
  const windows = [];
  for (let off=0; off<=searchH-durationH; off+=stepH){
    const wStart = new Date(startDate.getTime() + off*3600*1000);
    const wEnd   = new Date(wStart.getTime() + durationH*3600*1000);
    const kpWin = kpEvents.filter(e => e.time >= wStart && e.time <= wEnd);
    const r1 = intersectMinutes(wStart, wEnd, kpWin.map(e=>({
      from:e.time, to:new Date(e.time.getTime()+3*3600*1000),
      value:e.kp, threshold:5
    })));
    const r2 = intersectMinutes(wStart, wEnd, mmod);
    const risky = r1.risky + r2.risky;
    const completeness = (kpWin.length > 0 ? 1 : 0) + (mmod.length > 0 ? 1 : 0);
    windows.push({
      start:wStart, end:wEnd, risky,
      completeness: completeness === 2 ? "полная" : completeness === 1 ? "частичная" : "нет данных"
    });
  }
  windows.sort((a,b)=>a.risky-b.risky);

  drawTimeline(kpEvents, track, startDate, searchH + durationH);
  renderWindows(windows, durationMin);
  renderWarnings(kpEvents, mmod, windows);

  // Карточки
  const lastKp = kpEvents[kpEvents.length-1];
  $("kpValue").textContent = lastKp ? lastKp.kp.toFixed(1) : "—";
  $("kpMeta").textContent  = lastKp
    ? `Источник: ${lastKp.source} · ${fmt(lastKp.time)} UTC`
    : "нет данных";

  $("mmodValue").textContent = mmod.filter(e=>e.value>=e.threshold).length;
  $("mmodMeta").textContent  = "Источник: демо-заглушка (заменить на SOCRATES)";

  setStatus(`Готово. Окон: ${windows.length}. Лучшее: ${fmt(windows[0].start)} UTC.`);
}

/* =========================================================
   12. ИНИЦИАЛИЗАЦИЯ
   ========================================================= */
function initForm(){
  const now = new Date();
  now.setMinutes(0,0,0);
  const iso = new Date(now.getTime() - now.getTimezoneOffset()*60000)
    .toISOString().slice(0,16);
  $("start").value = iso;
}
initForm();

$("runBtn").addEventListener("click", () => {
  run().catch(e => setStatus("Ошибка: "+e.message, true));
});
$("reloadBtn").addEventListener("click", () => {
  setStatus("Принудительное обновление...");
  run().catch(e => setStatus("Ошибка: "+e.message, true));
});