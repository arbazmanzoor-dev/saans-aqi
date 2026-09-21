#!/usr/bin/env python3
"""Saans AQI — retrain the forecast models and regenerate ml_lookup.json.

    npm run train:setup    # once: creates .venv from requirements.txt
    npm run train          # retrains, then rebuilds day_factors.json

XGBoost on macOS needs OpenMP first (brew install libomp); without it the
script falls back to the sklearn stand-in. Restart the server afterwards.

Why this replaces the previous lookup
-------------------------------------
1. Its training targets came from the buggy sheet parse (summary rows counted
   as AQI readings), so every 2020-2025 month was biased low.
2. It forecast recursively through a lag-12 feature. Tree ensembles cannot
   extrapolate, so each step regressed toward the training mean and the series
   collapsed to a fixed point — November 2026 came out at 203 against a
   354 average, and 2027-2035 were byte-identical.

The fix is to forecast level and shape separately:

    AQI(year, month) = level(year) x seasonal_ratio(month, features)

`level` is a damped robust trend over recent complete years; the ensemble
predicts the ratio from features that are knowable in advance for any future
month (month, season angle, Diwali timing, monthly climatology of stubble /
PM2.5 / rain / fog). Nothing feeds on its own output, so a 2035 November stays
a November.
"""
import json, math, statistics, sys
from pathlib import Path

import numpy as np
from openpyxl import load_workbook
from sklearn.ensemble import (RandomForestRegressor, GradientBoostingRegressor,
                              HistGradientBoostingRegressor)

HERE = Path(__file__).parent
MONTHS = ['January','February','March','April','May','June',
          'July','August','September','October','November','December']

FORECAST_YEARS  = range(2025, 2036)
# Complete years used for the level trend. Six, not five: a 5-year window ends
# at 2020, whose COVID-lockdown dip (185.6 against ~209 either side) drags the
# robust slope to +2.87/yr — an artefact, not a trend. Widening by one year
# gives -0.13/yr, matching the flat 2021-2024 record (209.1, 209.4, 203.8, 209.2).
LEVEL_YEARS     = 6
SHAPE_YEARS     = 5     # years behind the climatology baseline
BACKTEST_FROM   = 5     # keep 2020 in the walk-forward: a COVID year is a real test
DAMPING         = 0.8   # trend damping per year ahead
SEED            = 0

# Train on the recent regime only. Delhi's seasonal shape has drifted: November
# ran ~1.36x the annual mean in 2015 and ~1.79x by 2024 (r=0.74 against year).
# Fitting all ten years pulled the November ratio down to 1.56 against a
# recent-five-year 1.74 — the single biggest error in the old table. A 5-year
# window reproduces 1.80 at the same walk-forward MAPE (17.5% either way).
TRAIN_WINDOW     = 5
RECENCY_HALFLIFE = 8.0  # mild preference for recent rows inside the window

# Diwali timing is knowable years ahead, so it looks like free signal — but it
# measurably costs accuracy on the months it should help. Re-tested 2026-09-21
# with ten years of history, walk-forward Oct+Nov MAPE:
#   5-year window: 11.60% without, 12.98% with
#   10-year window: 11.44% without, 13.54% with
# Still too few Diwalis to learn from. `--diwali` re-runs the test.
# (The 10-year window without Diwali is a wash, not a win: MAPE 18.00% vs
# 18.39% but MAE 33.2 vs 32.8 and R² 0.767 vs 0.779, so 5 years stays.)
USE_DIWALI_TIMING = False

# Command-line switches for experiments, so a variant can be tested without
# editing this file or overwriting the served model:
#   --diwali       add the Diwali-timing features
#   --window N     train on the last N years instead of TRAIN_WINDOW
#   --dry-run      run the walk-forward and print it; write nothing
if '--diwali' in sys.argv: USE_DIWALI_TIMING = True
if '--window' in sys.argv: TRAIN_WINDOW = int(sys.argv[sys.argv.index('--window') + 1])
DRY_RUN = '--dry-run' in sys.argv


# ── data ────────────────────────────────────────────────────────────────────
def days_in_month(year, month):
    if month == 2:
        return 29 if (year % 4 == 0 and year % 100 != 0) or year % 400 == 0 else 28
    return [31,28,31,30,31,30,31,31,30,31,30,31][month-1]


