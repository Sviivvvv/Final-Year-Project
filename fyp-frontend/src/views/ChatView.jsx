import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, PlusCircle, CheckCircle2, ShieldAlert, Sparkles } from 'lucide-react';
import { useApp } from '../lib/app-context.js';
import { EMPTY_FIELDS, EXAMPLES, MAX_ATTEMPTS, displayName } from '../lib/format.js';
import Composer from '../components/Composer.jsx';
import { Transcript, UserBubble, ThinkingMessage, ReviewNote, BotAvatar } from '../components/Messages.jsx';

const fieldsOf = (a) => ({
  observed_behavior:  a?.observed_behavior ?? '',
  expected_behavior:  a?.expected_behavior ?? '',
  steps_to_reproduce: a?.steps_to_reproduce ?? '',
});

/**
 * QA workspace. One conversation = one bug report thread: each attempt is your
 * report followed by the assistant's assessment, and the revise box sits at the
 * bottom until the report passes or the 3 attempts are used.
 */
export default function ChatView({ threadId }) {
  const { api, auth, navigate, refreshHistory } = useApp();

  const [thread, setThread]   = useState(null);     // { attempts, outcome, review }
  const [fields, setFields]   = useState(EMPTY_FIELDS);
  const [pending, setPending] = useState(null);     // attempt being assessed right now
  const [loadingThread, setLoadingThread] = useState(false);
  const [error, setError]     = useState(null);
  const [notFound, setNotFound] = useState(false);
  const skipLoadFor = useRef(null);
  const scrollerRef = useRef(null);

  const scrollToLastAttempt = useCallback(() => {
    requestAnimationFrame(() => {
      const el = document.querySelector('[data-last-attempt]');
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, []);

  const loadThread = useCallback(async (id) => {
    const res = await api(`/reports/threads/${id}`);
    if (res.status === 200) {
      setThread(res.data);
      setNotFound(false);
      return res.data;
    }
    setNotFound(true);
    setThread(null);
    return null;
  }, [api]);

  // Open / switch conversation.
  useEffect(() => {
    setError(null);
    setPending(null);
    if (!threadId) {
      setThread(null); setNotFound(false); setFields(EMPTY_FIELDS);
      return undefined;
    }
    if (skipLoadFor.current === threadId) { skipLoadFor.current = null; return undefined; }

    let cancelled = false;
    setLoadingThread(true);
    loadThread(threadId)
      .then(data => {
        if (cancelled || !data) return;
        setFields(fieldsOf(data.attempts[data.attempts.length - 1]));
        scrollToLastAttempt();
      })
      .catch(() => { if (!cancelled) setError('Could not load this report. Is the backend running?'); })
      .finally(() => { if (!cancelled) setLoadingThread(false); });
    return () => { cancelled = true; };
  }, [threadId, loadThread, scrollToLastAttempt]);

  const submit = async () => {
    const sent = { ...fields };
    setError(null);
    setPending({ ...sent, submitted_at: new Date().toISOString() });
    requestAnimationFrame(() => scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' }));

    try {
      const res = await api('/reports', { method: 'POST', body: { ...sent, ...(threadId ? { thread_id: threadId } : {}) } });
      const data = res.data ?? {};

      if (data.thread_id && (res.status === 200 || data.status === 'rejected_incomplete')) {
        skipLoadFor.current = data.thread_id;
        const full = await loadThread(data.thread_id);
        if (full) {
          // Keep the text they just sent; prefill the next revision with it.
          setFields(sent);
          if (!threadId) navigate(`t/${data.thread_id}`);
          refreshHistory();
          scrollToLastAttempt();
        }
      } else {
        if (res.status === 409 && threadId) await loadThread(threadId);
        setError(data.error ?? `Something went wrong (HTTP ${res.status}).`);
        if (data.detail) setError(`${data.error} ${data.detail}`);
      }
    } catch {
      setError('Could not reach the server. Make sure the backend is running.');
    } finally {
      setPending(null);
    }
  };

  const startNew = () => navigate('new');

  // ---------------------------------------------------------------- render
  const attempts = thread?.attempts ?? [];
  const last = attempts[attempts.length - 1];
  const outcome = thread?.outcome;
  const missing = last?.status === 'rejected_incomplete' ? (last.missing_sections ?? []) : [];
  const isNew = !threadId && !pending;

  if (notFound) {
    return (
      <div className="scroll"><div className="col">
        <div className="empty">
          <AlertTriangle size={34} aria-hidden="true" />
          <p>That report could not be found.</p>
          <button className="btn btn-primary" onClick={startNew}><PlusCircle size={16} aria-hidden="true" />New report</button>
        </div>
      </div></div>
    );
  }

  if (loadingThread && !thread) {
    return (
      <div className="scroll"><div className="col">
        <div className="skeleton" style={{ height: 120, marginBottom: 20 }} />
        <div className="skeleton" style={{ height: 300 }} />
      </div></div>
    );
  }

  return (
    <div className="scroll" ref={scrollerRef} id="chat-scroll">
      <div className="col">
        {isNew && (
          <div className="hero">
            <h2>Hey {displayName(auth.email).split(' ')[0]}, what bug are we reporting today?</h2>
            <p>Write it up in three parts. You get a score out of 100 and clear suggestions, before it reaches a developer.</p>
            <ol className="how-steps">
              <li><b>1</b>Write what happened, what should happen, and the steps</li>
              <li><b>2</b>See your score and what to fix</li>
              <li><b>3</b>Improve it and resend (up to {MAX_ATTEMPTS} tries)</li>
            </ol>
            <div className="examples">
              {EXAMPLES.map(ex => (
                <button key={ex.id} className="btn btn-sm btn-sky" onClick={() => setFields(ex.fields)}>
                  <Sparkles size={14} aria-hidden="true" />{ex.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {error && <div className="alert" style={{ marginBottom: 16 }} role="alert"><AlertTriangle size={16} aria-hidden="true" />{error}</div>}

        {attempts.length > 0 && <Transcript attempts={attempts} canRate />}
        {pending && (
          <>
            {attempts.length > 0 && <div className="attempt-label">Try {attempts.length + 1}</div>}
            <UserBubble attempt={pending} />
            <ThinkingMessage />
          </>
        )}

        {outcome === 'escalated' && thread?.review && <ReviewNote review={thread.review} />}

        {/* What comes next, depending on how the thread ended */}
        {!pending && outcome === 'passed' && (
          <div className="msg">
            <BotAvatar />
            <div className="bot-body">
              <div className="card" style={{ padding: 16 }}>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <CheckCircle2 size={22} style={{ color: 'var(--good)' }} aria-hidden="true" />
                  <b>This report passed.</b>
                  <span className="muted">It is ready for the development team.</span>
                  <span className="grow" />
                  <button className="btn btn-primary" onClick={startNew}><PlusCircle size={16} aria-hidden="true" />New report</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!pending && outcome === 'escalated' && (
          <div className="msg">
            <BotAvatar />
            <div className="bot-body">
              <div className="card" style={{ padding: 16 }}>
                <div className="row" style={{ flexWrap: 'wrap' }}>
                  <ShieldAlert size={22} style={{ color: 'var(--bad)' }} aria-hidden="true" />
                  <div className="grow">
                    <b>Sent to a manager</b>
                    <p className="muted" style={{ fontSize: 13.5 }}>
                      This report used all {MAX_ATTEMPTS} tries, so it can't be edited here any more.
                      {thread?.review ? '' : ' A manager will look at it and leave a note here.'}
                    </p>
                  </div>
                  <button className="btn" onClick={startNew}><PlusCircle size={16} aria-hidden="true" />New report</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {!pending && outcome !== 'passed' && outcome !== 'escalated' && (
          <Composer
            fields={fields} setFields={setFields} onSubmit={submit} loading={!!pending}
            missing={missing} autoFocus={isNew && window.innerWidth > 820}
            revise={attempts.length > 0}
            title={attempts.length > 0 ? 'Improve your report' : 'Write up the bug'}
            subtitle={attempts.length > 0 ? `Try ${attempts.length + 1} of ${MAX_ATTEMPTS}` : undefined}
            submitLabel={attempts.length > 0 ? 'Send again' : 'Get my score'}
          />
        )}
      </div>
    </div>
  );
}
