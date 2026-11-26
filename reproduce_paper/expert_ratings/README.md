# Expert ratings (Fig. 6)

Data and code behind Fig. 6.

## About the ratings

1. Five domain experts who study or manage the two reservoirs rated LEADS answers to 10 questions.
2. Six questions were asked from the manager profile (Q1–Q6) and four from the researcher profile
   (Q7–Q10).
3. The criteria were accuracy, completeness, verbosity, clarity, actionability and reasoning transparency.
4. For each answer and criterion, the experts scored their agreement from 1 (strongly disagree) to
   5 (strongly agree), giving 300 ratings.

## Data

| File | Contents |
|---|---|
| `expert_ratings.csv` | The 300 ratings: one row per expert (Reviewer 1–5) and question (Q1–Q10), with one column per criterion |
| `figure6.pdf`, `figure6.png`, `figure6.svg` | Fig. 6 |

## Code

| File | What it does |
|---|---|
| [`make_figure6.py`](make_figure6.py) | Draws Fig. 6 and prints the rating counts, means and standard deviations reported in the Results |

## Reproduce

From the repository root (Python 3.12–3.14):

```bash
pip install numpy==2.5.3 matplotlib==3.10.9
python reproduce_paper/expert_ratings/make_figure6.py
```

It writes `figure6.pdf`, `.png` and `.svg` in this folder and prints the numbers in the Results.
