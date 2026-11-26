"""Score the 30 LEADS benchmark answers with RAGAS 0.4.3.

Metrics: faithfulness, answer relevancy, reference-free context precision and context recall.
Judge gpt-4o; embeddings text-embedding-3-small. Requires OPENAI_API_KEY.

    python evaluate_ragas.py              # all 30 questions
    python evaluate_ragas.py --limit 2    # first 2 questions

Writes results/ragas_scores.csv and prints the means next to the reported ones (ragas_scores.csv).
RAGAS samples the judge at a small temperature (0.01; 0.3 when generating questions for answer
relevancy), so per-question scores can vary slightly between runs.
"""
import argparse
import csv
import os
import statistics
import sys

from common import METRICS, RESULTS, load_benchmark, load_scores, prepare_ragas_import

LABELS = {"faithfulness": "Faithfulness", "answer_relevancy": "Answer relevancy",
          "context_precision_no_ref": "Context precision (reference-free)", "context_recall": "Context recall"}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--judge-model", default="gpt-4o")
    ap.add_argument("--embedding-model", default="text-embedding-3-small")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    if not os.environ.get("OPENAI_API_KEY"):
        sys.exit("Set OPENAI_API_KEY first.")

    prepare_ragas_import()
    from datasets import Dataset
    from langchain_openai import ChatOpenAI, OpenAIEmbeddings
    from ragas import evaluate
    from ragas.embeddings import LangchainEmbeddingsWrapper
    from ragas.llms import LangchainLLMWrapper
    from ragas.metrics import LLMContextPrecisionWithoutReference, answer_relevancy, context_recall, faithfulness
    from ragas.run_config import RunConfig

    items = load_benchmark()[: args.limit]
    rows = [{"user_input": it["question"], "response": it["answer"], "retrieved_contexts": it["contexts"],
             "reference": it["reference"]} for it in items]
    metrics = [faithfulness, answer_relevancy, LLMContextPrecisionWithoutReference(name="context_precision_no_ref"),
               context_recall]
    # RAGAS sets the judge temperature to 0.01 internally (0.3 when generating questions for answer relevancy).
    print(f"Scoring {len(rows)} questions (judge {args.judge_model}, embeddings {args.embedding_model}) ...")
    result = evaluate(dataset=Dataset.from_list(rows), metrics=metrics,
                      llm=LangchainLLMWrapper(ChatOpenAI(model=args.judge_model, temperature=0)),
                      embeddings=LangchainEmbeddingsWrapper(OpenAIEmbeddings(model=args.embedding_model)),
                      run_config=RunConfig(max_workers=args.workers, timeout=1800, max_retries=20, max_wait=90))
    df = result.to_pandas()

    RESULTS.mkdir(exist_ok=True)
    with open(RESULTS / "ragas_scores.csv", "w", newline="") as fh:
        w = csv.writer(fh)
        w.writerow(["id", "category"] + METRICS)
        for it, (_, r) in zip(items, df.iterrows()):
            w.writerow([it["id"], it["category"]] + [repr(float(r[m])) for m in METRICS])

    reported = load_scores()
    print(f"\n{'Metric':38s} {'this run':>9s} {'reported':>9s}   (mean over {len(items)} questions)")
    for m in METRICS:
        mine = [v for v in df[m].tolist() if v == v]
        print(f"{LABELS[m]:38s} {statistics.mean(mine):9.3f} {statistics.mean(reported[it['id']][m] for it in items):9.3f}")
    print(f"\nPer-question scores: {RESULTS / 'ragas_scores.csv'}")


if __name__ == "__main__":
    main()
