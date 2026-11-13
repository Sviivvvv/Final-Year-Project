/**
 * routes/reports.js
 *
 * QA Tester
 *   POST /reports                    submit -> gate -> score -> feedback, with the
 *                                    resubmission loop (3 attempts per thread)
 *   GET  /reports/threads            own report history (sidebar)
 *   GET  /reports/threads/:threadId  every attempt in one thread
 *   POST /reports/:id/feedback       rate whether the feedback was helpful
 *
 * Manager / Admin
 *   GET  /reports/threads            all threads (?filter=escalated_open|escalated_reviewed|all, ?q=)
 *   GET  /reports/threads/:threadId
 *   POST /reports/threads/:threadId/review   close out an escalated thread
 *   GET  /reports/escalated          flat list of escalated attempts (Mid-Point endpoint, kept)
 *
 * Everyone
 *   GET  /reports/analytics          aggregated stats (QA: own data; Manager/Admin: all)
 *   GET  /reports/:id                one stored attempt
 *
 * Resubmission model:
 *   - Each attempt is its own document linked by `thread_id`, preserving the
 *     full history rather than updating in place.
 *   - A structural rejection or a scored-but-failed report counts as a failed
 *     attempt. The 3rd failure marks the document `escalated: true`.
 *   - A thread that passed, or was escalated, cannot be resubmitted.
 *   - Concurrency: an in-process lock rejects a second request for the same
 *     thread while one is being scored, and a unique (thread_id,
 *     attempt_number) index rejects any duplicate that slips past (e.g. a
 *     second server process).
 */

const express      = require('express');
const { ObjectId } = require('mongodb');
const router       = express.Router();

const { getDb }                             = require('../db');
const { classifyReport, reshapeForContext } = require('../services/component1');
const { scoreReport }                       = require('../services/component2');
const { computeAnalytics, summarizeThreads, threadOutcome } = require('../services/analytics');
const { requireRole }                       = require('../middleware/auth');

const MAX_ATTEMPTS = 3;
const REVIEW_DECISIONS = ['accepted', 'needs_rework'];

// Threads currently being scored (in-process guard against double submit).
const inFlight = new Set();

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildReportText(ob, eb, s2r) {
  return `OB: ${ob.trim()}\nEB: ${eb.trim()}\nS2R: ${s2r.trim()}`;
}

async function getThreadAttempts(reports, threadId) {
  if (!threadId) return [];
  return reports.find({ thread_id: threadId }).sort({ attempt_number: 1 }).toArray();
}

/** Stored document -> API shape (_id renamed to report_id). */
function publicDoc(doc) {
  const { _id, ...rest } = doc;
  return { report_id: _id.toString(), ...rest };
}

const isStaff = (req) => req.user.role === 'manager' || req.user.role === 'admin';

/** QA may only see their own threads; staff see everything. */
function canView(req, attempts) {
  if (isStaff(req)) return true;
  return attempts.length > 0 && attempts[0].user_email === req.user.email;
}

function sinceFromDays(raw) {
  const days = parseInt(raw, 10);
  if (!Number.isFinite(days) || days <= 0) return { days: null, since: null };
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return { days, since: d.toISOString() };
}

// ---------------------------------------------------------------------------
// GET /reports/analytics
// ---------------------------------------------------------------------------

router.get('/analytics', requireRole(['qa', 'manager', 'admin']), wrap(async (req, res) => {
  const { days, since } = sinceFromDays(req.query.days);
  const query = {};
  if (since) query.submitted_at = { $gte: since };
  if (!isStaff(req)) query.user_email = req.user.email;

  const db      = await getDb();
  const reports = db.collection('reports');
  const docs    = await reports.find(query).toArray();
  const result  = computeAnalytics(docs, { days, withReporters: isStaff(req) });

  // Same-length window just before this one, so the UI can say "up 4 points".
  let previous = null;
  if (days && since) {
    const prevSince = new Date(new Date(since).getTime() - days * 86400000).toISOString();
    const prevQuery = { submitted_at: { $gte: prevSince, $lt: since } };
    if (!isStaff(req)) prevQuery.user_email = req.user.email;
    const prevDocs = await reports.find(prevQuery).toArray();
    if (prevDocs.length) {
      const t = computeAnalytics(prevDocs).totals;
      previous = { avg_score: t.avg_score, pass_rate: t.pass_rate, threads: t.threads };
    }
  }

  return res.status(200).json({ scope: isStaff(req) ? 'all' : 'mine', days, previous, ...result });
}));

// ---------------------------------------------------------------------------
// GET /reports/threads
// ---------------------------------------------------------------------------

