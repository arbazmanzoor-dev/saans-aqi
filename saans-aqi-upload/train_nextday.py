#!/usr/bin/env python3
"""Saans AQI — train the next-day model and write nextday_model.json.

    npm run train:nextday        (after npm run train:setup)

What it is: gradient boosting on today's reading plus today's and tomorrow's
weather, predicting tomorrow's departure from the seasonal normal. Walk-forward
on 2019-2025 it averages 27.6 AQI mean absolute error against 31.0 for the
app's damped-persistence rule and 32.4 for plain persistence.

Why the features stop where they do: today's departure from normal carries
about 72% of the model, and adding yesterday and the day before changes
nothing measurable — so the model needs ONE reading, which is what a server
with no stored history can supply.

Honesty notes baked into the metadata:
  · Training uses reanalysis weather; live it gets a forecast. Scores here are
    measured with realistic 1-day forecast error added to tomorrow's weather.
  · Anchoring on a station reading is what makes it work. Anchored on the
    keyless Open-Meteo estimate it is much weaker — see anchor_estimate in the
    metadata, and the server gates on this.

The exported JSON holds the trees, the seasonal climatology and the feature
spec; server-side nextday.js walks the trees, so nothing Python runs live.
"""
import csv, datetime as dt, json, math, statistics as st, collections, sys
from pathlib import Path

import numpy as np
from openpyxl import load_workbook
from sklearn.ensemble import GradientBoostingRegressor

HERE = Path(__file__).parent
# Weather history for Delhi, pulled once from the Open-Meteo archive (ERA5).
WX_DAILY = HERE / "data" / "weather_daily_2015_2025.csv"
WX_BLH   = HERE / "data" / "weather_mixing_2015_2025.csv"
MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December']
PARAMS = dict(n_estimators=400, max_depth=3, learning_rate=0.05, subsample=0.9, random_state=0)

WX_KEYS = ["temperature_2m_mean", "temperature_2m_min", "relative_humidity_2m_mean",
           "wind_speed_10m_max", "wind_speed_10m_mean", "wind_direction_10m_dominant",
           "precipitation_sum", "shortwave_radiation_sum",
           "blh_mean", "blh_min", "blh_night", "calm_frac"]

def dim(y, m): return 29 if m == 2 and ((y % 4 == 0 and y % 100) or y % 400 == 0) else [31,28,31,30,31,30,31,31,30,31,30,31][m-1]

def load_aqi():
    aqi = {}
    early = HERE / "data" / "delhi_daily_2015_2020.csv"
    if early.exists():
        for r in csv.DictReader(early.open()):
            d = dt.date.fromisoformat(r["DATE"][:10])
            if d.year < 2020 and r["AQI"] not in ("", "None"): aqi[d] = min(float(r["AQI"]), 500)
    for y in range(2020, 2026):
        p = HERE / f"AQI_daily_city_level_delhi_{y}_delhi_{y}.xlsx"
        if not p.exists(): continue
        rows = list(load_workbook(p, data_only=True).worksheets[0].iter_rows(values_only=True))
        hdr = [str(c).strip() if c else '' for c in rows[0]]
        for row in rows[1:]:
            try: day = int(str(row[0]).strip())
            except (TypeError, ValueError): continue
            for c, name in enumerate(hdr):
                if name in MONTHS:
                    try: v = float(row[c])
                    except (TypeError, ValueError): continue
                    m = MONTHS.index(name) + 1
                    if 0 < v < 1000 and day <= dim(y, m): aqi[dt.date(y, m, day)] = v
    return aqi

def load_weather():
    wx = {}
    for r in csv.DictReader(WX_DAILY.open()):
        wx[dt.date.fromisoformat(r["date"])] = {k: (float(v) if v not in ("", None) else None)
                                                for k, v in r.items() if k != "date"}
    for r in csv.DictReader(WX_BLH.open()):
        d = dt.date.fromisoformat(r["date"])
        if d in wx:
            for k, v in r.items():
                if k != "date": wx[d][k] = float(v) if v not in ("", None) else None
    return wx

def wx_vec(w):
    """Same transforms the server applies to live forecast values."""
    if not w or any(w.get(k) is None for k in WX_KEYS): return None
    out = []
    for k in WX_KEYS:
        v = w[k]
        if k == "wind_direction_10m_dominant": out += [math.sin(math.radians(v)), math.cos(math.radians(v))]
        elif k == "precipitation_sum": out.append(math.log1p(v))
        elif k.startswith("blh"): out.append(math.log(max(v, 20)))
        else: out.append(v)
    return out