def read_sheets():
    """Daily AQI from the CPCB workbooks, keyed (year, month) -> [values].

    Rows below day 31 hold category counts and '% of Availability'; the 2020
    workbook heads its first column 'Date' with string days. Only rows whose
    first cell is a real calendar day are readings."""
    monthly = {}
    for year in range(2020, 2026):
        path = HERE / f'AQI_daily_city_level_delhi_{year}_delhi_{year}.xlsx'
        if not path.exists():
            continue
        rows = list(load_workbook(path, data_only=True).worksheets[0].iter_rows(values_only=True))
        header = [str(c).strip() if c is not None else '' for c in rows[0]]
        for row in rows[1:]:
            try:
                day = int(str(row[0]).strip())
            except (TypeError, ValueError):
                continue
            if not 1 <= day <= 31:
                continue
            for col, name in enumerate(header):
                if name not in MONTHS:
                    continue
                month = MONTHS.index(name) + 1
                value = row[col]
                if value is None or str(value).strip() == '':
                    continue
                try:
                    aqi = float(value)
                except (TypeError, ValueError):
                    continue
                if not 0 < aqi < 1000 or day > days_in_month(year, month):
                    continue
                monthly.setdefault((year, month), []).append(aqi)
    return monthly


EARLY_CSV = HERE / 'data' / 'delhi_daily_2015_2020.csv'


def read_early():
    """Daily AQI for 2015-2019 from data/delhi_daily_2015_2020.csv: the
    "Air Quality Data in India (2015-2020)" city_day table, compiled from CPCB
    station data. Its AQI reads ~10 above the CPCB workbooks where the two
    overlap (Jan-Jun 2020), so only the years before the workbooks come from it."""
    import csv
    monthly = {}
    if not EARLY_CSV.exists():
        return monthly
    with EARLY_CSV.open(newline='') as fh:
        for row in csv.DictReader(fh):
            try:
                year, month, day = (int(x) for x in row['DATE'][:10].split('-'))
                aqi = float(row['AQI'])
            except (KeyError, ValueError):
                continue
            if year < 2020 and 0 < aqi < 1000 and 1 <= day <= days_in_month(year, month):
                monthly.setdefault((year, month), []).append(aqi)
    return monthly


def build_history(previous):
    """Monthly means: 2015-2019 from the city_day CSV, 2020-2025 from the CPCB
    workbooks. If the CSV is missing, 2015-2019 fall back to the previous
    lookup, which holds the same monthly values."""
    history = {}
    for key, value in (previous.get('monthly_aqi_history') or {}).items():
        year, month = (int(x) for x in key.split('_'))
        if year < 2020:
            history[(year, month)] = float(value)
    for (year, month), values in {**read_early(), **read_sheets()}.items():
        history[(year, month)] = round(sum(values)/len(values), 3)
    return history


# ── level: where the year sits ──────────────────────────────────────────────
def theil_sen(xs, ys):
    slopes = [(ys[j]-ys[i])/(xs[j]-xs[i])
              for i in range(len(xs)) for j in range(i+1, len(xs))]
    slope = statistics.median(slopes) if slopes else 0.0
    intercept = statistics.median([y - slope*x for x, y in zip(xs, ys)])
    return slope, intercept


def build_levels(history):
    """Annual level per year, plus a damped projection for future years.

    A robust (Theil-Sen) slope over the most recent complete years resists the
    2020 COVID dip, and damping keeps a weak, noisy trend from compounding into
    an implausible 2035."""
    years = sorted({y for y, _ in history})
    complete = [y for y in years if sum((y, m) in history for m in range(1, 13)) == 12]
    levels = {y: sum(history[(y, m)] for m in range(1, 13))/12 for y in complete}

    recent = complete[-LEVEL_YEARS:]
    slope, intercept = theil_sen(recent, [levels[y] for y in recent])
    anchor_year  = complete[-1]
    anchor_level = intercept + slope*anchor_year        # smoothed, not the raw year

    # Partial years: rescale the months we do have by their seasonal shape.
    season = seasonal_shape(history, complete[-SHAPE_YEARS:])
    for year in years:
        if year in levels:
            continue
        obs = [(m, history[(year, m)]) for m in range(1, 13) if (year, m) in history]
        if obs:
            levels[year] = sum(a/season[m] for m, a in obs)/len(obs)

    return levels, complete, slope, anchor_year, anchor_level


