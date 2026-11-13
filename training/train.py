"""
Train Component 1 (multi-task RoBERTa-Large) - the v10 recipe, plus switches for the improvements.

    python train.py --data-dir <dir> --run-name baseline
    python train.py --data-dir <dir> --run-name aug      --train-file bug_reports_train_aug.csv
    python train.py --data-dir <dir> --run-name ctx      --context 1
    python train.py --data-dir <dir> --run-name aug_ctx  --train-file bug_reports_train_aug.csv --context 1

With no switches this is the v10 recipe: lr 2e-5, weight decay 0.05, 6 epochs, warmup 10%, batch 16,
AMP, grad-clip 1.0, EB/S2R weighted sampler, raw pos-weights for EB/S2R and sqrt-dampened OB,
checkpoint chosen by validation macro-F1 (patience 2), thresholds tuned on validation, test scored once.
"""

import argparse
import json
import os
import random
import sys
import time

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from torch.utils.data import WeightedRandomSampler
from transformers import get_linear_schedule_with_warmup

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import (LABELS, MultiTaskRoberta, get_predictions, get_tokenizer, make_loader, score, sha256_of,
                    tune_quality_threshold, tune_thresholds)


def pos_weight_from_counts(n_total, n_pos, dampen=False, cap=None):
    raw = (n_total - n_pos) / max(n_pos, 1)
    w = np.sqrt(raw) if dampen else raw
    return min(w, cap) if cap is not None else w


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data-dir", required=True)
    ap.add_argument("--train-file", default="bug_reports_train.csv")
    ap.add_argument("--run-name", required=True)
    ap.add_argument("--out", default="runs")
    ap.add_argument("--model", default="roberta-large")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--epochs", type=int, default=6)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--weight-decay", type=float, default=0.05)
    ap.add_argument("--warmup", type=float, default=0.1)
    ap.add_argument("--patience", type=int, default=2)
    ap.add_argument("--batch-size", type=int, default=16)
    ap.add_argument("--context", type=int, default=0, help="1 = also feed the previous sentence of the same bug report")
    ap.add_argument("--limit", type=int, default=0, help="smoke test: use only N rows per split")
    args = ap.parse_args()

    random.seed(args.seed); np.random.seed(args.seed); torch.manual_seed(args.seed); torch.cuda.manual_seed_all(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    os.makedirs(args.out, exist_ok=True)
    ckpt = os.path.join(args.out, f"{args.run_name}.pt")

    train_df = pd.read_csv(os.path.join(args.data_dir, args.train_file))
    val_df = pd.read_csv(os.path.join(args.data_dir, "bug_reports_val.csv"))
    test_df = pd.read_csv(os.path.join(args.data_dir, "bug_reports_test.csv"))
    if args.limit:
        rng = np.random.RandomState(0)
        keep = lambda d: d.iloc[np.sort(rng.choice(len(d), min(args.limit, len(d)), replace=False))].reset_index(drop=True)
        train_df, val_df, test_df = keep(train_df), keep(val_df), keep(test_df)
        for d in (val_df, test_df):  # context needs neighbours; in a smoke test they are simply absent
            pass
    n_aug = int((train_df.get("aug_type", pd.Series(["original"] * len(train_df))) != "original").sum())
    print(f"[{args.run_name}] train rows {len(train_df)} (augmented {n_aug}) | val {len(val_df)} | test {len(test_df)} | device {device} | context={args.context}")

    tok = get_tokenizer()
    # ----- sampler: oversample EB- and S2R-positive rows to balance (v10) -----
    eb = train_df["is_EB"].values == 1
    s2r = train_df["is_S2R"].values == 1
    w = np.ones(len(train_df))
    w = np.where(eb, np.maximum(w, (len(train_df) - eb.sum()) / max(eb.sum(), 1)), w)
    w = np.where(s2r, np.maximum(w, (len(train_df) - s2r.sum()) / max(s2r.sum(), 1)), w)
    sampler = WeightedRandomSampler(w, num_samples=len(train_df), replacement=True)
    train_loader = make_loader(train_df, tok, args.batch_size, sampler=sampler, use_context=bool(args.context))
    val_loader = make_loader(val_df, tok, 64, use_context=bool(args.context))
    test_loader = make_loader(test_df, tok, 64, use_context=bool(args.context))

    # ----- class weights (v10) -----
    n = len(train_df)
    struct_pos_weight = torch.tensor([
        pos_weight_from_counts(n, train_df.is_OB.sum(), dampen=True, cap=10.0),
        pos_weight_from_counts(n, train_df.is_EB.sum()),
        pos_weight_from_counts(n, train_df.is_S2R.sum()),
    ], dtype=torch.float32).to(device)
    trusted = train_df["quality_trusted"] != 0 if "quality_trusted" in train_df else pd.Series(True, index=train_df.index)
    structural = (train_df.is_OB == 1) | (train_df.is_EB == 1) | (train_df.is_S2R == 1)
    qc = train_df.loc[structural & trusted, "quality_label"].value_counts()
    quality_pos_weight = torch.tensor(qc.get("HIGH", 1) / max(qc.get("LOW", 1), 1), dtype=torch.float32).to(device)

    def combined_loss(s_logits, s_labels, q_logits, q_label, q_mask):
        s_loss = nn.BCEWithLogitsLoss(pos_weight=struct_pos_weight)(s_logits, s_labels)
        q_raw = nn.functional.binary_cross_entropy_with_logits(q_logits, q_label, pos_weight=quality_pos_weight, reduction="none")
        q_loss = (q_raw * q_mask).sum() / q_mask.sum().clamp(min=1.0)
        return s_loss + q_loss

    model = MultiTaskRoberta(args.model).to(device)
    opt = torch.optim.AdamW(model.parameters(), lr=args.lr, weight_decay=args.weight_decay)
    total = len(train_loader) * args.epochs
    sched = get_linear_schedule_with_warmup(opt, int(total * args.warmup), total)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")

    history, best, bad, t0 = [], -1.0, 0, time.time()
    for epoch in range(1, args.epochs + 1):
        model.train()
        run_loss = 0.0
        for step, b in enumerate(train_loader, 1):
            opt.zero_grad(set_to_none=True)
            with torch.autocast(device_type="cuda", enabled=device.type == "cuda"):
                s_logits, q_logits = model(b["input_ids"].to(device), b["attention_mask"].to(device))
                loss = combined_loss(s_logits.float(), b["struct_labels"].to(device), q_logits.float(),
                                     b["quality_label"].to(device), b["quality_mask"].to(device))
            scaler.scale(loss).backward()
            scaler.unscale_(opt)
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(opt); scaler.update(); sched.step()
            run_loss += loss.item()
            if step % 500 == 0:
                print(f"  epoch {epoch} step {step}/{len(train_loader)} loss {run_loss / step:.4f} ({(time.time() - t0) / 60:.1f} min)", flush=True)

        val = get_predictions(model, val_loader, device)
        m = score(val, np.array([0.5, 0.5, 0.5]), 0.5)  # selection criterion exactly as v10: macro-F1 at 0.5
        history.append({"epoch": epoch, "train_loss": run_loss / len(train_loader), "val_macro_f1_at_0.5": m["macro_f1"],
                        **{f"val_{c}_f1": m[c]["f1"] for c in LABELS}})
        print(f"epoch {epoch}/{args.epochs}  train loss {run_loss / len(train_loader):.4f}  val macro-F1 {m['macro_f1']:.3f}"
              f"  (OB {m['OB']['f1']:.3f} EB {m['EB']['f1']:.3f} S2R {m['S2R']['f1']:.3f})  {(time.time() - t0) / 60:.1f} min", flush=True)
        if m["macro_f1"] > best:
            best, bad = m["macro_f1"], 0
            torch.save(model.state_dict(), ckpt)
            print(f"  -> new best, saved {ckpt}", flush=True)
        else:
            bad += 1
            if bad >= args.patience:
                print(f"early stopping at epoch {epoch}")
                break

    # ----- thresholds on validation, test scored once -----
    model.load_state_dict(torch.load(ckpt, map_location=device))
    val = get_predictions(model, val_loader, device)
    test = get_predictions(model, test_loader, device)
    th, qt = tune_thresholds(val[0], val[1]), tune_quality_threshold(val[2], val[3], val[4])
    res = {
        "run": args.run_name, "config": vars(args), "train_rows": len(train_df), "augmented_rows": n_aug,
        "minutes": round((time.time() - t0) / 60, 1), "history": history, "sha256": sha256_of(ckpt),
        "thresholds": dict(zip(LABELS + ["QUALITY"], [*map(float, th), qt])),
        "val": score(val, th, qt), "test": score(test, th, qt),
    }
    json.dump(res, open(os.path.join(args.out, f"{args.run_name}_results.json"), "w"), indent=2)
    np.savez(os.path.join(args.out, f"{args.run_name}_probs.npz"),
             val_struct=val[0], val_labels=val[1], val_q=val[2], val_ql=val[3], val_qm=val[4],
             test_struct=test[0], test_labels=test[1], test_q=test[2], test_ql=test[3], test_qm=test[4],
             thresholds=th, q_threshold=qt)
    print(f"\n=== {args.run_name}: TEST (thresholds tuned on validation) ===")
    for c in LABELS:
        r = res["test"][c]
        print(f"  {c:<3} P={r['precision']:.3f} R={r['recall']:.3f} F1={r['f1']:.3f} (threshold {res['thresholds'][c]:.2f})")
    q = res["test"]["quality"]
    print(f"  Structure macro-F1: {res['test']['macro_f1']:.3f}   |  Quality F1 {q['f1']:.3f}  |  SHA-256 {res['sha256']}")


if __name__ == "__main__":
    main()
