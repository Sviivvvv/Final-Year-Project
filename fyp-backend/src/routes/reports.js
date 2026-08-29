/**
 * routes/reports.js
 *
 * POST /reports  — submit → gate → score → feedback flow, with a
 *                  resubmission loop: up to 3 attempts per report
 *                  "thread", escalated to Manager on the 3rd failure.
 * GET  /reports/:id — retrieve a stored report by its MongoDB _id
 *
 * Resubmission model:
 *   - Each attempt is its own document (not an update-in-place), linked by a
 *     shared `thread_id` string. This preserves full attempt history for the
 *     Manager view, rather than overwriting prior attempts.
 *   - First submission: client sends no `thread_id` -> one is generated and
 *     returned in the response. Client stores it and includes it on resubmit.
 *   - A structural rejection (C1 incomplete) OR a scored-but-failed report
 *     (`passed: false`) both count as a "failed attempt" against the cap.
 *   - On the 3rd failed/incomplete attempt, that document is marked
 *     `escalated: true` and no further resubmission is accepted for that
 *     thread.
 *   - A thread that has already passed cannot be resubmitted against.
 *
 * Not yet implemented:
 *   - Concurrent-resubmission race protection (two simultaneous requests on
 *     the same thread could both read the same attempt count).
 *   - Auth beyond the current QA/Manager role check (no per-user identity
 *     tracking yet).
 *   - Admin endpoints (Manager's escalated-reports list is the route below;
 *     Admin-specific routes are not built in this file).
 */

const express      = require('express');
const { ObjectId } = require('mongodb');
const router       = express.Router();

const { getDb }                             = require('../db');
const { classifyReport, reshapeForContext } = require('../services/component1');
const { scoreReport }                       = require('../services/component2');
const { requireRole }                       = require('../middleware/auth');

const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReportText(ob, eb, s2r) {
  return `OB: ${ob.trim()}\nEB: ${eb.trim()}\nS2R: ${s2r.trim()}`;
}

/**
 * Loads every prior attempt for a thread, oldest first.
 * Returns [] if thread_id is falsy or nothing found yet.
 */
async function getThreadAttempts(reports, threadId) {
  if (!threadId) return [];
  return reports.find({ thread_id: threadId }).sort({ attempt_number: 1 }).toArray();
}

// ---------------------------------------------------------------------------
// GET /reports/escalated — Manager's list of escalated reports
// ---------------------------------------------------------------------------
// Returns a flat list (id, score, attempt count, timestamp, a short excerpt),
// sorted most-recent-first. No aggregation, metrics, or filtering beyond the
// escalated flag itself.
//
// Registered before '/:id' below — Express matches routes in registration
// order, and '/:id' would otherwise try to parse "escalated" as a MongoDB
// ObjectId and return a 400.

router.get('/escalated', requireRole('manager'), async (req, res) => {
  const db      = await getDb();
  const reports = db.collection('reports');

  const escalatedDocs = await reports
    .find({ escalated: true })
    .sort({ submitted_at: -1 })
    .toArray();

  const list = escalatedDocs.map(doc => ({
    report_id:      doc._id.toString(),
    thread_id:      doc.thread_id,
    attempt_number: doc.attempt_number,
    status:         doc.status,                 // 'rejected_incomplete' or 'scored'
    total_score:    doc.total_score ?? null,     // null for structural rejections
    submitted_at:   doc.submitted_at,
    excerpt:        doc.observed_behavior?.slice(0, 120) ?? '',
  }));

  return res.status(200).json({ count: list.length, escalated_reports: list });
});

// ---------------------------------------------------------------------------
// GET /reports/:id — retrieve a stored report
// ---------------------------------------------------------------------------

router.get('/:id', requireRole(['qa', 'manager']), async (req, res) => {
  // Validate that the id is a well-formed MongoDB ObjectId before querying.
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid report ID format.' });
  }

  const db      = await getDb();
  const reports = db.collection('reports');
  const doc     = await reports.findOne({ _id: new ObjectId(req.params.id) });

  if (!doc) {
    return res.status(404).json({ error: 'Report not found.' });
  }

  // Return the stored document with _id renamed to report_id for consistency.
  const { _id, ...rest } = doc;
  return res.status(200).json({ report_id: _id.toString(), ...rest });
});

// ---------------------------------------------------------------------------
// POST /reports — submit → gate → score → feedback (+ resubmission loop)
// ---------------------------------------------------------------------------

