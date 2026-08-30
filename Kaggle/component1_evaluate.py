"""
Component 1 evaluation script.

Loads a trained checkpoint, verifies its SHA-256 hash against the value
recorded at training time, tunes per-class decision thresholds on the
validation set, then computes final precision/recall/F1 on the held-out
test set.
file is used and exists within kaggle
"""

import hashlib

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
from sklearn.metrics import precision_recall_fscore_support
from torch.utils.data import DataLoader, Dataset
from transformers import AutoTokenizer, RobertaModel

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")
MAX_LEN = 128
BATCH_SIZE = 16
CHECKPOINT_PATH = "component1_best.pt"
VAL_PATH = "bug_reports_val.csv"
TEST_PATH = "bug_reports_test.csv"
EXPECTED_CHECKPOINT_HASH = "171562925ab687a875d892a38f4c91ada25569e39fc6a27609cfb69b221842e5"


def sha256_of(path):
    """Computes the SHA-256 hash of a file, read in chunks."""
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


class MultiTaskRoberta(nn.Module):
    """Shared RoBERTa-Large encoder with a structural head (OB/EB/S2R) and
    a content-quality head (HIGH/LOW), matching the deployed inference
    service's architecture."""

    def __init__(self, model_name="roberta-large", hidden_dropout=0.3, head_hidden=256):
        super().__init__()
        self.encoder = RobertaModel.from_pretrained(model_name)
        encoder_dim = self.encoder.config.hidden_size
        self.dropout = nn.Dropout(hidden_dropout)
        self.struct_head = nn.Sequential(
            nn.Linear(encoder_dim, head_hidden), nn.GELU(),
            nn.Dropout(hidden_dropout), nn.Linear(head_hidden, 3),
        )
        self.quality_head = nn.Sequential(
            nn.Linear(encoder_dim, head_hidden), nn.GELU(),
            nn.Dropout(hidden_dropout), nn.Linear(head_hidden, 1),
        )

    def forward(self, input_ids, attention_mask):
        out = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        pooled = self.dropout(out.last_hidden_state[:, 0, :])
        return self.struct_head(pooled), self.quality_head(pooled).squeeze(-1)


class BugReportDataset(Dataset):
    """Wraps a labelled sentence-level CSV for structural (OB/EB/S2R) and
    content-quality (HIGH/LOW) classification."""

    def __init__(self, df, tokenizer, max_len=MAX_LEN):
        self.texts = df['sentence_text'].astype(str).tolist()
        self.is_ob = df['is_OB'].astype('float32').tolist()
        self.is_eb = df['is_EB'].astype('float32').tolist()
        self.is_s2r = df['is_S2R'].astype('float32').tolist()
        self.quality_raw = df['quality_label'].tolist()
        self.tokenizer = tokenizer
        self.max_len = max_len

    def __len__(self):
        return len(self.texts)

    def __getitem__(self, idx):
        enc = self.tokenizer(
            self.texts[idx], truncation=True, max_length=self.max_len,
            padding='max_length', return_tensors='pt',
        )
        q_raw = self.quality_raw[idx]
        q_label, q_mask = (1.0, 1.0) if q_raw == 'LOW' else (0.0, 1.0) if q_raw == 'HIGH' else (0.0, 0.0)
        return {
            'input_ids': enc['input_ids'].squeeze(0),
            'attention_mask': enc['attention_mask'].squeeze(0),
            'struct_labels': torch.tensor([self.is_ob[idx], self.is_eb[idx], self.is_s2r[idx]], dtype=torch.float32),
            'quality_label': torch.tensor(q_label, dtype=torch.float32),
            'quality_mask': torch.tensor(q_mask, dtype=torch.float32),
        }


@torch.no_grad()
def get_predictions(model, loader):
    """Runs the model over a DataLoader and collects predictions/labels for evaluation."""
    model.eval()
    sp, sl, qp, ql, qm = [], [], [], [], []
    for batch in loader:
        input_ids = batch['input_ids'].to(DEVICE)
        attention_mask = batch['attention_mask'].to(DEVICE)
        struct_logits, quality_logits = model(input_ids, attention_mask)
        sp.append(torch.sigmoid(struct_logits).cpu())
        sl.append(batch['struct_labels'])
        qp.append(torch.sigmoid(quality_logits).cpu())
        ql.append(batch['quality_label'])
        qm.append(batch['quality_mask'])
    return (torch.cat(sp).numpy(), torch.cat(sl).numpy(), torch.cat(qp).numpy(),
            torch.cat(ql).numpy(), torch.cat(qm).numpy().astype(bool))


def tune_threshold(probs, true, mask=None):
    """Finds the decision threshold (0.1 to 0.9) that maximises F1 on the given data."""
    best_f1, best_t = 0, 0.5
    p = probs[mask] if mask is not None else probs
    t_ = true[mask] if mask is not None else true
    for t in np.arange(0.1, 0.91, 0.05):
        pred = (p >= t).astype(int)
        _, _, f1, _ = precision_recall_fscore_support(t_, pred, average='binary', zero_division=0)
        if f1 > best_f1:
            best_f1, best_t = f1, t
    return best_t, best_f1


def main():
    print("Verifying checkpoint integrity...")
    actual_hash = sha256_of(CHECKPOINT_PATH)
    assert actual_hash == EXPECTED_CHECKPOINT_HASH, (
        f"Checkpoint hash mismatch: expected {EXPECTED_CHECKPOINT_HASH}, got {actual_hash}"
    )

    model = MultiTaskRoberta()
    model.load_state_dict(torch.load(CHECKPOINT_PATH, map_location="cpu"))
    model.to(DEVICE)
    model.eval()

    tokenizer = AutoTokenizer.from_pretrained("roberta-large")
    val_loader = DataLoader(BugReportDataset(pd.read_csv(VAL_PATH), tokenizer), batch_size=BATCH_SIZE, shuffle=False)
    test_loader = DataLoader(BugReportDataset(pd.read_csv(TEST_PATH), tokenizer), batch_size=BATCH_SIZE, shuffle=False)

    # Tune per-class thresholds on the validation set
    vs_probs, vs_true, vq_probs, vq_true, vq_mask = get_predictions(model, val_loader)
    thresholds = {}
    for i, name in enumerate(["OB", "EB", "S2R"]):
        thresholds[name], _ = tune_threshold(vs_probs[:, i], vs_true[:, i])
    quality_threshold, _ = tune_threshold(vq_probs, vq_true, vq_mask)

    # Final evaluation on the held-out test set
    ts_probs, ts_true, tq_probs, tq_true, tq_mask = get_predictions(model, test_loader)
    th_arr = np.array([thresholds["OB"], thresholds["EB"], thresholds["S2R"]])
    ts_pred = (ts_probs >= th_arr).astype(int)
    p, r, f1, _ = precision_recall_fscore_support(ts_true, ts_pred, average=None, zero_division=0)
    tq_pred = (tq_probs[tq_mask] >= quality_threshold).astype(int)
    qp, qr, qf1, _ = precision_recall_fscore_support(tq_true[tq_mask], tq_pred, average='binary', zero_division=0)

    print("\n=== Test set results ===")
    for i, name in enumerate(["OB", "EB", "S2R"]):
        print(f"  {name}: P={p[i]:.3f} R={r[i]:.3f} F1={f1[i]:.3f} (threshold={th_arr[i]:.2f})")
    print(f"  Structure macro-F1: {f1.mean():.3f}")
    print(f"  Quality: P={qp:.3f} R={qr:.3f} F1={qf1:.3f} (threshold={quality_threshold:.2f})")


if __name__ == "__main__":
    main()