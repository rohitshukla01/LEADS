# Example forecast and skill (Fig. 4)

Data and code behind Fig. 4. The skill record in Fig. 4d is built in [`forecast_skill/`](../forecast_skill/).

## Data

| File | Contents |
|---|---|
| `observations.csv` | VERA daily chlorophyll-a at FCR, 1.6 m (µg/L), 31 May–28 June 2026, from the VERA file of 6 October 2026 (Fig. 4a) |
| `member_shares.csv` | FLARE forecast of 14 June 2026, days 1–14: ensemble mean, 10th and 90th percentiles, and share of the 221 members above 20 µg/L (Fig. 4a–b) |
| `members.csv` | The 221 members of that forecast, days 1–14 (Fig. 4a–b) |
| `vera_chla_history.csv` | VERA daily chlorophyll-a at FCR, 1.6 m (µg/L), August 2018–13 June 2026, from the VERA file of 6 October 2026, for the seasonal mean (Fig. 4a) |
| `icons/` | The six icons in Fig. 4c, adapted from Google's Material Symbols (Apache License 2.0, see `icons/LICENSE`) |
| `figure4.pdf`, `figure4.png`, `figure4.svg` | Fig. 4 |

## Code

| File | What it does |
|---|---|
| [`make_figure4.py`](make_figure4.py) | Draws Fig. 4 |
| [`check_flare_members.py`](check_flare_members.py) | Rebuilds `member_shares.csv` and `members.csv` from the FLARE file and checks them against the saved files |
| [`tool/lib/leads/sensor-public.ts`](../../tool/lib/leads/sensor-public.ts) | Reads the VERA observations and their seasonal mean in LEADS |
| [`tool/lib/leads/flare-reader.ts`](../../tool/lib/leads/flare-reader.ts) | Reads the FLARE forecast in LEADS: ensemble mean and percentiles |
| [`tool/lib/leads/ensemble.ts`](../../tool/lib/leads/ensemble.ts) | Counts the share of ensemble members above the threshold |
| [`tool/components/InsightPanel.tsx`](../../tool/components/InsightPanel.tsx) | Draws the forecast chart in the LEADS interface |

## Reproduce

Run the commands from the repository root (Python 3.12–3.14, no API keys).

**1. Figure**

```bash
pip install -r reproduce_paper/benchmark/requirements-offline.txt
python reproduce_paper/forecast_example/make_figure4.py
```

It writes `figure4.pdf`, `.png` and `.svg` in this folder.

**2. Forecast members** (downloads the FLARE files, about 64 MB)

```bash
pip install duckdb==1.5.4 numpy==2.3.5
python reproduce_paper/forecast_example/check_flare_members.py
```

It rebuilds `member_shares.csv` and `members.csv` from the 221 members and prints `OK` when each matches the saved file.
