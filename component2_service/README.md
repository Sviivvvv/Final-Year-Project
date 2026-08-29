# Component 2 — Deployed Scoring Service

## Files
- `component2_service.py` — core module. `score_report(report_text, component1_context)` is the main entry point.
- `component2_api.py` — thin FastAPI wrapper (`POST /score`, `GET /health`), following the same pattern as the Component 1 service.
- `component2_prompts.py` — prompt templates; only `build_structured_prompt` is used in the deployed service.
- `test_component2_service.py` — mocked tests covering response parsing, the pass/fail boundary, markdown-fenced responses, LLM call failures, regex-fallback parsing, and dict-context formatting. All pass.

## Setup
```bash
export GOOGLE_API_KEY="your-api-key-here"
pip install google-genai fastapi uvicorn --break-system-packages
uvicorn component2_api:app --host 0.0.0.0 --port 8002
```

## Usage
From the backend:
```js
const res = await fetch("http://localhost:8002/score", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ report_text, component1_context }),
});
const { total_score, passed, dimension_scores, recommendations } = await res.json();
```

## Testing
The test suite mocks `call_gemini` with realistic response shapes rather than
calling the live API, so tests run without network access or an API key.
Prompt-building, JSON parsing (including markdown-fenced responses), the
regex score-fallback, dimension/recommendation extraction, pass/fail
threshold logic, and error handling are all exercised as real code paths —
only the network round-trip to Gemini is stubbed. Run
`python component2_service.py` directly with `GOOGLE_API_KEY` set for a
live one-shot sanity check before wiring changes into the backend.