def project_level(year, anchor_year, anchor_level, slope):
    """Level for a year past the last complete one. The trend contributes a
    damped, bounded amount — with DAMPING=0.8 it can never add more than five
    years' worth of slope, however far out the forecast runs."""
    steps = max(0, year - anchor_year)
    return anchor_level + slope*sum(DAMPING**i for i in range(steps))


def seasonal_shape(history, years):
    """Mean AQI(month)/AQI(year) over the given years."""
    shape = {}
    for month in range(1, 13):
        ratios = []
        for year in years:
            year_vals = [history[(year, m)] for m in range(1, 13) if (year, m) in history]
            if len(year_vals) == 12 and (year, month) in history:
                ratios.append(history[(year, month)]/(sum(year_vals)/12))
        shape[month] = sum(ratios)/len(ratios) if ratios else 1.0
    return shape


# ── features ────────────────────────────────────────────────────────────────
FEATURES = (['month','sinM','cosM','pm25f','stubble']
            + (['diwali_month','diwali_pos'] if USE_DIWALI_TIMING else [])
            + ['dry_streak','rain_cat','fog_score','monsoon_onset','monsoon_withdraw'])


def make_features(year, month, meta):
    pm25     = meta['pm25_monthly_avgs']
    monthly  = meta['feat_avgs'][str(month)]
    diwali   = meta['diwali_dates'].get(str(year))
    in_month = 1.0 if diwali and diwali[0] == month else 0.0
    # Where in the month Diwali falls: a late-October Diwali pushes its smoke
    # into November, an early one keeps it in October. Known years ahead.
    position = (diwali[1]/days_in_month(year, month)) if in_month else 0.0
    return ([
        month,
        math.sin(2*math.pi*month/12), math.cos(2*math.pi*month/12),
        pm25[str(month)], monthly['stubble'],
    ] + ([in_month, position] if USE_DIWALI_TIMING else []) + [
        monthly['dry_streak'], monthly['rain_cat'], monthly['fog_score'],
        monthly['monsoon_onset'], monthly['monsoon_withdraw'],
    ])


def training_matrix(history, levels, meta, window=TRAIN_WINDOW):
    X, y, weights = [], [], []
    latest = max(y_ for y_, _ in history)
    for (year, month), aqi in sorted(history.items()):
        if window and year <= latest - window:
            continue
        if year not in levels:
            continue
        X.append(make_features(year, month, meta))
        y.append(aqi/levels[year])
        weights.append(0.5**((latest - year)/RECENCY_HALFLIFE))
    return np.array(X, float), np.array(y, float), np.array(weights, float)


# ── models ──────────────────────────────────────────────────────────────────
def make_models():
    models = {
        'rf': RandomForestRegressor(n_estimators=400, min_samples_leaf=2,
                                    random_state=SEED, n_jobs=-1),
        'gb': GradientBoostingRegressor(n_estimators=300, learning_rate=0.05,
                                        max_depth=2, random_state=SEED),
        # depth kept shallow on purpose: ~60 training rows
    }
    try:
        from xgboost import XGBRegressor
        models['xgb'] = XGBRegressor(n_estimators=300, learning_rate=0.05, max_depth=3,
                                     subsample=0.9, random_state=SEED, verbosity=0)
        third = 'xgb'
    except Exception:                                   # no OpenMP runtime → stand-in
        models['hgb'] = HistGradientBoostingRegressor(max_iter=300, learning_rate=0.05,
                                                      max_depth=3, min_samples_leaf=3,
                                                      random_state=SEED)
        third = 'hgb'
    return models, third


def fit_all(models, X, y, w):
    for name, model in models.items():
        try:
            model.fit(X, y, sample_weight=w)
        except TypeError:
            model.fit(X, y)
    return models


def predict_all(models, feats):
    row = np.array([feats], float)
    return {name: float(model.predict(row)[0]) for name, model in models.items()}


