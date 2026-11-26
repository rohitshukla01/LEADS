#!/usr/bin/env bash
# Rebuild and check the paper's results that need no API keys.
#
#   bash reproduce.sh            # 2-3 minutes the first time, which installs the Python packages (needs internet)
#   bash reproduce.sh --online   # also re-checks against today's public data (downloads about 150 MB)
#
# Needs Python 3.12 to 3.14 and bash (tested on macOS 14.8). In the repository it writes to .reproduce/: two
# Python environments, the rebuilt outputs (.reproduce/rebuild/, compared with the saved ones in
# reproduce_paper/) and a log for each step (.reproduce/logs/). It also saves a
# copy of the redrawn figures in reproduced_figures/.
set -uo pipefail
cd "$(dirname "$0")" || exit 1
PY=${PYTHON:-python3}
ONLINE=0
[ "${1:-}" = "--online" ] && ONLINE=1
R=.reproduce
W="$R/rebuild"
OK_PY='import sys; sys.exit(not (3, 12) <= sys.version_info[:2] <= (3, 14))'  # the exact package versions used here have no ready-built 3.15 version
if ! "$PY" -c "$OK_PY" 2>/dev/null; then
  have=$("$PY" --version 2>&1) || have="no '$PY'"
  echo "reproduce.sh needs Python 3.12, 3.13 or 3.14; you have $have."
  echo "Install Python 3.14 from https://www.python.org/downloads/ (not 3.15),"
  echo "then run: PYTHON=python3.14 bash reproduce.sh"
  exit 1
fi
mkdir -p "$R/logs"
export MPLCONFIGDIR="$PWD/$R/matplotlib"
results=()

step() {  # step "<name>" <command...>: run a check, record PASS, FAIL or SKIP (exit code 77: cannot be checked here)
  local name="$1"; shift
  local log="$R/logs/$(echo "$name" | tr ' /().,' '______').log"
  printf '  %-64s' "$name"
  "$@" >"$log" 2>&1
  case $? in
    0) echo "PASS"; results+=("PASS  $name") ;;
    77) echo "SKIP  ($(tail -n 1 "$log"); see $log)"; results+=("SKIP  $name") ;;
    *) echo "FAIL  (see $log)"; results+=("FAIL  $name") ;;
  esac
}

echo "Setting up Python environments..."
for v in venv-eval venv-skill; do  # (re)create an environment that is missing, broken or not on Python 3.12-3.14
  "$R/$v/bin/python" -c "$OK_PY" 2>/dev/null || "$PY" -m venv --clear "$R/$v" || exit 1
done
"$R/venv-eval/bin/pip" install -q --disable-pip-version-check -r reproduce_paper/benchmark/requirements-offline.txt || exit 1
"$R/venv-skill/bin/pip" install -q --disable-pip-version-check duckdb==1.5.4 numpy==2.3.5 || exit 1
E="$PWD/$R/venv-eval/bin/python"
S="$PWD/$R/venv-skill/bin/python"