router.post('/', requireRole('qa'), async (req, res) => {
  const {
    observed_behavior,
    expected_behavior,
    steps_to_reproduce,
    thread_id: incomingThreadId,
  } = req.body ?? {};

  // ------------------------------------------------------------------
  // 1. Input validation
  // ------------------------------------------------------------------
  const missingFields = [];
  if (!observed_behavior?.trim())  missingFields.push('observed_behavior');
  if (!expected_behavior?.trim())  missingFields.push('expected_behavior');
  if (!steps_to_reproduce?.trim()) missingFields.push('steps_to_reproduce');

  if (missingFields.length > 0) {
    return res.status(400).json({
      error:          'Missing required fields.',
      missing_fields: missingFields,
    });
  }

  const reportText  = buildReportText(observed_behavior, expected_behavior, steps_to_reproduce);
  const submittedAt = new Date().toISOString();
  const db          = await getDb();
  const reports     = db.collection('reports');

  // ------------------------------------------------------------------
  // 2. Resubmission-loop bookkeeping
  // ------------------------------------------------------------------
  const priorAttempts = await getThreadAttempts(reports, incomingThreadId);

  if (incomingThreadId && priorAttempts.length === 0) {
    // Client sent a thread_id that doesn't match anything on record.
    return res.status(404).json({
      error: 'thread_id does not match any existing report thread.',
    });
  }

  if (priorAttempts.some(a => a.passed === true)) {
    return res.status(409).json({
      error:     'This report thread has already passed and cannot be resubmitted.',
      thread_id: incomingThreadId,
    });
  }

  if (priorAttempts.some(a => a.escalated === true)) {
    return res.status(409).json({
      error:     `This report thread was escalated to a Manager after ${MAX_ATTEMPTS} failed attempts and can no longer be resubmitted here.`,
      thread_id: incomingThreadId,
    });
  }

  const attemptNumber = priorAttempts.length + 1;
  // docId generated up front so it can double as the thread_id on a first
  // submission, without a second write to set it after insertion.
  const docId    = new ObjectId();
  const threadId = incomingThreadId || docId.toString();

  // ------------------------------------------------------------------
  // 3. Component 1 — structure gate
  // ------------------------------------------------------------------
  let c1;
  try {
    c1 = await classifyReport(reportText);
  } catch (err) {
    console.error('[C1 error]', err.message);
    return res.status(502).json({
      error:  'Component 1 (structure classifier) is currently unavailable.',
      detail: err.message,
    });
  }

  // ------------------------------------------------------------------
  // 4. Gate: structurally incomplete — persist as a failed attempt + return 400
  // ------------------------------------------------------------------
  if (!c1.complete) {
    const escalated = attemptNumber >= MAX_ATTEMPTS;

    await reports.insertOne({
      _id:                docId,
      thread_id:          threadId,
      attempt_number:     attemptNumber,
      submitted_at:        submittedAt,
      observed_behavior:  observed_behavior.trim(),
      expected_behavior:  expected_behavior.trim(),
      steps_to_reproduce: steps_to_reproduce.trim(),
      report_text:        reportText,
      status:             'rejected_incomplete',
      missing_sections:   c1.missingSections,
      passed:             false,
      escalated,
    });

    return res.status(400).json({
      status:           'rejected_incomplete',
      report_id:        docId.toString(),
      thread_id:        threadId,
      attempt_number:    attemptNumber,
      attempts_remaining: escalated ? 0 : MAX_ATTEMPTS - attemptNumber,
      escalated,
      message:          escalated
        ? `Report is missing required sections: ${c1.missingSectionsReadable.join(', ')}. This was attempt ${attemptNumber} of ${MAX_ATTEMPTS} — the report has been escalated to a Manager and can no longer be resubmitted.`
        : `Report is missing required sections: ${c1.missingSectionsReadable.join(', ')}.`,
      missing_sections: c1.missingSections,
    });
  }

  // ------------------------------------------------------------------
  // 5. Component 2 — content scoring
  // ------------------------------------------------------------------
  const c1Context = reshapeForContext(c1.sentences);

  let c2;
  try {
    c2 = await scoreReport(reportText, c1Context);
  } catch (err) {
    console.error('[C2 error]', err.message);
    return res.status(502).json({
      error:  'Component 2 (content scorer) is currently unavailable.',
      detail: err.message,
    });
  }

  const passed    = c2.passed ?? false;
  const escalated = !passed && attemptNumber >= MAX_ATTEMPTS;

  await reports.insertOne({
    _id:                docId,
    thread_id:          threadId,
    attempt_number:     attemptNumber,
    submitted_at:       submittedAt,
    observed_behavior:  observed_behavior.trim(),
    expected_behavior:  expected_behavior.trim(),
    steps_to_reproduce: steps_to_reproduce.trim(),
    report_text:        reportText,
    status:             'scored',
    total_score:        c2.total_score        ?? null,
    passed,
    dimension_scores:   c2.dimension_scores   ?? {},
    recommendations:    c2.recommendations    ?? [],
    reasoning:          c2.reasoning          ?? null,
    deductions_applied: c2.deductions_applied ?? [],
    c2_parsed_ok:       c2.parsed_ok          ?? false,
    c2_error:           c2.error              ?? null,
    escalated,
  });

  const response = {
    status:             'scored',
    report_id:          docId.toString(),
    thread_id:          threadId,
    attempt_number:     attemptNumber,
    attempts_remaining: passed ? null : (escalated ? 0 : MAX_ATTEMPTS - attemptNumber),
    escalated,
    total_score:        c2.total_score,
    passed,
    dimension_scores:   c2.dimension_scores,
    recommendations:    c2.recommendations,
    reasoning:          c2.reasoning,
    deductions_applied: c2.deductions_applied,
    parsed_ok:          c2.parsed_ok,
  };

  if (!c2.parsed_ok && c2.error) {
    response.scoring_warning = c2.error;
  }

  if (escalated) {
    response.message = `This was attempt ${attemptNumber} of ${MAX_ATTEMPTS} and did not pass. The report has been escalated to a Manager and can no longer be resubmitted.`;
  }

  return res.status(200).json(response);
});

module.exports = router;