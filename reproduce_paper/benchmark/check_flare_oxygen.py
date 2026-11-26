"""Recompute the FLARE dissolved-oxygen values quoted in the benchmark evidence (no API keys).

FLARE writes dissolved oxygen in mmol/m3. In 21 answers the evidence converts it to mg/L (x 32/1000) only
for values above 30; in the other 9 answers, and in tool/, every value is converted. This script downloads the two public FLARE files of 26 June 2026 that the answers
used, checks their SHA-256, recomputes every dissolved-oxygen forecast value in the evidence of
benchmark.json with both conversions, and reports which conversion reproduces each saved value.

Run from the repository root with duckdb 1.5.4 and numpy 2.3.5 installed, or run `bash reproduce.sh --online`;
it downloads about 64 MB:

    python reproduce_paper/benchmark/check_flare_oxygen.py
"""
import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request

import duckdb
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
URL = ("https://amnh1.osn.mghpcc.org/bio230121-bucket01/flare/forecasts/parquet/"
       "site_id={site}/model_id=glm_aed_flare_v3/reference_date=2026-06-26/part-0.parquet")
SHA256 = {  # SHA-256 of the two FLARE files
    "fcre": "fe559f7c5c38aaa88c106e870dcc0f6b01dbe8a8b9be7d33738f814bcc1552ad",
    "bvre": "1740c7cfb06797a5290b809a1dc1618572a489f392306aa485b13fa5e840cc17",
}
EVERY_VALUE = {"F1", "F2", "F3", "F4", "F5", "HYB-1", "HYB-2", "HYB-3", "M1"}  # answers whose evidence converts every value

NUM = r"(\d+\.\d+)"
WINDOW = re.compile(rf"FLARE GLM-AED (\d+)-day forecast for (FCRE|BVRE) DO_mgL_mean: mean {NUM} "
                    rf"\(range {NUM}–{NUM}\), ensemble spread {NUM}")
VAL = r"(\d+(?:\.\d+)?)"  # a depth or threshold, with or without decimals
DAY = re.compile(rf"FLARE (\d+)-day forecast for (FCRE|BVRE) DO_mgL_mean at {VAL} m: mean {NUM} mg/L "
                 rf"\({NUM}–{NUM}\), spread {NUM}, \d+-member ensemble\. "
                 rf"P\(DO_mgL_mean ([<>]) {VAL} mg/L\) = (\d+)% on day (\d+)")


def above_30(v):
    return v * 0.032 if v > 30 else v


def every_value(v):
    return v * 0.032


def fetch(site, cache):
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, f"flare_{site}_2026-06-26.parquet")
    if not os.path.exists(path) or sha256(path) != SHA256[site]:
        urllib.request.urlretrieve(URL.format(site=site), path)
    got = sha256(path)
    if got != SHA256[site]:
        sys.exit(f"{site}: SHA-256 {got} differs from the file the answers used ({SHA256[site]})")
    return path


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def members(path):
    """{depth: {forecast day: raw member values (mmol/m3)}} for dissolved oxygen."""
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    rows = con.execute(
        "SELECT depth, datediff('day', reference_datetime::DATE, datetime::DATE) AS day, parameter, "
        "avg(prediction) FROM read_parquet(?) WHERE variable = 'DO_mgL_mean' AND forecast = 1 "
        "AND prediction IS NOT NULL "
        "GROUP BY 1, 2, 3", [path]).fetchall()
    out = {}
    for depth, day, _, value in rows:
        out.setdefault(round(depth, 2), {}).setdefault(day, []).append(value)
    return out


def day_stats(raw, rule):
    x = np.sort(np.array([rule(v) for v in raw]))
    lo, hi = np.quantile(x, [0.025, 0.975])  # linear interpolation (R type 7)
    # LEADS stores the spread rounded to 3 decimals and prints it with 2 (tool/lib/leads/ensemble.ts).
    return x, x.mean(), lo, hi, round((hi - lo) / 2, 3)


