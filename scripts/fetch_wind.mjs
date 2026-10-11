#!/usr/bin/env node
/**
 * vetflu fetch_wind.mjs — v2.2 «ветровой занос»: атмосферный перенос в сторону РФ
 * у границ со странами-граничниками (фаза 5).
 *
 * WAHIS не отдаёт координат событий (проверено 2026-10-11: filtered-list содержит только
 * country; detail/эндпоинты outbreak закрыты BAD_REQUEST), поэтому геометрия заноса
 * строится на опорных точках границы РФ (data/points_border.json, 45 точек): для каждой
 * точки Open-Meteo отдаёт погодовой ветер за прошедшие 72 ч (past_days=3, один batch-запрос).
 *
 * wind_score точки = доля часов из 72, когда:
 *   (а) скорость ветра ≥ 4 м/с (значимый перенос), и
 *   (б) направление ПЕРЕНОСА (wind_direction + 180°, метеоконвенция «откуда» → «куда»)
 *       попадает в сектор ±60° вокруг inward-азимута точки (направление внутрь РФ).
 *
 * В build_model.mjs wind_score перемножается на вес вспышек страны у границы:
 * вклад в WD дают только страны с активной (≤21 дн) вспышкой ВПГП из bp_events WAHIS —
 * без вспышки ветер заноса бесполезен (физически корректная активация).
 * WD_fw = 1.00 + 0.15·(1 − exp(−wd_raw/2)) — только усиление, диапазон 1.00–1.15.
 *
 * Graceful degradation: Open-Meteo недоступен → {available:false}, WD нейтрален (1.00).
 * Скрипт всегда завершается с кодом 0 — чтобы не ломать ежедневную сборку.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PTS = JSON.parse(readFileSync(join(ROOT, "data", "points_border.json"), "utf8")).points;
const OUT = join(ROOT, "data", "wind_live.json");

const MIN_SPEED_MS = 4;
const SECTOR_DEG = 60;
const WINDOW_HOURS = 72;

// доля часов из окна, когда перенос «в сторону РФ» и достаточно силён
function windScore(hours, inward) {
  let hit = 0, n = 0, maxS = 0;
  for (const h of hours) {
    const spd = h.ws, dir = h.wd;
    if (spd == null || dir == null) continue;
    n++;
    if (spd > maxS) maxS = spd;
    if (spd < MIN_SPEED_MS) continue;
    const carry = (dir + 180) % 360; // куда несёт
    let diff = Math.abs(carry - inward) % 360;
    if (diff > 180) diff = 360 - diff;
    if (diff <= SECTOR_DEG) hit++;
  }
  return { ws: n ? hit / Math.max(n, WINDOW_HOURS) : 0, max_speed: Math.round(maxS * 10) / 10 };
}

async function fetchWithRetry(url, tries = 4) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "vetflu/2.2 (open-source; contact via GitHub)" } });
      if (res.ok) return res;
      lastErr = new Error(`Open-Meteo ${res.status}`);
      // 4xx (кроме 429) — бессмысленно повторять
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (e) {
      lastErr = e;
      if (e.message && !/429|5\d\d|network|fetch failed/i.test(e.message)) throw e;
    }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1) ** 2)); // 2s, 8s, 18s
  }
  throw lastErr;
}

async function main() {
  try {
    const lats = PTS.map((p) => p.lat).join(",");
    const lons = PTS.map((p) => p.lon).join(",");
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lats}&longitude=${lons}` +
      `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms` +
      `&past_days=3&forecast_days=1&timezone=UTC`;
    console.log(`[wind] fetching ${PTS.length} border points (batch)…`);
    const res = await fetchWithRetry(url);
    if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
    const data = await res.json();
    const list = Array.isArray(data) ? data : [data]; // multi-location → массив; single → объект
    if (list.length !== PTS.length) throw new Error(`points mismatch: got ${list.length}, want ${PTS.length}`);

    // первый штамп времени одинаков для всех локаций; берём последние WINDOW_HOURS часов
    const times = list[0].hourly.time;
    const cut = Math.max(0, times.length - WINDOW_HOURS);
    const points = PTS.map((p, i) => {
      const h = list[i].hourly;
      const hours = [];
      for (let t = cut; t < times.length; t++) hours.push({ ws: h.wind_speed_10m[t], wd: h.wind_direction_10m[t] });
      const s = windScore(hours, p.inward);
      return { id: p.id, country: p.country, name: p.name, lat: p.lat, lon: p.lon, inward: p.inward, flyways: p.flyways, ws: Math.round(s.ws * 1000) / 1000, max_speed: s.max_speed };
    });

    const out = {
      available: true,
      updated: new Date().toISOString(),
      source: "Open-Meteo forecast API — погодовой ветер 10 м за прошедшие 72 ч на опорных точках границы РФ",
      window_hours: WINDOW_HOURS,
      past_days: 3,
      min_speed_ms: MIN_SPEED_MS,
      sector_deg: SECTOR_DEG,
      formula:
        "ws = доля часов за 72 ч, когда перенос (dir+180°) в секторе ±60° от inward и скорость ≥4 м/с; " +
        "wd_raw_fw = Σ(вспышки ≤21 дн у границы: bpRecency × borderWeight × max ws страны); WD = 1.00 + 0.15·(1 − exp(−wd_raw/2))",
      points,
    };
    writeFileSync(OUT, JSON.stringify(out));
    const active = points.filter((p) => p.ws > 0).length;
    console.log(`OK data/wind_live.json: ${points.length} точек, перенос «в РФ» сейчас у ${active} (ws>0)`);
    for (const p of points.filter((x) => x.ws > 0).slice(0, 8))
      console.log(`  ${p.id} ${p.country} ${p.name}: ws=${p.ws} max=${p.max_speed} м/с`);
  } catch (err) {
    console.warn(`[wind] FAILED: ${err.message}`);
    writeFileSync(OUT, JSON.stringify({
      available: false,
      updated: new Date().toISOString(),
      source: "Open-Meteo forecast API",
      note: "источник недоступен в этом прогоне; WD считается нейтральным (1.00)",
    }));
    console.warn("[wind] wrote available:false — WD neutral (1.00)");
    process.exitCode = 0;
  }
}

main();
