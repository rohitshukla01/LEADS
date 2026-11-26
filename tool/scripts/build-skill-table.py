#!/usr/bin/env python3
"""
Build lib/skill/forecast-skill.json, the forecast-skill record read by the Forecast skill card
(components/ForecastSkillCard.tsx), the PDF decision report (lib/report.ts) and the answer's
evidence record (lib/leads/orchestrator.ts), all through lib/skill/forecast-skill.ts.

Offline tool: not run by the app or its build. The record is frozen at SNAPSHOT (target dates
on or before 14 October 2026) and built from three pinned input parquets, so a re-run
matches the saved JSON (`--check`). Inputs that differ from the pinned
ones are refused unless `--allow-new-inputs` is passed.

One pooled rule for every variable (Temp_C_mean, DO_mgL_mean, Chla_ugL_mean):
  CRPSS (%) = 100 * (1 - sum CRPS(glm_aed_flare_v3) / sum CRPS(climatology)) at FCR, 1.6 m,
  strictly paired on (reference date, target date, depth), each pair counted once (earliest
  pub_datetime: the archive repeats rows), pooled over every scored forecast, per forecast day
  1..21, with a 95% CI from a block bootstrap over issue dates (14-day blocks, B = 10000,
  seed 20261015).
Fig. 4d of the paper is drawn from this record (reproduce_paper/forecast_example/make_figure4.py).

Usage:
  python3 scripts/build-skill-table.py --scores-dir DIR   compute from the three frozen parquets (no network)
  python3 scripts/build-skill-table.py --fetch DIR        first write the parquets from the public archive
                                                          (anonymous, free), then compute
  options:
    --out PATH                 where to write (default lib/skill/forecast-skill.json)
    --check                    rebuild and check that it matches --out; writes nothing
    --allow-new-inputs         accept inputs whose sha256 differs from the pinned ones
Requires duckdb and numpy (the record was built with duckdb 1.5.4 and numpy 2.3.5; both are
written to meta.software, so --check fails on other versions on purpose).
"""
import argparse, hashlib, json, os, sys
import duckdb
import numpy as np

SITE, MODEL, BASELINE = "fcre", "glm_aed_flare_v3", "climatology"
VARS = {"Temp_C_mean": "temp", "DO_mgL_mean": "do", "Chla_ugL_mean": "chla"}
DEPTH_M, DEPTH_TOL_M = 1.6, 0.05     # the one depth glm_aed_flare_v3 is scored at; matches SKILL_DEPTH_TOLERANCE_M
MAX_DAY, DEFAULT_DAYS = 21, 7
SNAPSHOT = "2026-10-14"
BLOCK_DAYS, B, SEED = 14, 10000, 20261015
# sha256 of the frozen per-variable input parquets
PINNED_SHA256 = {
    "temp": "f7d5bdd60741603ce62397ec3616736e24cb024677bf842b948a18797a02c103",
    "do":   "9cb9d54d84f4c8a360022aff95c34ef0acce30ac4f8431bb3098854fa451d6a9",
    "chla": "5f0a77c730957508da324896833cab8c4f1a0dd430e22f98451ea95447652497",
}
SCORES = "s3://bio230121-bucket01/vera4cast/scores/bundled-parquet/project_id=vera4cast/duration=P1D"
OUT_DEFAULT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "lib", "skill", "forecast-skill.json"))


def parquet_path(d, tag):
    return os.path.join(d, f"fcre_{tag}_1p6_flare_vs_clim.parquet")


