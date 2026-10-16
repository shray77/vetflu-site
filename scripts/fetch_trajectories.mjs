#!/usr/bin/env node
/**
 * vetflu fetch_trajectories.mjs — v2.5 «траекторный ветровой канал»:
 * обратные кинематические траектории от 16 узлов РФ по приземному ветру
 * (упрощённый аналог HYSPLIT backward trajectories без бинарника NOAA).
 *
 * Зачем: v2.2 (fetch_wind.mjs) оценивает перенос секторной эвристикой у
 * опорных точек границы. Здесь честнее: для каждого узла восстанавливаем,
 * ГДЕ БЫЛА воздушная масса, сейчас находящаяся над узлом, — назад на 96 ч
 * (шаг 6 ч) по полю ветра Open-Meteo — и проверяем, проходила ли траектория
 * над активными очагами ВПГП (WAHIS bp_events ≤21 дн, опорные точки стран из
 * country_coords.json — WAHIS координат не отдаёт, проверено 2026-10-11).
 *
 * Метод (kinematic single-level trajectory):
 *   u = −ws·sin(dir), v = −ws·cos(dir)  (метеоконвенция dir «откуда»)
 *   pos(t−Δ) = pos(t) − Δ·v(pos,t)      (движение против потока)
 *   Δ = 6 ч, 16 шагов = 96 ч; ветер — билинейная интерполяция сетки 3×3
 *   (±4° вокруг узла), при выходе за сетку — кламп к краю (осознанное
 *   упрощение: интересуют первые ~300 км коридора).
 *
 * Оценка: вклад очага = recency(≤14 дн = 1.0, ≤21 дн = 0.7) ×
 * exp(−d_min/300 км), d_min — мин. дистанция трека до опорной точки очага.
 * w_raw(узел) = Σ вкладов; публикация — data/wind_traj.json.
 *
 * Graceful degradation: любой сбой → {available:false}, build_model остаётся
 * на секторной эвристике v2.2. Скрипт всегда завершается с кодом 0.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PTS = JSON.parse(readFileSync(join(ROOT, "data", "points.json"), "utf8"));
const OBF = JSON.parse(readFileSync(join(ROOT, "data", "outbreaks_live.json"), "utf8"));
const GEO = JSON.parse(readFileSync(join(ROOT, "data", "country_coords.json"), "utf8"));
const OUT = join(ROOT, "data", "wind_traj.json");

const HOURS = 96;        // глубина обратной траектории
const STEP_H = 6;        // шаг интегрирования
const GRID_DEG = 4;      // полуразмер локальной сетки ветра
const CORRIDOR_KM = 300; // масштаб затухания вклада очага
const MS_MIN = 0.5;      // ниже — штиль, шаг пропускается
const UA = "vetflu-site/2.5 (trajectories; +https://shray77.github.io/vetflu-site/)";

const R_EARTH = 6371;
const rad = (d) => (d * Math.PI) / 180;
function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(a));
}

// ---- источники: активные очаги (≤21 дн) по опорным точкам стран, дедуп по id ----
// маппинг имён WAHIS → ключи country_coords: тот же substring-матч, что в fetch_outbreaks.mjs
function anchorsFor(country) {
  const n = String(country || "").toLowerCase();
  for (const [key, pts] of Object.entries(GEO.countries || {})) if (n.includes(key)) return pts;
  return null;
}

function collectSources() {
  const seen = new Set();
  const out = [];
  for (const fw of Object.values(OBF.per_flyway || {})) {
    for (const ev of fw.bp_events || []) {
      if (!ev || ev.days == null || ev.days > 21) continue;
      const key = ev.id != null ? `id:${ev.id}` : `${ev.c}:${ev.days}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pts = anchorsFor(ev.c);
      if (!Array.isArray(pts) || !pts.length) continue;
      const recency = ev.days <= 14 ? 1.0 : 0.7;
      for (const [la, lo] of pts) out.push({ country: ev.c, days: ev.days, lat: la, lon: lo, recency });
    }
  }
  return out;
}

// ---- ветер: 3×3 сетка вокруг узла, один запрос в Open-Meteo ----
async function fetchWindGrid(lat0, lon0) {
  const lats = [], lons = [];
  for (let dy = GRID_DEG; dy >= -GRID_DEG; dy -= GRID_DEG)
    for (let dx = -GRID_DEG; dx <= GRID_DEG; dx += GRID_DEG) { lats.push(lat0 + dy); lons.push(lon0 + dx); }
  const url = "https://api.open-meteo.com/v1/forecast?latitude=" + lats.map((x) => x.toFixed(3)).join(",") +
    "&longitude=" + lons.map((x) => x.toFixed(3)).join(",") +
    "&hourly=wind_speed_10m,wind_direction_10m&windspeed_unit=ms&past_days=5&forecast_days=1&timeformat=iso8601";
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const j = await res.json();
  const arr = Array.isArray(j) ? j : [j];
  const n = arr.length;
  if (n !== 9 || !arr[0]?.hourly?.time) throw new Error("unexpected open-meteo payload");
  const times = arr[0].hourly.time;
  const ws = [], wd = [];
  for (let i = 0; i < n; i++) {
    ws.push(arr[i].hourly.wind_speed_10m.map((x) => (Number.isFinite(x) ? x : 0)));
    wd.push(arr[i].hourly.wind_direction_10m.map((x) => (Number.isFinite(x) ? x : 0)));
  }
  return { times, ws, wd, lat0, lon0 };
}

// билинейная интерполяция (u,v) по сетке 3×3 в момент hi
function windAt(g, lat, lon, hi) {
  const iy = Math.max(0, Math.min(2, (g.lat0 + GRID_DEG - lat) / GRID_DEG));
  const ix = Math.max(0, Math.min(2, (lon - (g.lon0 - GRID_DEG)) / GRID_DEG));
  const y0 = Math.min(Math.floor(iy), 1), x0 = Math.min(Math.floor(ix), 1);
  const fy = iy - y0, fx = ix - x0;
  // порядок записи сетки: dy от +GRID до −GRID, dx от −GRID до +GRID
  const idx = (r, c) => r * 3 + c;
  let us = 0, vs = 0;
  for (let r = y0; r <= y0 + 1; r++) {
    for (let c = x0; c <= x0 + 1; c++) {
      const w = (r === y0 ? 1 - fy : fy) * (c === x0 ? 1 - fx : fx);
      const dir = rad(g.wd[idx(r, c)][hi]);
      us += w * -g.ws[idx(r, c)][hi] * Math.sin(dir);
      vs += w * -g.ws[idx(r, c)][hi] * Math.cos(dir);
    }
  }
  return { u: us, v: vs };
}

// обратная траектория: 17 точек (t0 … t0−96 ч)
function backtrack(g) {
  const hi0 = g.times.length - 1; // последний час (прошедшие + текущие)
  let lat = g.lat0, lon = g.lon0;
  const track = [[lat, lon]];
  for (let k = 1; k <= HOURS / STEP_H; k++) {
    const hi = hi0 - STEP_H * k;
    if (hi < 0) break;
    // ветер берётся на времени ТЕКУЩЕЙ точки трека (предыдущего шага)
    const hiPrev = hi0 - STEP_H * (k - 1);
    const { u, v } = windAt(g, lat, lon, hiPrev);
    const ws = Math.hypot(u, v);
    if (ws < MS_MIN) { track.push([lat, lon]); continue; }
    const dt = STEP_H * 3600;
    lat = Math.max(-89, Math.min(89, lat - (v * dt) / 111320));
    lon = lon - (u * dt) / (111320 * Math.max(0.2, Math.cos(rad(lat))));
    track.push([lat, lon]);
  }
  return track;
}

function scoreNode(track, sources) {
  let w = 0;
  const tops = [];
  for (const s of sources) {
    let dmin = Infinity;
    for (const [la, lo] of track) dmin = Math.min(dmin, haversineKm(la, lo, s.lat, s.lon));
    const contrib = s.recency * Math.exp(-dmin / CORRIDOR_KM);
    w += contrib;
    tops.push({ country: s.country, days: s.days, d_km: Math.round(dmin), contrib: Math.round(contrib * 100) / 100 });
  }
  tops.sort((a, b) => b.contrib - a.contrib);
  return { w_raw: Math.round(w * 100) / 100, top: tops.slice(0, 4) };
}

async function main() {
  const sources = collectSources();
  const nodes = [];
  for (const [fwId, list] of Object.entries(PTS.flyways || {}))
    for (const p of list) nodes.push({ fw: fwId, ...p });

  const per_node = {};
  let ok = 0;
  try {
    for (const n of nodes) {
      const g = await fetchWindGrid(n.lat, n.lon);
      const track = backtrack(g);
      const sc = scoreNode(track, sources);
      const wd = Math.round((1 + 0.15 * (1 - Math.exp(-sc.w_raw / 2))) * 1000) / 1000;
      per_node[n.id] = {
        fw: n.fw, w_raw: sc.w_raw, wd,
        top: sc.top.filter((t) => t.contrib > 0.01),
        track: track.map(([la, lo]) => [Math.round(la * 10) / 10, Math.round(lo * 10) / 10]),
      };
      ok++;
      await new Promise((r) => setTimeout(r, 350)); // вежливость к Open-Meteo
    }
  } catch (e) {
    console.error("trajectories failed:", e.message);
    writeFileSync(OUT, JSON.stringify({ available: false, updated: new Date().toISOString(), error: e.message }, null, 1));
    process.exit(0); // graceful: build_model останется на секторной эвристике
  }

  const out = {
    available: true,
    updated: new Date().toISOString(),
    source: "Open-Meteo forecast API — обратные кинематические траектории (упрощённый аналог HYSPLIT) от 16 узлов, приземный ветер 10 м",
    hours: HOURS, step_h: STEP_H, grid_deg: GRID_DEG, corridor_km: CORRIDOR_KM,
    sources: sources.length,
    formula:
      "w_raw(узел) = Σ(очаги ≤21 дн, WAHIS bp_events → опорные точки стран country_coords.json): recency(≤14 дн = 1.0, ≤21 дн = 0.7) × exp(−d_min/300 км), где d_min — мин. дистанция 96-часовой обратной траектории (шаг 6 ч, ветер 10 м, билинейная сетка 3×3 ±4°) до очага; WD_узла = 1.00 + 0.15·(1 − exp(−w_raw/2)); WD_флайвея = Σ share·WD_узла",
    per_node,
    requests: ok,
  };
  writeFileSync(OUT, JSON.stringify(out, null, 1));
  const hot = Object.values(per_node).filter((x) => x.w_raw > 0.1).length;
  console.log(`trajectories: ${ok}/16 узлов, источников ${sources.length}, узлов с переносом (w_raw>0.1): ${hot}`);
}

main();
