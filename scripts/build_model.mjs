#!/usr/bin/env node
/**
 * vetflu build_model.mjs — Фаза 1: индекс миграционного пролёта M по 4 флайвеям РФ.
 * Читает data/migration.json (экспертная параметризация окон/пиков по группам видов),
 * считает 52-недельные ряды M(0–100) на каждую неделю года и пишет data/model.json.
 *
 * M_fw(week) = нормированный взвешенный вклад групп видов:
 *   curve_g(week) = gauss(week, peakA+Δfw, σA)                     — осень (полный вес)
 *                 + springFactor * gauss(week, peakS+Δfw, σS)      — весна (ослаблена)
 *   σ = (end - start) / sigma_divisor
 * Дальше нормируем на максимум флайвея → 0..100, с нижним порогом resident_base.
 *
 * Фаза 2 добавит множитель погоды W (вет-метео: форсаж холодом, ледостав, персистентность),
 * фаза 3 — фон заносов B (EMPRES-i/WOAH/vet-heatmap) с валидацией по волнам 2020–2023.
 */
import { readFileSync, writeFileSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const M = JSON.parse(readFileSync(join(ROOT, "data", "migration.json"), "utf8"));
const WEEKS = 52;

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

const gauss = (w, peak, sigma) => Math.exp(-((w - peak) ** 2) / (2 * sigma * sigma));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

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

const out = {
  version: M.version,
  generated_at: new Date().toISOString(),
  source: "data/migration.json v" + M.version,
  model: {
    ...M.model,
    formula: "R = M * (0.70 + 0.45*W + 0.25*P); M_fw(week)=96*Σ_g(w_g*m_g,fw*(gaussA+springFactor*gaussS))/max_fw + resident_base",
    factors: {
      M: "миграционная фаза — активна",
      W: "погодный форсаж (аномалия холода, ледостав) — активна (Open-Meteo)",
      P: "персистентность вируса (температура) — активна",
      B: "фон заносов (EMPRES-i/WOAH/vet-heatmap) — фаза 3",
    },
  },
  flyways: M.flyways,
  species: M.species,
  weather: weather ? { updated: weather.updated, source: weather.source, formulas: weather.formulas, per_flyway: weather.per_flyway } : null,
  series: {},
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
  const weeks = raw.map((r, i) => {
    const m = Math.round(clamp((96 * r.sum) / maxRaw + M.model.resident_base, 0, 100));
    return {
      w: i + 1,
      m,
      ph: phaseLabel(m),
      seas: seasonLabel(r.autumnPart, r.springPart),
      top: Object.entries(r.contributions)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 2)
        .map(([id]) => id),
    };
  });
  // фаза 2: R = M × MW на текущую неделю (погода относится к «сейчас», не ко всем 52 неделям)
  let stamped = null;
  if (weather && weather.per_flyway[fw.id]) {
    const cw = Math.min(WEEKS, isoWeekNow());
    const row = weeks[cw - 1];
    const r = Math.round(clamp(row.m * weather.per_flyway[fw.id].mw, 0, 100));
    row.r = r; row.ph_r = phaseLabel(r);
    stamped = r;
  }
  const peakAutumn = weeks.reduce((a, b) => (b.seas.startsWith("осенний") && b.m > weeks[a - 1].m ? b.w : a), 1);
  const peakM = Math.max(...weeks.map((x) => x.m));
  out.series[fw.id] = { weeks, peak_autumn_week: peakAutumn, peak_m: peakM };
}

const file = join(ROOT, "data", "model.json");
writeFileSync(file, JSON.stringify(out));
const kb = (statSync(file).size / 1024).toFixed(1);
for (const [id, s] of Object.entries(out.series)) {
  const cur = s.weeks[isoWeekNow() - 1];
  console.log(`${id}: peak autumn w${s.peak_autumn_week} (M up to ${s.peak_m}); now w${isoWeekNow()} M=${cur.m}${cur.r != null ? ` R=${cur.r} (${cur.ph_r})` : " (no weather)"} — ${cur.ph}`);
}
console.log(`OK data/model.json (${kb} KB)${weather ? " · weather embedded" : " · weather: none"}`);
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