# Rebuild in a fresh copy of the code and input data, so that the saved outputs in reproduce_paper/
# are never overwritten and every run compares with them.
C7=case_studies/fig7_algal_2026-05-03
C8=case_studies/fig8_hypoxia_2026-04-04
rm -rf "$W" && mkdir -p "$W/benchmark" "$W/expert_ratings" "$W/forecast_example" "$W/$C7" "$W/$C8" &&
  cp reproduce_paper/benchmark/*.py reproduce_paper/benchmark/*.json reproduce_paper/benchmark/*.jsonl reproduce_paper/benchmark/*.csv "$W/benchmark/" &&
  cp reproduce_paper/expert_ratings/*.py reproduce_paper/expert_ratings/*.csv "$W/expert_ratings/" &&
  cp -R reproduce_paper/forecast_example/*.py reproduce_paper/forecast_example/*.csv reproduce_paper/forecast_example/icons "$W/forecast_example/" &&
  cp -R reproduce_paper/case_studies/case_figure.py reproduce_paper/case_studies/images "$W/case_studies/" &&
  cp -R reproduce_paper/$C7/*.py reproduce_paper/$C7/*.json reproduce_paper/$C7/inputs "$W/$C7/" &&
  cp -R reproduce_paper/$C8/*.py reproduce_paper/$C8/*.json reproduce_paper/$C8/inputs "$W/$C8/" || exit 1

MAC_ARIAL=/System/Library/Fonts/Supplemental/Arial.ttf   # the Arial the saved figures were made with (macOS 14)
ARIAL_FILE='import matplotlib; matplotlib.rcdefaults(); from matplotlib import font_manager as m; print(m.findfont(m.FontProperties(family="Arial"), fallback_to_default=False))'
same() { cmp -s "$W/$1" "reproduce_paper/$1" || { echo "rebuilt $W/$1 differs from the saved reproduce_paper/$1"; return 1; }; }
figure() {  # figure <n> <folder>: rebuild Fig. n with make_figure<n>.py and check that it matches the saved files
  (cd "$W/$2" && "$E" "make_figure$1.py") || return 1
  local f bad="" svg="$W/$2/figure$1.svg"
  for f in pdf svg png; do
    [ -f "reproduce_paper/$2/figure$1.$f" ] || { echo "reproduce_paper/$2/figure$1.$f is missing"; return 1; }
    same "$2/figure$1.$f" || bad="$bad $f"
  done
  [ -z "$bad" ] && return 0
  if grep -q "font-family: 'Arial'" "$svg" || ! grep -q "font-family: 'DejaVu Sans'" "$svg"; then
    local arial; arial=$("$E" -c "$ARIAL_FILE" 2>/dev/null) || arial=""
    if [ "$bad" = " pdf" ] && [ -f "$arial" ] && [ "$arial" != "$MAC_ARIAL" ]; then
      echo "The rebuilt Fig. $1 SVG and PNG match the saved files. Only the PDF differs, because it embeds"
      echo "a copy of your Arial ($arial), not the macOS one the saved files were made with."
      echo "SVG and PNG match; the PDF embeds your Arial, not the macOS one"
      return 77
    fi
    echo "The rebuilt Fig. $1 differs from the saved files (${bad# }), although Arial is installed."; return 1
  fi
  echo "Arial is not installed, so the rebuilt Fig. $1 ($W/$2/) is drawn in DejaVu Sans and cannot be"
  echo "compared with the saved files, which use Arial. Only the drawing code was run."
  echo "needs Arial to compare with the saved files"
  return 77
}
evidence() { (cd "$W/benchmark" && "$E" evidence_use.py) && same benchmark/results/evidence_use.json; }
headline() {
  local out; out=$(cd "$W/benchmark" && "$E" headline_numbers.py) || return 1
  echo "$out"
  for want in "Faithfulness                         0.82 (0.75–0.88), median 0.85" \
              "Answer relevancy                     0.85 (0.82–0.88), median 0.85" \
              "Context precision (reference-free)   0.81 (0.72–0.88), median 0.91" \
              "Context recall                       0.95 (0.91–0.99), median 1.00" \
              "Answers with complete context recall: 25 of 30"; do
    grep -qF "$want" <<<"$out" || { echo "missing: $want"; return 1; }
  done
}
ratings() {
  local out; out=$(cd "$W/expert_ratings" && "$E" make_figure6.py) || return 1
  echo "$out"
  for want in "300 ratings from 5 experts on 10 questions, mean 4.28" \
              "Rated 4 or 5: 246 of 300 (82%); rated 2: 6 (2%); rated 1: 0" \
              "Accuracy                 4.38 ± 0.67   % at 1-5: 0 0 10 42 48" \
              "Completeness             4.30 ± 0.86   % at 1-5: 0 0 26 18 56" \
              "Verbosity                4.12 ± 0.92   % at 1-5: 0 8 12 40 40" \
              "Clarity                  4.02 ± 0.87   % at 1-5: 0 4 24 38 34" \
              "Actionability            4.20 ± 0.73   % at 1-5: 0 0 18 44 38" \
              "Reasoning transparency   4.68 ± 0.59   % at 1-5: 0 0 6 20 74" \
              "Manager-framed questions (Q1-Q6): mean 4.28" \
              "Researcher-framed questions (Q7-Q10): mean 4.28" \
              "Question means (30 ratings each): Q1 4.10, Q2 4.13, Q3 4.27, Q4 4.47, Q5 4.43, Q6 4.30, Q7 3.93, Q8 4.67, Q9 4.23, Q10 4.30"; do
    grep -qF "$want" <<<"$out" || { echo "missing: $want"; return 1; }
  done
}
skill_online() {
  "$S" tool/scripts/build-skill-table.py --fetch "$R/skill-fetch" --allow-new-inputs --out "$R/skill-fetch/forecast-skill.json" || return 1
  "$S" -c "import json, sys; a = json.load(open('tool/lib/skill/forecast-skill.json')); b = json.load(open('$R/skill-fetch/forecast-skill.json')); sys.exit(a['fcre'] != b['fcre'])"
}

echo "Checking the paper's results:"
step "Fig. 5b and evidence counts (evidence_use.py)" evidence
step "Fig. 5 (make_figure5.py)" figure 5 benchmark
step "Headline RAGAS numbers (headline_numbers.py)" headline
step "Per-item judge verdicts (judge_items.py --replay)" bash -c "cd '$W/benchmark' && '$E' judge_items.py --replay item_verdicts.jsonl && cmp -s results/item_verdicts_replay.jsonl '$PWD/reproduce_paper/benchmark/item_verdicts.jsonl'"
step "Fig. 6 (make_figure6.py)" figure 6 expert_ratings
step "Expert-rating numbers (make_figure6.py)" ratings
step "Fig. 4 (make_figure4.py)" figure 4 forecast_example
step "Fig. 4d forecast-skill record (build-skill-table.py --check)" "$S" tool/scripts/build-skill-table.py --scores-dir reproduce_paper/forecast_skill --check
step "Fig. 7 (make_figure7.py)" figure 7 "$C7"
step "Fig. 7 skill record (rebuilt from the frozen scores)" "$S" reproduce_paper/case_studies/rebuild_skill_records.py fig7_algal_2026-05-03
step "Fig. 8 (make_figure8.py)" figure 8 "$C8"
step "Fig. 8 skill record (rebuilt from the frozen scores)" "$S" reproduce_paper/case_studies/rebuild_skill_records.py fig8_hypoxia_2026-04-04
if [ "$ONLINE" = 1 ]; then
  step "Fig. 4d skill values from today's public archive" skill_online
  step "FLARE oxygen values in the evidence (public FLARE files)" "$S" reproduce_paper/benchmark/check_flare_oxygen.py --cache "$R/flare"
  step "FLARE members in Figs 4a-b, 7 and 8 (public FLARE files)" "$S" reproduce_paper/forecast_example/check_flare_members.py --cache "$R/flare"
fi

F=reproduced_figures   # a copy of the redrawn figures
rm -f "$F"/figure4.* "$F"/figure5.* "$F"/figure6.* "$F"/figure7.* "$F"/figure8.*
if mkdir -p "$F" && cp "$W"/forecast_example/figure4.* "$W"/benchmark/figure5.* "$W"/expert_ratings/figure6.* \
    "$W/$C7"/figure7.* "$W/$C8"/figure8.* "$F"/ 2>/dev/null; then
  echo; echo "The redrawn figures are in $F/."
fi

echo
fails=$(printf '%s\n' "${results[@]}" | grep -c '^FAIL' || true)
skips=$(printf '%s\n' "${results[@]}" | grep -c '^SKIP' || true)
if [ "$skips" = 0 ]; then echo "${#results[@]} checks, $fails failed."
else echo "${#results[@]} checks, $fails failed, $skips skipped on this computer (see SKIP above)."; fi
[ "$fails" = 0 ]
