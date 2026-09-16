import React, { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ArrowDownRight,
  Plus,
  Search,
  SlidersHorizontal,
  Activity,
  FileCode2,
  PanelLeftClose,
  ChevronRight,
  Terminal,
  GitBranch,
  ExternalLink,
  X,
  Check,
  Upload,
  Copy,
  ShieldCheck,
  Eye,
  Pause,
  History,
  FlaskConical,
  AlertTriangle,
  RefreshCw,
  Inbox,
} from 'lucide-react';
import type { Ledger, Rule, LogEvent } from '../src/schema';
import type { RuleMetrics } from '../src/metrics';
import './style.css';
type State = {
  ledger: Ledger;
  revision: string;
  metrics: RuleMetrics[];
  events: LogEvent[];
  budgets: any[];
  digest: string;
  backtest: any[];
  traces: number;
  synthetic: boolean;
  yaml: string;
  queue: (LogEvent & { review: string })[];
  prompt_savings: { path: string; before: number; after: number; saved_per_request: number }[];
};
const number = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(n);
const pct = (n: number | null | undefined) => (n == null ? '—' : `${Math.round(n * 100)}%`);
async function request(path: string, method = 'GET', data?: unknown) {
  const res = await fetch('/api/' + path, {
    method,
    ...(data !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }
      : {}),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? 'Request failed');
  return body;
}
export default function RuleWorkbench() {
  const [state, setState] = useState<State | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [view, setView] = useState('ledger'),
    [search, setSearch] = useState(''),
    [filter, setFilter] = useState('all'),
    [selected, setSelected] = useState<string | null>(null),
    [modal, setModal] = useState<'add' | 'import' | null>(null),
    [text, setText] = useState(''),
    [editor, setEditor] = useState(''),
    [toast, setToast] = useState('');
  async function refresh() {
    try {
      setState(await request('state'));
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    function close(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setModal(null);
        setSelected(null);
      }
    }
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 3500);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  async function mutate(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await fn();
      await refresh();
      setToast(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  function selectRule(r: Rule) {
    setSelected(r.id);
    setEditor(
      JSON.stringify(
        {
          condition: r.condition,
          actions: r.actions,
          rollout: r.rollout,
          priority: r.priority,
          owner: r.owner,
          notes: r.notes,
        },
        null,
        2,
      ),
    );
  }
  const rule = state?.ledger.rules.find((r) => r.id === selected);
  const metric = state?.metrics.find((m) => m.rule_id === selected);
  const rules =
    state?.ledger.rules.filter(
      (r) =>
        (filter === 'all' || r.status === filter) &&
        (r.name + ' ' + r.id + ' ' + r.description).toLowerCase().includes(search.toLowerCase()),
    ) ?? [];
  const totalFires = state?.metrics.reduce((s, m) => s + m.fires, 0) ?? 0,
    totalShadow = state?.metrics.reduce((s, m) => s + m.would_have_fired, 0) ?? 0;
  const active = state?.ledger.rules.filter((r) => r.status === 'active').length ?? 0;
  const titles: Record<string, string> = {
    queue: 'A decision needs you.',
    ledger: 'Your rules, reflected.',
    activity: 'Every intervention, explained.',
    discover: 'Start with what you already have.',
    digest: 'A reason to come back Monday.',
    yaml: 'Behavior, versioned like code.',
  };
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="Mirrors home">
          <span className="mark">
            <i />
            <i />
          </span>
          mirrors<span className="edition">LOCAL</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">A</span>
          <div>
            <strong>{state?.ledger.name ?? 'Your workspace'}</strong>
            <small>Local workspace</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="nav-caption">OPTIONAL RUNTIME RULES</div>
        <a className="nav-item" href="/">
          ← Fixes & release health
        </a>
        <nav>
          {[
            ['ledger', SlidersHorizontal, 'Rule ledger'],
            ['queue', ShieldCheck, 'Human review'],
            ['activity', Activity, 'Activity'],
            ['discover', FlaskConical, 'Discover'],
            ['digest', Inbox, 'Weekly digest'],
            ['yaml', FileCode2, 'mirrors.yaml'],
          ].map(([id, Icon, label]) => {
            const I = Icon as typeof Activity;
            return (
              <button
                key={id as string}
                className={view === id ? 'nav-item selected' : 'nav-item'}
                onClick={() => setView(id as string)}
              >
                <I size={17} />
                <span>{label as string}</span>
                {id === 'ledger' ? (
                  <span className="nav-count">{state?.ledger.rules.length ?? 0}</span>
                ) : null}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="live-dot" />
            <div>
              Local by default.<small>Ledger and traces on your machine.</small>
            </div>
          </div>
          <div className="sidebar-footer">
            <GitBranch size={14} />
            <span>Open source · v0.2</span>
            <span className="mono">MIT</span>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <div>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>
              {view === 'ledger'
                ? 'Rule ledger'
                : view === 'yaml'
                  ? 'mirrors.yaml'
                  : view[0].toUpperCase() + view.slice(1)}
            </strong>
          </div>
          <div className="topbar-right">
            <span className="connection">
              <span className="live-dot" /> Local connection
            </span>
            <button
              className="icon-button"
              aria-label="Refresh ledger"
              onClick={() => void refresh()}
            >
              <RefreshCw size={15} />
            </button>
            <span className="avatar">M</span>
          </div>
        </header>
        <section className="page">
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                THE BEHAVIOR LEDGER <span>/</span> {view.toUpperCase()}
              </div>
              <h1>{titles[view]}</h1>
              <p>See when a rule matters. Measure what it changes. Keep what works.</p>
            </div>
            <button
              className="primary"
              onClick={() => {
                setText('');
                setModal('add');
              }}
            >
              <Plus size={16} /> Add a rule
            </button>
          </div>
          {state?.synthetic ? (
            <div className="demo-banner">
              <FlaskConical size={15} />
              <strong>Demo workspace</strong>
              <span>
                All activity and comparisons below are synthetic. Your real agents are unchanged.
              </span>
            </div>
          ) : null}
          {error ? (
            <div role="alert" className="error-banner">
              <AlertTriangle size={17} />
              {error}
              <button onClick={() => setError('')} aria-label="Dismiss error">
                <X size={15} />
              </button>
            </div>
          ) : null}
          {!state && !error ? <div className="empty">Opening your ledger…</div> : null}
          {state && view === 'ledger' ? (
            <>
              <div className="stats">
                <Stat
                  label="RULES IN YOUR LEDGER"
                  value={String(state.ledger.rules.length)}
                  foot={`${active} active · ${state.ledger.rules.filter((r) => r.status === 'shadow').length} observing`}
                  icon={<SlidersHorizontal size={16} />}
                />
                <Stat
                  label="INTERVENTIONS"
                  value={number(totalFires)}
                  foot="Changes made in the last 30 days"
                  icon={<Activity size={16} />}
                />
                <Stat
                  label="SHADOW MATCHES"
                  value={number(totalShadow)}
                  foot="Observed without changing behavior"
                  icon={<Eye size={16} />}
                />
                <Stat
                  label="RULES WITH MEASURED LIFT"
                  value={String(state.metrics.filter((m) => m.verdict === 'working').length)}
                  foot="Completed treatment vs. control runs"
                  icon={<ArrowDownRight size={16} />}
                />
              </div>
              <div className="ledger-card">
                <div className="table-toolbar">
                  <div className="tabs">
                    {['all', 'active', 'shadow', 'off', 'retired'].map((f) => (
                      <button
                        key={f}
                        onClick={() => setFilter(f)}
                        className={filter === f ? 'active' : ''}
                      >
                        {f === 'all' ? 'All rules' : f[0].toUpperCase() + f.slice(1)}
                        {f === 'all' ? <span>{state.ledger.rules.length}</span> : null}
                      </button>
                    ))}
                  </div>
                  <label className="search">
                    <Search size={15} />
                    <input
                      aria-label="Search rules"
                      placeholder="Find a rule…"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                    <kbd>/</kbd>
                  </label>
                </div>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>RULE / CONDITION</th>
                        <th>STATUS</th>
                        <th>FIRES</th>
                        <th>
                          RECURRENCE <small>PER 1K RUNS</small>
                        </th>
                        <th>VERDICT</th>
                        <th aria-label="Open rule" />
                      </tr>
                    </thead>
                    <tbody>
                      {rules.map((r) => {
                        const m = state.metrics.find((m) => m.rule_id === r.id)!;
                        return (
                          <tr key={r.id}>
                            <td>
                              <button className="rule-link" onClick={() => selectRule(r)}>
                                <span className={'rule-dot ' + r.status} />
                                <strong>{r.name}</strong>
                              </button>
                              <div className="rule-sub">
                                <code>
                                  {r.condition.type === 'code'
                                    ? summarize(r.condition.when)
                                    : 'judgment · ' + pct(r.condition.confidence) + ' confidence'}
                                </code>
                              </div>
                            </td>
                            <td>
                              <select
                                aria-label={`Status for ${r.name}`}
                                className={'status-select ' + r.status}
                                disabled={busy}
                                value={r.status}
                                onChange={(e) =>
                                  void mutate(
                                    () =>
                                      request('rules/' + r.id, 'PATCH', {
                                        revision: state.revision,
                                        patch: { status: e.target.value },
                                      }),
                                    'Rule status saved to mirrors.yaml',
                                  )
                                }
                              >
                                {['off', 'shadow', 'active', 'retired'].map((s) => (
                                  <option key={s} value={s}>
                                    {s}
                                  </option>
                                ))}
                              </select>
                              {r.status === 'active' ? (
                                <small className="rollout">{r.rollout}% rollout</small>
                              ) : null}
                            </td>
                            <td>
                              <strong className="mono count">{number(m.fires)}</strong>
                              <small className="subcount">
                                {number(m.would_have_fired)} shadow
                              </small>
                            </td>
                            <td>
                              {m.treatment_per_1k !== null && m.control_per_1k !== null ? (
                                <div className="comparison">
                                  <span>{number(m.control_per_1k)}</span>
                                  <span className="arrow">→</span>
                                  <strong
                                    className={m.lift !== null && m.lift > 0 ? 'positive' : ''}
                                  >
                                    {number(m.treatment_per_1k)}
                                  </strong>
                                  <small>control → treatment</small>
                                </div>
                              ) : (
                                <>
                                  <span className="muted">—</span>
                                  <small className="subcount">Awaiting outcomes</small>
                                </>
                              )}
                            </td>
                            <td>
                              <span className={'verdict ' + m.verdict.replace(' ', '-')}>
                                {m.verdict === 'working' ? (
                                  <Check size={12} />
                                ) : m.verdict === 'cannot assess' ? (
                                  <span className="tiny-ring" />
                                ) : null}
                                {m.verdict}
                              </span>
                            </td>
                            <td>
                              <button
                                className="icon-button"
                                aria-label={`Open ${r.name}`}
                                onClick={() => selectRule(r)}
                              >
                                <ArrowUpRight size={17} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {!rules.length ? (
                    <div className="empty">
                      <SlidersHorizontal size={28} />
                      <h3>{search ? 'No matching rules' : 'Your ledger starts here'}</h3>
                      <p>
                        Import a prompt or add your first rule. Every new rule starts in shadow.
                      </p>
                      <button className="secondary" onClick={() => setView('discover')}>
                        Discover rules <ArrowUpRight size={14} />
                      </button>
                    </div>
                  ) : null}
                </div>
                <div className="table-footer">
                  <span>
                    <ShieldCheck size={13} /> New rules start in shadow. You decide when they act.
                  </span>
                  <span>Last 30 days · {state.traces} imported traces</span>
                </div>
              </div>
              <div className="below-grid">
                <section className="activity-preview">
                  <div className="section-heading">
                    <h2>In the mirror</h2>
                    <button onClick={() => setView('activity')}>
                      View activity <ArrowUpRight size={14} />
                    </button>
                  </div>
                  {state.events
                    .filter((e) => e.type === 'evaluation')
                    .slice(0, 3)
                    .map((e) => (
                      <div className="mini-event" key={e.id}>
                        <span className={'event-symbol ' + e.outcome}>
                          {e.outcome === 'fire' ? <Check size={13} /> : <Eye size={13} />}
                        </span>
                        <div>
                          <strong>{e.rule_id}</strong>
                          <p>{e.reason}</p>
                        </div>
                        <span className="mono muted">step {e.step}</span>
                      </div>
                    ))}
                  {!state.events.length ? (
                    <p className="muted">Connect a runtime to see the first event here.</p>
                  ) : null}
                </section>
                <section className="principle-card">
                  <div className="mini-eyebrow">LESS PROMPT. MORE PROOF.</div>
                  <h2>
                    A rule should earn
                    <br />
                    its place.
                  </h2>
                  <p>
                    Start silent. Watch it fire. Compare the outcomes. Retire it when the model no
                    longer needs the reminder.
                  </p>
                  <button onClick={() => setView('discover')}>
                    Inspect your existing prompt <ArrowUpRight size={15} />
                  </button>
                </section>
              </div>
            </>
          ) : null}
          {state && view === 'queue' ? (
            <section className="content-card">
              <h2>Human review queue</h2>
              <p className="muted">
                These tool calls were blocked. Your decision is recorded here; the host agent
                controls resumption.
              </p>
              {state.queue.map((e) => (
                <div className="full-event" key={e.id}>
                  <strong>{e.rule_id}</strong>
                  <p>{e.reason}</p>
                  <small className="mono muted">
                    {e.session_id} · step {e.step} · {e.review}
                  </small>
                  {e.review === 'pending' ? (
                    <div className="label-actions">
                      {['approved', 'denied'].map((decision) => (
                        <button
                          disabled={busy}
                          key={decision}
                          onClick={() =>
                            void mutate(
                              () => request('reviews', 'POST', { target_id: e.id, decision }),
                              'Review recorded',
                            )
                          }
                        >
                          {decision === 'approved' ? 'Approve' : 'Deny'}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {!state.queue.length ? (
                <div className="empty">No calls waiting for review.</div>
              ) : null}
            </section>
          ) : null}
          {state && view === 'activity' ? (
            <section className="content-card">
              <div className="section-heading">
                <h2>Recent decisions & changes</h2>
                <span className="muted">Latest 100 events</span>
              </div>
              {state.events.map((e) => (
                <div className="full-event" key={e.id}>
                  <div>
                    <span className="event-tag">{e.outcome ?? e.type}</span>
                    <code>{e.rule_id ?? 'ledger'}</code>
                    <time>{new Date(e.timestamp).toLocaleString()}</time>
                  </div>
                  <p>{e.reason ?? JSON.stringify(e.data ?? { label: e.label })}</p>
                  {e.session_id ? (
                    <small className="mono muted">
                      {e.session_id} · step {e.step}
                    </small>
                  ) : null}
                  {e.outcome === 'fire' ? (
                    <div className="label-actions">
                      <span>Was this useful?</span>
                      {['correct', 'incorrect', 'override'].map((label) => (
                        <button
                          disabled={busy}
                          key={label}
                          onClick={() =>
                            void mutate(
                              () => request('labels', 'POST', { target_id: e.id, label }),
                              'Feedback saved',
                            )
                          }
                        >
                          {label === 'correct'
                            ? 'Yes'
                            : label === 'incorrect'
                              ? 'No'
                              : 'I overrode it'}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
              {!state.events.length ? (
                <div className="empty">
                  No activity yet. Connect a runtime or import traces for a backtest.
                </div>
              ) : null}
            </section>
          ) : null}
          {state && view === 'discover' ? (
            <>
              <div className="discover-grid">
                <section className="content-card">
                  <div className="square-icon">
                    <FileCode2 />
                  </div>
                  <h2>Your prompt already has a ledger.</h2>
                  <p>
                    Find conditional instructions and move them into reviewable, silent rules.
                    Nothing in your prompt changes automatically.
                  </p>
                  <button
                    className="primary"
                    onClick={() => {
                      setText('');
                      setModal('import');
                    }}
                  >
                    <Plus size={15} /> Import prompt
                  </button>
                </section>
                <section className="content-card">
                  <div className="square-icon">
                    <Upload />
                  </div>
                  <h2>Bring the evidence.</h2>
                  <p>
                    Import JSON or JSONL sessions and tool spans. Backtests show where a condition
                    applies; live cohorts establish lift.
                  </p>
                  <label className="secondary file-button">
                    <Upload size={15} /> Import trace file
                    <input
                      type="file"
                      accept=".json,.jsonl"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        if (!file) return;
                        await mutate(async () => {
                          const text = await file.text();
                          return request(
                            'import/traces',
                            'POST',
                            file.name.endsWith('.jsonl')
                              ? text
                                  .split('\n')
                                  .filter(Boolean)
                                  .map((l) => JSON.parse(l))
                              : JSON.parse(text),
                          );
                        }, 'Traces imported');
                        e.target.value = '';
                      }}
                    />
                  </label>
                </section>
              </div>
              <section className="content-card">
                <div className="section-heading">
                  <h2>Historical backtest</h2>
                  <span className="muted">{state.traces} traces · last 30 days</span>
                </div>
                <p className="muted">
                  Retrospective matches are opportunities for intervention. They are not measured
                  fixes.
                </p>
                {state.backtest.map((b) => (
                  <div className="backtest-row" key={b.rule_id}>
                    <strong>{b.rule_id}</strong>
                    <span>{b.occurrences} matches</span>
                    <span className="muted">{b.reason}</span>
                  </div>
                ))}
              </section>
            </>
          ) : null}
          {state && view === 'digest' ? (
            <section className="content-card digest">
              <div className="mini-eyebrow">YOUR MONDAY CHECK-IN</div>
              <h2>Five lines. A clearer agent.</h2>
              <pre>{state.digest}</pre>
              <button
                className="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(state.digest)
                    .then(() => setToast('Digest copied'))
                }
              >
                <Copy size={15} /> Copy digest
              </button>
              <p className="muted">
                Run <code>mirrors rule-digest</code> from your scheduler. Delivery is opt-in.
              </p>
              {state.budgets.length ? (
                <div className="error-banner">
                  {state.budgets.length} behavior budget(s) exceeded their recurrence ceiling.
                </div>
              ) : null}
            </section>
          ) : null}
          {state && view === 'yaml' ? (
            <section className="content-card">
              <div className="section-heading">
                <h2>mirrors.yaml</h2>
                <button
                  className="secondary"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(state.yaml)
                      .then(() => setToast('Ledger copied'))
                  }
                >
                  <Copy size={14} /> Copy
                </button>
              </div>
              <p className="muted">
                This is the source of truth. Commit it with your code; roll back with a revert.
              </p>
              <pre className="yaml-preview">{state.yaml}</pre>
            </section>
          ) : null}
          <footer className="page-footer">
            <span className="mark tiny">
              <i />
              <i />
            </span>
            <span>Every rule has a reason. Now it has a record.</span>
            <span className="mono">mirrors.yaml</span>
          </footer>
        </section>
      </main>
      {rule && state ? (
        <div className="overlay" onClick={() => setSelected(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()} aria-label="Rule details">
            <div className="drawer-top">
              <span className="eyebrow">RULE DETAILS</span>
              <button
                className="icon-button"
                aria-label="Close rule"
                onClick={() => setSelected(null)}
              >
                <X size={20} />
              </button>
            </div>
            <code className="muted">{rule.id}</code>
            <h2>{rule.name}</h2>
            <p>{rule.description || 'A scoped behavioral instruction in your ledger.'}</p>
            <div className="detail-stats">
              <Stat
                label="PRECISION"
                value={pct(metric?.precision)}
                foot={`${metric?.labels ?? 0} human labels`}
              />
              <Stat
                label="P95 EVALUATION"
                value={metric?.p95_ms == null ? '—' : number(metric.p95_ms) + ' ms'}
                foot="Engine evaluation, excluding I/O"
              />
            </div>
            <div className="evidence-note">
              <strong>{metric?.verdict}</strong>
              <p>{metric?.explanation}</p>
              <small>
                {metric?.treatment_runs} treatment runs · {metric?.control_runs} control runs
              </small>
            </div>
            <label className="editor-label">
              Condition, actions & ownership
              <textarea
                spellCheck={false}
                className="code-editor"
                aria-label="Rule JSON"
                value={editor}
                onChange={(e) => setEditor(e.target.value)}
              />
            </label>
            <button
              className="primary wide"
              disabled={busy}
              onClick={() =>
                void mutate(
                  () =>
                    request('rules/' + rule.id, 'PATCH', {
                      revision: state.revision,
                      patch: JSON.parse(editor),
                    }),
                  'Rule changes saved',
                )
              }
            >
              Save to mirrors.yaml <Check size={15} />
            </button>
            <p className="muted small">
              Source: {rule.source.kind} · {rule.source.ref ?? 'Created locally'}
              <br />
              Model pin: {rule.pinned.model ?? 'Any model'}
            </p>
          </aside>
        </div>
      ) : null}
      {modal ? (
        <div className="overlay centered" onClick={() => setModal(null)}>
          <section
            role="dialog"
            aria-modal="true"
            aria-label={modal === 'add' ? 'Add a rule' : 'Import prompt'}
            className="modal"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close-modal icon-button"
              aria-label="Close dialog"
              onClick={() => setModal(null)}
            >
              <X size={20} />
            </button>
            <div className="eyebrow">START IN SHADOW</div>
            <h2>
              {modal === 'add'
                ? 'What should your agent do differently?'
                : 'Let’s find the rules in your prompt.'}
            </h2>
            <p>
              {modal === 'add'
                ? 'Describe the situation and the behavior you want. Mirrors drafts a condition for you to review.'
                : 'Paste your prompt. Conditional instructions become shadow candidates; your original prompt stays intact.'}
            </p>
            <textarea
              autoFocus
              aria-label={modal === 'add' ? 'Rule instruction' : 'System prompt'}
              placeholder={
                modal === 'add'
                  ? 'When the same tool call fails twice, check the error and change the input before retrying.'
                  : 'Paste your system prompt here…'
              }
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <div className="modal-footer">
              <span>
                <Eye size={14} /> No behavior changes
              </span>
              <button
                className="primary"
                disabled={busy || !text.trim()}
                onClick={() =>
                  void mutate(
                    async () => {
                      await request(modal === 'add' ? 'rules' : 'import/prompt', 'POST', { text });
                      setModal(null);
                    },
                    modal === 'add' ? 'Draft rule added in shadow' : 'Prompt imported in shadow',
                  )
                }
              >
                {modal === 'add' ? 'Draft rule' : 'Import candidates'} <ArrowUpRight size={15} />
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {toast ? (
        <div role="status" className="toast">
          <Check size={16} />
          {toast}
        </div>
      ) : null}
    </div>
  );
}
function Stat({
  label,
  value,
  foot,
  icon,
}: {
  label: string;
  value: string;
  foot: string;
  icon?: React.ReactNode;
}) {
  return (
    <div className="stat">
      <div className="stat-label">
        {label}
        {icon}
      </div>
      <strong className="stat-value">{value}</strong>
      <p>{foot}</p>
    </div>
  );
}
function summarize(p: any): string {
  if (p.all) return p.all.map(summarize).join(' && ');
  if (p.any) return '(' + p.any.map(summarize).join(' || ') + ')';
  if (p.not) return '!' + summarize(p.not);
  return (
    p.field +
    ' ' +
    (
      {
        eq: '=',
        ne: '≠',
        gte: '≥',
        gt: '>',
        lte: '≤',
        lt: '<',
        contains: 'contains',
        in: 'in',
        exists: 'exists',
      } as any
    )[p.op] +
    ' ' +
    (p.value === undefined ? '' : JSON.stringify(p.value))
  );
}
