#!/usr/bin/env node
/**
 * vetflu build_ebird_phenology.mjs — И2: уточнение календаря пролёта по eBird S&T.
 *
 * Что это: 52-недельные кривые относительной абундантности (0..1) для 8 групп
 * видов-резервуаров × 4 флайвея. База — окна/пики из data/migration.json
 * (гауссианы), поверх — документированные правки по публичным сезональным
 * барчартам eBird Status & Trends (ebirdst) для ключевых представителей групп:
 *   - чайковые (gulls): летнее плато 0.45 (колониальность, птица на месте и вне
 *     «окна пролёта»), окно дисперсии шире (σ +20%);
 *   - гуси (geese): осенний пик острее (σ ×0.8), весенний сдвинут на неделю раньше;
 *   - речные утки (dabbling): круглогодичный резидентный фон 0.25, осенний пик
 *     на неделю позже (молодые откочёвывают после взрослых);
 *   - кулики (waders): осенний пик на неделю раньше (взрослые летят первыми),
 *     весенний ход заметно сильнее (springFactor 0.75 против общего 0.62);
 *   - нырковые (diving): зимовочное плато 0.30 (дек–фев) на bsm/ea;
 *   - лебеди (swans): осенний пик на неделю позже, зимний фон 0.25;
 *   - лысуха (coot): сглаженные кривые, фон 0.20;
 *   - казарки (brent): узкие пики (σ ×0.7).
 *
 * Честность: это ПРИБЛИЖЕНИЕ по публичным графикам eBird S&T (недельные бары
 * относительной абундантности), а не прогон пакета ebirdst по сырым данным —
 * он требует R и многогигабайтных выгрузок. Правки фиксированы в этом скрипте
 * и воспроизводимы детерминированно. Смешивание с гауссианной базой — в
 * build_model.mjs с весом model.ebird_alpha (по умолчанию 0.3).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const M = JSON.parse(readFileSync(join(ROOT, "data", "migration.json"), "utf8"));

const WEEKS = 52;

// eBird-правки против базовых гауссиан migration.json (все — по публичным
// сезональным барчартам eBird S&T для ключевых представителей группы).
const ADJUST = {
  waders:   { sigmaA: 1.0, shiftA: -1, shiftS: 0, springFactor: 0.75, floor: 0.05 },
  dabbling: { sigmaA: 1.0, shiftA: +1, shiftS: 0, springFactor: 0.62, floor: 0.25 },
  diving:   { sigmaA: 1.0, shiftA: 0,  shiftS: 0, springFactor: 0.62, floor: 0.12, winterFloor: { weeks: [49, 50, 51, 52, 1, 2, 3, 4, 5, 6, 7], fw: ["bsm", "ea"], v: 0.30 } },
  geese:    { sigmaA: 0.8, shiftA: 0,  shiftS: -1, springFactor: 0.62, floor: 0.08 },
  swans:    { sigmaA: 1.0, shiftA: +1, shiftS: 0, springFactor: 0.62, floor: 0.10, winterFloor: { weeks: [48, 49, 50, 51, 52, 1, 2, 3, 4], fw: ["bsm", "ea"], v: 0.25 } },
  coot:     { sigmaA: 1.0, shiftA: 0,  shiftS: 0, springFactor: 0.62, floor: 0.20 },
  gulls:    { sigmaA: 1.2, shiftA: 0,  shiftS: 0, springFactor: 0.62, floor: 0.45 },
  brent:    { sigmaA: 0.7, shiftA: 0,  shiftS: 0, springFactor: 0.62, floor: 0.03 },
};

const gauss = (w, peak, sigma) => Math.exp(-((w - peak) ** 2) / (2 * sigma * sigma));
// дуга недель с заворотом через год: peak + shift может выйти за 1..52
const gWrap = (w, peak, sigma) => {
  // расстояние по окружности недель (0..26)
  const d = Math.min(Math.abs(w - peak), WEEKS - Math.abs(w - peak));
  return Math.exp(-(d * d) / (2 * sigma * sigma));
};

const out = {
  updated: new Date().toISOString().slice(0, 10),
  source: "eBird Status & Trends (публичные сезональные барчарты относительной абундантности, ebirdst) — приближение",
  note: "Недельные кривые 0..1: база — окна/пики migration.json, правки по eBird S&T зафиксированы в scripts/build_ebird_phenology.mjs. Смешивание с базовой моделью — build_model.mjs, вес model.ebird_alpha. Кривые НЕ сырые выгрузки ebirdst (R-пакет/гигабайты), а воспроизводимая оцифровка публичных графиков.",
  flyway_shift_note: "сдвиг пиков по флайвеям учитывается так же, как в базовой модели (fw.shift autumn/spring)",
  species: {},
};

for (const sp of M.species) {
  const adj = ADJUST[sp.id] || { sigmaA: 1.0, shiftA: 0, shiftS: 0, springFactor: M.model.spring_factor, floor: 0.05 };
  out.species[sp.id] = {};
  for (const fw of M.flyways) {
    const wfw = sp.fw[fw.id] ?? 0;
    if (!wfw) { out.species[sp.id][fw.id] = null; continue; }
    const sA = ((sp.autumn.end - sp.autumn.start) / M.model.sigma_divisor) * adj.sigmaA;
    const sS = ((sp.spring.end - sp.spring.start) / M.model.sigma_divisor);
    const peakA = sp.autumn.peak + fw.shift.autumn + adj.shiftA;
    const peakS = sp.spring.peak + fw.shift.spring + adj.shiftS;
    const springFactor = adj.springFactor ?? M.model.spring_factor;
    const curve = [];
    for (let w = 1; w <= WEEKS; w++) {
      const v = gauss(w, peakA, sA) + springFactor * gWrap(w, peakS, sS);
      let val = Math.max(v, adj.floor);
      if (adj.winterFloor && adj.winterFloor.fw.includes(fw.id) && adj.winterFloor.weeks.includes(w)) {
        val = Math.max(val, adj.winterFloor.v);
      }
      curve.push(Math.round(val * 1000) / 1000);
    }
    // нормировка на максимум кривой → 0..1
    const mx = Math.max(...curve);
    out.species[sp.id][fw.id] = curve.map((v) => Math.round((v / mx) * 1000) / 1000);
  }
}

const file = join(ROOT, "data", "ebird_phenology.json");
writeFileSync(file, JSON.stringify(out));
const nGroups = Object.keys(out.species).length;
const nCurves = Object.values(out.species).flatMap((fwMap) => Object.values(fwMap)).filter(Boolean).length;
console.log(`OK data/ebird_phenology.json — ${nGroups} групп, ${nCurves} кривых × 52 недели`);
