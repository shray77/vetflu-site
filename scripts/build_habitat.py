#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
И8 (v2.4.0-habitat): генератор data/habitat.json — статические гео-драйверы среды
обитания по мотивам Opata et al. 2025 (Sci Rep, s41598-025-04624-x: вода, NDVI и
плотность птицеводства — в числе главных драйверов наступления ВПГП).

Источники (все открытые, без ключей):
  ВОДА       JRC Global Surface Water v1.5 "occurrence" (1984–2024), тайлы 10°×10°,
             сэмпл окна ±0.02° (~4.4 км) через HTTP Range (/vsicurl, полная скачка не нужна).
  NDVI       MODIS MOD13Q1 (250 м, 16 дн) через ORNL DAAC Web Service v1 (без auth),
             климатология 2023–2025 по месяцам.
  ПЛОТНОСТЬ  FAO GLW-4 (2015, 5 угл. мин): chickens + ducks, голов/км²
             (Harvard Dataverse doi:10.7910/DVN/SXHLF3 / S9ONXV, файлы *_Da.tif).

Скрипт запускается ВРУЧНУЮ и РЕДКО (данные — климатологии/статика), habitat.json
коммитится в репо и читается scripts/build_model.mjs. Не является частью CI.
Зависимости: pip install rasterio numpy
Запуск:  python3 scripts/build_habitat.py [путь-к-репо]
"""
import json
import math
import os
import sys
import time
import urllib.request

import numpy as np
import rasterio

ROOT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), ".."))
DATA = os.path.join(ROOT, "data")
SAMPLES_CACHE = "/tmp/geo/habitat_samples.json"  # инкрементальный кэш: перезапуск добирает только None-компоненты

# ---- константы формулы (дублируются в build_model.mjs — держать синхронно) ----
W_WATER, W_NDVI, W_POULTRY = 0.40, 0.30, 0.30
GSW_WINDOW_DEG = 0.02          # ±0.02° ≈ 4.4 км — ландшафтное окно
NDVI_KERNEL_KM = 1             # ядро NDVI 3×3 px (±750 м) — прибрежные точки не в море
GSW_WATER_SAT = 25.0           # нормировка: 1-exp(-pct/25)
NDVI_SAT = 3500.0              # нормировка: 1-exp(-ndvi/3500), шкала NDVI×10000
POULTRY_SAT = 2000.0           # нормировка: 1-exp(-D/2000)
NDVI_YEARS = (2023, 2024, 2025)
GSW_BASE = "https://storage.googleapis.com/water-world/download2024/VER1-5/occurrence/occurrence_{lon}_{ns}_v1_5_2024.tif"
ORNL = "https://modis.ornl.gov/rst/api/v1/MOD13Q1/subset?latitude={lat}&longitude={lon}&product=MOD13Q1&band=250m_16_days_NDVI&kernel=3&kmAboveBelow=1&kmLeftRight=1&startDate={start}&endDate={end}"
ORNL_DATES = "https://modis.ornl.gov/rst/api/v1/MOD13Q1/dates?latitude={lat}&longitude={lon}"
GLW_CHICKENS_ID, GLW_DUCKS_ID = 6786792, 6769700  # 5_Ch_2015_Da.tif / 5_Dk_2015_Da.tif
GLW_DIR = "/tmp/geo"
UA = {"User-Agent": "vetflu-site-habitat/1.0 (github.com/shray77/vetflu-site)", "Accept": "*/*"}  # без Accept WAF ORNL отдаёт 500


def http_json(url, retries=5, delay=2.0):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode())
        except Exception as e:
            if i == retries - 1:
                raise
            wait = delay * (i + 1)
            print(f"    retry {i+1} (wait {wait:.0f}s): {e}", flush=True)
            time.sleep(wait)


def download(url, path):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r, open(path, "wb") as f:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            f.write(chunk)


# ---------- точки: hubs (migration.json) + nodes (points.json) ----------
def collect_points():
    m = json.load(open(os.path.join(DATA, "migration.json")))
    p = json.load(open(os.path.join(DATA, "points.json")))
    hubs, nodes = {}, {}
    for fw in m["flyways"]:
        hubs[fw["id"]] = [{"key": f"{fw['id']}:hub{i}", "fw": fw["id"], "name": h["name"],
                           "lat": h["ll"][0], "lon": h["ll"][1]} for i, h in enumerate(fw["hubs"])]
    for fw, arr in p["flyways"].items():
        nodes[fw] = [{"key": f"{fw}:{n['id']}", "fw": fw, "name": n["name"],
                      "lat": n["lat"], "lon": n["lon"]} for n in arr]
    return hubs, nodes


# ---------- ВОДА: JRC GSW v1.5 occurrence ----------
_gsw_cache = {}


def gsw_open(lon, lat):
    x0 = math.floor(lon / 10) * 10
    ytop = math.floor(lat / 10) * 10 + 10
    lon_tag = f"{abs(x0)}{'E' if x0 >= 0 else 'W'}"
    lat_tag = f"{abs(ytop)}{'N' if ytop >= 0 else 'S'}"
    url = GSW_BASE.format(lon=lon_tag, ns=lat_tag)
    if url not in _gsw_cache:
        _gsw_cache[url] = rasterio.open("/vsicurl/" + url)
    return _gsw_cache[url]


def water_sample(lon, lat, d=GSW_WINDOW_DEG):
    """Средний % occurrence воды в окне ±d°; None — если окно целиком nodata/вне покрытия."""
    src = gsw_open(lon, lat)
    eps = 1e-6  # тайлы имеют float-грязь на краях (130.0000000000002) — точка на краю не должна отсекаться
    if not (src.bounds.left - eps <= lon <= src.bounds.right + eps and src.bounds.bottom - eps <= lat <= src.bounds.top + eps):
        return None
    win = rasterio.windows.from_bounds(lon - d, lat - d, lon + d, lat + d, transform=src.transform)
    arr = src.read(1, window=win)
    v = arr[(arr >= 0) & (arr <= 100)].astype(float)  # 255 = вне покрытия (море)
    return round(float(v.mean()), 1) if v.size else None


# ---------- NDVI: ORNL MODIS MOD13Q1, месячная климатология ----------
_dates_cache = {"list": None}


def ornl_dates(lat, lon):
    """Список дат продукта (глобальный для MOD13Q1 — берём один раз, точка почти не влияет)."""
    if _dates_cache["list"] is None:
        d = http_json(ORNL_DATES.format(lat=lat, lon=lon), retries=6, delay=4.0)
        _dates_cache["list"] = [x["calendar_date"] for x in d["dates"]]
    return _dates_cache["list"]


def to_modis_date(cal):
    """'2023-01-01' -> 'A2023001' (год + день года) — единственный формат, который ест subset."""
    import datetime as _dt
    d = _dt.date.fromisoformat(cal)
    return f"A{d.year}{d.timetuple().tm_yday:03d}"


def _ndvi_once(lat, lon, km, dates):
    by_month = {m: [] for m in range(1, 13)}
    CH = 9
    for i in range(0, len(dates), CH):
        chunk = dates[i:i + CH]
        url = ORNL.format(lat=lat, lon=lon, start=to_modis_date(chunk[0]), end=to_modis_date(chunk[-1])).replace(
            "kernel=3&kmAboveBelow=1&kmLeftRight=1", f"kernel={km * 2 + 1}&kmAboveBelow={km}&kmLeftRight={km}")
        resp = http_json(url, retries=4, delay=5.0)
        time.sleep(3 + (hash(url) % 20) / 10.0)
        for c in resp.get("subset", []):
            vals = [v for v in c["data"] if 0 <= v <= 10000]
            if vals:
                mo = int(c["calendar_date"][5:7])
                by_month[mo].extend(vals)
    return by_month


def ndvi_climatology(lat, lon):
    """12 месячных средних NDVI (шкала ×10000), климатология NDVI_YEARS.
    Каскад ядер 1→5→10 км: прибрежные точки (пиксель в море) расширяются до суши."""
    dates = ornl_dates(lat, lon)
    wanted = [x for x in dates if any(x.startswith(str(y) + "-") for y in NDVI_YEARS)]
    by_month, used_km = None, None
    for km in (1, 5, 10):
        try:
            cand = _ndvi_once(lat, lon, km, wanted)
        except Exception as e:
            print(f"    ndvi km={km} FAIL: {repr(e)[:70]}", flush=True)
            continue
        if any(cand[m] for m in range(1, 13)):
            by_month, used_km = cand, km
            break
        print(f"    ndvi km={km}: пусто (пиксель в море/вне покрытия)", flush=True)
    if by_month is None:
        raise RuntimeError("no NDVI coverage at any kernel size (1/5/10 км)")
    if used_km != 1:
        print(f"    ndvi: использовано ядро ±{used_km} км (прибрежная точка)", flush=True)
    out = []
    for m in range(1, 13):
        out.append(round(float(np.mean(by_month[m]))) if by_month[m] else None)
    if all(v is None for v in out):
        raise RuntimeError("no valid NDVI values for any month (API data empty/masked)")
    # дырки в месяцах (снег/облака за 3 года) — закрытие по соседям по кругу
    for _ in range(24):
        if all(v is not None for v in out):
            break
        for m in range(12):
            if out[m] is None:
                out[m] = out[(m + 1) % 12] if out[(m + 1) % 12] is not None else out[(m - 1) % 12]
    return out


# ---------- ПЛОТНОСТЬ: FAO GLW-4 chickens + ducks ----------
def glw_sample(src, lon, lat):
    row, col = src.index(lon, lat)
    r0, r1 = max(0, row - 1), min(src.height, row + 2)
    c0, c1 = max(0, col - 1), min(src.width, col + 2)
    arr = src.read(1, window=rasterio.windows.Window(c0, r0, c1 - c0, r1 - r0))
    v = arr[np.isfinite(arr) & (arr >= 0) & (arr < 1e6)]
    return float(v.mean()) if v.size else None


def poultry_density(lon, lat):
    os.makedirs(GLW_DIR, exist_ok=True)
    total = 0.0
    for fid, fn in [(GLW_CHICKENS_ID, "chickens_da.tif"), (GLW_DUCKS_ID, "ducks_da.tif")]:
        path = os.path.join(GLW_DIR, fn)
        if not os.path.exists(path):
            print(f"    download GLW {fn}...", flush=True)
            download(f"https://dataverse.harvard.edu/api/access/datafile/{fid}", path)
        v = glw_sample(rasterio.open(path), lon, lat)
        if v is not None:
            total += v
    return round(total, 1)


# ---------- сводка ----------
def main():
    hubs, nodes = collect_points()
    allpts = {p["key"]: p for lst in list(hubs.values()) + list(nodes.values()) for p in lst}
    print(f"points: {len(allpts)}", flush=True)

    samples = {}
    if os.path.exists(SAMPLES_CACHE):
        try:
            samples = json.load(open(SAMPLES_CACHE))
            print(f"cache: {len(samples)} points loaded from {SAMPLES_CACHE}", flush=True)
        except Exception:
            samples = {}
    for key, p in allpts.items():
        time.sleep(1.0)
        prev = samples.get(key, {})
        need = [c for c in ("water_pct", "ndvi_monthly", "poultry_head_km2") if prev.get(c) is None]
        if not need:
            continue
        print(f"[{key}] {p['name'][:32]} @ {p['lat']},{p['lon']} (need: {','.join(need)})", flush=True)
        s = dict(prev)
        if "water_pct" in need:
            try:
                s["water_pct"] = water_sample(p["lon"], p["lat"])
            except Exception as e:
                print("    water FAIL:", repr(e)[:90], flush=True)
                s["water_pct"] = None
        if "ndvi_monthly" in need and os.environ.get("SKIP_NDVI") == "1":
            s["ndvi_monthly"] = None
        elif "ndvi_monthly" in need:
            try:
                s["ndvi_monthly"] = ndvi_climatology(p["lat"], p["lon"])
            except Exception as e:
                print("    ndvi FAIL:", repr(e)[:90], flush=True)
                s["ndvi_monthly"] = None
        if "poultry_head_km2" in need:
            try:
                s["poultry_head_km2"] = poultry_density(p["lon"], p["lat"])
            except Exception as e:
                print("    poultry FAIL:", repr(e)[:90], flush=True)
                s["poultry_head_km2"] = None
        samples[key] = s
        os.makedirs(os.path.dirname(SAMPLES_CACHE), exist_ok=True)
        json.dump(samples, open(SAMPLES_CACHE, "w"))
        nd = s["ndvi_monthly"]
        nd_disp = [round(x / 1000, 1) if x is not None else None for x in nd] if nd else None
        print(f"    water={s['water_pct']} ndvi={nd_disp} poultry={s['poultry_head_km2']}", flush=True)

    def agg(fw, keys):
        """Средние по точкам флайвея (None-значения исключаются)."""
        res = {"water_pct": None, "ndvi_monthly": None, "poultry_head_km2": None, "n_points": len(keys)}
        ws = [samples[k]["water_pct"] for k in keys if samples[k]["water_pct"] is not None]
        if ws:
            res["water_pct"] = round(float(np.mean(ws)), 1)
        ps = [samples[k]["poultry_head_km2"] for k in keys if samples[k]["poultry_head_km2"] is not None]
        if ps:
            res["poultry_head_km2"] = round(float(np.mean(ps)), 1)
        ms = [samples[k]["ndvi_monthly"] for k in keys if samples[k]["ndvi_monthly"] is not None]
        if ms:
            res["ndvi_monthly"] = [round(float(np.mean([m[j] for m in ms if m[j] is not None]))) if any(m[j] is not None for m in ms) else None for j in range(12)]
        return res

    per_flyway = {fw: agg(fw, [p["key"] for p in hubs[fw]]) for fw in hubs}
    per_node = {key: {**samples[key], "fw": p["fw"], "name": p["name"], "lat": p["lat"], "lon": p["lon"]}
                for key, p in [(k, v) for k, v in allpts.items() if ":hub" not in k]}

    # санити-печать: компоненты и HG при летнем NDVI (июль)
    print("\n=== sanity (июль) ===", flush=True)
    for fw, v in per_flyway.items():
        water_n = 1 - math.exp(-(v["water_pct"] or 0) / GSW_WATER_SAT)
        ndvi_n = 1 - math.exp(-((v["ndvi_monthly"] or [0] * 12)[6] or 0) / NDVI_SAT)
        pol_n = 1 - math.exp(-(v["poultry_head_km2"] or 0) / POULTRY_SAT)
        gh = W_WATER * water_n + W_NDVI * ndvi_n + W_POULTRY * pol_n
        hg = min(1.12, max(0.92, 0.92 + 0.20 * gh))
        print(f"{fw}: water%={v['water_pct']} ndvi_jul={v['ndvi_monthly'] and v['ndvi_monthly'][6]} D={v['poultry_head_km2']} -> gh={gh:.3f} HG={hg:.3f}", flush=True)

    out = {
        "version": "1.0.0",
        "updated": time.strftime("%Y-%m-%d"),
        "note": "И8 (v2.4.0-habitat): статические гео-драйверы среды обитания (Opata et al. 2025). "
                "water_pct — средний % occurrence воды (JRC GSW v1.5, окно ±0.02°) в хабах; "
                "ndvi_monthly — климатология MOD13Q1 2023–2025 (шкала ×10000); "
                "poultry_head_km2 — chickens+ducks (FAO GLW-4, 2015). Генератор: scripts/build_habitat.py.",
        "sources": {
            "water": "JRC Global Surface Water v1.5 occurrence 1984–2024 (10° tiles, GCS, /vsicurl)",
            "ndvi": f"MODIS MOD13Q1 250m 16d via ORNL DAAC Web Service v1, years {NDVI_YEARS[0]}–{NDVI_YEARS[-1]}",
            "poultry": "FAO GLW-4 2015 (5 arc-min): chickens doi:10.7910/DVN/SXHLF3 + ducks doi:10.7910/DVN/S9ONXV",
            "driver_paper": "Opata et al. 2025, Sci Rep 15, doi:10.1038/s41598-025-04624-x",
        },
        "formula": {"w_water": W_WATER, "w_ndvi": W_NDVI, "w_poultry": W_POULTRY,
                    "gsw_window_deg": GSW_WINDOW_DEG, "water_sat": GSW_WATER_SAT,
                    "ndvi_sat": NDVI_SAT, "poultry_sat": POULTRY_SAT},
        "per_flyway": per_flyway,
        "per_node": per_node,
    }
    path = os.path.join(DATA, "habitat.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=1)
    print(f"\nwrote {path} ({os.path.getsize(path)} bytes)", flush=True)


if __name__ == "__main__":
    main()
