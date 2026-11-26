# Benchmark evaluation (Fig. 5)

Data and code behind Fig. 5.

## The questions

| Question type (Fig. 5) | Questions | `category` and IDs in the files |
|---|---|---|
| Research | 10 | `science`: SCI-01 to SCI-10 |
| Observation | 5 | `data`: DATA-01 to DATA-05 |
| Multi-source | 5 | `hybrid`: HYB-1 to HYB-5 |
| Forecast | 5 | `forecast`: F1 to F5 |
| Management | 5 | `management`: M1 to M5 |

Each question has a reference answer and was asked with a user profile. The research reference answers were
written by a domain expert or derived from the expert's supporting quotes. The observation reference values were
taken from the VERA data, and the forecast ones were computed from the FLARE run. The multi-source and management
reference answers were drawn from a frozen LEADS run and approved by a domain expert.

## How the answers were scored

1. RAGAS 0.4.3, with GPT-4o as the judge, scored each answer for faithfulness, answer relevancy,
   reference-free context precision and context recall (Fig. 5a).
2. The same judge marked each retrieved item as useful or not for reaching the answer. An answer
   used a source of evidence if at least one item from that source was marked useful (Fig. 5b).

## Data

| File | Contents |
|---|---|
| `benchmark.json` | The 30 questions, with LEADS's answers, the retrieved evidence and the reference answers |
| `profiles.json` | The user profile of each question |
| `ragas_scores.csv` | RAGAS scores of each answer |
| `item_verdicts.jsonl` | The judge's verdict on each retrieved item |
| `results/evidence_use.json` | The evidence counts in Fig. 5b |
| `figure5.pdf`, `figure5.png`, `figure5.svg` | Fig. 5 |

## Code

| File | What it does |
|---|---|
| [`evidence_use.py`](evidence_use.py) | Counts the evidence sources each answer used (Fig. 5b) |
| [`make_figure5.py`](make_figure5.py) | Draws Fig. 5 |
| [`headline_numbers.py`](headline_numbers.py) | Prints the RAGAS means and 95% confidence intervals reported in the Results |
| [`evaluate_ragas.py`](evaluate_ragas.py) | Scores the answers with RAGAS 0.4.3 (judge gpt-4o); needs your own OpenAI key |
| [`judge_items.py`](judge_items.py) | Judges whether each retrieved item was useful (gpt-4o); needs your own OpenAI key |
| [`check_flare_oxygen.py`](check_flare_oxygen.py) | Checks the dissolved-oxygen forecast values quoted in the evidence against the FLARE files (run by `bash reproduce.sh --online`) |
| [`common.py`](common.py) | Functions shared by the scripts above |

## Reproduce

Run the commands from the repository root (Python 3.12–3.14).

**1. Figure and numbers** (no API keys)

```bash
pip install -r reproduce_paper/benchmark/requirements-offline.txt
python reproduce_paper/benchmark/evidence_use.py
python reproduce_paper/benchmark/make_figure5.py
python reproduce_paper/benchmark/headline_numbers.py
```

These write `results/evidence_use.json` and `figure5.pdf`, `.png` and `.svg` in this folder and print the RAGAS
numbers reported in the Results.

**2. Scores** (needs your own OpenAI key; costs a few US dollars with gpt-4o)

```bash
pip install -r reproduce_paper/benchmark/requirements.txt
export OPENAI_API_KEY=your-key
python reproduce_paper/benchmark/evaluate_ragas.py
python reproduce_paper/benchmark/judge_items.py             # shows the number of calls and the estimated cost
python reproduce_paper/benchmark/judge_items.py --execute
```

The new scores are written to `results/`, and `evaluate_ragas.py` prints its means next to the saved ones.

**3. Answers** (needs the full [LEADS set-up](../../tool/README.md))

To generate the answers again, add the settings they were generated with to `tool/.env.local`:

```bash
LEADS_AS_OF=2026-06-28T23:59:59Z        # data as available on 28 June 2026
LEADS_FLARE_REFERENCE_DATE=2026-06-26   # the FLARE forecast issued on 26 June 2026
LEADS_RAPTOR_MODE=legacy                # passage summaries searched together with the passages
LEADS_LIT_VERBATIM=off                  # each literature passage reduced to one extracted sentence
LEADS_CITATION_ALIGN=off                # citation markers kept as the model wrote them
```

Then ask each question in `benchmark.json` with its profile from `profiles.json`.

**Note: Using a different model or provider may lead to different results.**
