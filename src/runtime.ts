import { Engine, cohort, ruleVersion, type Judge, emptyDecision } from './engine.js';
import { Store } from './store.js';
import type { Context, Decision, Ledger } from './schema.js';
export class Runtime {
  engine: Engine;
  error?: string;
  constructor(
    readonly store: Store,
    readonly judge?: Judge,
  ) {
    try {
      this.engine = new Engine(store.read());
    } catch (e) {
      this.error = String(e);
      this.engine = new Engine({ version: 1, rules: [] });
    }
  }
  reload() {
    try {
      this.engine = new Engine(this.store.read());
      this.error = undefined;
    } catch (e) {
      this.error = String(e);
      this.engine = new Engine({ version: 1, rules: [] });
    }
  }
  async evaluate(ctx: Context): Promise<Decision> {
    if (this.error) return emptyDecision(ctx, this.error);
    try {
      const d = await this.engine.evaluateAsync(ctx, this.judge);
      this.store.logDecision(ctx, d, this.engine.ledger);
      return d;
    } catch (e) {
      return emptyDecision(ctx, String(e));
    }
  }
  // Call once at run completion. Signals are evaluated on the final trajectory, not on pre-intervention state.
  finish(ctx: Context, failures?: Record<string, boolean>) {
    try {
      for (const r of this.engine.ledger.rules) {
        if (
          (r.expiry.expires_at && Date.parse(r.expiry.expires_at) < Date.now()) ||
          (ctx.capabilities && !r.actions.some((a) => ctx.capabilities!.includes(a.type))) ||
          r.status !== 'active' ||
          (r.pinned.model && r.pinned.model !== ctx.model) ||
          (r.pinned.prompt_hash && r.pinned.prompt_hash !== ctx.prompt_hash)
        )
          continue;
        const failure = failures && r.id in failures ? failures[r.id] : this.engine.failure(r, ctx);
        if (failure === null) continue;
        this.store.append({
          type: 'outcome',
          session_id: ctx.session_id,
          model: ctx.model,
          prompt_hash: ctx.prompt_hash,
          rule_id: r.id,
          rule_version: ruleVersion(r),
          cohort: cohort(r, ctx.session_id),
          failure,
          failure_class: r.failure?.class,
        });
      }
    } catch {
      /* Telemetry must never stop the host. */
    }
  }
}
