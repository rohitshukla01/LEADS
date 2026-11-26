"""Evidence sources used by each answer (Fig. 5b). No API calls.

An answer uses a source (evidence channel) when the judge marked at least one item retrieved from
that source as useful for producing the answer (item_verdicts.jsonl, column "useful").
As a second measure, an answer cites a source when it cites at least one item from that source by its
number in the evidence list ([n] in the answer text).

    python evidence_use.py                      # verdicts used in the paper
    python evidence_use.py --verdicts results/item_verdicts.jsonl

Writes results/evidence_use.json.
"""
import argparse
import json
import re
from collections import Counter

from common import CATEGORIES, CHANNELS, RESULTS, channel, load_benchmark, load_item_verdicts


def summarise(verdicts_path=None):
    items = load_benchmark()
    verdicts = load_item_verdicts(verdicts_path)
    answers = {}
    for it in items:
        rows = verdicts[it["id"]]
        if len(rows) != len(it["contexts"]) or any(channel(ctx) != r["channel"] for ctx, r in zip(it["contexts"], rows)):
            raise ValueError(f"{it['id']}: item verdicts do not match the benchmark evidence list")
        used = sorted({r["channel"] for r in rows if r["useful"]}, key=CHANNELS.index)
        cited = sorted({rows[int(n) - 1]["channel"] for n in re.findall(r"\[(\d+)\]", it["answer"])
                        if 1 <= int(n) <= len(rows)}, key=CHANNELS.index)
        answers[it["id"]] = {"category": it["category"], "channels_used": used, "channels_cited": cited}
    by_type = {c: Counter(ch for a in answers.values() if a["category"] == c for ch in a["channels_used"])
               for c in CATEGORIES}
    cited_by_type = {c: Counter(ch for a in answers.values() if a["category"] == c for ch in a["channels_cited"])
                     for c in CATEGORIES}
    return {
        "answers": answers,
        "answers_per_type": {c: sum(a["category"] == c for a in answers.values()) for c in CATEGORIES},
        "answers_using_channel": {c: {ch: by_type[c][ch] for ch in CHANNELS} for c in CATEGORIES},
        "answers_using_at_least_one": sum(bool(a["channels_used"]) for a in answers.values()),
        "answers_using_two_or_more": sum(len(a["channels_used"]) >= 2 for a in answers.values()),
        "answers_citing_channel": {c: {ch: cited_by_type[c][ch] for ch in CHANNELS} for c in CATEGORIES},
        "answers_citing_at_least_one": sum(bool(a["channels_cited"]) for a in answers.values()),
        "answers_citing_two_or_more": sum(len(a["channels_cited"]) >= 2 for a in answers.values()),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--verdicts", default=None)
    args = ap.parse_args()
    s = summarise(args.verdicts)
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / "evidence_use.json").write_text(json.dumps(s, indent=1))
    n = len(s["answers"])
    print("Answers using each source (Fig. 5b)")
    print(f"{'':16s}" + "".join(f"{ch:>13s}" for ch in CHANNELS))
    for c, label in CATEGORIES.items():
        print(f"{label + ' (' + str(s['answers_per_type'][c]) + ')':16s}"
              + "".join(f"{s['answers_using_channel'][c][ch]:>13d}" for ch in CHANNELS))
    print(f"\nAnswers using at least one source: {s['answers_using_at_least_one']} of {n}")
    print(f"Answers using two or more sources: {s['answers_using_two_or_more']} of {n}")
    print("\nAnswers citing each source")
    print(f"{'':16s}" + "".join(f"{ch:>13s}" for ch in CHANNELS))
    for c, label in CATEGORIES.items():
        print(f"{label + ' (' + str(s['answers_per_type'][c]) + ')':16s}"
              + "".join(f"{s['answers_citing_channel'][c][ch]:>13d}" for ch in CHANNELS))
    print(f"\nAnswers citing at least one source: {s['answers_citing_at_least_one']} of {n}")
    print(f"Answers citing two or more sources: {s['answers_citing_two_or_more']} of {n}")


if __name__ == "__main__":
    main()
