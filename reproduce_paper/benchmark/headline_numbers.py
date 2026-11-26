"""Print the RAGAS numbers reported in the Results, from ragas_scores.csv (no API calls).

Mean, bootstrap 95% confidence interval of the mean (the resampling of Fig. 5a) and median of each
metric, the number of answers with complete context recall, and the mean faithfulness of each question type.

    python headline_numbers.py
"""
import numpy as np

from common import CATEGORIES, METRICS, load_scores
from make_figure5 import bootstrap_ci

NAMES = {"faithfulness": "Faithfulness", "answer_relevancy": "Answer relevancy",
         "context_precision_no_ref": "Context precision (reference-free)", "context_recall": "Context recall"}


def main():
    s = load_scores()
    print(f"RAGAS scores of the {len(s)} benchmark answers: mean (bootstrap 95% CI of the mean), median")
    for m in METRICS:
        x = np.array([v[m] for v in s.values()])
        lo, hi = bootstrap_ci(x)
        print(f"  {NAMES[m]:<36} {x.mean():.2f} ({lo:.2f}–{hi:.2f}), median {np.median(x):.2f}")
    recall = [v["context_recall"] for v in s.values()]
    print(f"Answers with complete context recall: {sum(r == 1.0 for r in recall)} of {len(recall)}")
    print("Mean faithfulness by question type:")
    for cat, label in CATEGORIES.items():
        x = [v["faithfulness"] for v in s.values() if v["category"] == cat]
        print(f"  {label} ({len(x)}): {np.mean(x):.2f}")


if __name__ == "__main__":
    main()
