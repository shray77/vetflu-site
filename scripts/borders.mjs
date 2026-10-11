/**
 * vetflu borders.mjs — общий модуль приграничных стран (v2.1 BP) и весов свежести.
 * Используется fetch_outbreaks.mjs (агрегация bp_raw из WAHIS) и build_model.mjs
 * (вклад стран в ветровой перенос WD, v2.2). Один источник правды — без дублирования.
 *
 * ключ — подстрока названия страны в WAHIS (case-insensitive), значение — вес границы
 * (1.0 — протяжённая/значимая для флайвея, 0.5 — короткий сегмент).
 * Кореи не включены: в WAHIS неоднозначные названия («Korea, Rep.» / DPRK), обе не граничат
 * по значимым для водоплавающих сегментам; Япония не граничит с РФ вовсе.
 */
export const BORDER = {
  ea:  { label: "Балтика/Северо-Запад", countries: { finland: 1.0, estonia: 1.0, latvia: 1.0, lithuania: 0.5, poland: 0.5, belarus: 1.0, ukraine: 1.0, norway: 0.5 } },
  bsm: { label: "Юг ЕТР/Кавказ/Каспий", countries: { ukraine: 1.0, georgia: 0.5, azerbaijan: 1.0, kazakhstan: 1.0 } },
  ca:  { label: "Казахстан/Алтай",      countries: { kazakhstan: 1.0, mongolia: 1.0, china: 0.5 } },
  eaa: { label: "ДВ/Китай/Монголия",    countries: { china: 1.0, mongolia: 1.0 } },
};

export const BP_WINDOW_DAYS = 21;
export const BP_SATURATION = 4; // P = 1 − exp(−raw/4)
export const BP_GAIN = 0.20;    // BP = 1.00 + 0.20·P
export const bpRecency = (days) => (days <= 7 ? 1.0 : days <= 14 ? 0.8 : 0.5);

// вес границы страны (WAHIS-название) для флайвея; 0 если страна не граничник флайвея
export function borderWeight(fwId, countryName) {
  const map = BORDER[fwId] && BORDER[fwId].countries;
  if (!map) return 0;
  const n = String(countryName || "").toLowerCase();
  for (const [key, weight] of Object.entries(map)) if (n.includes(key)) return weight;
  return 0;
}