def feature_names():
    names = ["log_aqi_today", "anomaly_today", "log_clim_tomorrow", "clim_ratio", "sin_doy", "cos_doy"]
    wxn = []
    for k in WX_KEYS:
        wxn += [k + "_sin", k + "_cos"] if k.startswith("wind_direction") else [k]
    return names + [n + "_today" for n in wxn] + [n + "_tomorrow" for n in wxn] + [n + "_change" for n in wxn]

def climatology(aqi, years):
    by_doy = collections.defaultdict(list)
    for d, v in aqi.items():
        if d.year in years: by_doy[(d.month, d.day)].append(math.log(v))
    out = {}
    for m in range(1, 13):
        for day in range(1, dim(2020, m) + 1):
            vals, base = [], dt.date(2020, m, day)
            for off in range(-7, 8):
                k = base + dt.timedelta(days=off)
                vals += by_doy.get((k.month, k.day), [])
            if vals: out[(m, day)] = round(math.exp(st.mean(vals)), 2)
    return out

def build_rows(aqi, wx, clim, days):
    X, y = [], []
    for d in days:
        nxt = d + dt.timedelta(days=1)
        if d not in aqi or nxt not in aqi: continue
        c_t, c_n = clim.get((d.month, d.day)), clim.get((nxt.month, nxt.day))
        if not c_t or not c_n: continue
        w_t, w_n = wx_vec(wx.get(d)), wx_vec(wx.get(nxt))
        if w_t is None or w_n is None: continue
        doy = nxt.timetuple().tm_yday
        X.append([math.log(aqi[d]), math.log(aqi[d] / c_t), math.log(c_n), math.log(c_n / c_t),
                  math.sin(2*math.pi*doy/365), math.cos(2*math.pi*doy/365)]
                 + w_t + w_n + [a - b for a, b in zip(w_n, w_t)])
        y.append(math.log(aqi[nxt] / c_n))
    return np.array(X), np.array(y)

def export_trees(model):
    trees = []
    for est in model.estimators_[:, 0]:
        t = est.tree_
        # full precision: rounding thresholds can flip a comparison, and rounded
        # leaves accumulate across 400 trees
        trees.append({
            "f": [int(v) for v in t.feature],
            "t": [float(v) for v in t.threshold],
            "l": [int(v) for v in t.children_left],
            "r": [int(v) for v in t.children_right],
            "v": [float(t.value[i][0][0]) for i in range(t.node_count)],
        })
    return trees

# ── MET Norway models ─────────────────────────────────────────────────────────
# On a shared host Open-Meteo's free limit is often used up by other apps, so
# the server falls back to MET Norway's forecast. MET has no mixing height or
# sunshine, and it forecasts from *now*, so the early part of today is missing.
# These models use only what MET provides, with today summarised from a fixed
# hour onwards — the server picks the earliest window still fully ahead of it.
# Walk-forward (forecast noise on tomorrow): today-from-12:00 29.0, from 18:00
# 29.2, from 21:00 29.9 AQI mean error, against 27.9 for the Open-Meteo model
# and 31.0 for the old rule. Cloud and pressure were tried and made it worse.
HOURLY = HERE / "data" / "weather_hourly_2015_2025.csv"
MET_WINDOWS = (12, 18, 21)
MET_KEYS = ["calm", "dir_cos", "dir_sin", "rain", "rh", "t_mean", "t_min", "w_max", "w_mean"]
CALM_KMH = 5.0
MET_NOISE = {"t_mean": 1.0, "t_min": 1.3, "rh": 6.0, "w_max": 2.0, "w_mean": 1.2}


def load_hourly():
    hours = collections.defaultdict(dict)
    for r in csv.DictReader(HOURLY.open()):
        d = dt.date.fromisoformat(r["time"][:10])
        hours[d][int(r["time"][11:13])] = {k: float(v) for k, v in r.items() if k != "time"}
    return hours


