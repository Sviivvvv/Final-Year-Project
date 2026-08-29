/**
 * services/component1.js
 *
 * Thin wrapper around Component 1's POST /classify endpoint.
 *
 * Contract:
 *   Request:  POST :8000/classify  { "text": "..." }
 *   Response: {
 *     "sentences": [
 *       { "text": string, "labels": string[], "quality": string, "probabilities": {...} }
 *     ],
 *     "complete": boolean   ← authoritative gate signal
 *   }
 *
 * "complete: true" means the union of labels[] across all sentences covers
 * all three required sections: OB, EB, S2R.
 *
 * reshapeForContext() resolves a labels[] vs. label mismatch between C1's
 * response shape and what Component 2's _format_component1_context() reads:
 *   C1 returns: { labels: ["OB"] }   (array, plural)
 *   C2 reads:   sentence.get("label", "?")  (scalar, singular)
 * The first label in the array is used as the primary label for each sentence.
 */

const axios = require('axios');

const REQUIRED_SECTIONS = ['OB', 'EB', 'S2R'];

const SECTION_NAMES = {
  OB:  'Observed Behavior',
  EB:  'Expected Behavior',
  S2R: 'Steps to Reproduce',
};

/**
 * Calls Component 1's /classify endpoint.
 *
 * @param {string} text - Full bug report text (combined OB/EB/S2R).
 * @returns {{
 *   complete: boolean,
 *   sentences: Array,
 *   missingSections: string[],     // subset of ['OB','EB','S2R'] not found in any sentence
 *   missingSectionsReadable: string[]  // human-readable equivalents for API response
 * }}
 * @throws if the upstream service is unreachable or returns a non-2xx status.
 */
async function classifyReport(text) {
  const c1Url = process.env.COMPONENT1_URL || 'http://127.0.0.1:8000';

  let response;
  try {
    response = await axios.post(
      `${c1Url}/classify`,
      { text },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30_000,
      }
    );
  } catch (err) {
    // Preserve upstream HTTP status if available so the route can surface it.
    const detail = err.response?.data?.detail ?? err.message;
    const upstreamStatus = err.response?.status;
    const wrapped = new Error(`Component 1 unreachable or returned an error: ${detail}`);
    wrapped.upstreamStatus = upstreamStatus;
    throw wrapped;
  }

  const { complete, sentences } = response.data;

  // Derive which sections are missing from the union of all labels[].
  // Used only for the human-readable rejection message — the gate itself
  // is driven by `complete` (Component 1's authoritative flag).
  const foundLabels = new Set(sentences.flatMap(s => s.labels ?? []));
  const missingSections = REQUIRED_SECTIONS.filter(sec => !foundLabels.has(sec));
  const missingSectionsReadable = missingSections.map(
    s => `${SECTION_NAMES[s]} (${s})`
  );

  return { complete, sentences, missingSections, missingSectionsReadable };
}

/**
 * Reshapes Component 1 sentences into the dict shape that Component 2's
 * _format_component1_context() expects.
 *
 * C1:  { text, labels: ["OB"], quality, probabilities }
 * C2:  { sentences: [{ text, label: "OB", quality }] }
 *
 * The first entry in labels[] is used as the primary label (each sentence
 * typically has one).
 *
 * @param {Array} sentences - Raw sentences array from C1 response.
 * @returns {{ sentences: Array }}
 */
function reshapeForContext(sentences) {
  return {
    sentences: sentences.map(s => ({
      text:    s.text,
      label:   (s.labels ?? [])[0] ?? '?',
      quality: s.quality ?? '?',
    })),
  };
}

module.exports = { classifyReport, reshapeForContext };