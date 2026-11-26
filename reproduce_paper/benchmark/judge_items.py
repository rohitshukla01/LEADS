"""Judge whether each retrieved item was useful for its answer (input to Fig. 5b).

Instrument: the RAGAS reference-free context-precision judge (LLMContextPrecisionWithoutReference,
gpt-4o), applied to one retrieved item at a time with the question and the LEADS answer held fixed.
This is the per-item prompt that RAGAS uses inside the full metric.

Step 1  One verdict per retrieved item (item_pass).
Step 2  Single verdicts are not perfectly repeatable. For each answer whose item verdicts do not
        reproduce its RAGAS context precision, the RAGAS run's per-item verdicts are recovered from
        that score: every 0/1 pattern is tested, and the patterns whose average precision equals the
        score to within 1e-13 are kept (floating-point rounding is below 1e-15; RAGAS adds 1e-10 to
        the denominator, so patterns that differ only in the number of leading useful items still
        give distinct scores). Each item on which the two runs disagree, or whose RAGAS-run verdict is
        ambiguous, is judged again until it has three verdicts, and the majority is used.

    python judge_items.py                              # plan and cost estimate
    python judge_items.py --replay item_verdicts.jsonl # rebuild from stored verdicts, no API calls
    python judge_items.py --execute                    # make the calls (requires OPENAI_API_KEY)

Writes results/item_verdicts.jsonl (results/item_verdicts_replay.jsonl with --replay) in the format of
item_verdicts.jsonl. Calls are cached in results/judge_calls.jsonl, so an interrupted run resumes;
--replay uses a separate cache.
"""
import argparse
import asyncio
import itertools
import json
import os
import sys

from common import RESULTS, average_precision, channel, load_benchmark, load_scores, prepare_ragas_import

MATCH = 1e-13                        # two average precisions are equal below this difference
PRICE_IN, PRICE_OUT = 2.50, 10.00    # gpt-4o list price, USD per million tokens
PROMPT_TOKENS, OUTPUT_TOKENS = 1100, 120   # RAGAS instruction and examples; verdict with reason
CACHE = RESULTS / "judge_calls.jsonl"
REPLAY_CACHE = RESULTS / "replay_calls.jsonl"


def cached():
    if not CACHE.exists():
        return {}
    return {json.loads(line)["call"]: json.loads(line)["verdict"] for line in CACHE.read_text().splitlines()}


def seed_cache(path):
    """Write the verdicts of an item-verdict file into the call cache (replay without API calls)."""
    with CACHE.open("w") as fh:
        for line in open(path):
            r = json.loads(line)
            fh.write(json.dumps({"call": f"{r['id']}|{r['rank']}|pass", "verdict": r["item_pass"]}) + "\n")
            for j, v in enumerate(r.get("repeats", []), 1):
                fh.write(json.dumps({"call": f"{r['id']}|{r['rank']}|repeat{j}", "verdict": v}) + "\n")


def cost(calls, items):
    chars = sum(len(items[c.split("|")[0]]["question"]) + len(items[c.split("|")[0]]["answer"])
                + len(items[c.split("|")[0]]["contexts"][int(c.split("|")[1]) - 1]) for c in calls)
    tokens_in = chars / 4 + PROMPT_TOKENS * len(calls)
    return tokens_in / 1e6 * PRICE_IN + OUTPUT_TOKENS * len(calls) / 1e6 * PRICE_OUT


async def judge(calls, items, workers):
    prepare_ragas_import()
    from langchain_community.callbacks import get_openai_callback
    from langchain_openai import ChatOpenAI
    from ragas.dataset_schema import SingleTurnSample
    from ragas.llms import LangchainLLMWrapper
    from ragas.metrics import LLMContextPrecisionWithoutReference

    # RAGAS sets the judge temperature to 0.01 internally.
    metric = LLMContextPrecisionWithoutReference(
        llm=LangchainLLMWrapper(ChatOpenAI(model="gpt-4o", temperature=0, max_retries=6)))
    sem = asyncio.Semaphore(workers)
    spent = {"in": 0, "out": 0}

    async def one(call):
        qid, rank, _ = call.split("|")
        it = items[qid]
        sample = SingleTurnSample(user_input=it["question"], response=it["answer"],
                                  retrieved_contexts=[it["contexts"][int(rank) - 1]])
        async with sem:
            with get_openai_callback() as cb:
                score = await metric.single_turn_ascore(sample)
        if score != score:
            raise RuntimeError(f"{call}: the judge returned no verdict")
        spent["in"] += cb.prompt_tokens
        spent["out"] += cb.completion_tokens
        with CACHE.open("a") as fh:
            fh.write(json.dumps({"call": call, "verdict": 1 if score >= 0.5 else 0}) + "\n")

    await asyncio.gather(*(one(c) for c in calls))
    print(f"spent: {spent['in']:,} input + {spent['out']:,} output tokens = "
          f"${spent['in'] / 1e6 * PRICE_IN + spent['out'] / 1e6 * PRICE_OUT:.2f}")


