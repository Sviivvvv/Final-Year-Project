"""
Shared pieces for Component 1 training and evaluation.

The model, dataset semantics and evaluation logic are identical to the v10 notebook
(Appendix, Code Listings 1-7). The only difference is dynamic padding: sentences are
padded to the longest one in the batch instead of to MAX_LEN. Padded positions are masked
by the attention mask, so predictions are unchanged; it just runs much faster.
"""

import hashlib

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.metrics import precision_recall_fscore_support
from torch.utils.data import DataLoader, Dataset
from transformers import AutoTokenizer, RobertaModel

MODEL_NAME = "roberta-large"
MAX_LEN = 128
LABELS = ["OB", "EB", "S2R"]
THRESHOLD_GRID = np.arange(0.1, 0.91, 0.05)


class MultiTaskRoberta(nn.Module):
    """Shared RoBERTa-Large encoder with a structure head (3 sigmoids) and a quality head (P(LOW))."""

    def __init__(self, model_name=MODEL_NAME, hidden_dropout=0.3, head_hidden=256, pretrained=True):
        super().__init__()
        if pretrained:
            self.encoder = RobertaModel.from_pretrained(model_name)
        else:  # architecture only, weights come from a checkpoint
            from transformers import RobertaConfig
            self.encoder = RobertaModel(RobertaConfig.from_pretrained(model_name))
        dim = self.encoder.config.hidden_size
        self.dropout = nn.Dropout(hidden_dropout)
        self.struct_head = nn.Sequential(nn.Linear(dim, head_hidden), nn.GELU(), nn.Dropout(hidden_dropout), nn.Linear(head_hidden, 3))
        self.quality_head = nn.Sequential(nn.Linear(dim, head_hidden), nn.GELU(), nn.Dropout(hidden_dropout), nn.Linear(head_hidden, 1))

    def forward(self, input_ids, attention_mask):
        out = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        pooled = self.dropout(out.last_hidden_state[:, 0, :])
        return self.struct_head(pooled), self.quality_head(pooled).squeeze(-1)


def get_tokenizer():
    tok = AutoTokenizer.from_pretrained(MODEL_NAME)
    # Guard against the tokenizer bug that invalidated earlier runs (Section 5.4.1).
    assert len(tok.tokenize("Thread leaks in Tomcat on hot-redeploy")) < 15, "TOKENIZER IS CHARACTER-SPLITTING"
    return tok


class BugReportDataset(Dataset):
    """
    One sentence per row. quality_label: LOW -> 1, HIGH -> 0, anything else is masked out of the
    quality loss. Rows with `quality_trusted == 0` (machine-generated paraphrases, whose quality
    label we cannot vouch for) are also masked out, but still train the structure head.
    """

    def __init__(self, df, ctx=None):
        self.texts = df["sentence_text"].astype(str).tolist()
        self.ctx = list(ctx) if ctx is not None else None
        self.struct = df[["is_OB", "is_EB", "is_S2R"]].astype("float32").values
        self.q_raw = df["quality_label"].tolist()
        self.trusted = df["quality_trusted"].tolist() if "quality_trusted" in df else [1] * len(df)

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, i):
        q = self.q_raw[i]
        if q == "LOW" and self.trusted[i] != 0:
            ql, qm = 1.0, 1.0
        elif q == "HIGH" and self.trusted[i] != 0:
            ql, qm = 0.0, 1.0
        else:
            ql, qm = 0.0, 0.0
        return self.texts[i], (self.ctx[i] if self.ctx is not None else None), self.struct[i], ql, qm


def make_collate(tokenizer):
    def collate(batch):
        texts, ctx, struct, ql, qm = zip(*batch)
        if ctx[0] is None:
            enc = tokenizer(list(texts), truncation=True, max_length=MAX_LEN, padding=True, return_tensors="pt")
        else:  # sentence first, the sentence before it as the second segment
            enc = tokenizer(list(texts), list(ctx), truncation="longest_first", max_length=MAX_LEN, padding=True, return_tensors="pt")
        return {
            "input_ids": enc["input_ids"],
            "attention_mask": enc["attention_mask"],
            "struct_labels": torch.tensor(np.stack(struct), dtype=torch.float32),
            "quality_label": torch.tensor(ql, dtype=torch.float32),
            "quality_mask": torch.tensor(qm, dtype=torch.float32),
        }
    return collate