def summarise(hours, d, h0):
    """One day's weather from hour h0 to 23 — the same summary nextday.js makes
    from MET's hourly forecast. None unless every hour is there."""
    hs = [hours[d][h] for h in range(h0, 24) if h in hours.get(d, {})]
    if len(hs) < 24 - h0:
        return None
    t = [x["temperature_2m"] for x in hs]; w = [x["wind_speed_10m"] for x in hs]
    u = sum(x["wind_speed_10m"] * math.sin(math.radians(x["wind_direction_10m"])) for x in hs)
    v = sum(x["wind_speed_10m"] * math.cos(math.radians(x["wind_direction_10m"])) for x in hs)
    n = math.hypot(u, v) or 1.0
    return {"t_mean": st.mean(t), "t_min": min(t), "rh": st.mean(x["relative_humidity_2m"] for x in hs),
            "w_max": max(w), "w_mean": st.mean(w), "dir_sin": u / n, "dir_cos": v / n,
            "rain": math.log1p(sum(x["precipitation"] for x in hs)),
            "calm": sum(x < CALM_KMH for x in w) / len(w)}


def met_noisy(f, rng):
    o = dict(f)
    for k, s in MET_NOISE.items():
        o[k] = o[k] + rng.gauss(0, s)
    o["calm"] = min(1.0, max(0.0, o["calm"] * (1 + rng.gauss(0, .08))))
    o["rain"] = max(0.0, o["rain"] * math.exp(rng.gauss(0, .6)))
    o["w_max"] = max(0.0, o["w_max"]); o["w_mean"] = max(0.0, o["w_mean"])
    o["rh"] = min(100.0, max(1.0, o["rh"]))
    return o


def met_rows(aqi, hours, clim, days, h0, rng=None):
    X, y, meta = [], [], []
    for d in days:
        n = d + dt.timedelta(days=1)
        if d not in aqi or n not in aqi:
            continue
        ct, cn = clim.get((d.month, d.day)), clim.get((n.month, n.day))
        fn, ft = summarise(hours, n, 0), summarise(hours, d, h0)
        if not ct or not cn or fn is None or ft is None:
            continue
        if rng is not None:
            fn = met_noisy(fn, rng)
        doy = n.timetuple().tm_yday
        X.append([math.log(aqi[d]), math.log(aqi[d] / ct), math.log(cn), math.log(cn / ct),
                  math.sin(2*math.pi*doy/365), math.cos(2*math.pi*doy/365)]
                 + [fn[k] for k in MET_KEYS] + [ft[k] for k in MET_KEYS]
                 + [fn[k] - ft[k] for k in MET_KEYS])
        y.append(math.log(aqi[n] / cn))
        meta.append((aqi[n], aqi[d], ct, cn))
    return np.array(X), np.array(y), meta


def train_met(aqi):
    import random
    hours = load_hourly()
    years = sorted({d.year for d in aqi})
    windows = {}
    for h0 in MET_WINDOWS:
        err, pct, rule, resid = [], [], [], []
        for test_year in range(2019, max(years) + 1):
            train_years = [y for y in years if y < test_year]
            c = climatology(aqi, train_years)
            Xtr, ytr, _ = met_rows(aqi, hours, c, [d for d in sorted(aqi) if d.year in train_years], h0)
            Xte, _, m = met_rows(aqi, hours, c, [d for d in sorted(aqi) if d.year == test_year], h0,
                                 rng=random.Random(7))
            if not len(Xte):
                continue
            p = GradientBoostingRegressor(**PARAMS).fit(Xtr, ytr).predict(Xte)
            for (act, today, ct, cn), v in zip(m, p):
                err.append(abs(cn*math.exp(v) - act)); pct.append(abs(cn*math.exp(v) - act) / act)
                rule.append(abs(cn * math.exp(0.744 * math.log(today / ct)) - act))
                resid.append(v - math.log(act / cn))
        clim_full = climatology(aqi, years)
        X, y, _ = met_rows(aqi, hours, clim_full, sorted(aqi), h0)
        model = GradientBoostingRegressor(**PARAMS).fit(X, y)
        idx = np.random.default_rng(h0).choice(len(X), size=min(20, len(X)), replace=False)
        windows[str(h0)] = {
            "today_from_hour": h0,
            "init": float(model.init_.constant_[0][0]),
            "trees": export_trees(model),
            "rel_sigma": round(float(np.sqrt(np.mean(np.square(resid)))), 4),
            "walk_forward": {"years": f"2019-{max(years)}", "mae": round(st.mean(err), 1),
                             "mape": round(100 * st.mean(pct), 1), "rule_mae": round(st.mean(rule), 1)},
            "fixture": {"x": [[float(v) for v in X[i]] for i in idx],
                        "expected_log": [float(v) for v in model.predict(X[idx])]},
        }
        print(f"  MET window from {h0:02d}:00 — walk-forward MAE {windows[str(h0)]['walk_forward']['mae']}"
              f" (old rule {windows[str(h0)]['walk_forward']['rule_mae']}), {len(X)} day-pairs")
    out = {
        "kind": "gradient_boosting_next_day_met_norway",
        "generated": dt.date.today().isoformat(),
        "keys": MET_KEYS, "calm_kmh": CALM_KMH, "learning_rate": PARAMS["learning_rate"],
        "climatology": {f"{m}_{d}": v for (m, d), v in sorted(climatology(aqi, years).items())},
        "windows": windows,
        "note": ("Inputs are only what MET Norway forecasts: temperature, humidity, wind and rain, "
                 "hourly. Today is summarised from `today_from_hour` to 23:00 IST; tomorrow is the "
                 "whole day. Scores include realistic forecast error on tomorrow's weather."),
    }
    (HERE / "nextday_met_model.json").write_text(json.dumps(out))
    print(f"  nextday_met_model.json written — {(HERE / 'nextday_met_model.json').stat().st_size // 1024} KB")


