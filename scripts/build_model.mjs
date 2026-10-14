#!/usr/bin/env node
/**
 * vetflu build_model.mjs — v2.0 «каналы риска».
 * Читает data/migration.json (экспертная параметризация окон/пиков по группам видов),
 * считает 52-недельные ряды трёх каналов на каждый флайвей и пишет data/model.json.
 *
 * КАНАЛЫ РИСКА (шкала 0–100, статика на всю неделю года):
 *   M_fw(w) — транзит: миграционный календарь 8 групп видов
 *     curve_g(w) = gauss(w, peakA+Δfw, σA) + springFactor * gauss(w, peakS+Δfw, σS),
 *     нормировка на максимум флайвея → 0..100 + resident_base.
 *   C_fw(w) = 100 * c_fw * gauss(w, peak=28, σ_fw) — колониальный канал
 *     (гнездовые колонии чаек/бакланов/лысух, активен июнь–август — форма задаёт гауссиана).
 *   Z_fw(w) = 100 * z_fw * trap(w) — зимовочный канал: трапеция
 *     [start→full1 подъём 0→1; full1→full2 плато 1; full2→end спад 1→0]
 *     с заворотом через границу года (дуги окружности 1..52).
 *
 * Итог: R = max(M, C, Z) × MW × MB × BP × WD × HG, где MW = 0.70+0.45W+0.25P (Open-Meteo),
 * MB = 0.85+0.30B (WOAH WAHIS), BP = 1.00+0.20·(1−exp(−bp_raw/4)) — страны-граничники,
 * WD = 1.00+0.15·(1−exp(−wd_raw/2)) — ветровой перенос в сторону РФ (v2.2, Open-Meteo 72 ч
 * на опорных точках границы). Живые множители штампуются только на текущую неделю
 * (данные относятся к «сейчас»); chan — канал-победитель argmax(M,C,Z).
 *
 * Фаза 2: weather.json; Фаза 3: outbreaks_live.json; v2.0: узловая детализация
 * (16 узлов points.json — свой MW по метеоточке), история R (history.json),
 * бэктест v2 по трём каналам, RSS-лента (feed.xml) смен фазы риска.
 * v2.1: BP (границы, фаза 4); v2.2: WD (ветровой занос, фаза 5) + приграничные веса в borders.mjs.
 * v2.3 «riskgeo»: И1 — дистанционный фон B (гаверсинус от опорных точек стран до 16 узлов,
 * exp(-d/1000 км), пер-узловые MB — см. fetch_outbreaks.mjs); И2 — транзитный канал M смешан
 * с eBird S&T-фенологией (вес model.ebird_alpha, генерация build_ebird_phenology.mjs);
 * И6 — changelog модели в model.json (data/changelog.json). Бэктест перепроверяется при сборке.
 * v2.4 «habitat»: И8 — статический гео-фактор среды обитания HG (драйверы Opata et al. 2025:
 * вода JRC GSW v1.5 + NDVI MOD13Q1 + плотность птицы FAO GLW-4; данные data/habitat.json,
 * генератор build_habitat.py — климатологии коммитятся, в CI не запускается), пер-флайвей
 * и пер-узловой, формулы выше и в model.json.formula.
 */
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const M = JSON.parse(readFileSync(join(ROOT, "data", "migration.json"), "utf8"));
const PTS = JSON.parse(readFileSync(join(ROOT, "data", "points.json"), "utf8"));
const WEEKS = 52;

// ---- каналы риска v2.0: параметры (экспертные, по открытым орнитологическим сводкам) ----
// Колониальный канал: гнездовые скопления, пик н28 (середина июля), активен июнь–август.
const COLONIAL = {
  bsm: { c: 0.82, sigma: 4.5 },  // Каспий/дельта Волги: бакланы, пеликаны, чайковые, лысухи
  ea:  { c: 0.62, sigma: 5.0 },  // Баренцево/Белое море — морские колонии, Ладога
  eaa: { c: 0.55, sigma: 5.0 },  // Ханка, Селенга, Охотское море
  ca:  { c: 0.42, sigma: 5.0 },  // озёрные колонии юга Западной Сибири
};
// Зимовочный канал: трапеция с заворотом через Новый год (start→full1→full2→end).
const WINTERING = {
  bsm: { z: 0.88, start: 44, full1: 50, full2: 5, end: 10 }, // Каспий-Азов-Черноморье (ноябрь 2022 Дагестан)
  ea:  { z: 0.50, start: 45, full1: 51, full2: 4, end: 9 },  // Балтика, полыньи Северо-Запада
  eaa: { z: 0.38, start: 46, full1: 51, full2: 3, end: 9 },  // юг ДВ: Ханка, Приамурье
  ca:  { z: 0.25, start: 46, full1: 50, full2: 3, end: 8 },  // юг Западной Сибири
};
const CHAN_LABEL = { transit: "Транзит", colonies: "Колонии", wintering: "Зимовки" };
const CHAN_KEY = { transit: "m", colonies: "c", wintering: "z" }; // поле ряда для канала

