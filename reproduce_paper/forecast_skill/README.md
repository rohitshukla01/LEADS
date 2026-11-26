# Forecast skill (Fig. 4d)

Data and code behind Fig. 4d.

## How the skill record is built

1. The VERA4cast forecasting challenge scores every archived forecast against the observation on its
   target date with the continuous ranked probability score (CRPS; lower is better).
2. Each FLARE forecast (`glm_aed_flare_v3`) is paired with the climatology forecast for the same issue
   date, target date and depth.
3. For each forecast day 1–21, all pairs with target dates up to 14 October 2026 are pooled:
   CRPSS (%) = 100 × (1 − ΣCRPS<sub>FLARE</sub> / ΣCRPS<sub>climatology</sub>). A positive value means FLARE was
   better than climatology.
4. The 95% confidence interval comes from a block bootstrap over issue dates (14-day blocks,
   10,000 resamples).

The record covers water temperature, dissolved oxygen and chlorophyll-a at FCR, 1.6 m; BVR forecasts are not scored.

## Data

| File | Contents |
|---|---|
| `fcre_chla_1p6_flare_vs_clim.parquet` | Paired scores for chlorophyll-a: 478 FLARE forecasts issued from 25 September 2024 to 13 October 2026 |
| `fcre_temp_1p6_flare_vs_clim.parquet` | The same for water temperature (651 forecasts) |
| `fcre_do_1p6_flare_vs_clim.parquet` | The same for dissolved oxygen (597 forecasts, from 3 October 2024) |
| [`tool/lib/skill/forecast-skill.json`](../../tool/lib/skill/forecast-skill.json) | The skill record built from these files |

Each row of a score file is one forecast and target date: issue date (`rd`), target date (`dt`), forecast day
(`lead`), observation (`obs`), the CRPS of FLARE and of climatology (`crps_flare`, `crps_clim`), and the mean,
standard deviation and 10th and 90th percentiles of both forecasts.

## Code

| File | What it does |
|---|---|
| [`tool/scripts/build-skill-table.py`](../../tool/scripts/build-skill-table.py) | Builds the skill record from these files, or fetches them again from the archive |
| [`tool/lib/skill/forecast-skill.ts`](../../tool/lib/skill/forecast-skill.ts) | Reads the record for the skill card, the decision report and the answer's evidence |
| [`tool/components/ForecastSkillCard.tsx`](../../tool/components/ForecastSkillCard.tsx) | Draws the skill card in the LEADS interface |

## Reproduce

From the repository root (Python 3.12–3.14):

```bash
pip install duckdb==1.5.4 numpy==2.3.5
python tool/scripts/build-skill-table.py --scores-dir reproduce_paper/forecast_skill --check
```

It rebuilds the record from the three files and checks that it matches the saved one. The
record lists the duckdb and numpy versions it was built with, so the check needs exactly these versions.

To rebuild it from today's archive instead (needs internet):

```bash
python tool/scripts/build-skill-table.py --fetch /tmp/leads-skill --allow-new-inputs \
    --out /tmp/leads-skill/forecast-skill.json
python -c "import json; a = json.load(open('tool/lib/skill/forecast-skill.json'))['fcre']; \
b = json.load(open('/tmp/leads-skill/forecast-skill.json'))['fcre']; print(a == b)"
```

The last command prints `True` when every skill value is reproduced. A warning for each downloaded file is expected:
the archive holds newer scores, but the record uses only target dates up to 14 October 2026.
