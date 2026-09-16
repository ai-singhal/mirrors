import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Activity,
  ArrowUpRight,
  ArrowDownRight,
  Check,
  ChevronRight,
  Code2,
  Copy,
  FileCode2,
  FlaskConical,
  GitBranch,
  Inbox,
  Layers,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
  X,
  AlertTriangle,
  Play,
  Clock,
} from 'lucide-react';
import RuleWorkbench from './rules';
import './style.css';
import './observe.css';
const percent = (n: number | null | undefined) => (n == null ? '—' : (n * 100).toFixed(1) + '%');
const num = (n: number | null | undefined) => new Intl.NumberFormat().format(n ?? 0);
async function api(path: string, method = 'GET', body?: unknown) {
  const r = await fetch('/api/observe/' + path, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error ?? 'Request failed');
  return b;
}
function App() {
  const [state, setState] = useState<any>(null),
    [days, setDays] = useState(() => {
      const days = Number(new URLSearchParams(location.search).get('days'));
      return [7, 30, 365, 3650].includes(days) ? days : 30;
    }),
    [view, setView] = useState('overview'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [toast, setToast] = useState(''),
    [intent, setIntent] = useState('all'),
    [search, setSearch] = useState(''),
    [run, setRun] = useState<any>(null),
    [signal, setSignal] = useState<any>(null),
    [modal, setModal] = useState<'fix' | 'import' | 'prompt' | 'intent' | null>(null),
    [form, setForm] = useState<any>({}),
    [health, setHealth] = useState<any>(null),
    [synthetic, setSynthetic] = useState(false);
  async function refresh() {
    try {
      const data = await api('state?days=' + days);
      setState(data);
      setHealth(data.health);
      setError('');
    } catch (e) {
      setError(String(e));
    }
  }
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 30000);
    return () => clearInterval(timer);
  }, [days]);
  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then((s) => setSynthetic(!!s.synthetic))
      .catch(() => {});
    const close = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setModal(null);
        setRun(null);
        setSignal(null);
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, []);
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(''), 4000);
      return () => clearTimeout(timer);
    }
  }, [toast]);
  async function mutate(action: () => Promise<unknown>, message: string) {
    setBusy(true);
    try {
      await action();
      await refresh();
      setToast(message);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function showRun(id: string) {
    try {
      setRun(await api('runs/' + encodeURIComponent(id)));
      setSignal(null);
    } catch (e) {
      setError(String(e));
    }
  }
  function draft(signalId?: string) {
    setForm({
      name: '',
      target_signal_id: signalId ?? state?.signals[0]?.id,
      type: 'code',
      status: 'proposed',
      version_id: '',
      baseline_version: '',
      model: '',
      notes: '',
      source: '',
    });
    setModal('fix');
  }
  const titles: Record<string, string> = {
    overview: 'Know what broke. Prove what changed.',
    health: 'Every deploy has a before and after.',
    fixes: 'Give every fix a number.',
    runs: 'The evidence, one run at a time.',
    replay: 'Replay the failure. Keep the tools cached.',
    digest: 'Five lines. A clearer next step.',
  };
  const nav = [
    ['overview', Activity, 'Failure patterns'],
    ['health', GitBranch, 'Release health'],
    ['fixes', ShieldCheck, 'Fixes'],
    ['runs', Layers, 'Conversations'],
    ['replay', Play, 'Cheap replay'],
    ['digest', Inbox, 'Weekly digest'],
  ] as const;
  const intents = state ? ([...new Set(state.runs.map((r: any) => r.intent))] as string[]) : [];
  const ranked = (state?.signals ?? [])
    .map((s: any) => {
      const rows = intent === 'all' ? s.intents : s.intents.filter((i: any) => i.intent === intent);
      const affected = rows.reduce((n: number, r: any) => n + r.affected, 0),
        assessed = rows.reduce((n: number, r: any) => n + r.assessed, 0);
      return { ...s, affected, assessed, rate: assessed ? affected / assessed : null };
    })
    .sort((a: any, b: any) => b.affected - a.affected)
    .slice(0, 10);
  return (
    <div className="app">
      <aside className="sidebar">
        <a className="brand" href="/">
          <span className="mark">
            <i />
            <i />
          </span>
          mirrors<span className="edition">LOCAL</span>
        </a>
        <div className="workspace">
          <span className="workspace-icon">M</span>
          <div>
            <strong>{synthetic ? 'Atlas · demo agent' : 'Your agent workspace'}</strong>
            <small>Failure → fix → evidence</small>
          </div>
          <ChevronRight size={14} />
        </div>
        <div className="nav-caption">OBSERVE & VERIFY</div>
        <nav>
          {nav.map(([key, Icon, title]) => (
            <button
              key={key}
              aria-label={title}
              className={'nav-item ' + (view === key ? 'selected' : '')}
              onClick={() => setView(key)}
            >
              <Icon size={17} />
              <span>{title}</span>
              {key === 'fixes' ? (
                <span className="nav-count">{state?.fixes.length ?? 0}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="nav-caption rule-nav-caption">OPTIONAL INTERVENTIONS</div>
        <a className="nav-item" href="/?view=rules">
          <SlidersHorizontal size={17} />
          <span>Runtime rules</span>
          <ArrowUpRight size={13} />
        </a>
        <div className="sidebar-bottom">
          <div className="local-note">
            <span className="live-dot" />
            <div>
              Raw traces stay local.<small>SQLite index · no SDK required</small>
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
            <strong>{nav.find((n) => n[0] === view)?.[2]}</strong>
          </div>
          <div className="topbar-right">
            <span className="connection">
              <span className="live-dot" /> Local connection
            </span>
            <button
              className="icon-button"
              aria-label="Refresh evidence"
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
                THE FIX LEDGER <span>/</span> {view.toUpperCase()}
              </div>
              <h1>{titles[view]}</h1>
              <p>Find failures by task. Track the fix. Catch the next regression.</p>
            </div>
            <div className="heading-actions">
              <button
                className="secondary"
                onClick={() => {
                  setModal('import');
                  setForm({});
                }}
              >
                <Upload size={15} /> Import traces
              </button>
              <button className="primary" onClick={() => draft()}>
                <Plus size={16} /> Track a fix
              </button>
            </div>
          </div>
          {synthetic ? (
            <div className="demo-banner">
              <FlaskConical size={15} />
              <strong>Demo workspace</strong>
              <span>
                All runs, fixes and comparisons are synthetic. Human labels are intentionally empty.
              </span>
            </div>
          ) : null}
          {error ? (
            <div className="error-banner" role="alert">
              <AlertTriangle size={16} />
              {error}
              <button aria-label="Dismiss error" onClick={() => setError('')}>
                <X size={15} />
              </button>
            </div>
          ) : null}
          {!state ? (
            <div className="empty">Opening the local index…</div>
          ) : (
            <>
              <div className="observation-toolbar">
                <div>
                  <Clock size={14} />{' '}
                  <select
                    aria-label="Evidence window"
                    value={days}
                    onChange={(e) => setDays(Number(e.target.value))}
                  >
                    <option value={7}>Last 7 days</option>
                    <option value={30}>Last 30 days</option>
                    <option value={365}>Last 365 days</option>
                    <option value={3650}>All dated history</option>
                  </select>
                </div>
                <span>
                  {state.last_ingest
                    ? 'Last import ' + new Date(state.last_ingest.at).toLocaleString()
                    : 'Import existing sessions to begin. No runtime hook required.'}
                </span>
              </div>
              {view === 'overview' ? (
                <>
                  <div className="stats">
                    <Stat
                      label="INDEXED RUNS"
                      value={num(state.total_runs)}
                      foot="Conversations on your machine"
                      icon={<Layers size={16} />}
                    />
                    <Stat
                      label="CODE SIGNALS"
                      value={num(state.signals.filter((s: any) => s.kind === 'code').length)}
                      foot="Definitions you can inspect"
                      icon={<Code2 size={16} />}
                    />
                    <Stat
                      label="RELEASE REGRESSIONS"
                      value={state.health.rows.length ? num(state.health.regressions) : '—'}
                      foot={
                        state.health.rows.length
                          ? 'Compared within intent and segment'
                          : 'Needs two tagged versions'
                      }
                      icon={<GitBranch size={16} />}
                    />
                    <Stat
                      label="FIXES TRACKED"
                      value={num(state.fixes.length)}
                      foot={`${state.fixes.filter((f: any) => f.status === 'shipped').length} shipped · ${state.fixes.filter((f: any) => f.status === 'verified').length} verified`}
                      icon={<ShieldCheck size={16} />}
                    />
                  </div>
                  <div className="ledger-card">
                    <div className="table-toolbar">
                      <div>
                        <h2 className="table-title">Top failure patterns</h2>
                        <span className="muted small">
                          Frequency-ranked definitions, with evidence attached
                        </span>
                      </div>
                      <select
                        aria-label="Filter by intent"
                        className="plain-select"
                        value={intent}
                        onChange={(e) => setIntent(e.target.value)}
                      >
                        <option value="all">All task types</option>
                        {intents.map((i) => (
                          <option key={i}>{i}</option>
                        ))}
                      </select>
                    </div>
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>SIGNAL / DEFINITION</th>
                            <th>AFFECTED RUNS</th>
                            <th>RATE</th>
                            <th>HUMAN REVIEW</th>
                            <th>FIX</th>
                          </tr>
                        </thead>
                        <tbody>
                          {ranked.map((s: any) => (
                            <tr key={s.id}>
                              <td>
                                <button className="rule-link" onClick={() => setSignal(s)}>
                                  <span className="rule-dot active" />
                                  <strong>{s.name}</strong>
                                </button>
                                <div className="signal-definition">{s.definition_text}</div>
                              </td>
                              <td>
                                <strong className="mono count">{num(s.affected)}</strong>
                                <small className="subcount">of {num(s.assessed)} assessable</small>
                              </td>
                              <td>
                                <strong className="mono">{percent(s.rate)}</strong>
                                <small className="subcount">{percent(s.coverage)} coverage</small>
                              </td>
                              <td>
                                <span
                                  className={
                                    'verdict ' + (s.labels.reviewed ? 'working' : 'cannot-assess')
                                  }
                                >
                                  {s.labels.reviewed ? (
                                    <Check size={12} />
                                  ) : (
                                    <span className="tiny-ring" />
                                  )}
                                  {s.labels.reviewed
                                    ? percent(s.labels.agreement) + ' agreement'
                                    : 'Needs labels'}
                                </span>
                                <small className="subcount">{s.labels.samples} samples</small>
                              </td>
                              <td>
                                <button
                                  className="text-button"
                                  aria-label={'Track fix for ' + s.name}
                                  onClick={() => draft(s.id)}
                                >
                                  Track fix <ArrowUpRight size={14} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="table-footer">
                      <span>
                        <ShieldCheck size={13} /> Code defines the event. Human samples establish
                        whether it matters.
                      </span>
                      <span>{days}-day window</span>
                    </div>
                  </div>
                  <div className="below-grid">
                    <section className="activity-preview">
                      <div className="section-heading">
                        <h2>Latest deploy</h2>
                        <button onClick={() => setView('health')}>
                          Inspect release <ArrowUpRight size={14} />
                        </button>
                      </div>
                      <h3>{state.health.version ?? 'No version tags yet'}</h3>
                      <p className="muted">
                        {state.health.baseline
                          ? 'Compared with ' + state.health.baseline
                          : 'Tag your existing exports with a deployment version to compare outcomes.'}
                      </p>
                      {state.health.rows
                        .filter((r: any) => r.verdict === 'regression')
                        .slice(0, 3)
                        .map((r: any) => (
                          <div className="mini-event" key={r.signal_id + r.intent + r.segment}>
                            <span className="event-symbol regression">
                              <ArrowUpRight size={14} />
                            </span>
                            <div>
                              <strong>{r.intent}</strong>
                              <p>
                                {r.signal_id} · {r.segment}
                              </p>
                            </div>
                            <strong className="negative">+{percent(r.delta)}</strong>
                          </div>
                        ))}
                    </section>
                    <section className="principle-card">
                      <div className="mini-eyebrow">FIXES, NOT JUST FINDINGS</div>
                      <h2>
                        Ship a change.
                        <br />
                        Keep the evidence.
                      </h2>
                      <p>
                        Prompt edit, code patch, or scoped runtime rule. Each fix points to one
                        signal and a version you can measure.
                      </p>
                      <button onClick={() => draft()}>
                        Register your first fix <ArrowUpRight size={15} />
                      </button>
                    </section>
                  </div>
                </>
              ) : null}
              {view === 'health' && health ? (
                <>
                  <section className="content-card release-controls">
                    <div>
                      <label>
                        BASELINE
                        <select
                          aria-label="Baseline version"
                          value={health.baseline ?? ''}
                          onChange={(e) =>
                            void api(
                              `health?days=${days}&baseline=${encodeURIComponent(e.target.value)}&version=${encodeURIComponent(health.version ?? '')}`,
                            )
                              .then(setHealth)
                              .catch((e) => setError(String(e)))
                          }
                        >
                          <option value="">Choose baseline</option>
                          {state.versions
                            .filter((v: any) => v.known)
                            .map((v: any) => (
                              <option key={v.id} value={v.id}>
                                {v.id} · {v.runs} runs
                              </option>
                            ))}
                        </select>
                      </label>
                      <ChevronRight size={20} />
                      <label>
                        CURRENT RELEASE
                        <select
                          aria-label="Current version"
                          value={health.version ?? ''}
                          onChange={(e) =>
                            void api(
                              `health?days=${days}&baseline=${encodeURIComponent(health.baseline ?? '')}&version=${encodeURIComponent(e.target.value)}`,
                            )
                              .then(setHealth)
                              .catch((e) => setError(String(e)))
                          }
                        >
                          <option value="">Choose release</option>
                          {state.versions
                            .filter((v: any) => v.known)
                            .map((v: any) => (
                              <option key={v.id} value={v.id}>
                                {v.id} · {v.runs} runs
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                    <p className="muted">
                      {health.reason} {health.model_changed ? 'The model also changed.' : ''}
                    </p>
                  </section>
                  <section className="ledger-card">
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>SIGNAL / TASK TYPE</th>
                            <th>SEGMENT</th>
                            <th>BEFORE → AFTER</th>
                            <th>SAMPLES</th>
                            <th>STATUS</th>
                            <th>EVIDENCE</th>
                          </tr>
                        </thead>
                        <tbody>
                          {health.rows.map((r: any) => (
                            <tr key={r.signal_id + r.intent + r.segment}>
                              <td>
                                <strong>{r.signal_id}</strong>
                                <small className="subcount">{r.intent}</small>
                              </td>
                              <td>{r.segment}</td>
                              <td className="mono">
                                {percent(r.before_rate)} <span className="muted">→</span>{' '}
                                <strong className={r.delta > 0 ? 'negative' : 'positive'}>
                                  {percent(r.after_rate)}
                                </strong>
                              </td>
                              <td className="mono">
                                {r.n_before} / {r.n_after}
                              </td>
                              <td>
                                <span className={'verdict ' + r.verdict}>{r.verdict}</span>
                              </td>
                              <td>
                                {r.worst[0] ? (
                                  <button
                                    className="text-button"
                                    onClick={() => void showRun(r.worst[0].run_id)}
                                  >
                                    Worst run <ArrowUpRight size={14} />
                                  </button>
                                ) : (
                                  <span className="muted">—</span>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {!health.rows.length ? (
                        <div className="empty">
                          <GitBranch size={28} />
                          <h3>A release needs a baseline.</h3>
                          <p>Import two tagged versions. Unknown versions are not invented.</p>
                          <code>mirrors ingest ./sessions --version release-2</code>
                        </div>
                      ) : null}
                    </div>
                    <div className="table-footer">
                      Threshold: +5 percentage points · minimum 30 completed runs per intent,
                      segment and version · no p-value claim
                    </div>
                  </section>
                </>
              ) : null}
              {view === 'fixes' ? (
                <section className="ledger-card">
                  <div className="table-toolbar">
                    <div>
                      <h2 className="table-title">The fix ledger</h2>
                      <span className="muted small">
                        Target signal → shipped version → observed change
                      </span>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => {
                        setForm({ text: '', signal: state.signals[0]?.id });
                        setModal('prompt');
                      }}
                    >
                      <FileCode2 size={15} /> Import prompt fixes
                    </button>
                  </div>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>FIX / TARGET</th>
                          <th>TYPE</th>
                          <th>VERSION</th>
                          <th>BEFORE → AFTER</th>
                          <th>STATUS</th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.fixes.map((f: any) => (
                          <tr key={f.id}>
                            <td>
                              <strong>{f.name}</strong>
                              <small className="subcount">{f.target_signal_id}</small>
                              <small className="subcount mono">{f.source}</small>
                            </td>
                            <td>
                              <span className="event-tag">{f.type}</span>
                            </td>
                            <td>
                              <select
                                className="plain-select"
                                aria-label={'Shipped version for ' + f.name}
                                disabled={busy}
                                value={f.version_id ?? ''}
                                onChange={(e) =>
                                  void mutate(
                                    () =>
                                      api('fixes/' + f.id, 'PATCH', {
                                        version_id: e.target.value || null,
                                      }),
                                    'Version linked',
                                  )
                                }
                              >
                                <option value="">Not linked</option>
                                {state.versions.map((v: any) => (
                                  <option key={v.id}>{v.id}</option>
                                ))}
                              </select>
                              {f.results.shared_deploy ? (
                                <small className="subcount">
                                  Shared deploy · {f.results.co_shipped_fixes + 1} fixes
                                </small>
                              ) : null}
                            </td>
                            <td>
                              {f.results.rows.length ? (
                                f.results.rows.slice(0, 3).map((r: any) => (
                                  <div className="fix-comparison" key={r.intent + r.segment}>
                                    <small>
                                      {r.intent} · {r.segment}
                                    </small>
                                    <span className="mono">
                                      {percent(r.before_rate)} → {percent(r.after_rate)}{' '}
                                      <span className="muted">
                                        ({r.n_before}/{r.n_after})
                                      </span>
                                    </span>
                                  </div>
                                ))
                              ) : (
                                <small className="muted">Awaiting a baseline and outcomes</small>
                              )}
                            </td>
                            <td>
                              <select
                                className="plain-select"
                                aria-label={'Fix status for ' + f.name}
                                disabled={busy}
                                value={f.status}
                                onChange={(e) =>
                                  void mutate(
                                    () =>
                                      api('fixes/' + f.id + '?days=' + days, 'PATCH', {
                                        status: e.target.value,
                                      }),
                                    'Fix status updated',
                                  )
                                }
                              >
                                <option>proposed</option>
                                <option>shipped</option>
                                <option>verified</option>
                                <option>retired</option>
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!state.fixes.length ? (
                      <div className="empty">
                        <ShieldCheck size={28} />
                        <h3>Start with the change you just shipped.</h3>
                        <p>Link a commit, prompt edit or runtime rule to the failure it targets.</p>
                        <button className="primary" onClick={() => draft()}>
                          Track a fix
                        </button>
                      </div>
                    ) : null}
                  </div>
                  <div className="table-footer">
                    Verification needs human-reviewed positive and negative samples, enough
                    outcomes, an improvement and no observed segment regression.
                  </div>
                </section>
              ) : null}
              {view === 'runs' ? (
                <>
                  <div className="observation-toolbar">
                    <label className="search">
                      <Search size={15} />
                      <input
                        aria-label="Search conversations"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                        placeholder="Run, intent or version…"
                      />
                    </label>
                    <button
                      className="secondary"
                      onClick={() => {
                        setForm({ id: state.intents[0]?.id ?? '', name: '' });
                        setModal('intent');
                      }}
                    >
                      Name an intent cluster
                    </button>
                  </div>
                  <section className="ledger-card">
                    <div className="table-scroll">
                      <table>
                        <thead>
                          <tr>
                            <th>CONVERSATION</th>
                            <th>TASK TYPE / SEGMENT</th>
                            <th>VERSION</th>
                            <th>STEPS</th>
                            <th>SIGNALS</th>
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {state.runs
                            .filter((r: any) =>
                              JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
                            )
                            .map((r: any) => (
                              <tr key={r.id}>
                                <td>
                                  <strong className="mono">{r.id}</strong>
                                  <small className="subcount">
                                    {new Date(r.started_at).toLocaleString()}
                                  </small>
                                </td>
                                <td>
                                  {r.intent}
                                  <small className="subcount">{r.segment}</small>
                                </td>
                                <td>
                                  <code>{r.version}</code>
                                  <small className="subcount">{r.model}</small>
                                </td>
                                <td className="mono">{r.step_count}</td>
                                <td>
                                  <span
                                    className={
                                      'signal-number ' + (r.signal_count ? 'has-hits' : '')
                                    }
                                  >
                                    {r.signal_count}
                                  </span>
                                </td>
                                <td>
                                  <button
                                    className="icon-button"
                                    aria-label={'Open run ' + r.id}
                                    onClick={() => void showRun(r.id)}
                                  >
                                    <ArrowUpRight size={17} />
                                  </button>
                                </td>
                              </tr>
                            ))}
                        </tbody>
                      </table>
                      {!state.runs.length ? (
                        <div className="empty">Import sessions to inspect conversations here.</div>
                      ) : null}
                    </div>
                    <div className="table-footer">
                      Latest 200 conversations · raw content served only from your local workspace
                    </div>
                  </section>
                </>
              ) : null}
              {view === 'replay' ? (
                <>
                  <div className="discover-grid">
                    <section className="content-card">
                      <div className="square-icon">
                        <Play />
                      </div>
                      <h2>Model calls only. Cached tool results.</h2>
                      <p>
                        Replay affected conversation prefixes against a candidate prompt or model.
                        Exact tool names and argument hashes must match. The first differing action
                        stops scoring and is reported as diverged.
                      </p>
                      <pre className="command-example">
                        mirrors replay repeated-identical-error \\{'\n'} --model provider/model \\
                        {'\n'} --prompt ./candidate-prompt.txt --limit 100
                      </pre>
                      <p className="muted">
                        Explicitly invokes a model provider. No tool executes. Missing schemas or
                        results are marked unreplayable.
                      </p>
                    </section>
                    <section className="content-card">
                      <div className="square-icon">
                        <ShieldCheck />
                      </div>
                      <h2>Diverged is a result.</h2>
                      <p>
                        A new tool action can be a better strategy. Cached data cannot tell us what
                        would happen next, so it never becomes a manufactured pass.
                      </p>
                      <div className="replay-legend">
                        <span className="verdict improved">completed</span>
                        <span className="verdict stable">diverged</span>
                        <span className="verdict cannot-assess">unreplayable</span>
                      </div>
                      <p className="muted">
                        Up to 8 concurrent runs. Default batch deadline: 10 minutes. Completion time
                        depends on provider latency and trace length.
                      </p>
                    </section>
                  </div>
                  <section className="content-card">
                    <h2>Replay reports</h2>
                    {state.replays.map((r: any) => (
                      <details className="replay-report" key={r.id}>
                        <summary>
                          {r.signal_id} · {r.summary.completed}/{r.summary.selected} completed ·{' '}
                          {r.summary.diverged} diverged · {Math.round(r.elapsed_ms / 1000)}s
                        </summary>
                        <pre>{JSON.stringify(r, null, 2)}</pre>
                      </details>
                    ))}
                    {!state.replays.length ? (
                      <p className="muted">
                        No replay calls made. Run the command above to create a report here.
                      </p>
                    ) : null}
                  </section>
                </>
              ) : null}
              {view === 'digest' ? (
                <section className="content-card digest">
                  <div className="mini-eyebrow">YOUR WEEKLY CHECK-IN</div>
                  <h2>What broke. What changed. What needs proof.</h2>
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
                    <code>mirrors release-digest --webhook-env MIRRORS_SLACK_WEBHOOK</code>
                    <br />
                    Delivery is opt-in. Use your scheduler for weekly delivery.
                  </p>
                </section>
              ) : null}
            </>
          )}
          <footer className="page-footer">
            <span className="mark tiny">
              <i />
              <i />
            </span>
            <span>Every fix has a reason. Now it has a result.</span>
            <span className="mono">LOCAL FIRST</span>
          </footer>
        </section>
      </main>
      {signal ? (
        <div className="overlay" onClick={() => setSignal(null)}>
          <aside className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-top">
              <span className="eyebrow">SIGNAL DEFINITION</span>
              <button
                className="icon-button"
                aria-label="Close signal"
                onClick={() => setSignal(null)}
              >
                <X />
              </button>
            </div>
            <code>{signal.id}</code>
            <h2>{signal.name}</h2>
            <p>{signal.definition_text}</p>
            <div className="evidence-note">
              <strong>
                {signal.labels.reviewed ? 'Human samples reviewed' : 'Needs human alignment'}
              </strong>
              <p>
                {signal.labels.samples} labeled samples. Agreement:{' '}
                {percent(signal.labels.agreement)}. A deterministic definition is not a claim of
                perfect real-world precision.
              </p>
            </div>
            <h3>Affected conversations</h3>
            {signal.examples.map((e: any) => (
              <button
                className="run-link"
                key={e.run_id + e.step_idx}
                onClick={() => void showRun(e.run_id)}
              >
                <span>
                  <strong>{e.intent}</strong>
                  <small>
                    {e.run_id} · step {e.step_idx}
                  </small>
                  <small>{e.reason}</small>
                </span>
                <ArrowUpRight size={16} />
              </button>
            ))}
            {!signal.examples.length ? (
              <p className="muted">No affected runs in this window.</p>
            ) : null}
            <button
              className="primary wide"
              onClick={() => {
                draft(signal.id);
                setSignal(null);
              }}
            >
              Track a fix for this signal
            </button>
            <p className="muted small">
              To review negative samples: <code>mirrors signals samples {signal.id}</code>
            </p>
          </aside>
        </div>
      ) : null}
      {run ? (
        <div className="overlay" onClick={() => setRun(null)}>
          <aside className="drawer conversation-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-top">
              <span className="eyebrow">CONVERSATION EVIDENCE</span>
              <button
                className="icon-button"
                aria-label="Close conversation"
                onClick={() => setRun(null)}
              >
                <X />
              </button>
            </div>
            <h2>{run.run.intent}</h2>
            <code className="muted">{run.run.id}</code>
            <p>
              {run.run.version} · {run.run.model} · {run.run.segment}
            </p>
            <div className="conversation-prompt">
              <small>FIRST USER MESSAGE</small>
              <p>{run.run.first_user_message || 'Not captured'}</p>
            </div>
            <h3>Signal review</h3>
            {run.assessments.map((a: any) => {
              const hit = run.hits.find((h: any) => h.signal_id === a.signal_id);
              const idx = hit?.step_idx ?? -1;
              const label = run.labels.find(
                (l: any) => l.signal_id === a.signal_id && l.step_idx === idx,
              );
              return (
                <div className="sample-review" key={a.signal_id}>
                  <div>
                    <strong>{a.signal_id}</strong>
                    <small>
                      {a.assessable
                        ? hit
                          ? hit.reason
                          : 'Definition did not match'
                        : 'Not assessable: ' + a.reason}
                    </small>
                  </div>
                  {a.assessable ? (
                    <div className="label-actions">
                      <span>
                        {label
                          ? 'Recorded: ' + (label.agree ? 'agree' : 'disagree')
                          : 'Agree with this result?'}
                      </span>
                      {[true, false].map((agree) => (
                        <button
                          key={String(agree)}
                          disabled={busy}
                          onClick={() =>
                            void mutate(async () => {
                              await api('labels', 'POST', {
                                signal_id: a.signal_id,
                                run_id: run.run.id,
                                step_idx: idx,
                                agree,
                              });
                              setRun(await api('runs/' + encodeURIComponent(run.run.id)));
                            }, 'Sample label saved')
                          }
                        >
                          {agree ? 'Agree' : 'Disagree'}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
            <h3>Conversation steps</h3>
            {run.run.steps.map((s: any) => (
              <section className="conversation-step" key={s.idx}>
                <div className="step-heading">
                  <span>STEP {s.idx}</span>
                  <span className="mono">
                    {s.messages_hash?.slice(0, 10) ?? 'prefix hash unavailable'}
                  </span>
                </div>
                {s.final_message ? <p className="message-text">{s.final_message}</p> : null}
                {s.tool_calls.map((c: any, i: number) => (
                  <details className="tool-call" key={c.id + i}>
                    <summary>
                      <span className={'tool-state ' + c.status} />
                      <strong>{c.name}</strong>
                      <span className="muted">
                        {c.status}
                        {c.duration_ms != null ? ' · ' + c.duration_ms + ' ms' : ''}
                      </span>
                    </summary>
                    <p className="negative">{c.error}</p>
                    <small>ARGUMENTS · {c.args_hash.slice(0, 12)}</small>
                    <pre>{JSON.stringify(c.args, null, 2)}</pre>
                    <small>CACHED RESULT</small>
                    <pre>
                      {c.result === undefined ? 'Not captured' : JSON.stringify(c.result, null, 2)}
                    </pre>
                  </details>
                ))}
              </section>
            ))}
          </aside>
        </div>
      ) : null}
      {modal ? (
        <div className="overlay centered" onClick={() => setModal(null)}>
          <section
            className="modal observation-modal"
            role="dialog"
            aria-modal="true"
            aria-label={
              modal === 'fix'
                ? 'Track a fix'
                : modal === 'import'
                  ? 'Import traces'
                  : modal === 'prompt'
                    ? 'Import prompt fixes'
                    : 'Name an intent'
            }
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="close-modal icon-button"
              aria-label="Close dialog"
              onClick={() => setModal(null)}
            >
              <X />
            </button>
            <div className="eyebrow">
              {modal === 'fix' ? 'FAILURE → FIX → EVIDENCE' : 'LOCAL WORKSPACE'}
            </div>
            <h2>
              {modal === 'fix'
                ? 'What did you change?'
                : modal === 'import'
                  ? 'Bring the traces you already have.'
                  : modal === 'prompt'
                    ? 'Turn conditional lines into fix records.'
                    : 'Give a task type a name.'}
            </h2>
            {modal === 'import' ? (
              <>
                <p>
                  JSON and JSONL exports from your existing agent or observability tool. Raw content
                  stays on disk. No SDK wrapper required.
                </p>
                <label className="primary file-button">
                  <Upload size={16} /> Choose export file
                  <input
                    type="file"
                    accept=".json,.jsonl"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      await mutate(async () => {
                        const text = await file.text();
                        const result = await api(
                          'ingest',
                          'POST',
                          file.name.endsWith('.jsonl')
                            ? text
                                .split('\n')
                                .filter(Boolean)
                                .map((s) => JSON.parse(s))
                            : JSON.parse(text),
                        );
                        if (!result.imported)
                          throw Error(result.warnings?.[0] ?? 'No recognized runs');
                        setModal(null);
                      }, 'Conversations imported and scored');
                    }}
                  />
                </label>
                <p className="muted">
                  For directories: <code>mirrors ingest ./sessions</code>
                  <br />
                  For River: <code>mirrors documentdb --help</code>
                </p>
              </>
            ) : null}
            {modal === 'fix' ? (
              <>
                <label>
                  Fix description
                  <input
                    autoFocus
                    aria-label="Fix description"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Refresh the document target after a rejected edit"
                  />
                </label>
                <div className="form-grid">
                  <label>
                    Target signal
                    <select
                      aria-label="Target signal"
                      value={form.target_signal_id}
                      onChange={(e) => setForm({ ...form, target_signal_id: e.target.value })}
                    >
                      {state.signals.map((s: any) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Fix type
                    <select
                      aria-label="Fix type"
                      value={form.type}
                      onChange={(e) => setForm({ ...form, type: e.target.value })}
                    >
                      <option value="code">Code change</option>
                      <option value="prompt">Prompt change</option>
                      <option value="rule">Runtime rule (opt-in)</option>
                    </select>
                  </label>
                  <label>
                    Shipped version
                    <select
                      aria-label="Fix version"
                      value={form.version_id}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          version_id: e.target.value,
                          status: e.target.value ? 'shipped' : 'proposed',
                        })
                      }
                    >
                      <option value="">Not shipped yet</option>
                      {state.versions.map((v: any) => (
                        <option key={v.id}>{v.id}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Commit / source
                    <input
                      aria-label="Fix source"
                      value={form.source}
                      onChange={(e) => setForm({ ...form, source: e.target.value })}
                      placeholder="Commit SHA or PR reference"
                    />
                  </label>
                </div>
                <label>
                  Notes
                  <textarea
                    aria-label="Fix notes"
                    value={form.notes}
                    onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  />
                </label>
                {form.type === 'rule' ? (
                  <p className="muted">
                    Creates a linked shadow rule in mirrors.yaml. It does not change agent behavior
                    until you activate it.
                  </p>
                ) : null}
                <button
                  className="primary wide"
                  disabled={busy || !form.name.trim()}
                  onClick={() =>
                    void mutate(async () => {
                      await api('fixes', 'POST', {
                        ...form,
                        version_id: form.version_id || null,
                        baseline_version: form.baseline_version || null,
                        model: form.model || null,
                        source: form.source || 'local-ui',
                      });
                      setModal(null);
                      setView('fixes');
                    }, 'Fix registered')
                  }
                >
                  Track fix <Check size={15} />
                </button>
              </>
            ) : null}
            {modal === 'prompt' ? (
              <>
                <p>
                  Choose the signal these instructions are intended to prevent. Each imported line
                  starts as a proposed prompt fix.
                </p>
                <select
                  aria-label="Prompt target signal"
                  value={form.signal}
                  onChange={(e) => setForm({ ...form, signal: e.target.value })}
                >
                  {state.signals.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <textarea
                  aria-label="Prompt fix text"
                  value={form.text}
                  onChange={(e) => setForm({ ...form, text: e.target.value })}
                />
                <button
                  className="primary wide"
                  disabled={busy || !form.text.trim()}
                  onClick={() =>
                    void mutate(async () => {
                      await api('import-prompt', 'POST', form);
                      setModal(null);
                    }, 'Prompt fixes imported')
                  }
                >
                  Import proposed fixes
                </button>
              </>
            ) : null}
            {modal === 'intent' ? (
              <>
                <p>
                  Grouping uses a local feature-hash embedding. It never detects failures. Name each
                  cluster once.
                </p>
                <select
                  aria-label="Intent cluster"
                  value={form.id}
                  onChange={(e) => setForm({ ...form, id: e.target.value })}
                >
                  {state.intents.map((i: any) => (
                    <option key={i.id} value={i.id}>
                      {i.name} · {i.count} runs
                    </option>
                  ))}
                </select>
                <input
                  aria-label="Intent name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="Document editing"
                />
                <button
                  className="primary wide"
                  disabled={busy || !form.id || !form.name.trim()}
                  onClick={() =>
                    void mutate(async () => {
                      await api('intents/name', 'POST', form);
                      setModal(null);
                    }, 'Intent named')
                  }
                >
                  Save name
                </button>
              </>
            ) : null}
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
  icon: React.ReactNode;
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
createRoot(document.getElementById('root')!).render(
  new URLSearchParams(location.search).get('view') === 'rules' ? <RuleWorkbench /> : <App />,
);