// дуги окружности недель 1..52 с заворотом 52→1
const arcDist = (a, b) => ((b - a) % WEEKS + WEEKS) % WEEKS; // длина дуги a→b по возрастанию
function arcContains(a, b, w, inclEnd = false) {
  const L = arcDist(a, b);
  if (L === 0) return w === a;
  const d = arcDist(a, w);
  return inclEnd ? d <= L : d > 0 && d < L;
}
// трапеция зимовки: плато [full1..full2] = 1, подъём [start→full1), спад (full2→end]
function winterTrap(w, p) {
  if (arcContains(p.full1, p.full2, w, true)) return 1;
  if (arcContains(p.start, p.full1, w)) return arcDist(p.start, w) / arcDist(p.start, p.full1);
  if (arcContains(p.full2, p.end, w)) return 1 - arcDist(p.full2, w) / arcDist(p.full2, p.end);
  return 0;
}
// фаза 2: погодные множители (если есть свежий weather.json — штампуем R на текущую неделю)
const WF = join(ROOT, "data", "weather.json");
let weather = null;
if (existsSync(WF)) {
  try {
    const w = JSON.parse(readFileSync(WF, "utf8"));
    const ageDays = (Date.now() - new Date(w.updated).getTime()) / 86400000;
    if (w.current_available && ageDays <= 7 && Object.keys(w.per_flyway || {}).length) weather = w;
    else console.warn(`weather skipped: current_available=${w.current_available}, age=${ageDays.toFixed(1)}d`);
  } catch (e) { console.warn("weather.json unreadable:", e.message); }
}

// фаза 3: фон заносов B (WAHIS) — если есть свежий outbreaks_live.json
const OF = join(ROOT, "data", "outbreaks_live.json");
let outbreaks = null;
if (existsSync(OF)) {
  try {
    const o = JSON.parse(readFileSync(OF, "utf8"));
    const ageDays = (Date.now() - new Date(o.updated).getTime()) / 86400000;
    if (o.available && ageDays <= 3 && Object.keys(o.per_flyway || {}).length) outbreaks = o;
    else console.warn(`outbreaks skipped: available=${o.available}, age=${ageDays.toFixed(1)}d`);
  } catch (e) { console.warn("outbreaks_live.json unreadable:", e.message); }
}

// фаза 5 (v2.2): ветровой перенос WD — свежий wind_live.json (fetch_wind.mjs, ≤2 дней)
const WNDF = join(ROOT, "data", "wind_live.json");
let wind = null;
if (existsSync(WNDF)) {
  try {
    const w = JSON.parse(readFileSync(WNDF, "utf8"));
    const ageDays = (Date.now() - new Date(w.updated).getTime()) / 86400000;
    if (w.available && ageDays <= 2 && Array.isArray(w.points) && w.points.length) wind = w;
    else console.warn(`wind skipped: available=${w.available}, age=${ageDays.toFixed(1)}d`);
  } catch (e) { console.warn("wind_live.json unreadable:", e.message); }
}

// v2.1/v2.2: приграничные страны/веса — общий модуль с fetch_outbreaks.mjs
import { bpRecency, borderWeight } from "./borders.mjs";

// И2 (v2.3): eBird S&T фенология — недельные кривые относительной абундантности
// (детерминированная оцифровка публичных барчартов, см. build_ebird_phenology.mjs)
const EF = join(ROOT, "data", "ebird_phenology.json");
let ebird = null;
if (existsSync(EF)) {
  try { ebird = JSON.parse(readFileSync(EF, "utf8")); } catch (e) { console.warn("ebird_phenology.json unreadable:", e.message); }
}
// вес смешивания гауссианной базы и eBird-кривой (0 = чистая база, 1 = чистый eBird)
const EBIRD_ALPHA = (M.model && M.model.ebird_alpha != null) ? M.model.ebird_alpha : 0.3;

