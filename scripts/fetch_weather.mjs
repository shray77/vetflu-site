#!/usr/bin/env node
/**
 * vetflu fetch_weather.mjs — фаза 2: погодные множители W (форс-миграции) и P (персистентность).
 *
 * Нормы: архив Open-Meteo 2015–2024 (temperature_2m_mean), агрегация по календарной дате
 * (MM-DD) → кэш в data/climate_cache.json (нормы не меняются, качаются один раз).
 * Текущие: прогноз Open-Meteo (past_days=7 + forecast_days=7) — одним батч-запросом
 * на все 12 точек. При недоступности API текущие данные пишутся как null
 * (vitрина честно показывает «погода: нет данных», Actions доберёт на следующем прогоне).
 *
 * Формулы (эвристики, не калиброванная эпидемиология):
 *   A = clamp(−аномалия/8, 0, 1)         — аномалия холода за 7 дней против нормы
 *   F = доля суток с Tmin<0 за 14 дней   — прокси ледостава/снега
 *   W = clamp(0.6·A + 0.4·F, 0, 1)       — погодный форсаж движений
 *   P = clamp(1 − (T+5)/40, 0.25, 1)     — персистентность H5N1 (холодная вода = дольше)
 *   Итог: R = M × MW, MW = 0.70 + 0.45·W + 0.25·P  (погода ±40%/−30% к миграционной базе)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const P = JSON.parse(readFileSync(join(ROOT, "data", "points.json"), "utf8"));
const CACHE_FILE = join(ROOT, "data", "climate_cache.json");
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, "utf8")) : {};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const mdKey = (iso) => { const [, m, d] = iso.split("-"); return `${m}-${d}`; };

async function getJson(url, tries = 3) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j.error) throw new Error(j.reason || "API error");
      return j;
    } catch (e) { err = e; }
  }
  throw err;
}

// разворачиваем точки в плоский список (стабильный порядок)
const flat = [];
for (const [fw, pts] of Object.entries(P.flyways)) for (const p of pts) flat.push({ ...p, fw });

// 1) климатические нормы (кэш навсегда)
let normsFetched = 0;
await Promise.all(flat.map(async (p) => {
  if (cache[p.id]?.norm) return;
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${p.lat}&longitude=${p.lon}` +
    `&start_date=${P.archive.start}&end_date=${P.archive.end}&daily=temperature_2m_mean&timezone=UTC`;
  const j = await getJson(url);
  const acc = {};
  j.daily.time.forEach((t, i) => {
    if (j.daily.temperature_2m_mean[i] == null) return;
    (acc[mdKey(t)] ||= []).push(j.daily.temperature_2m_mean[i]);
  });
  const norm = {};
  for (const [k, arr] of Object.entries(acc)) norm[k] = Math.round(mean(arr) * 100) / 100;
  cache[p.id] = { updated: new Date().toISOString().slice(0, 10), norm };
  normsFetched++;
}));
writeFileSync(CACHE_FILE, JSON.stringify(cache));
console.log(`norms: cached=${flat.length - normsFetched}, fetched=${normsFetched}`);

// 2) текущие данные — батч-запрос
let current = null, errNote = null;
try {
  const lats = flat.map(p => p.lat).join(",");
  const lons = flat.map(p => p.lon).join(",");
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
    `&daily=temperature_2m_mean,temperature_2m_min,temperature_2m_max&past_days=7&forecast_days=7&timezone=UTC`;
  const j = await getJson(url);
  const arr = Array.isArray(j) ? j : [j];
  if (arr.length !== flat.length) throw new Error(`batch size mismatch: ${arr.length} != ${flat.length}`);
  current = flat.map((p, i) => {
    const d = arr[i].daily;
    const obs = d.temperature_2m_mean.slice(0, 7).filter(v => v != null);
    const tmins = d.temperature_2m_min.filter(v => v != null);
    if (obs.length < 5 || tmins.length < 7) throw new Error(`${p.id}: insufficient data`);
    const tmins14 = d.temperature_2m_min.slice(0, 14).filter(v => v != null);
    const norm7 = d.time.slice(0, 7).map(t => cache[p.id].norm[mdKey(t)]).filter(v => v != null);
    if (norm7.length < 5) throw new Error(`${p.id}: no norms for window`);
    const obs7 = Math.round(mean(obs) * 10) / 10;
    const norm7m = Math.round(mean(norm7) * 10) / 10;
    return {
      id: p.id, name: p.name,
      obs7_c: obs7,
      norm7_c: norm7m,
      anomaly_c: Math.round((obs7 - norm7m) * 10) / 10,
      frost14: Math.round((tmins14.filter(v => v < 0).length / tmins14.length) * 100) / 100,
      tmin_forecast_min: Math.round(Math.min(...d.temperature_2m_max.map((v, k) => v == null ? 99 : v)) * 10) / 10,
    };
  });
} catch (e) {
  errNote = String(e.message || e);
  console.warn("forecast unavailable:", errNote);
}

// 3) агрегация по флайвеям
const per_flyway = {};
if (current) {
  for (const [fw, pts] of Object.entries(P.flyways)) {
    const rows = current.filter(c => pts.some(p => p.id === c.id));
    const anomaly = Math.round(mean(rows.map(r => r.anomaly_c)) * 10) / 10;
    const frost = Math.round(mean(rows.map(r => r.frost14)) * 100) / 100;
    const tmean = Math.round(mean(rows.map(r => r.obs7_c)) * 10) / 10;
    const A = clamp(-anomaly / 8, 0, 1);
    const W = clamp(0.6 * A + 0.4 * frost, 0, 1);
    const Pv = clamp(1 - (tmean + 5) / 40, 0.25, 1);
    per_flyway[fw] = {
      anomaly_c: anomaly, frost14: frost, tmean7_c: tmean,
      w: Math.round(W * 100) / 100,
      p: Math.round(Pv * 100) / 100,
      mw: Math.round((0.70 + 0.45 * W + 0.25 * Pv) * 100) / 100,
      points: rows,
    };
  }
}

const out = {
  updated: new Date().toISOString(),
  source: "Open-Meteo: archive 2015–2024 (нормы) + forecast past7/next7",
  current_available: !!current,
  note: errNote,
  formulas: { A: "clamp(-anomaly/8,0,1)", F: "share(Tmin<0, 14d)", W: "clamp(0.6A+0.4F,0,1)", P: "clamp(1-(T+5)/40,0.25,1)", MW: "0.70+0.45W+0.25P", R: "M*MW" },
  per_flyway,
};
writeFileSync(join(ROOT, "data", "weather.json"), JSON.stringify(out));

if (current) {
  for (const [fw, v] of Object.entries(per_flyway))
    console.log(`${fw}: anomaly ${v.anomaly_c}°C, frost14 ${Math.round(v.frost14 * 100)}%, W=${v.w}, P=${v.p}, MW=${v.mw}`);
  console.log("OK data/weather.json (current)");
} else {
  console.log("OK data/weather.json (no current — forecast unavailable)");
}
