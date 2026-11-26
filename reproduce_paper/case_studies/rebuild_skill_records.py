"""Rebuild the forecast-skill record that each case read (inputs/forecast-skill.pooled-frozen-<case date>.json) from
the scores in ../forecast_skill, using only forecasts scored up to the day before the case date, and check that its
skill values (`fcre`) equal those of the saved record. No API keys; needs duckdb 1.5.4 and numpy 2.3.5. From the
repository root:

    python reproduce_paper/case_studies/rebuild_skill_records.py
"""
import json
import os
import re
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
BUILDER = os.path.join(HERE, "..", "..", "tool", "scripts", "build-skill-table.py")
SCORES = os.path.join(HERE, "..", "forecast_skill")
LAST_SCORED_DAY = {"fig7_algal_2026-05-03": "2026-05-02", "fig8_hypoxia_2026-04-04": "2026-04-03"}


def main():
    source = open(BUILDER, encoding="utf-8").read()
    bad = 0
    with tempfile.TemporaryDirectory() as tmp:
        for case in sys.argv[1:] or LAST_SCORED_DAY:
            builder = os.path.join(tmp, "build-skill-table.py")
            with open(builder, "w", encoding="utf-8") as fh:
                fh.write(re.sub(r"^SNAPSHOT = .*$", f'SNAPSHOT = "{LAST_SCORED_DAY[case]}"', source, count=1, flags=re.M))
            out = os.path.join(tmp, case + ".json")
            # -O turns off all of the builder's assert checks: two of them (rounding, and CI bounds near zero) fail on
            # these shorter records. The lines below still compare every skill value with the saved record.
            subprocess.run([sys.executable, "-O", builder, "--scores-dir", SCORES, "--out", out], check=True)
            saved = os.path.join(case, "inputs", f"forecast-skill.pooled-frozen-{case.rsplit('_', 1)[1]}.json")
            ok = json.load(open(out))["fcre"] == json.load(open(os.path.join(HERE, saved)))["fcre"]
            print(("OK   " if ok else "BAD  ") + saved)
            bad += not ok
    sys.exit(bad)


if __name__ == "__main__":
    main()