// И8 (v2.4.0-habitat): статический гео-фактор среды обитания HG — драйверы Opata et al. 2025
// (Sci Rep, doi:10.1038/s41598-025-04624-x: вода, NDVI, плотность птицеводства — в числе главных).
// Данные — data/habitat.json (генератор scripts/build_habitat.py, климатологии — коммитятся):
//   вода JRC GSW v1.5 occurrence (%), NDVI MOD13Q1 (месячная климатология 2023–2025),
//   плотность chickens+ducks FAO GLW-4 (голов/км²).
// gh = w_w·water_n + w_n·ndvi_n(w) + w_p·poultry_n (сатурационные нормировки 1−exp(−x/sat));
// HG = clamp(0.92 + 0.20·gh, 0.92, 1.12). Статика: множитель доступен всегда, штампуется вместе с живыми.
const HABF = join(ROOT, "data", "habitat.json");
let habitat = null;
if (existsSync(HABF)) {
  try {
    const h = JSON.parse(readFileSync(HABF, "utf8"));
    if (h.per_flyway && h.formula) habitat = h;
    else console.warn("habitat.json: нет per_flyway/formula — И8 отключён (HG = 1.00)");
  } catch (e) { console.warn("habitat.json unreadable:", e.message); }
}
const HG_BASE = 0.92, HG_GAIN = 0.20, HG_MIN = 0.92, HG_MAX = 1.12; // держать синхронно с build_habitat.py
// центр месяца в недельных координатах (≈15-е число месяца, шкала недель ISO 1..52)
const MONTH_CENTER_WEEKS = [2.7, 6.8, 11.0, 15.2, 19.4, 23.6, 27.8, 32.0, 36.3, 40.5, 44.7, 48.9];
function ndviAtWeek(mo, w) {
  if (!Array.isArray(mo) || !mo.length || mo.some((x) => x == null)) return null;
  const pts = MONTH_CENTER_WEEKS.map((c, i) => [c, mo[i]]);
  pts.push([MONTH_CENTER_WEEKS[0] + 52, mo[0]]);   // заворот года: январь следующим годом
  pts.push([MONTH_CENTER_WEEKS[11] - 52, mo[11]]); // и декабрь предыдущим
  pts.sort((a, b) => a[0] - b[0]);
  for (let i = 0; i < pts.length - 1; i++) {
    if (w >= pts[i][0] && w <= pts[i + 1][0]) {
      const t = (w - pts[i][0]) / (pts[i + 1][0] - pts[i][0]);
      return pts[i][1] + t * (pts[i + 1][1] - pts[i][1]);
    }
  }
  return mo[0];
}
function ghComponents(rec, week) {
  const f = habitat.formula;
  const sat = (x, s) => 1 - Math.exp(-Math.max(0, x || 0) / s);
  const water_n = sat(rec.water_pct, f.water_sat);
  const ndvi_w = ndviAtWeek(rec.ndvi_monthly, week);
  if (ndvi_w == null) return null; // без NDVI-климатологии фактор не считаем (частичные данные закрывает генератор)
  const ndvi_n = sat(ndvi_w, f.ndvi_sat);
  const poultry_n = sat(rec.poultry_head_km2, f.poultry_sat);
  const gh = f.w_water * water_n + f.w_ndvi * ndvi_n + f.w_poultry * poultry_n;
  return { gh, hg: clamp(HG_BASE + HG_GAIN * gh, HG_MIN, HG_MAX), water_n, ndvi_n, poultry_n, ndvi_w };
}
function habFw(fwId, week) {
  return habitat ? ghComponents(habitat.per_flyway[fwId] || {}, week) : null;
}
function habNode(fwId, nodeId, week) {
  if (!habitat) return null;
  const rec = habitat.per_node[fwId + ":" + nodeId];
  return ghComponents(rec || habitat.per_flyway[fwId] || {}, week);
}

// И6 (v2.3): changelog модели — история версий в model.json
const CF = join(ROOT, "data", "changelog.json");
let CHANGELOG = [];
if (existsSync(CF)) {
  try {
    const c = JSON.parse(readFileSync(CF, "utf8"));
    if (Array.isArray(c)) CHANGELOG = c;
  } catch (e) { console.warn("changelog.json unreadable:", e.message); }
}

// ---- v2.2: ветровой перенос WD по флайвею ----
// Вклад дают только страны с активной (≤21 дн) вспышкой из WAHIS bp_events:
// вклад события = bpRecency(days) × borderWeight(fw, страна) × ws (max wind_score
// сегментов границы этой страны во флайвее). Без вспышки ветер не считается —
// физически корректная активация: перенос несёт вирус только там, где он есть.
// WD = 1.00 + 0.15·(1 − exp(−raw/2)) — только усиление, диапазон 1.00–1.15.
const WD_GAIN = 0.15;
const WD_SATURATION = 2;
function windFw(fwId, obf) {
  const neutral = { wd: 1, wd_raw: 0, contributing: [] };
  if (!wind || !obf || !Array.isArray(obf.bp_events) || !obf.bp_events.length) return neutral;
  const pts = wind.points || [];
  const byC = {};
  for (const ev of obf.bp_events) {
    const bw = borderWeight(fwId, ev.c);
    if (!bw) continue;
    const cl = String(ev.c).toLowerCase();
    if (!byC[cl]) byC[cl] = { country: ev.c, raw: 0, ws: 0 };
    byC[cl].raw += bpRecency(ev.days);
    if (byC[cl].ws === 0) {
      let best = 0;
      for (const p of pts) {
        if (!p.flyways || !p.flyways.includes(fwId)) continue;
        const pc = String(p.country || "").toLowerCase();
        if (pc === cl || pc.includes(cl) || cl.includes(pc)) { if (p.ws > best) best = p.ws; }
      }
      byC[cl].ws = best;
    }
  }
  let raw = 0;
  const contributing = [];
  for (const v of Object.values(byC)) {
    const w = v.raw * v.ws;
    raw += w;
    if (w > 0) contributing.push({ country: v.country, raw: r2(v.raw), ws: Math.round(v.ws * 1000) / 1000, contrib: r2(w) });
  }
  contributing.sort((a, b) => b.contrib - a.contrib);
  const wd = 1 + WD_GAIN * (1 - Math.exp(-raw / WD_SATURATION));
  return { wd: Math.round(wd * 1000) / 1000, wd_raw: Math.round(raw * 100) / 100, contributing: contributing.slice(0, 4) };
}

