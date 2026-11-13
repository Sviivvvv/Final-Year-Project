"""
Compare training runs fairly.

    python compare_runs.py --runs-dir runs --test-csv <bug_reports_test.csv> [--baseline baseline]

With only ~190 Expected-Behaviour sentences in the test set, a single run's score moves by a few
points from chance alone (the v10 vs v11 result in Table 5.3 is an example). So this script reports:
  * every run's TEST macro-F1 with a 95% bootstrap confidence interval (resampling whole bug
    reports, because sentences from one report are not independent), and
  * for each run, the paired difference to the baseline run with its own interval and the
    probability that it is really better.
It also scores an ensemble (average of the runs' probabilities, thresholds re-tuned on validation).
"""

import argparse
import glob
import json
import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import LABELS, score, tune_quality_threshold, tune_thresholds

N_BOOT = 2000


def load_run(path):
    name = os.path.basename(path).replace("_probs.npz", "")
    z = np.load(path)
    meta = json.load(open(path.replace("_probs.npz", "_results.json")))
    return name, z, meta


def per_bug_counts(probs, labels, thresholds, bug_ids):
    """tp/fp/fn per bug report for each class -> array [n_bugs, 3 classes, 3]."""
    pred = (probs >= thresholds).astype(int)
    codes, uniq = pd.factorize(bug_ids)
    out = np.zeros((len(uniq), 3, 3))
    for c in range(3):
        for k, m in enumerate(((pred[:, c] == 1) & (labels[:, c] == 1), (pred[:, c] == 1) & (labels[:, c] == 0), (pred[:, c] == 0) & (labels[:, c] == 1))):
            np.add.at(out[:, c, k], codes, m.astype(float))
    return out


def macro_f1_from_counts(counts):  # counts [..., 3 classes, 3]
    tp, fp, fn = counts[..., 0], counts[..., 1], counts[..., 2]
    f1 = 2 * tp / np.maximum(2 * tp + fp + fn, 1e-9)
    return f1.mean(axis=-1), f1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs-dir", default="runs")
    ap.add_argument("--test-csv", required=True)
    ap.add_argument("--baseline", default="baseline")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    test = pd.read_csv(args.test_csv)
    runs = [load_run(p) for p in sorted(glob.glob(os.path.join(args.runs_dir, "*_probs.npz")))]
    if not runs:
        sys.exit("no *_probs.npz files found")
    rng = np.random.RandomState(0)
    n_bugs = test["bug_id"].nunique()
    boot_idx = rng.randint(0, n_bugs, size=(N_BOOT, n_bugs))

    rows, boots = [], {}
    for name, z, meta in runs:
        th = z["thresholds"]
        counts = per_bug_counts(z["test_struct"], z["test_labels"], th, test["bug_id"].values)
        boot_counts = counts[boot_idx].sum(axis=1)  # [N_BOOT, 3, 3]
        macro, per_class = macro_f1_from_counts(boot_counts)
        boots[name] = (macro, per_class)
        point = meta["test"]
        rows.append({
            "run": name, "macro_f1": point["macro_f1"], "ci95": f"{np.percentile(macro, 2.5):.3f}-{np.percentile(macro, 97.5):.3f}",
            "OB": point["OB"]["f1"], "EB": point["EB"]["f1"], "S2R": point["S2R"]["f1"], "quality_f1": point["quality"]["f1"],
            "val_macro_f1": meta["val"]["macro_f1"], "minutes": meta.get("minutes"),
        })

    # Ensemble of all runs (probability average, thresholds tuned on validation only)
    if len(runs) > 1:
        avg = lambda key: np.mean([z[key] for _, z, _ in runs], axis=0)
        val = (avg("val_struct"), runs[0][1]["val_labels"], avg("val_q"), runs[0][1]["val_ql"], runs[0][1]["val_qm"])
        tst = (avg("test_struct"), runs[0][1]["test_labels"], avg("test_q"), runs[0][1]["test_ql"], runs[0][1]["test_qm"])
        th, qt = tune_thresholds(val[0], val[1]), tune_quality_threshold(val[2], val[3], val[4])
        s = score(tst, th, qt)
        counts = per_bug_counts(tst[0], tst[1], th, test["bug_id"].values)
        macro, per_class = macro_f1_from_counts(counts[boot_idx].sum(axis=1))
        boots["ENSEMBLE"] = (macro, per_class)
        rows.append({"run": "ENSEMBLE", "macro_f1": s["macro_f1"], "ci95": f"{np.percentile(macro, 2.5):.3f}-{np.percentile(macro, 97.5):.3f}",
                     "OB": s["OB"]["f1"], "EB": s["EB"]["f1"], "S2R": s["S2R"]["f1"], "quality_f1": s["quality"]["f1"],
                     "val_macro_f1": score(val, th, qt)["macro_f1"], "minutes": None})

    table = pd.DataFrame(rows)
    lines = ["# Run comparison (held-out TEST, thresholds tuned on validation)", "", table.round(3).to_markdown(index=False), ""]

    if args.baseline in boots:
        lines += [f"## Difference to `{args.baseline}` (paired bootstrap over bug reports, {N_BOOT} resamples)", "",
                  "| run | macro-F1 gain | 95% interval | P(better) | EB gain | S2R gain |", "|---|---|---|---|---|---|"]
        b_macro, b_pc = boots[args.baseline]
        for name, (m, pc) in boots.items():
            if name == args.baseline:
                continue
            d = m - b_macro
            lines.append(f"| {name} | {d.mean():+.3f} | {np.percentile(d, 2.5):+.3f} to {np.percentile(d, 97.5):+.3f} | {(d > 0).mean():.0%} | "
                         f"{(pc[:, 1] - b_pc[:, 1]).mean():+.3f} | {(pc[:, 2] - b_pc[:, 2]).mean():+.3f} |")
        lines += ["", "Rule of thumb: call a run better only when the interval excludes zero (P(better) above about 95%)."]

    text = "\n".join(lines)
    print(text)
    open(args.out or os.path.join(args.runs_dir, "comparison.md"), "w", encoding="utf8").write(text)


if __name__ == "__main__":
    main()