router.get('/threads', requireRole(['qa', 'manager', 'admin']), wrap(async (req, res) => {
  const db      = await getDb();
  const reports = db.collection('reports');

  const query = {};
  if (!isStaff(req)) query.user_email = req.user.email;

  const docs = await reports
    .find(query)
    .project({ // keep the payload small: no recommendations / reasoning here
      thread_id: 1, attempt_number: 1, user_email: 1, observed_behavior: 1,
      status: 1, total_score: 1, passed: 1, escalated: 1, submitted_at: 1, manager_review: 1,
      'recommendations.issue': 1,
    })
    .toArray();

  let threads = summarizeThreads(docs);

  const counts = {
    all:                threads.length,
    escalated_open:     threads.filter(t => t.outcome === 'escalated' && !t.review).length,
    escalated_reviewed: threads.filter(t => t.outcome === 'escalated' && t.review).length,
  };

  const filter = String(req.query.filter ?? 'all');
  if (filter === 'escalated_open')     threads = threads.filter(t => t.outcome === 'escalated' && !t.review);
  if (filter === 'escalated_reviewed') threads = threads.filter(t => t.outcome === 'escalated' && t.review);

  const q = String(req.query.q ?? '').trim().toLowerCase();
  if (q) threads = threads.filter(t => t.title.toLowerCase().includes(q) || (t.user_email ?? '').includes(q));

  // Click-through from Insights: one problem type, or one reporter.
  const tag = String(req.query.tag ?? '').trim();
  if (tag) threads = threads.filter(t => t.all_tags.includes(tag));
  const user = String(req.query.user ?? '').trim().toLowerCase();
  if (user) threads = threads.filter(t => (t.user_email ?? 'unknown').toLowerCase() === user);

  return res.status(200).json({ counts, threads: threads.slice(0, 300) });
}));

// ---------------------------------------------------------------------------
// GET /reports/threads/:threadId
// ---------------------------------------------------------------------------

router.get('/threads/:threadId', requireRole(['qa', 'manager', 'admin']), wrap(async (req, res) => {
  const db       = await getDb();
  const attempts = await getThreadAttempts(db.collection('reports'), req.params.threadId);

  if (attempts.length === 0 || !canView(req, attempts)) {
    return res.status(404).json({ error: 'Report thread not found.' });
  }

  return res.status(200).json({
    thread_id:    req.params.threadId,
    user_email:   attempts[0].user_email ?? null,
    outcome:      threadOutcome(attempts),
    max_attempts: MAX_ATTEMPTS,
    review:       attempts.find(a => a.escalated)?.manager_review ?? null,
    attempts:     attempts.map(publicDoc),
  });
}));

// ---------------------------------------------------------------------------
// POST /reports/threads/:threadId/review — Manager / Admin closes an escalation
// ---------------------------------------------------------------------------

router.post('/threads/:threadId/review', requireRole(['manager', 'admin']), wrap(async (req, res) => {
  const { decision, note } = req.body ?? {};
  if (!REVIEW_DECISIONS.includes(decision)) {
    return res.status(400).json({ error: `decision must be one of: ${REVIEW_DECISIONS.join(', ')}.` });
  }
  const cleanNote = String(note ?? '').trim().slice(0, 1000);
  if (decision === 'needs_rework' && !cleanNote) {
    return res.status(400).json({ error: 'A note is required when sending a report back for rework.' });
  }

  const db       = await getDb();
  const reports  = db.collection('reports');
  const attempts = await getThreadAttempts(reports, req.params.threadId);
  const escDoc   = attempts.find(a => a.escalated === true);

  if (!escDoc) {
    return res.status(404).json({ error: 'No escalated report found for this thread.' });
  }

  const review = {
    decision,
    note:        cleanNote,
    reviewer:    req.user.email,
    reviewed_at: new Date().toISOString(),
  };
  await reports.updateOne({ _id: escDoc._id }, { $set: { manager_review: review } });

  return res.status(200).json({ thread_id: req.params.threadId, review });
}));

// ---------------------------------------------------------------------------
// GET /reports/escalated — flat list (Mid-Point endpoint, still available)
// ---------------------------------------------------------------------------
// Registered before '/:id' so "escalated" is not parsed as an ObjectId.

router.get('/escalated', requireRole(['manager', 'admin']), wrap(async (req, res) => {
  const db      = await getDb();
  const reports = db.collection('reports');

  const escalatedDocs = await reports.find({ escalated: true }).sort({ submitted_at: -1 }).toArray();

  const list = escalatedDocs.map(doc => ({
    report_id:      doc._id.toString(),
    thread_id:      doc.thread_id,
    user_email:     doc.user_email ?? null,
    attempt_number: doc.attempt_number,
    status:         doc.status,
    total_score:    doc.total_score ?? null,
    submitted_at:   doc.submitted_at,
    excerpt:        doc.observed_behavior?.slice(0, 120) ?? '',
    review:         doc.manager_review ?? null,
  }));

  return res.status(200).json({ count: list.length, escalated_reports: list });
}));

// ---------------------------------------------------------------------------
// GET /reports/:id
// ---------------------------------------------------------------------------

router.get('/:id', requireRole(['qa', 'manager', 'admin']), wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid report ID format.' });
  }

  const db  = await getDb();
  const doc = await db.collection('reports').findOne({ _id: new ObjectId(req.params.id) });

  if (!doc || !canView(req, [doc])) {
    return res.status(404).json({ error: 'Report not found.' });
  }
  return res.status(200).json(publicDoc(doc));
}));

// ---------------------------------------------------------------------------
// POST /reports/:id/feedback — "was this feedback helpful?"
// ---------------------------------------------------------------------------