// бэктест: ретроспективный прогон каналов по неделям известных волн 2020–2023
// (только статика каналов — погода и фон задним числом не восстанавливаются)
const POSTHOC_NOTE = "Канал колонии добавлен в v2.0 пост-хоком после разбора промаха v1 — не считать независимым подтверждением.";
const WAVES = [
  { label: "Осень 2020 — юг ЕТР (H5N8 2.2)", fw: "bsm", week: 46, note: "Крым, Ростовская, Волгоградская, Астраханская — конец осеннего транзита" },
  { label: "Лето 2021 — Каспий, чайковые", fw: "bsm", week: 27, note: "гнездовые колонии чаек и лысух, не транзит — в v1 был честный промах (M=4)", posthoc: true },
  { label: "Осень 2021 — Северо-Запад", fw: "ea", week: 42, note: "2.3.4.4b через морские колонии и Балтику, каскад по ЕТР" },
  { label: "Ноябрь 2022 — Дагестан/Каспий", fw: "bsm", week: 45, note: "массовая гибель диких птиц на зимовках после транзита" },
  { label: "Осень 2023 — Поволжье и юг", fw: "bsm", week: 44, note: "продолжение волны, региональные заносы" },
];

const gauss = (w, peak, sigma) => Math.exp(-((w - peak) ** 2) / (2 * sigma * sigma));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r2 = (v) => Math.round(v * 100) / 100;

function phaseLabel(m) {
  if (m >= 75) return "окно высокого риска";
  if (m >= 45) return "активный пролёт";
  if (m >= 15) return "умеренное движение";
  return "фон";
}

function seasonLabel(autumnPart, springPart) {
  const th = 0.12;
  if (autumnPart >= th && autumnPart >= springPart) return "осенний пролёт";
  if (springPart >= th) return "весенний пролёт";
  return "межсезонный фон";
}

const windPer = {}; // v2.2: {fw: {wd, wd_raw, contributing}} — собирается в цикле серий
const out = {
  version: M.version,
  generated_at: new Date().toISOString(),
  source: "data/migration.json v" + M.version,
  model: {
    ...M.model,
    formula: "R = max(M, C, Z) × MW × MB × BP × WD × HG — три канала риска в шкале 0–100: M транзит (миграционный календарь 8 групп видов, с v2.3 смешан с eBird S&T-кривой абундантности, α=" + ((M.model && M.model.ebird_alpha != null) ? M.model.ebird_alpha : 0.3) + "), C колонии = 100·c_fw·gauss(w, peak=28, σ) (гнездовые скопления, июнь–август), Z зимовки = 100·z_fw·trap(w) (трапеция ноябрь–март с заворотом через Новый год); MW = 0.70 + 0.45*W + 0.25*P; MB = 0.85 + 0.30*B, B — сатурация свежих ВПГП-событий вверх по коридору (WOAH WAHIS) с гаверсинус-затуханием exp(-d/1000км) до 16 узлов (v2.3); BP = 1.00 + 0.20·(1−exp(−bp_raw/4)) — входящее давление от стран-граничников РФ (окно 21 день); WD = 1.00 + 0.15·(1−exp(−wd_raw/2)) — ветровой перенос в сторону РФ при активных вспышках у границы (72 ч, Open-Meteo, опорные точки границы); HG = clamp(0.92 + 0.20·gh, 0.92, 1.12) — статический гео-фактор среды обитания (v2.4, Opata et al. 2025): gh = 0.40·вода_n + 0.30·NDVI_n(w) + 0.30·птица_n, вода = JRC GSW v1.5 occurrence (%), NDVI = MOD13Q1 климатология 2023–2025, птица = chickens+ducks FAO GLW-4 (голов/км²), сатурационные нормировки 1−exp(−x/sat); chan = argmax(M,C,Z)",
    factors: {
      M: "транзитный канал — миграционная фаза пролёта (с v2.3: бленд экспертной базы и eBird S&T-фенологии)",
      C: "колониальный канал — гнездовые скопления (июнь–август)",
      Z: "зимовочный канал — массовые зимовки (ноябрь–март)",
      W: weather ? "погодный форсаж (аномалия холода, ледостав) — активна (Open-Meteo)" : "погодный форсаж — нет свежих данных, MW = 1.00",
      P: weather ? "персистентность вируса (температура) — активна" : "персистентность — нет свежих данных",
      B: outbreaks ? "фон заносов (WOAH WAHIS, с v2.3 — гаверсинус-затухание до узлов, e-fold 1000 км) — активна" : "фон заносов (WOAH WAHIS) — нет свежих данных, MB = 1.00",
      BP: outbreaks ? "входящее давление (WOAH WAHIS, страны-граничники РФ, окно 21 дн) — активен" : "входящее давление — нет свежих данных, BP = 1.00",
      WD: wind ? "ветровой перенос в сторону РФ (Open-Meteo, 72 ч, опорные точки границы) — активен" : "ветровой перенос — нет свежих данных, WD = 1.00",
      HG: habitat ? "гео-фактор среды обитания (v2.4, статика): вода JRC GSW + NDVI MOD13Q1 + плотность птицы GLW-4 (драйверы Opata et al. 2025)" : "гео-фактор среды обитания — нет data/habitat.json, HG = 1.00",
    },
  },
  channels: {
    transit: { label: "Транзит", desc: "миграционный календарь пролёта 8 групп видов-резервуаров" },
    colonies: { label: "Колонии", desc: "гнездовые колонии (чайковые, бакланы, лысухи) — гауссиана пика н28, июнь–август", params: COLONIAL },
    wintering: { label: "Зимовки", desc: "массовые зимовки водоплавающих — трапеция ноябрь–март с заворотом через год", params: WINTERING },
  },
  flyways: M.flyways,
  species: M.species,
  ebird: ebird ? { alpha: EBIRD_ALPHA, updated: ebird.updated, source: ebird.source, data: "data/ebird_phenology.json" } : null,
  habitat: habitat ? { version: habitat.version, updated: habitat.updated, sources: habitat.sources, formula: habitat.formula, data: "data/habitat.json" } : null,
  changelog: CHANGELOG,
  weather: weather ? { updated: weather.updated, source: weather.source, formulas: weather.formulas, per_flyway: weather.per_flyway } : null,
  wind: wind ? {
    available: true,
    updated: wind.updated, source: wind.source, window_hours: wind.window_hours,
    min_speed_ms: wind.min_speed_ms, sector_deg: wind.sector_deg, formula: wind.formula,
    per_flyway: windPer,
    points_active: (wind.points || []).filter((p) => p.ws > 0).length,
    points_total: (wind.points || []).length,
  } : null,
  alert: null, // v2.2: заполняется ниже (уровень для Telegram-алертов)
  outbreaks: outbreaks ? {
    available: true, // флаг для витрины (obj()/drawOutbreaks) — блок вкладывается только когда данные свежие
    updated: outbreaks.updated, source: outbreaks.source, window_days: outbreaks.window_days,
    formula: outbreaks.formula, hpai_events_60d: outbreaks.hpai_events_60d,
    countries_60d: outbreaks.countries_60d, per_flyway: outbreaks.per_flyway,
  } : null,
  series: {},
  nodes: {},
};