def fetch(d):
    """Fetch the paired FLARE and climatology scores: one row per (model, reference, target, depth), earliest pub_datetime."""
    os.makedirs(d, exist_ok=True)
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    con.execute("CREATE SECRET osn (TYPE S3, KEY_ID '', SECRET '', ENDPOINT 'amnh1.osn.mghpcc.org', URL_STYLE 'path', USE_SSL true, REGION 'us-east-1');")
    for var, tag in VARS.items():
        g = f"{SCORES}/variable={var}/**/*.parquet"
        out = parquet_path(d, tag)
        con.execute(f"""
COPY (
  WITH s AS (SELECT model_id, reference_datetime::timestamp rd, datetime::timestamp dt, depth_m d, observation obs, crps, pub_datetime,
                    mean, sd, quantile10 q10, quantile90 q90, "quantile02.5" q025, "quantile97.5" q975
             FROM read_parquet('{g}', hive_partitioning=1)
             WHERE site_id='{SITE}' AND abs(depth_m - {DEPTH_M}) <= {DEPTH_TOL_M} AND crps IS NOT NULL
               AND model_id IN ('{MODEL}','{BASELINE}')
             QUALIFY row_number() OVER (PARTITION BY model_id, reference_datetime, datetime, depth_m
                                        ORDER BY pub_datetime ASC, crps) = 1),
       f AS (SELECT * FROM s WHERE model_id='{MODEL}'),
       c AS (SELECT * FROM s WHERE model_id='{BASELINE}')
  SELECT f.rd, f.dt, date_diff('day', f.rd, f.dt) AS lead, f.obs,
         f.crps AS crps_flare, c.crps AS crps_clim,
         f.mean AS mean_flare, f.sd AS sd_flare, f.q10 AS q10_flare, f.q90 AS q90_flare,
         c.mean AS mean_clim, c.sd AS sd_clim, c.q10 AS q10_clim, c.q90 AS q90_clim
  FROM f JOIN c ON f.rd=c.rd AND f.dt=c.dt AND f.d=c.d
  WHERE date_diff('day', f.rd, f.dt) BETWEEN 1 AND 35
) TO '{out}' (FORMAT parquet);
""")
        n, k = con.execute(f"SELECT count(*), count(DISTINCT (rd, dt)) FROM read_parquet('{out}')").fetchone()
        assert n == k, f"{tag}: {n - k} duplicate (rd, dt) rows survived"
        print(f"fetched {var} -> {out}", file=sys.stderr)


def crpss_ci(rday, f, c, block_days=BLOCK_DAYS, n_boot=B, seed=SEED):
    """Point CRPSS (%) and its 95% block-bootstrap interval over issue-date blocks."""
    blk = (rday - rday.min()) // block_days
    _, inv = np.unique(blk, return_inverse=True)
    F, C = np.bincount(inv, f), np.bincount(inv, c)
    idx = np.random.default_rng(seed).integers(0, len(F), (n_boot, len(F)))
    lo, hi = np.percentile(100 * (1 - F[idx].sum(1) / C[idx].sum(1)), [2.5, 97.5])
    return 100 * (1 - f.sum() / c.sum()), lo, hi


def js_round(x):
    """JavaScript Math.round (ties toward +inf), which the card, PDF and evidence apply to the stored 2-dp value."""
    return int(np.floor(x + 0.5)) or 0