router.post('/:id/feedback', requireRole('qa'), wrap(async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ error: 'Invalid report ID format.' });
  }
  const { helpful, comment } = req.body ?? {};
  if (typeof helpful !== 'boolean') {
    return res.status(400).json({ error: 'helpful (boolean) is required.' });
  }

  const db      = await getDb();
  const reports = db.collection('reports');
  const doc     = await reports.findOne({ _id: new ObjectId(req.params.id) });

  if (!doc || doc.user_email !== req.user.email) {
    return res.status(404).json({ error: 'Report not found.' });
  }

  const user_feedback = {
    helpful,
    comment:  String(comment ?? '').trim().slice(0, 500),
    rated_at: new Date().toISOString(),
  };
  await reports.updateOne({ _id: doc._id }, { $set: { user_feedback } });
  return res.status(200).json({ report_id: req.params.id, user_feedback });
}));

// ---------------------------------------------------------------------------
// POST /reports — submit -> gate -> score -> feedback (+ resubmission loop)
// ---------------------------------------------------------------------------

router.post('/', requireRole('qa'), wrap(async (req, res) => {
  const {
    observed_behavior,
    expected_behavior,
    steps_to_reproduce,
    thread_id: incomingThreadId,
  } = req.body ?? {};

  // 1. Input validation ------------------------------------------------------
  const missingFields = [];
  if (!observed_behavior?.trim())  missingFields.push('observed_behavior');
  if (!expected_behavior?.trim())  missingFields.push('expected_behavior');
  if (!steps_to_reproduce?.trim()) missingFields.push('steps_to_reproduce');

  if (missingFields.length > 0) {
    return res.status(400).json({ error: 'Missing required fields.', missing_fields: missingFields });
  }

  const reportText  = buildReportText(observed_behavior, expected_behavior, steps_to_reproduce);
  const submittedAt = new Date().toISOString();
  const db          = await getDb();
  const reports     = db.collection('reports');

  // 2. Resubmission bookkeeping ------------------------------------------------
  const priorAttempts = await getThreadAttempts(reports, incomingThreadId);

  // A thread belonging to someone else is reported as "not found" so thread
  // ids do not leak between reporters.
  if (incomingThreadId && (priorAttempts.length === 0 || !canView(req, priorAttempts))) {
    return res.status(404).json({ error: 'thread_id does not match any existing report thread.' });
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
  const docId    = new ObjectId();
  const threadId = incomingThreadId || docId.toString();

  if (inFlight.has(threadId)) {
    return res.status(409).json({
      error:     'This report is already being assessed. Wait for the current result before resubmitting.',
      thread_id: threadId,
    });
  }
  inFlight.add(threadId);

  try {
    const base = {
      _id:                docId,
      thread_id:          threadId,
      user_email:         req.user.email,
      attempt_number:     attemptNumber,
      submitted_at:       submittedAt,
      observed_behavior:  observed_behavior.trim(),
      expected_behavior:  expected_behavior.trim(),
      steps_to_reproduce: steps_to_reproduce.trim(),
      report_text:        reportText,
    };

    const insertAttempt = async (doc) => {
      try {
        await reports.insertOne(doc);
        return true;
      } catch (err) {
        if (err.code === 11000) {
          res.status(409).json({
            error:     'Another submission for this report was processed at the same time. Reload the thread and try again.',
            thread_id: threadId,
          });
          return false;
        }
        throw err;
      }
    };

    // 3. Component 1 — structure gate ---------------------------------------
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

    // 4. Gate: structurally incomplete --------------------------------------
    if (!c1.complete) {
      const escalated = attemptNumber >= MAX_ATTEMPTS;

      const ok = await insertAttempt({
        ...base,
        status:           'rejected_incomplete',
        missing_sections: c1.missingSections,
        passed:           false,
        escalated,
      });
      if (!ok) return;

      return res.status(400).json({
        status:             'rejected_incomplete',
        report_id:          docId.toString(),
        thread_id:          threadId,
        attempt_number:     attemptNumber,
        attempts_remaining: escalated ? 0 : MAX_ATTEMPTS - attemptNumber,
        escalated,
        message:            escalated
          ? `Report is missing required sections: ${c1.missingSectionsReadable.join(', ')}. This was attempt ${attemptNumber} of ${MAX_ATTEMPTS} — the report has been escalated to a Manager and can no longer be resubmitted.`
          : `Report is missing required sections: ${c1.missingSectionsReadable.join(', ')}.`,
        missing_sections:   c1.missingSections,
      });
    }

    // 5. Component 2 — content scoring ----------------------------------------
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

    const ok = await insertAttempt({
      ...base,
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
    if (!ok) return;

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

    if (!c2.parsed_ok && c2.error) response.scoring_warning = c2.error;
    if (escalated) {
      response.message = `This was attempt ${attemptNumber} of ${MAX_ATTEMPTS} and did not pass. The report has been escalated to a Manager and can no longer be resubmitted.`;
    }

    return res.status(200).json(response);
  } finally {
    inFlight.delete(threadId);
  }
}));

module.exports = router;