for (const fw of M.flyways) {
  const rows = [];
  const raw = [];
  for (let w = 1; w <= WEEKS; w++) {
    let sum = 0, autumnPart = 0, springPart = 0;
    const contributions = {};
    for (const g of M.species) {
      const wfw = g.fw[fw.id] ?? 0;
      if (!wfw) continue;
      const dA = fw.shift.autumn, dS = fw.shift.spring;
      const sA = (g.autumn.end - g.autumn.start) / M.model.sigma_divisor;
      const sS = (g.spring.end - g.spring.start) / M.model.sigma_divisor;
      const cA = gauss(w, g.autumn.peak + dA, sA);
      const cS = gauss(w, g.spring.peak + dS, sS);
      const c = g.weight * wfw * (cA + M.model.spring_factor * cS);
      contributions[g.id] = Math.round(c * 1000) / 1000;
      sum += c;
      autumnPart += cA;
      springPart += M.model.spring_factor * cS;
    }
    raw.push({ sum, autumnPart, springPart, contributions });
  }
  const maxRaw = Math.max(...raw.map((r) => r.sum));
  // И2: максимум eBird-суммы для нормировки
  let maxRawE = 1e-9;
  if (ebird && ebird.species) {
    for (let wi = 0; wi < WEEKS; wi++) {
      let sumE = 0;
      for (const g of M.species) {
        const wfw = g.fw[fw.id] ?? 0;
        if (!wfw) continue;
        const cur = ebird.species[g.id] && ebird.species[g.id][fw.id];
        if (!cur) continue;
        sumE += g.weight * wfw * cur[wi];
      }
      if (sumE > maxRawE) maxRawE = sumE;
    }
  }
  const col = COLONIAL[fw.id], win = WINTERING[fw.id];
  const weeks = raw.map((r, i) => {
    const w = i + 1;
    // И2: eBird-кривая транзита — та же нормировка на максимум флайвея,
    // затем линейный бленд с гауссианной базой (вес EBIRD_ALPHA)
    const mGauss = (96 * r.sum) / maxRaw + M.model.resident_base;
    let m = mGauss;
    if (ebird && ebird.species) {
      let sumE = 0;
      for (const g of M.species) {
        const wfw = g.fw[fw.id] ?? 0;
        if (!wfw) continue;
        const cur = ebird.species[g.id] && ebird.species[g.id][fw.id];
        if (!cur) continue;
        sumE += g.weight * wfw * cur[i];
      }
      const mEbird = (96 * sumE) / maxRawE + M.model.resident_base;
      m = (1 - EBIRD_ALPHA) * mGauss + EBIRD_ALPHA * mEbird;
    }
    m = Math.round(clamp(m, 0, 100));
    const c = Math.round(100 * col.c * gauss(w, 28, col.sigma));
    const z = Math.round(100 * win.z * winterTrap(w, win));
    const chan = m >= c && m >= z ? "transit" : c >= z ? "colonies" : "wintering";
    return {
      w,
      m,
      c,
      z,
      chan,
      ph: phaseLabel(m),
      seas: seasonLabel(r.autumnPart, r.springPart),
      top: Object.entries(r.contributions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => id),
    };
  });
  // фазы 2–5: R = max(M, C, Z) × MW × MB × BP × WD — только на текущую неделю (живые данные относятся к «сейчас»)
  const cw = Math.min(WEEKS, isoWeekNow());
  const row = weeks[cw - 1];
  const mw = weather && weather.per_flyway[fw.id] ? weather.per_flyway[fw.id].mw : 1;
  const obf = outbreaks && outbreaks.per_flyway[fw.id] ? outbreaks.per_flyway[fw.id] : null;
  const mb = obf ? obf.mb : 1;
  const bp = obf && obf.bp ? obf.bp : 1; // v2.1: входящее давление (страны-граничники, 21 дн); нет данных → 1.00
  const windF = windFw(fw.id, obf);     // v2.2: ветровой перенос (вспышки у границы × ветер 72 ч); нет данных → 1.00
  const wd = windF.wd;
  const hab = habFw(fw.id, cw);         // v2.4: гео-фактор среды (статика); нет habitat.json → null (×1)
  if (weather || obf) {
    const rawMax = Math.max(row.m, row.c, row.z) * mw * mb * bp * wd * (hab ? hab.hg : 1);
    const r = Math.round(clamp(rawMax, 0, 100));
    row.r = r; row.ph_r = phaseLabel(r); row.mw = mw; row.mb = mb; row.bp = bp; row.b = obf ? obf.b : null;
    row.wd = wd; row.wd_raw = windF.wd_raw;
    row.hg = hab ? Math.round(hab.hg * 1000) / 1000 : null; row.gh = hab ? Math.round(hab.gh * 1000) / 1000 : null;
    row.chan = chanWinner(row); // канал-победитель argmax(M,C,Z)
    row.sat = rawMax > 100; // инфо-флаг сатурации: сырой max > 100 до клампа
  }
  windPer[fw.id] = windF;
  const peakAutumn = weeks.reduce((a, b) => (b.seas.startsWith("осенний") && b.m > weeks[a - 1].m ? b.w : a), 1);
  const peakM = Math.max(...weeks.map((x) => x.m));
  out.series[fw.id] = { weeks, peak_autumn_week: peakAutumn, peak_m: peakM };
}

