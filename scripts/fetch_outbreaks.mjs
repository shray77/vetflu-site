#!/usr/bin/env node
/**
 * vetflu fetch_outbreaks.mjs — Фаза 3: фон заносов B из WOAH WAHIS (публичный POST API,
 * тот же источник, что скрейпит ВетКарта: wahis.woah.org/api/v1/pi/event/filtered-list).
 *
 * Логика: пагинация по всем событиям, фильтр «грипп A высокой патогенности»,
 * свежесть по дате последнего рапорта (submissionDate, fallback eventStartDate):
 *   ≤14 дней — 1.0, ≤30 — 0.6, ≤60 — 0.3 (дальше — 0).
 * Каждая страна вносит вклад в флайвей(-и), где она часть коридора:
 *   страны коридора — полный вес, смежные — 0.4.
 * B_fw = clamp(raw / 10, 0, 1) — сатурация на 10 условных «свежих вспышечных единицах».
 * MB_fw = 0.85 + 0.30 * B_fw (диапазон 0.85–1.15).
 *
 * v2.1: входящее давление BP — страны, граничащие с РФ в коридоре флайвея.
 * WAHIS-лист не содержит координат событий, поэтому «радиус 200 км» заменён
 * странами-граничниками (сознательное упрощение: активная вспышка ВПГП в стране,
 * граничащей с РФ, — самостоятельный фактор заноса через сухопутную/морскую границу).
 * Окно 21 день (резче, чем 60-дневный фон B), вес по свежести: ≤7 дней — 1.0, ≤14 — 0.8, ≤21 — 0.5.
 * BP_fw = 1.00 + 0.20 * (1 − exp(−raw/4)) — диапазон 1.00–1.20 (BP только усиливает:
 * тихая граница не ослабляет базовый риск). BP не задним числом: в бэктесте не участвует.
 * v2.2: таблица BORDER и веса свежести вынесены в scripts/borders.mjs — общий модуль
 * с build_model.mjs, где тот же вес стран участвует в ветровом переносе WD.
 *
 * Graceful degradation: WAHIS недоступен → если свежий outbreaks_live.json (≤3 дней) есть,
 * он сохраняется как есть; иначе пишется {available:false} и build_model считает B нейтральным (1.00).
 * Скрипт всегда завершается с кодом 0 — чтобы не ломать ежедневную сборку.
 */
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, "data", "outbreaks_live.json");
const API_URL = "https://wahis.woah.org/api/v1/pi/event/filtered-list?language=en";
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const WINDOW_DAYS = 60;
const SATURATION = 10;
const ADJACENT_W = 0.4;

// ---- v2.1: приграничные страны/веса — общий модуль scripts/borders.mjs (с v2.2 делится с WD) ----
import { BORDER, BP_WINDOW_DAYS, BP_SATURATION, BP_GAIN, bpRecency } from "./borders.mjs";

const FLYWAYS = ["ea", "bsm", "ca", "eaa"];

// Коридоры флайвеев: страны коридора (полный вес) и смежные (0.4).
// Подстрки — под названия стран из WAHIS (case-insensitive contains).
const CORRIDORS = {
  ea: {
    label: "Восточно-Атлантический",
    primary: ["russ", "finland", "estonia", "latvia", "lithuania", "poland", "belarus", "germany", "denmark", "netherlands", "norway", "sweden"],
    adjacent: ["ukraine", "moldova", "romania", "hungary", "slovakia", "czech", "united kingdom", "iceland", "ireland", "france", "belgium"],
  },
  bsm: {
    label: "Черноморско-Средиземноморский",
    primary: ["russ", "ukraine", "moldova", "romania", "bulgaria", "turkey", "türkiye", "turkiye", "georgia", "armenia", "azerbaijan", "kazakhstan"],
    adjacent: ["hungary", "serbia", "greece", "iran", "iraq", "syria", "israel", "lebanon", "jordan", "turkmenistan", "uzbekistan", "slovakia"],
  },
  ca: {
    label: "Центральноазиатский",
    primary: ["russ", "kazakhstan", "uzbekistan", "turkmenistan", "kyrgyzstan", "tajikistan"],
    adjacent: ["mongolia", "iran", "azerbaijan", "georgia", "afghanistan", "china", "turkey", "türkiye", "turkiye", "ukraine"],
  },
  eaa: {
    label: "Восточноазиатско-Австралазийский",
    primary: ["russ", "mongolia", "china", "japan", "korea"],
    adjacent: ["vietnam", "kazakhstan", "india", "nepal", "thailand", "myanmar"],
  },
};