def run_calls(calls, items, execute, workers):
    done = cached()
    pending = [c for c in calls if c not in done]
    print(f"{len(calls)} judge calls needed, {len(pending)} not yet made (estimated ${cost(pending, items):.2f})")
    if pending and execute:
        asyncio.run(judge(pending, items, workers))
        done = cached()
    return done


def main():
    global CACHE
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--execute", action="store_true", help="make the judge calls")
    ap.add_argument("--replay", default=None, help="item-verdict file to rebuild from, without API calls")
    ap.add_argument("--ragas-scores", default=None, help="RAGAS scores to compare with (default ragas_scores.csv)")
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()
    if args.replay and args.execute:
        ap.error("--replay makes no calls; use it without --execute")
    if args.execute and not os.environ.get("OPENAI_API_KEY"):
        sys.exit("Set OPENAI_API_KEY first.")
    RESULTS.mkdir(exist_ok=True)
    if args.replay:
        CACHE = REPLAY_CACHE
        seed_cache(args.replay)
    items = {it["id"]: it for it in load_benchmark()}
    scores = load_scores(args.ragas_scores)

    # Step 1
    first = [f"{q}|{r + 1}|pass" for q, it in items.items() for r in range(len(it["contexts"]))]
    done = run_calls(first, items, args.execute, args.workers)
    if any(c not in done for c in first):
        print("Step 1 incomplete; run with --execute.")
        return

    # Step 2
    plan, repeats = {}, []
    for q, it in items.items():
        n = len(it["contexts"])
        item_pass = [done[f"{q}|{r + 1}|pass"] for r in range(n)]
        target = scores[q]["context_precision_no_ref"]
        if abs(average_precision(item_pass) - target) < MATCH:
            continue
        patterns = [p for p in itertools.product((0, 1), repeat=n) if abs(average_precision(list(p)) - target) < MATCH]
        if not patterns:
            sys.exit(f"{q}: no verdict pattern reproduces its RAGAS context precision ({target})")
        for r in range(n):
            options = {p[r] for p in patterns}
            if len(options) == 1:
                ragas_run = options.pop()
                if ragas_run != item_pass[r]:
                    plan[(q, r + 1)] = ragas_run
                    repeats.append(f"{q}|{r + 1}|repeat1")
            else:
                plan[(q, r + 1)] = None
                repeats += [f"{q}|{r + 1}|repeat1", f"{q}|{r + 1}|repeat2"]
    print(f"answers whose item verdicts differ from their RAGAS score: {len({q for q, _ in plan})}")
    done = run_calls(repeats, items, args.execute, args.workers)
    if any(c not in done for c in repeats):
        print("Step 2 incomplete; run with --execute.")
        return

    out = RESULTS / ("item_verdicts_replay.jsonl" if args.replay else "item_verdicts.jsonl")
    with open(out, "w") as fh:
        for q, it in items.items():
            for r, ctx in enumerate(it["contexts"], 1):
                row = {"id": q, "rank": r, "channel": channel(ctx), "item_pass": done[f"{q}|{r}|pass"]}
                if (q, r) in plan:
                    planned = [f"{q}|{r}|repeat1"] + ([f"{q}|{r}|repeat2"] if plan[(q, r)] is None else [])
                    row["ragas_run"] = plan[(q, r)]
                    row["repeats"] = [done[c] for c in planned]
                    votes = [row["item_pass"]] + ([row["ragas_run"]] if row["ragas_run"] is not None else []) + row["repeats"]
                    row["useful"] = int(sum(votes) >= 2)
                else:
                    row["useful"] = row["item_pass"]
                fh.write(json.dumps(row) + "\n")
    print(f"Wrote {out}")


if __name__ == "__main__":
    main()