// ---- v2.0: узловая детализация — свой погодный множитель на каждый из 16 узлов ----
// MW узла считается из уже скачанных данных weather.json per_flyway[fw].points[]:
// A = clamp(-anomaly/8, 0, 1); F = frost14; W = clamp(0.6A+0.4F, 0, 1);
// P = clamp(1-(obs7+5)/40, 0.25, 1); mw_n = 0.70 + 0.45W + 0.25P.
// R_node = round(clamp(chan_value × mw_n × mb × bp, 0, 100)) (v2.1: + BP флайвея),
// chan_value — статическое значение доминирующего канала флайвея на текущей неделе.
// канал-победитель недели (argmax по статическим значениям каналов, транзит приоритетен при равенстве)
function chanWinner(row) {
  return row.m >= row.c && row.m >= row.z ? "transit" : row.c >= row.z ? "colonies" : "wintering";
}

const cw = Math.min(WEEKS, isoWeekNow());
for (const fw of M.flyways) {
  const row = out.series[fw.id].weeks[cw - 1];
  const mb = row.mb ?? 1;
  const bp = row.bp ?? 1;
  const wd = row.wd ?? 1; // v2.2
  const live = weather && weather.per_flyway[fw.id];
  const wpoints = live ? weather.per_flyway[fw.id].points || [] : [];
  // И1 (v2.3): пер-узловый фон заносов (гаверсинус) — узловой MB вместо плоского флайвеевого
  const obGeo = outbreaks && outbreaks.per_flyway[fw.id] && outbreaks.per_flyway[fw.id].geo
    ? outbreaks.per_flyway[fw.id].geo : null;
  const nodes = (PTS.flyways[fw.id] || []).map((p) => {
    const wp = wpoints.find((x) => x.id === p.id) || null;
    const gn = obGeo && obGeo.per_node ? obGeo.per_node[p.id] : null;
    const mbGeo = gn ? gn.mb : mb;
    const habN = habNode(fw.id, p.id, cw); // v2.4: узловой гео-фактор (фолбэк — флайвей)
    let w = null, pv = null, mwN = null, r = null;
    if (wp) {
      const A = clamp(-wp.anomaly_c / 8, 0, 1);
      const F = wp.frost14;
      w = r2(clamp(0.6 * A + 0.4 * F, 0, 1));
      pv = r2(clamp(1 - (wp.obs7_c + 5) / 40, 0.25, 1));
      mwN = r2(0.70 + 0.45 * w + 0.25 * pv);
      r = Math.round(clamp(row[CHAN_KEY[row.chan]] * mwN * mbGeo * bp * wd * (habN ? habN.hg : 1), 0, 100));
    }
    return {
      id: p.id, name: p.name, lat: p.lat, lon: p.lon, share: p.share,
      anomaly_c: wp ? wp.anomaly_c : null, frost14: wp ? wp.frost14 : null,
      w, p: pv, mw: mwN, colony: !!p.colony, wintering: !!p.wintering,
      chan: row.chan, chan_value: row[CHAN_KEY[row.chan]], mb, mb_geo: gn ? gn.mb : null,
      min_km: gn && gn.min_km != null ? gn.min_km : null, bp, wd, r,
      hg: habN ? Math.round(habN.hg * 1000) / 1000 : null, gh: habN ? Math.round(habN.gh * 1000) / 1000 : null,
      water_n: habN ? Math.round(habN.water_n * 100) / 100 : null,
      ndvi_n: habN ? Math.round(habN.ndvi_n * 100) / 100 : null,
      poultry_n: habN ? Math.round(habN.poultry_n * 100) / 100 : null,
    };
  });
  out.nodes[fw.id] = nodes;
}