const recencyW = (days) => (days <= 14 ? 1.0 : days <= 30 ? 0.6 : days <= 60 ? 0.3 : 0);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function isHpai(e) {
  const d = String(e.disease || "").toLowerCase();
  return d.includes("influenza") && d.includes("high pathogenicity");
}

function lastDate(e) {
  const cand = [e.submissionDate, e.eventStartDate].filter(Boolean).map((s) => new Date(s).getTime()).filter((t) => !Number.isNaN(t));
  return cand.length ? Math.max(...cand) : null;
}

function countryMatch(name) {
  const n = String(name || "").toLowerCase();
  const hits = [];
  for (const fid of FLYWAYS) {
    const c = CORRIDORS[fid];
    if (c.primary.some((s) => n.includes(s))) hits.push({ fid, w: 1.0 });
    else if (c.adjacent.some((s) => n.includes(s))) hits.push({ fid, w: ADJACENT_W });
  }
  return hits;
}

async function fetchAll() {
  const all = [];
  for (let p = 0; p < MAX_PAGES; p++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0",
        Referer: "https://wahis.woah.org/",
        Origin: "https://wahis.woah.org",
      },
      body: JSON.stringify({ pageNumber: p, pageSize: PAGE_SIZE, sortOrder: "desc", sortBy: "startDate" }),
    });
    if (!res.ok) throw new Error(`WAHIS ${res.status} on page ${p}`);
    const data = await res.json();
    const list = Array.isArray(data.list) ? data.list : [];
    all.push(...list);
    if (list.length < PAGE_SIZE) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  return all;
}

function aggregate(events) {
  const now = Date.now();
  const per = {};
  for (const fid of FLYWAYS) per[fid] = { raw: 0, ev14: 0, ev30: 0, ev60: 0, ongoing: 0, fresh: [], bp_raw: 0, bp_events: [] };
  const countries = new Set();
  let hpai60 = 0;

  for (const e of events) {
    if (!isHpai(e)) continue;
    const ts = lastDate(e);
    if (ts == null) continue;
    const days = Math.round((now - ts) / 86400000);
    if (days < 0 || days > WINDOW_DAYS) continue;
    hpai60++;
    const hits = countryMatch(e.country);
    if (!hits.length) continue;
    countries.add(String(e.country));
    const w = recencyW(days);
    for (const { fid, w: cw } of hits) {
      per[fid].raw += w * cw;
      if (days <= 14) per[fid].ev14++;
      if (days <= 30) per[fid].ev30++;
      if (days <= 60) per[fid].ev60++;
      if (String(e.eventStatus).toLowerCase().startsWith("on-go")) per[fid].ongoing++;
      per[fid].fresh.push({
        c: e.country,
        date: String(e.eventStartDate || "").slice(0, 10),
        sub: e.subType && e.subType !== "None" ? e.subType : "",
        st: e.eventStatus === "On-going" ? "ongoing" : "resolved",
        id: e.eventId,
        days,
      });
    }
    // ---- v2.1: вклад в BP (только страны-граничники, окно 21 день) ----
    if (days > BP_WINDOW_DAYS) continue;
    const n = String(e.country || "").toLowerCase();
    for (const fid of FLYWAYS) {
      const bmap = BORDER[fid].countries;
      let bw = 0;
      for (const [key, weight] of Object.entries(bmap)) if (n.includes(key)) { bw = weight; break; }
      if (!bw) continue;
      per[fid].bp_raw += bpRecency(days) * bw;
      per[fid].bp_events.push({ c: e.country, days, st: e.eventStatus === "On-going" ? "ongoing" : "resolved", id: e.eventId });
    }
  }

  const out = {};
  for (const fid of FLYWAYS) {
    const p = per[fid];
    const b = clamp(p.raw / SATURATION, 0, 1);
    const bpP = 1 - Math.exp(-p.bp_raw / BP_SATURATION);
    const bp = 1 + BP_GAIN * bpP;
    p.fresh.sort((a, x) => a.days - x.days);
    p.bp_events.sort((a, x) => a.days - x.days);
    out[fid] = {
      b: Math.round(b * 1000) / 1000,
      mb: Math.round((0.85 + 0.3 * b) * 1000) / 1000,
      raw: Math.round(p.raw * 100) / 100,
      ev14: p.ev14,
      ev30: p.ev30,
      ev60: p.ev60,
      ongoing: p.ongoing,
      top: p.fresh.slice(0, 5),
      // v2.1: входящее давление
      bp: Math.round(bp * 1000) / 1000,
      bp_raw: Math.round(p.bp_raw * 100) / 100,
      bp_events: p.bp_events.slice(0, 5),
      bp_countries: [...new Set(p.bp_events.map((x) => x.c))].sort(),
    };
  }
  return { per: out, hpai60, countries: [...countries].sort() };
}

