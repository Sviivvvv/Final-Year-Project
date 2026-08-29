"""
Component 1 Inference Service

Loads the fine-tuned multi-task RoBERTa-Large checkpoint once at startup and
exposes a POST endpoint that takes raw bug report text and returns, per
sentence: which structural labels fired (OB / EB / S2R), a HIGH/LOW quality
label (for structural sentences only), and an overall "complete" flag.
"""

import os
import re

import torch
import torch.nn as nn
from fastapi import FastAPI
from pydantic import BaseModel
from transformers import RobertaConfig, RobertaModel, AutoTokenizer

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

CHECKPOINT_PATH = os.environ.get("COMPONENT1_CHECKPOINT_PATH", "./checkpoints/component1_v10.pt")
MAX_LENGTH = 128  # tokens per sentence; bug report sentences are typically short

# Thresholds for the v10 checkpoint (selected via a macro-F1-based checkpoint
# criterion, with the sampler extended to also oversample S2R-positive rows).
# Checkpoint verified via SHA-256 hash confirmation on reload, matching the
# in-session training metrics exactly: macro-F1 0.747, up from the prior
# checkpoint's 0.698. Thresholds are re-tuned for this checkpoint specifically
# and do not carry over to other checkpoints, since optimal decision
# boundaries shift with training.
# Note: quality_head outputs P(LOW), not P(HIGH) — see classify_sentence() below.
THRESHOLDS = {
    "OB": 0.40,
    "EB": 0.55,
    "S2R": 0.85,
    "QUALITY": 0.70,
}
STRUCT_LABELS = ["OB", "EB", "S2R"]  # order matches struct_head's 3 output logits

DEVICE = torch.device("cuda" if torch.cuda.is_available() else "cpu")


# ---------------------------------------------------------------------------
# Model definition (must match the saved checkpoint's architecture exactly)
# ---------------------------------------------------------------------------

class BugReportModel(nn.Module):
    def __init__(self, dropout=0.3):
        super().__init__()
        config = RobertaConfig.from_pretrained("roberta-large")
        self.encoder = RobertaModel(config)

        self.struct_head = nn.Sequential(
            nn.Linear(1024, 256),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(256, 3),
        )
        self.quality_head = nn.Sequential(
            nn.Linear(1024, 256),
            nn.GELU(),
            nn.Dropout(dropout),
            nn.Linear(256, 1),
        )

    def forward(self, input_ids, attention_mask):
        outputs = self.encoder(input_ids=input_ids, attention_mask=attention_mask)
        pooled = outputs.last_hidden_state[:, 0, :]  # raw <s> token hidden state, no pooler transform
        struct_logits = self.struct_head(pooled)
        quality_logits = self.quality_head(pooled)
        return struct_logits, quality_logits


# ---------------------------------------------------------------------------
# Sentence splitting
# ---------------------------------------------------------------------------
# Regex-based splitter: splits on '.', '!', '?' followed by whitespace and a
# capital letter or end of string. No external tokenizer dependency required.

_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9])")


def split_into_sentences(text: str) -> list[str]:
    text = text.strip()
    if not text:
        return []
    raw_sentences = _SENTENCE_SPLIT_RE.split(text)
    return [s.strip() for s in raw_sentences if s.strip()]


# ---------------------------------------------------------------------------
# Load model + tokenizer once at startup
# ---------------------------------------------------------------------------

print(f"Using device: {DEVICE}")
print("Loading tokenizer...")
tokenizer = AutoTokenizer.from_pretrained("roberta-large")

print("Loading checkpoint...")
state_dict = torch.load(CHECKPOINT_PATH, map_location="cpu")

print("Building model and loading weights...")
model = BugReportModel()
model.load_state_dict(state_dict)
model.to(DEVICE)
model.eval()  # disables dropout; required for consistent inference
print("Model ready.")


# ---------------------------------------------------------------------------
# Inference helpers
# ---------------------------------------------------------------------------

@torch.no_grad()  # disables gradient tracking; inference-only, saves memory/time
def classify_sentence(sentence: str) -> dict:
    encoded = tokenizer(
        sentence,
        truncation=True,
        max_length=MAX_LENGTH,
        padding="max_length",
        return_tensors="pt",
    )
    input_ids = encoded["input_ids"].to(DEVICE)
    attention_mask = encoded["attention_mask"].to(DEVICE)

    struct_logits, quality_logits = model(input_ids=input_ids, attention_mask=attention_mask)

    struct_probs = torch.sigmoid(struct_logits).squeeze(0).tolist()   # [p_OB, p_EB, p_S2R]
    quality_prob_low = torch.sigmoid(quality_logits).squeeze(0).item()  # P(LOW) — training encoded LOW=1

    fired_labels = [
        label
        for label, prob in zip(STRUCT_LABELS, struct_probs)
        if prob >= THRESHOLDS[label]
    ]

    is_structural = len(fired_labels) > 0
    quality_label = None
    if is_structural:
        quality_label = "LOW" if quality_prob_low >= THRESHOLDS["QUALITY"] else "HIGH"

    return {
        "text": sentence,
        "labels": fired_labels if fired_labels else None,
        "quality": quality_label,
        "probabilities": {
            "OB": round(struct_probs[0], 4),
            "EB": round(struct_probs[1], 4),
            "S2R": round(struct_probs[2], 4),
            "quality_low": round(quality_prob_low, 4),
        },
    }


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="Component 1 Inference Service")


class ReportRequest(BaseModel):
    text: str


class SentenceResult(BaseModel):
    text: str
    labels: list[str] | None
    quality: str | None
    probabilities: dict


class ReportResponse(BaseModel):
    sentences: list[SentenceResult]
    complete: bool


@app.post("/classify", response_model=ReportResponse)
def classify_report(request: ReportRequest):
    sentences = split_into_sentences(request.text)
    results = [classify_sentence(s) for s in sentences]

    has_ob = any(r["labels"] and "OB" in r["labels"] for r in results)
    has_eb = any(r["labels"] and "EB" in r["labels"] for r in results)
    has_s2r = any(r["labels"] and "S2R" in r["labels"] for r in results)
    complete = has_ob and has_eb and has_s2r

    return {"sentences": results, "complete": complete}


@app.get("/health")
def health():
    return {"status": "ok", "device": str(DEVICE)}