// ---- бэктест v2: по всем трём каналам, hit = max(M,C,Z) ≥ 45, chan — канал-победитель ----
out.backtest = WAVES.map((wv) => {
  const row = out.series[wv.fw].weeks[wv.week - 1];
  const fl = M.flyways.find((f) => f.id === wv.fw);
  const note = wv.posthoc ? `${wv.note}. ${POSTHOC_NOTE}` : wv.note;
  return {
    ...wv, note, flyway_label: fl ? fl.label : wv.fw,
    m: row.m, c: row.c, z: row.z,
    chan: chanWinner(row), value: Math.max(row.m, row.c, row.z),
    phase: row.ph, season: row.seas,
    hit: Math.max(row.m, row.c, row.z) >= 45,
  };
});

// ---- v2.0: история R — data/history.json, дедуп по дате, кап 180; в model.json — последние 90 ----
const HF = join(ROOT, "data", "history.json");
let history = { updated: null, records: [] };
if (existsSync(HF)) {
  try {
    const h = JSON.parse(readFileSync(HF, "utf8"));
    if (Array.isArray(h.records)) history = h;
  } catch (e) { console.warn("history.json unreadable, starting fresh:", e.message); }
}
const today = new Date().toISOString().slice(0, 10);
const rec = { date: today, per_flyway: {} };
for (const fw of M.flyways) {
  const row = out.series[fw.id].weeks[cw - 1];
  rec.per_flyway[fw.id] = {
    m: row.m, c: row.c, z: row.z, chan: row.chan,
    mw: row.mw ?? null, mb: row.mb ?? null, bp: row.bp ?? null, wd: row.wd ?? null, hg: row.hg ?? null, r: row.r ?? null,
  };
}
const idx = history.records.findIndex((x) => x.date === today);
if (idx >= 0) history.records[idx] = rec; else history.records.push(rec);
history.records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
history.records = history.records.slice(-180);
history.updated = new Date().toISOString();
writeFileSync(HF, JSON.stringify(history));
out.history = history.records.slice(-90);

// ---- v2.2: уровень риска для Telegram-алертов (сравнение и отправка — scripts/send_alert.mjs) ----
const rVals = M.flyways.map((f) => out.series[f.id].weeks[cw - 1].r).filter((v) => v != null);
const maxR = rVals.length ? Math.max(...rVals) : null;
const alertLevel = maxR == null ? "static" : maxR >= 75 ? "alert" : maxR >= 45 ? "watch" : "ok";
out.alert = { level: alertLevel, max_r: maxR, thresholds: { watch: 45, alert: 75 }, note: "ok<45≤watch<75≤alert; state-файл data/alert_state.json обновляет scripts/send_alert.mjs (пуш только при смене уровня)" };

// ---- v2.0: RSS-лента (feed.xml в корне — URL рекламируется витриной и self-link'ом) — смены фазы риска (ph_r) между соседними днями истории ----
const SITE = "https://shray77.github.io/vetflu-site/";
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const recPhase = (v) => (v && v.r != null ? phaseLabel(v.r) : null);
const pubDate = (d) => new Date(`${d}T12:00:00Z`).toUTCString();