def window(by_day, horizon, rule):
    if any(d not in by_day for d in range(1, horizon + 1)):
        return None
    stats = [day_stats(by_day[d], rule) for d in range(1, horizon + 1)]
    return ([round(np.mean([s[1] for s in stats]), 2), round(min(s[2] for s in stats), 2),
             round(max(s[3] for s in stats), 2), round(np.mean([s[4] for s in stats]), 2)])


def one_day(raw, rule, op, thr):
    x, mean, lo, hi, spread = day_stats(raw, rule)
    share = np.mean(x < thr) if op == "<" else np.mean(x > thr)
    return [round(mean, 2), round(lo, 2), round(hi, 2), round(spread, 2), int(round(100 * share))]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache", default="/tmp/leads-flare", help="folder for the downloaded FLARE files")
    args = ap.parse_args()
    data = {site: members(fetch(site, args.cache)) for site in ("fcre", "bvre")}
    items = json.load(open(os.path.join(HERE, "benchmark.json"), encoding="utf-8"))["items"]

    rows, problems = [], []
    for item in items:
        qid = item["id"]
        expected = "every_value" if qid in EVERY_VALUE else "above_30"
        for n, text in enumerate(item["contexts"], 1):
            for m in WINDOW.finditer(text):
                horizon, site, saved = int(m[1]), m[2].lower(), [float(m[i]) for i in range(3, 7)]
                # Window summaries do not name their depth: report the depth that reproduces them.
                hits = {rule.__name__: [d for d, by_day in data[site].items()
                                        if window(by_day, horizon, rule) == saved]
                        for rule in (above_30, every_value)}
                depth = (hits["above_30"] or hits["every_value"] or [None])[0]
                matters = depth is None or (window(data[site][depth], horizon, above_30)
                                            != window(data[site][depth], horizon, every_value))
                rows.append((qid, n, f"{horizon}-day summary, {site.upper()}", saved, hits, expected, matters))
            for m in DAY.finditer(text):
                site, depth = m[2].lower(), round(float(m[3]), 2)
                saved = [float(m[i]) for i in range(4, 8)] + [int(m[10])]
                op, thr, day = m[8], float(m[9]), int(m[11])
                raw = data[site][depth][day]
                hits = {rule.__name__: ([depth] if one_day(raw, rule, op, thr) == saved else [])
                        for rule in (above_30, every_value)}
                matters = one_day(raw, above_30, op, thr) != one_day(raw, every_value, op, thr)
                rows.append((qid, n, f"day {day}, {site.upper()} {depth:g} m", saved, hits, expected, matters))

    print(f"{'item':<12} {'evidence value':<26} {'saved':<34} {'above 30 only':<14} {'every value':<12} conversion matters")
    unexplained = []
    for qid, n, label, saved, hits, expected, matters in rows:
        e, f = hits["above_30"], hits["every_value"]
        mark = lambda h: ("yes" + (f" ({h[0]:g} m)" if "summary" in label else "")) if h else "no"
        print(f"{qid + ' [' + str(n) + ']':<12} {label:<26} {str(saved):<34} {mark(e):<14} {mark(f):<12} "
              f"{'yes' if matters else 'no'}")
        if not hits[expected]:
            (problems if matters else unexplained).append(f"{qid} [{n}]")

    part = [r for r in rows if r[5] == "above_30"]
    changed = [f"{r[0]} [{r[1]}]" for r in part if r[6]]
    print(f"\nAnswers converting values above 30 only: {len(part)} values; {sum(bool(r[4]['above_30']) for r in part)} "
          f"reproduce exactly with that conversion. Converting every value changes {len(changed)} of them: "
          f"{', '.join(changed)}.")
    full = [r for r in rows if r[5] == "every_value"]
    print(f"Answers converting every value: {len(full)} values; {sum(bool(r[4]['every_value']) for r in full)} reproduce "
          f"exactly with that conversion.")
    if unexplained:
        print(f"Not reproduced exactly, and the same under both conversions (so not caused by the conversion): "
              f"{', '.join(unexplained)}.")
    if problems:
        print("NOT REPRODUCED although the conversion matters: " + ", ".join(problems))
        sys.exit(1)


if __name__ == "__main__":
    main()