# ── validation ──────────────────────────────────────────────────────────────
def backtest(history, meta, model_names):
    """Walk-forward: for each held-out year, train only on earlier years and
    forecast all 12 months — level projection included, so this measures the
    whole pipeline rather than just the seasonal fit."""
    complete = sorted({y for y in {y for y, _ in history}
                       if sum((y, m) in history for m in range(1, 13)) == 12})
    rows, per_model = [], {n: [] for n in model_names}
    for test_year in complete[BACKTEST_FROM:]:
        past = {k: v for k, v in history.items() if k[0] < test_year}
        levels, _, slope, anchor_year, anchor_level = build_levels(past)
        level = project_level(test_year, anchor_year, anchor_level, slope)

        X, y, w = training_matrix(past, levels, meta)
        models = fit_all(dict(make_models()[0]), X, y, w)
        shape  = seasonal_shape(past, sorted({k[0] for k in past})[-SHAPE_YEARS:])
        # `shape` is the climatology baseline this ensemble has to beat

        for month in range(1, 13):
            actual = history[(test_year, month)]
            preds  = predict_all(models, make_features(test_year, month, meta))
            for name, ratio in preds.items():
                per_model[name].append((level*ratio, actual))
            blended = level*sum(preds.values())/len(preds)
            rows.append((test_year, month, blended, actual, level*shape[month]))
    return rows, per_model


def score(pairs):
    pred = np.array([p for p, _ in pairs]); act = np.array([a for _, a in pairs])
    ss_res = float(((act-pred)**2).sum())
    ss_tot = float(((act-act.mean())**2).sum())
    return {'mae': round(float(np.abs(act-pred).mean()), 1),
            'mape': round(float((np.abs(act-pred)/act).mean()*100), 2),
            'r2': round(1-ss_res/ss_tot, 4)}