const feedItems = [];
const first = history.records[0] || null;
if (first) {
  // стартовое состояние — всегда первый item (даже без живых множителей: показываем статику каналов)
  const parts = M.flyways.map((fw) => {
    const v = first.per_flyway[fw.id];
    if (!v) return `${fw.short} — нет данных`;
    return v.r != null
      ? `${fw.short} R${v.r} ${CHAN_LABEL[v.chan].toLowerCase()} (${recPhase(v)})`
      : `${fw.short}: транзит M${v.m} / колонии C${v.c} / зимовки Z${v.z} (без живых множителей)`;
  });
  feedItems.push({
    date: first.date,
    title: `Старт наблюдения: ${parts.join(" · ")}`,
    desc: `Начало ежедневной истории индекса R = max(M, C, Z) × MW × MB. ${parts.join("; ")}.`,
  });
}
for (let i = 1; i < history.records.length; i++) {
  const a = history.records[i - 1], b = history.records[i];
  for (const fw of M.flyways) {
    const va = a.per_flyway[fw.id], vb = b.per_flyway[fw.id];
    const pa = recPhase(va), pb = recPhase(vb);
    if (!pa || !pb || pa === pb) continue;
    feedItems.push({
      date: b.date,
      title: `${fw.short}: ${pa} → ${pb} · R ${vb.r} (${CHAN_LABEL[vb.chan]?.toLowerCase() || vb.chan})`,
      desc: `${fw.label}: фаза риска сменилась с «${pa}» на «${pb}». Разложение на ${b.date}: M ${vb.m} · C ${vb.c} · Z ${vb.z} → канал «${CHAN_LABEL[vb.chan] || vb.chan}», MW ${vb.mw ?? "—"} × MB ${vb.mb ?? "—"} = R ${vb.r}.`,
    });
  }
}
// стабильный короткий хэш для guid (items ротируются — guid должен быть детерминированным)
const strHash = (s) => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); };
const feedItemsLast = feedItems.slice(-20);
const feedXml =
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n<channel>\n` +
  `<title>VetFlu — окна риска ВПГП</title>\n` +
  `<link>${SITE}</link>\n` +
  `<description>Ежедневный индекс риска заноса высокопатогенного гриппа птиц по 4 флайвеям России: R = max(M, C, Z) × MW × MB × BP × WD × HG. События — смены фазы риска.</description>\n` +
  `<language>ru</language>\n` +
  `<lastBuildDate>${new Date().toUTCString()}</lastBuildDate>\n` +
  `<atom:link href="${SITE}feed.xml" rel="self" type="application/rss+xml" />\n` +
  feedItemsLast.map((it) =>
    `<item>\n<title>${xmlEsc(it.title)}</title>\n<link>${SITE}</link>\n` +
    `<guid isPermaLink="false">vetflu-${it.date}-${strHash(it.title)}</guid>\n` +
    `<pubDate>${pubDate(it.date)}</pubDate>\n<description>${xmlEsc(it.desc)}</description>\n</item>\n`).join("") +
  `</channel>\n</rss>\n`;
writeFileSync(join(ROOT, "feed.xml"), feedXml);

const file = join(ROOT, "data", "model.json");
writeFileSync(file, JSON.stringify(out));
const kb = (statSync(file).size / 1024).toFixed(1);
for (const [id, s] of Object.entries(out.series)) {
  const cur = s.weeks[isoWeekNow() - 1];
  const decomp = cur.r != null
    ? ` R=${cur.r} (max M${cur.m}, C${cur.c}, Z${cur.z} × MW${cur.mw} × MB${cur.mb} × BP${cur.bp ?? 1} × WD${cur.wd ?? 1} × HG${cur.hg ?? 1}) ${CHAN_LABEL[cur.chan]}${cur.sat ? " ⚠сатурация" : ""} — ${cur.ph_r}`
    : " (live-множителей нет — чистые каналы)";
  console.log(`${id}: peak autumn w${s.peak_autumn_week} (M up to ${s.peak_m}); now w${isoWeekNow()}${decomp} — ${cur.ph}`);
}
console.log(`nodes: ${Object.entries(out.nodes).map(([fw, ns]) => `${fw}[${ns.map((n) => `${n.id}:${n.r ?? "—"}`).join(",")}]`).join(" ")}`);
console.log(`backtest v2: ${out.backtest.map((x) => `${x.label.slice(0, 14)}… ${x.fw}/н${x.week} M${x.m}/C${x.c}/Z${x.z}→${CHAN_LABEL[x.chan]} ${x.hit ? "✓" : "✗"}`).join("; ")}`);
console.log(`wind: ${wind ? `${out.wind.points_total} точек (${out.wind.points_active} с переносом «в РФ») · ${Object.entries(windPer).map(([fw, w]) => `${fw} WD=${w.wd}`).join(", ")}` : "нет свежих данных — WD нейтрален"}`);
console.log(`alert: ${out.alert.level} (max R ${out.alert.max_r ?? "—"})`);
console.log(`history: ${history.records.length} записей (кап 180) · feed.xml: ${feedItemsLast.length} событий (из ${feedItems.length})`);
console.log(`OK data/model.json (${kb} KB)${weather ? " · weather embedded" : " · weather: none"}${outbreaks ? " · outbreaks embedded" : " · outbreaks: none"}`);

function isoWeekNow() {
  return isoWeek(new Date());
}
function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t - y0) / 86400000 + 1) / 7);
}
