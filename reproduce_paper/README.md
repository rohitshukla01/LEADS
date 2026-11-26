# Data and code behind the paper

The folders below hold the data and code for each figure, with the steps to reproduce it.

## Run all checks at once

From the repository root (Python 3.12–3.14, no API keys):

```bash
bash reproduce.sh
```

It ends with `12 checks, 0 failed.` and saves the redrawn figures in `reproduced_figures/` at the repository root.

## Reproduce one figure

Open the figure's folder below and follow the steps under **Reproduce** in its guide.

| Folder | Result |
|---|---|
| [`forecast_example/`](forecast_example/) | Fig. 4, example forecast and skill |
| [`forecast_skill/`](forecast_skill/) | Fig. 4d, forecast-skill record |
| [`benchmark/`](benchmark/) | Fig. 5, benchmark evaluation |
| [`expert_ratings/`](expert_ratings/) | Fig. 6, expert ratings |
| [`case_studies/`](case_studies/) | Figs 7 and 8, algal bloom and hypoxia cases |