async function main() {
  try {
    console.log("[outbreaks] fetching WAHIS events…");
    const events = await fetchAll();
    console.log(`[outbreaks] ${events.length} events scanned`);
    const { per, hpai60, countries } = aggregate(events);
    const out = {
      available: true,
      updated: new Date().toISOString(),
      source: "WOAH WAHIS — публичный API wahis.woah.org (официальные уведомления)",
      window_days: WINDOW_DAYS,
      saturation: SATURATION,
      formula: "B = clamp(raw/10, 0, 1); MB = 0.85 + 0.30*B; raw = Σ w_recency × (1.0 страна коридора | 0.4 смежная); BP = 1.00 + 0.20·(1−exp(−bp_raw/4)) — страны-граничники РФ, окно 21 день",
      weights: { recency: { d14: 1.0, d30: 0.6, d60: 0.3 }, adjacent_country: ADJACENT_W, bp: { window_days: BP_WINDOW_DAYS, recency: { d7: 1.0, d14: 0.8, d21: 0.5 }, saturation: BP_SATURATION, gain: BP_GAIN, borders: BORDER } },
      total_events: events.length,
      hpai_events_60d: hpai60,
      countries_60d: countries,
      per_flyway: per,
    };
    writeFileSync(OUT, JSON.stringify(out));
    for (const fid of FLYWAYS) {
      const p = per[fid];
      console.log(`${fid}: B=${p.b} MB=${p.mb} · BP=${p.bp} (raw ${p.bp_raw}, ${p.bp_countries.join(", ") || "тихо"}) · ${p.ev30} соб./30д, ${p.ev60}/60д, ongoing ${p.ongoing}`);
    }
    console.log(`OK data/outbreaks_live.json (HPAI 60д: ${hpai60}, страны: ${countries.length})`);
  } catch (err) {
    console.warn(`[outbreaks] FAILED: ${err.message}`);
    // свежий файл (≤3 дней) оставляем как есть — иначе пишем available:false
    let keep = false;
    if (existsSync(OUT)) {
      try {
        const prev = JSON.parse(readFileSync(OUT, "utf8"));
        const age = (Date.now() - new Date(prev.updated).getTime()) / 86400000;
        if (prev.available && age <= 3) {
          keep = true;
          console.warn(`[outbreaks] keeping previous file (age ${age.toFixed(1)}d)`);
        }
      } catch { /* ignore */ }
    }
    if (!keep) {
      writeFileSync(OUT, JSON.stringify({
        available: false,
        updated: new Date().toISOString(),
        source: "WOAH WAHIS — публичный API wahis.woah.org",
        note: "источник недоступен в этом прогоне; B считается нейтральным (MB = 1.00)",
      }));
      console.warn("[outbreaks] wrote available:false — B neutral (MB=1.00)");
    }
    process.exitCode = 0;
  }
}

main();
