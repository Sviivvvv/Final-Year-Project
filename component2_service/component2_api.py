"""
Component 2 - FastAPI service.

HTTP wrapper around component2_service.score_report(), exposing it as a REST
endpoint. The backend calls Component 1 first to get structural context, then
calls this service's POST /score with the report text and that context to get
a content-quality score and recommendations.
"""

from typing import Optional, Union

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from component2_service import score_report, PASS_THRESHOLD

app = FastAPI(title="Component 2 - Bug Report Content Quality Scoring")


class ScoreRequest(BaseModel):
    """Request body for POST /score."""
    report_text: str
    component1_context: Optional[Union[dict, str]] = None
    model: Optional[str] = None
    temperature: Optional[float] = None


class ScoreResponse(BaseModel):
    """Response body returned by POST /score."""
    total_score: Optional[int]
    passed: bool
    dimension_scores: dict
    recommendations: list
    reasoning: Optional[str]
    deductions_applied: list
    parsed_ok: bool
    error: Optional[str]


@app.get("/health")
def health():
    """Health check endpoint; also returns the current pass threshold."""
    return {"status": "ok", "pass_threshold": PASS_THRESHOLD}


@app.post("/score", response_model=ScoreResponse)
def score(req: ScoreRequest):
    """
    Scores a bug report's content quality and returns dimension scores,
    a pass/fail result, and recommendations.

    A hard failure to reach the LLM (network/auth/quota) returns a 502.
    A parse failure on a valid model response is not treated as an error;
    it is returned as a normal 200 with parsed_ok=False so the caller can
    decide how to handle it (e.g. retry, or show a generic message).
    """
    kwargs = {}
    if req.model:
        kwargs["model"] = req.model
    if req.temperature is not None:
        kwargs["temperature"] = req.temperature

    result = score_report(req.report_text, req.component1_context, **kwargs)

    if result["error"] and result["error"].startswith("LLM call failed"):
        raise HTTPException(status_code=502, detail=result["error"])

    result.pop("raw_response", None)
    result.pop("latency_s", None)
    return result