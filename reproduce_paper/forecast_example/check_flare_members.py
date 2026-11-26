"""Rebuild the FLARE ensemble members behind Figs 4a-b, 7 and 8 from the public files (no API keys).

Downloads the three public FLARE runs for FCR (reference dates 14 June, 2 May and 3 April 2026; about
64 MB), checks their SHA-256, rebuilds member_shares.csv and members.csv, and checks that the 221
members per day in the chart data of each case study's response equal the file's (dissolved oxygen converted
from mmol/m3 to mg/L, x 32/1000, as the tool does). Run from the repository root with
duckdb 1.5.4 and numpy 2.3.5 installed, or run `bash reproduce.sh --online`:

    python reproduce_paper/forecast_example/check_flare_members.py
"""
import argparse, csv, datetime, hashlib, io, json, os, sys, urllib.request

import duckdb
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
URL = ("https://amnh1.osn.mghpcc.org/bio230121-bucket01/flare/forecasts/parquet/"
       "site_id=fcre/model_id=glm_aed_flare_v3/reference_date={}/part-0.parquet")
SHA256 = {  # SHA-256 of the FLARE files
    "2026-06-14": "98667f3db649f36b650aae6303501680185dab9728c3f2681cdbaa0b541738fa",
    "2026-05-02": "0276231d955be97180ad1e7c3dc9e96bbca6a8211c20ac6719554104e396dcdd",
    "2026-04-03": "8eb05588d7729b0142855efcf578b4cbdd3e9868a7a99c69e297ed48424a027a",
}
CASES = {"2026-05-02": "fig7_algal_2026-05-03", "2026-04-03": "fig8_hypoxia_2026-04-04"}


def sha256(path):
    with open(path, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def members(ref, cache, variable, depth):
    """{forecast day: member values in member order} at one depth; day 1 is the day after ref (UTC)."""
    path = os.path.join(cache, f"flare_fcre_{ref}.parquet")
    if not os.path.exists(path) or sha256(path) != SHA256[ref]:
        os.makedirs(cache, exist_ok=True)
        urllib.request.urlretrieve(URL.format(ref), path)
    if sha256(path) != SHA256[ref]:
        sys.exit(f"{ref}: SHA-256 {sha256(path)} differs from the file used ({SHA256[ref]})")
    con = duckdb.connect()
    con.execute("SET TimeZone='UTC'")
    rows = con.execute(
        "SELECT datediff('day', reference_datetime::DATE, datetime::DATE), prediction FROM read_parquet(?) "
        "WHERE variable = ? AND depth = ? AND forecast = 1 ORDER BY 1, parameter", [path, variable, depth])
    scale = 32 / 1000 if variable == "DO_mgL_mean" else 1
    out = {}
    for day, value in rows.fetchall():
        out.setdefault(day, []).append(value * scale)
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cache", default="/tmp/leads-flare", help="folder for the downloaded FLARE files")
    cache = ap.parse_args().cache
    bad = 0

    # Fig. 4a-b: forecast_example/member_shares.csv, days 1-14, chlorophyll-a at 1.6 m.
    m, start = members("2026-06-14", cache, "Chla_ugL_mean", 1.6), datetime.date(2026, 6, 14)
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["day", "date", "k_above_20", "n_members", "fraction", "mean", "p10", "p90"])
    for day in range(1, 15):
        x = np.array(m[day])
        k = int((x > 20).sum())
        p10, p90 = np.quantile(x, [0.1, 0.9])  # linear interpolation, the numpy default
        w.writerow([day, start + datetime.timedelta(days=day), k, len(x), k / len(x),
                    float(x.mean()), float(p10), float(p90)])
    saved = open(os.path.join(HERE, "member_shares.csv"), newline="").read()
    ok = out.getvalue().splitlines() == saved.splitlines()
    print(("OK   " if ok else "BAD  ") + "forecast_example/member_shares.csv (14 June 2026 run)")
    bad += not ok
    if not ok:
        print(out.getvalue())

    # Fig. 4a-b: forecast_example/members.csv, the 221 members on days 1-14, in the file's member order.
    out = io.StringIO()
    w = csv.writer(out)
    w.writerow(["day", "member", "value"])
    for day in range(1, 15):
        for member, value in enumerate(m[day], start=1):
            w.writerow([day, member, value])
    saved = open(os.path.join(HERE, "members.csv"), newline="").read()
    ok = out.getvalue().splitlines() == saved.splitlines()
    print(("OK   " if ok else "BAD  ") + "forecast_example/members.csv (14 June 2026 run)")
    bad += not ok

    # Figs 7 and 8: the members per day in the chart data of LEADS's response in each case.
    for ref, case in CASES.items():
        name = "leads_response.json"
        chart = json.load(open(os.path.join(HERE, "..", "case_studies", case, name), encoding="utf-8"))["chartData"]
        m = members(ref, cache, chart["variable"], chart["depths"][0])
        days = [d for d in chart["perDay"] if sorted(m[d["day"]]) != d["members_raw"]]
        print(("OK   " if not days else "BAD  ") + f"case_studies/{case}/{name}: {len(chart['perDay'])} days "
              f"x {len(chart['perDay'][0]['members_raw'])} members of {chart['variable']} at "
              f"{chart['depths'][0]:g} m" + (f"; differ on days {[d['day'] for d in days]}" if days else ""))
        bad += bool(days)
    sys.exit(bad)


if __name__ == "__main__":
    main()