def add_context(df):
    """
    The sentence immediately before each one in the same bug report ('' for the first sentence).
    Augmented rows (see augment_data.py) inherit the context of the sentence they were made from.
    """
    if "source_row" in df.columns and "aug_type" in df.columns:
        orig = df[df.aug_type == "original"]
        prev = orig.groupby("bug_id")["sentence_text"].shift(1).fillna("").astype(str)
        by_source = dict(zip(orig["source_row"], prev))
        return [by_source.get(int(r), "") if t != "original" else prev.loc[i]
                for i, r, t in zip(df.index, df["source_row"], df["aug_type"])]
    return df.groupby("bug_id")["sentence_text"].shift(1).fillna("").astype(str).tolist()


def make_loader(df, tokenizer, batch_size=32, shuffle=False, sampler=None, use_context=False):
    return DataLoader(BugReportDataset(df, add_context(df) if use_context else None), batch_size=batch_size, shuffle=shuffle and sampler is None,
                      sampler=sampler, collate_fn=make_collate(tokenizer))


@torch.no_grad()
def get_predictions(model, loader, device, amp=True):
    model.eval()
    sp, sl, qp, ql, qm = [], [], [], [], []
    for b in loader:
        with torch.autocast(device_type="cuda", enabled=amp and device.type == "cuda"):
            s_logits, q_logits = model(b["input_ids"].to(device), b["attention_mask"].to(device))
        sp.append(torch.sigmoid(s_logits.float()).cpu())
        qp.append(torch.sigmoid(q_logits.float()).cpu())
        sl.append(b["struct_labels"]); ql.append(b["quality_label"]); qm.append(b["quality_mask"])
    return (torch.cat(sp).numpy(), torch.cat(sl).numpy(), torch.cat(qp).numpy(),
            torch.cat(ql).numpy(), torch.cat(qm).numpy().astype(bool))


def prf(y_true, y_pred):
    p, r, f, _ = precision_recall_fscore_support(y_true, y_pred, average="binary", zero_division=0)
    return float(p), float(r), float(f)


def tune_thresholds(probs, labels):
    """Per-class threshold that maximises F1 on validation (same grid as the v10 notebook)."""
    out = []
    for i in range(probs.shape[1]):
        best_f, best_t = 0.0, 0.5
        for t in THRESHOLD_GRID:
            f = prf(labels[:, i], (probs[:, i] >= t).astype(int))[2]
            if f > best_f:
                best_f, best_t = f, float(t)
        out.append(best_t)
    return np.array(out)


def tune_quality_threshold(probs, labels, mask):
    best_f, best_t = 0.0, 0.5
    for t in THRESHOLD_GRID:
        f = prf(labels[mask], (probs[mask] >= t).astype(int))[2]
        if f > best_f:
            best_f, best_t = f, float(t)
    return best_t


def score(split, thresholds, q_threshold):
    """Per-class P/R/F1 + macro-F1 for the structure head, and P/R/F1 for quality, at fixed thresholds."""
    sp, sl, qp, ql, qm = split
    pred = (sp >= thresholds).astype(int)
    res = {}
    for i, name in enumerate(LABELS):
        p, r, f = prf(sl[:, i], pred[:, i])
        res[name] = {"precision": p, "recall": r, "f1": f}
    res["macro_f1"] = float(np.mean([res[n]["f1"] for n in LABELS]))
    p, r, f = prf(ql[qm], (qp[qm] >= q_threshold).astype(int))
    res["quality"] = {"precision": p, "recall": r, "f1": f}
    return res


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_csvs(data_dir):
    return (pd.read_csv(f"{data_dir}/bug_reports_train.csv"),
            pd.read_csv(f"{data_dir}/bug_reports_val.csv"),
            pd.read_csv(f"{data_dir}/bug_reports_test.csv"))
