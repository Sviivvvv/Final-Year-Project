/**
 * services/component2.js
 *
 * Thin wrapper around Component 2's POST /score endpoint.
 *
 * Contract:
 *   Request:  POST :8002/score
 *   Body:     { "report_text": string, "component1_context": object | null }
 *
 *   Response (success, parsed_ok: true):
 *   {
 *     "total_score":       number,
 *     "passed":            boolean,
 *     "dimension_scores":  { clarity, specificity, logical_consistency, actionability },
 *     "recommendations":   [{ sentence_reference, issue, suggested_fix }],
 *     "reasoning":         string,
 *     "deductions_applied":[{ marker, section, dimension, points, evidence }],
 *     "parsed_ok":         true,
 *     "error":             null
 *   }
 *
 *   Response (degraded, parsed_ok: false — LLM replied but JSON unparse-able):
 *   {
 *     "total_score":       number | null,  // may still be set via regex fallback
 *     "passed":            boolean,
 *     "dimension_scores":  {},
 *     "recommendations":   [],
 *     "reasoning":         null,
 *     "deductions_applied":[],
 *     "parsed_ok":         false,
 *     "error":             string
 *   }
 *
 * Note: raw_response and latency_s from score_report() are not forwarded
 * by component2_api.py — they're stripped at the FastAPI layer.
 *
 * This function does not raise on parsed_ok: false — the calling route
 * decides how to surface it (the current route persists the partial result
 * and flags it as a scoring_warning).
 */

const axios = require('axios');

/**
 * Calls Component 2's /score endpoint.
 *
 * @param {string} reportText          - Full bug report text.
 * @param {object|null} component1Context - Reshaped C1 output (or null).
 * @returns {object} Raw response body from Component 2.
 * @throws if the upstream service is unreachable or returns a non-2xx status.
 */
async function scoreReport(reportText, component1Context = null) {
  const c2Url = process.env.COMPONENT2_URL || 'http://127.0.0.1:8002';

  let response;
  try {
    response = await axios.post(
      `${c2Url}/score`,
      {
        report_text:        reportText,
        component1_context: component1Context,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60_000, // Gemini can be slow; give it a full minute
      }
    );
  } catch (err) {
    const detail = err.response?.data?.detail ?? err.message;
    const upstreamStatus = err.response?.status;
    const wrapped = new Error(`Component 2 unreachable or returned an error: ${detail}`);
    wrapped.upstreamStatus = upstreamStatus;
    throw wrapped;
  }

  return response.data;
}

module.exports = { scoreReport };