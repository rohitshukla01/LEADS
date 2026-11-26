# Case studies (Figs 7 and 8)

Each folder holds LEADS's response to the case question (`leads_response.json`), the sensor file and forecast-skill
record LEADS read (`inputs/`) and the script that draws the figure.

| Figure | Case date | Question |
|---|---|---|
| [Fig. 7](fig7_algal_2026-05-03/) | 3 May 2026 | *What is the current surface chlorophyll-a at Falling Creek Reservoir (FCR), what is the bloom risk over the next 7 days, and should we plan an algaecide treatment?* |
| [Fig. 8](fig8_hypoxia_2026-04-04/) | 4 April 2026 | *What is the current hypolimnetic dissolved oxygen at Falling Creek Reservoir (FCR), what is the risk of it falling below the HOx threshold over the next 7 days, and should we operate the HOx system?* |

## Reproduce

From the repository root, run `bash reproduce.sh`, or install the packages in
[`requirements-offline.txt`](../benchmark/requirements-offline.txt) and run:

```bash
python reproduce_paper/case_studies/fig7_algal_2026-05-03/make_figure7.py
python reproduce_paper/case_studies/fig8_hypoxia_2026-04-04/make_figure8.py
```