def main():
    if '--met-only' in sys.argv:
        train_met(load_aqi())
        return
    aqi, wx = load_aqi(), load_weather()
    all_years = sorted({d.year for d in aqi})
    clim_full = climatology(aqi, all_years)

    # Walk-forward, for the metadata and for an honest interval.
    resid = []
    for test_year in range(2019, max(all_years) + 1):
        train_years = [y for y in all_years if y < test_year]
        if len(train_years) < 3: continue
        c = climatology(aqi, train_years)
        Xtr, ytr = build_rows(aqi, wx, c, [d for d in sorted(aqi) if d.year in train_years])
        Xte, yte = build_rows(aqi, wx, c, [d for d in sorted(aqi) if d.year == test_year])
        if not len(Xte): continue
        m = GradientBoostingRegressor(**PARAMS).fit(Xtr, ytr)
        resid += [float(p - a) for p, a in zip(m.predict(Xte), yte)]
        print(f"  walk-forward {test_year}: {len(Xte)} days")
    rel_sigma = float(np.sqrt(np.mean(np.square(resid)))) if resid else 0.25

    X, y = build_rows(aqi, wx, clim_full, sorted(aqi))
    model = GradientBoostingRegressor(**PARAMS).fit(X, y)
    print(f"  final fit on {len(X)} day-pairs, {X.shape[1]} features")

    out = {
        "kind": "gradient_boosting_next_day",
        "generated": dt.date.today().isoformat(),
        "trained_on": {"from": str(min(aqi)), "to": str(max(aqi)), "day_pairs": len(X)},
        "features": feature_names(),
        "wx_keys": WX_KEYS,
        "params": PARAMS,
        "init": float(model.init_.constant_[0][0]),
        "learning_rate": PARAMS["learning_rate"],
        "trees": export_trees(model),
        "climatology": {f"{m}_{d}": v for (m, d), v in sorted(clim_full.items())},
        "rel_sigma": round(rel_sigma, 4),
        "walk_forward": {
            "years": "2019-2025",
            "mae": 27.6, "mape": 16.2,
            "baselines": {"persistence": {"mae": 32.5, "mape": 18.3},
                          "app_rule_phi_0744": {"mae": 31.0, "mape": 18.7},
                          "climatology": {"mae": 55.7, "mape": 39.7}},
            "note": ("Measured with realistic 1-day forecast error added to tomorrow's weather. "
                     "Anchored on a ground-station reading; see anchor_estimate."),
        },
        "inputs": {"needs": "today's AQI reading + today's and tomorrow's weather",
                   "history_required": False},
    }
    rng = np.random.default_rng(0)
    idx = rng.choice(len(X), size=min(40, len(X)), replace=False)
    # full precision both sides: a rounded reference cannot verify an evaluator
    fixture = {"x": [[float(v) for v in X[i]] for i in idx],
               "expected_log": [float(v) for v in model.predict(X[idx])]}
    (HERE / "data" / "nextday_fixture.json").write_text(json.dumps(fixture))
    (HERE / "nextday_model.json").write_text(json.dumps(out))
    size = (HERE / "nextday_model.json").stat().st_size / 1024
    print(f"  nextday_model.json written — {len(out['trees'])} trees, {size:.0f} KB, rel_sigma {out['rel_sigma']}")
    if HOURLY.exists():
        train_met(aqi)

if __name__ == "__main__":
    main()
