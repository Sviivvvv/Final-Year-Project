"""
Independently evaluate a Component 1 checkpoint (the "re-verification" step of Section 5.4.1).

    python evaluate_checkpoint.py --checkpoint ../checkpoints/component1_v10.pt --data-dir <dir with bug_reports_*.csv>

It reloads the checkpoint from disk, tunes per-class thresholds on the VALIDATION split only,
scores the held-out TEST split once, and writes the errors to artifacts/ so they can be read.
Use --thresholds OB,EB,S2R,QUALITY to score at fixed thresholds instead (e.g. the deployed ones).
"""

import argparse
import json
import os
import sys

import numpy as np
import pandas as pd
import torch

sys.path.insert(0, os.path.dirname(__file__))
from common import (LABELS, MultiTaskRoberta, get_predictions, get_tokenizer, load_csvs, make_loader,
                    score, sha256_of, tune_quality_threshold, tune_thresholds)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "artifacts"))
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--thresholds", default=None, help="OB,EB,S2R,QUALITY (skip tuning)")
    ap.add_argument("--tag", default=None)
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    tag = args.tag or os.path.splitext(os.path.basename(args.checkpoint))[0]
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    print("SHA-256:", sha256_of(args.checkpoint))
    model = MultiTaskRoberta(pretrained=False)
    model.load_state_dict(torch.load(args.checkpoint, map_location="cpu"))
    model.to(device).eval()

    tok = get_tokenizer()
    _, val_df, test_df = load_csvs(args.data_dir)
    val = get_predictions(model, make_loader(val_df, tok, args.batch_size), device)
    test = get_predictions(model, make_loader(test_df, tok, args.batch_size), device)

    if args.thresholds:
        vals = [float(x) for x in args.thresholds.split(",")]
        th, qt = np.array(vals[:3]), vals[3]
    else:
        th, qt = tune_thresholds(val[0], val[1]), tune_quality_threshold(val[2], val[3], val[4])

    res = {"checkpoint": args.checkpoint, "sha256": sha256_of(args.checkpoint),
           "thresholds": dict(zip(LABELS + ["QUALITY"], [*map(float, th), qt])),
           "val": score(val, th, qt), "test": score(test, th, qt)}
    print(f"\n=== {tag}: held-out TEST (thresholds tuned on val) ===")
    for n in LABELS:
        r = res["test"][n]
        print(f"  {n:<3} P={r['precision']:.3f} R={r['recall']:.3f} F1={r['f1']:.3f} (threshold {res['thresholds'][n]:.2f})")
    q = res["test"]["quality"]
    print(f"  Structure macro-F1: {res['test']['macro_f1']:.3f}   (val {res['val']['macro_f1']:.3f})")
    print(f"  Quality P={q['precision']:.3f} R={q['recall']:.3f} F1={q['f1']:.3f} (threshold {qt:.2f})")

    json.dump(res, open(os.path.join(args.out, f"{tag}_results.json"), "w"), indent=2)
    # Same format train.py writes, so compare_runs.py can use this checkpoint as the baseline.
    np.savez(os.path.join(args.out, f"{tag}_probs.npz"),
             val_struct=val[0], val_labels=val[1], val_q=val[2], val_ql=val[3], val_qm=val[4],
             test_struct=test[0], test_labels=test[1], test_q=test[2], test_ql=test[3], test_qm=test[4],
             thresholds=th, q_threshold=qt)

    # Error dumps from the TEST split: what the model gets wrong, per class.
    pred = (test[0] >= th).astype(int)
    out = test_df.copy()
    for i, n in enumerate(LABELS):
        out[f"p_{n}"] = test[0][:, i].round(4)
        out[f"pred_{n}"] = pred[:, i]
    out.to_csv(os.path.join(args.out, f"{tag}_test_predictions.csv"), index=False)
    print("Wrote", os.path.join(args.out, f"{tag}_test_predictions.csv"))


if __name__ == "__main__":
    main()