def compute(d, strict_inputs):
    con = duckdb.connect()
    site, inputs = {}, {}
    for var, tag in VARS.items():
        P = parquet_path(d, tag)
        with open(P, "rb") as fh:
            sha = hashlib.sha256(fh.read()).hexdigest()
        if sha != PINNED_SHA256[tag]:
            msg = f"{tag}: input sha256 {sha} != pinned {PINNED_SHA256[tag]}"
            if strict_inputs:
                sys.exit(msg + " (the frozen record is built from the pinned inputs; pass --allow-new-inputs to rebuild from different inputs)")
            print("WARNING " + msg, file=sys.stderr)
        n, k = con.execute(f"SELECT count(*), count(DISTINCT (rd, dt)) FROM read_parquet('{P}')").fetchone()
        assert n == k, f"{tag}: {n - k} duplicate (rd, dt) rows; re-fetch"
        # Pairs with target dates up to SNAPSHOT, forecast days 1 to 21
        a = con.execute(f"SELECT rd, (epoch(rd) / 86400)::BIGINT rday, lead, month(dt) m, crps_flare f, crps_clim c FROM read_parquet('{P}') "
                        f"WHERE dt <= TIMESTAMP '{SNAPSHOT}' AND lead BETWEEN 1 AND {MAX_DAY}").fetchnumpy()
        a = {key: np.asarray(val) for key, val in a.items()}
        span = con.execute(f"SELECT min(rd), max(dt) FROM read_parquet('{P}') "
                           f"WHERE dt <= TIMESTAMP '{SNAPSHOT}' AND lead BETWEEN 1 AND {MAX_DAY}").fetchone()
        days = []
        for L in range(1, MAX_DAY + 1):
            sel = a["lead"] == L
            assert sel.sum() > 0, f"{var}: no pairs on day {L}"
            pt, lo, hi = crpss_ci(a["rday"][sel], a["f"][sel], a["c"][sel])
            # 2-dp storage: the paper prints f"{v:.0f}" of the unrounded value and the app applies Math.round to the
            # stored value; they must agree in every cell (1-dp storage would round twice: 29.46 to 29.5, then to 30).
            paper = int(f"{pt:.0f}") or 0
            assert paper == js_round(round(pt, 2)), (var, L, pt)
            # A rounded CI bound must never contradict the class (lo > 0 / includes 0 / hi < 0).
            assert abs(lo) >= 0.5 and abs(hi) >= 0.5, (var, L, lo, hi)
            row = {"day": L, "crpss": round(float(pt), 2), "lo": round(float(lo), 2), "hi": round(float(hi), 2), "n": int(sel.sum())}
            assert row["lo"] <= row["crpss"] <= row["hi"], (var, row)
            days.append(row)
        assert [x["day"] for x in days] == list(range(1, MAX_DAY + 1)), var
        site[var] = {"coverage": {"from": str(span[0])[:10], "to": str(span[1])[:10]},
                     "runs": int(len(np.unique(a["rd"]))), "days": days}
        inputs[var] = {"sha256": sha, "pairs": int(n)}
    meta = {
        "schema": 2,
        "model": MODEL,
        "baseline": BASELINE,
        "metric": "CRPSS (%) = 100 x (1 - sum CRPS(model) / sum CRPS(climatology)), strictly paired on (reference date, target date, depth), each pair counted once (earliest submission), pooled over every scored forecast",
        "site": SITE,
        "depth_m": DEPTH_M,
        "max_day": MAX_DAY,
        "default_days": DEFAULT_DAYS,
        "ci": {"level": 95, "method": "block bootstrap over issue dates", "block_days": BLOCK_DAYS, "resamples": B, "seed": SEED},
        "record_through": SNAPSHOT,
        "source": "VERA4cast scores archive, daily (P1D)",
        "inputs": inputs,
        "software": {"duckdb": duckdb.__version__, "numpy": np.__version__},
        "note": "Past skill (track record) of glm_aed_flare_v3 vs climatology at FCR 1.6 m, by forecast day 1-21. BVR is not scored.",
    }
    return {"meta": meta, SITE: site}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--scores-dir")
    g.add_argument("--fetch", metavar="DIR")
    ap.add_argument("--out", default=OUT_DEFAULT)
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--allow-new-inputs", action="store_true")
    a = ap.parse_args()
    d = a.scores_dir or a.fetch
    if a.fetch:
        fetch(d)
    rec = compute(d, strict_inputs=not a.allow_new_inputs)
    text = json.dumps(rec, indent=1, sort_keys=False) + "\n"
    if a.check:
        same = os.path.exists(a.out) and open(a.out).read() == text
        print("check: saved record matches a rebuild" if same else f"check: saved record DIFFERS from a rebuild: {a.out}", file=sys.stderr)
        sys.exit(0 if same else 1)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with open(a.out, "w") as fh:
        fh.write(text)
    for var, v in rec[SITE].items():
        print(f"{var}: " + ", ".join(f"d{x['day']} {x['crpss']:+.2f} [{x['lo']:+.2f},{x['hi']:+.2f}]" for x in v["days"][:7]) + " ...", file=sys.stderr)
    print(f"wrote {a.out}", file=sys.stderr)


if __name__ == "__main__":
    main()