# ── main ────────────────────────────────────────────────────────────────────
def main():
    previous = json.loads((HERE/'ml_lookup.json').read_text())
    meta = {k: previous[k] for k in
            ('pm25_monthly_avgs', 'feat_avgs', 'diwali_dates')}
    history = build_history(previous)

    models, third = make_models()
    names = list(models)
    print(f'History: {len(history)} months, '
          f'{min(y for y,_ in history)}–{max(y for y,_ in history)}')
    print(f'Models : {", ".join(names)}'
          + ('' if third == 'xgb' else
             '   (xgboost unavailable — using sklearn HistGradientBoosting;'
             ' `brew install libomp && pip install xgboost` to switch)'))

    rows, per_model = backtest(history, meta, names)
    metrics = {n: score(p) for n, p in per_model.items()}
    blend_score = score([(b, a) for _, _, b, a, _ in rows])
    clim_score  = score([(c, a) for _, _, _, a, c in rows])

    print('\nWalk-forward (each year forecast from earlier years only)')
    for name in names:
        m = metrics[name]
        print(f'  {name:<5} MAE {m["mae"]:6.1f}  MAPE {m["mape"]:5.2f}%  R² {m["r2"]:.3f}')
    print(f'  blend MAE {blend_score["mae"]:6.1f}  MAPE {blend_score["mape"]:5.2f}%'
          f'  R² {blend_score["r2"]:.3f}')
    print(f'  (seasonal climatology baseline: MAE {clim_score["mae"]:.1f},'
          f' MAPE {clim_score["mape"]:.2f}%)')

    per_year = {}
    for year, _, blended, actual, _ in rows:
        per_year.setdefault(year, []).append(abs(blended-actual)/actual)
    per_year = {y: round(100*sum(v)/len(v), 1) for y, v in sorted(per_year.items())}
    print('  by year: ' + '  '.join(f'{y} {v}%' for y, v in per_year.items())
          + '   ← 2020-21 are the COVID dip and its rebound')
    octnov = [(b, a) for _, m, b, a, _ in rows if m in (10, 11)]
    octnov_clim = [(c, a) for _, m, _, a, c in rows if m in (10, 11)]
    print(f'  Oct+Nov only: MAPE {score(octnov)["mape"]:.2f}%'
          f'  (climatology {score(octnov_clim)["mape"]:.2f}%)'
          f'   [window {TRAIN_WINDOW}, Diwali {"on" if USE_DIWALI_TIMING else "off"}]')
    if DRY_RUN:
        print('\n(dry run — nothing written)')
        return

    # Ensemble weights from held-out error, not hand-picked.
    inverse = {n: 1/metrics[n]['mae'] for n in names}
    total   = sum(inverse.values())
    weights = {n: round(inverse[n]/total, 3) for n in names}
    print(f'\nEnsemble weights (∝ 1/MAE): {weights}')

    # Final fit on everything, then the forecast table.
    levels, complete, slope, anchor_year, anchor_level = build_levels(history)
    X, y, w = training_matrix(history, levels, meta)
    models = fit_all(models, X, y, w)
    print(f'Level trend: {slope:+.2f} AQI/year (robust, last {LEVEL_YEARS} complete '
          f'years), anchored at {anchor_year} = {anchor_level:.1f}, damping {DAMPING}')

    lookup = {}
    for year in FORECAST_YEARS:
        level = (levels[year] if year in complete
                 else project_level(year, anchor_year, anchor_level, slope))
        for month in range(1, 13):
            key = f'{year}_{month}'
            if (year, month) in history:
                lookup[key] = {'predicted': round(history[(year, month)]),
                               'source': 'observed'}
                continue
            preds = predict_all(models, make_features(year, month, meta))
            blended = sum(weights[n]*preds[n] for n in names)*level
            entry = {'predicted': max(1, round(blended)), 'source': 'model'}
            entry.update({n: max(1, round(level*preds[n])) for n in names})
            entry.update({'confidence': max(0, round(100-blend_score['mape'])),
                          'r2': blend_score['r2'], 'level': round(level, 1)})
            lookup[key] = entry

    out = dict(previous)
    out.update({
        'lookup': lookup,
        'weights': weights,
        'model_names': names,
        'walk_forward': {'per_model': metrics, 'blend': blend_score,
                         'climatology_baseline': clim_score,
                         'mape_by_year': per_year,
                         'years_tested': sorted({r[0] for r in rows}),
                         'note': ('Each year forecast from earlier years only. The '
                                  'ensemble matches the seasonal-climatology baseline '
                                  'rather than beating it: at a one-year-plus horizon '
                                  'there is no input beyond season and level.')},
        'features': FEATURES,
        'training_records': len(y),
        'levels': {str(k): round(v, 1) for k, v in sorted(levels.items())},
        'level_model': {'slope_per_year': round(slope, 3), 'anchor_year': anchor_year,
                        'anchor_level': round(anchor_level, 1), 'damping': DAMPING,
                        'years_used': LEVEL_YEARS},
        'monthly_aqi_history': {f'{y}_{m}': v for (y, m), v in sorted(history.items())},
        'history_note': ('2015-2019 from data/delhi_daily_2015_2020.csv (city_day table '
                         'compiled from CPCB station data); 2020-2025 from the CPCB workbooks.'),
        'generated': __import__('datetime').date.today().isoformat(),
    })
    for stale in ('loo_metrics', 'rf_importance'):
        out.pop(stale, None)
    (HERE/'ml_lookup.json').write_text(json.dumps(out, indent=1))

    # model_meta.json is read by no code, but it is the file a write-up quotes.
    # Regenerate it so it cannot go on claiming metrics from a retired model.
    (HERE/'model_meta.json').write_text(json.dumps({
        'models': names,
        'weights': weights,
        'features': FEATURES,
        'training_records': len(y),
        'training_window_years': TRAIN_WINDOW,
        'walk_forward': out['walk_forward'],
        'level_model': out['level_model'],
        'generated': out['generated'],
        'note': ('Walk-forward metrics: each year forecast from earlier years only. '
                 'The previous file reported leave-one-out R2 0.8959 for a lag-based '
                 'model trained on miscounted sheet data; both are superseded.'),
    }, indent=2))

    print('\nNovember: history vs new forecast')
    for year in range(2020, 2028):
        past = history.get((year, 11))
        new  = lookup.get(f'{year}_11', {}).get('predicted')
        old  = (previous['lookup'].get(f'{year}_11') or {}).get('predicted')
        print(f'  {year}  actual {past and round(past) or "—":>4}   '
              f'old {old or "—":>4}   new {new or "—":>4}')
    print(f'\nml_lookup.json rewritten — {len(lookup)} entries')


if __name__ == '__main__':
    main()
