// Disposable feasibility probe, never a production storage adapter.
// Full current Core, original coordinator, exact owner SQL, and original fresh R2 fencing.
// The routable fixture cookie is a probe envelope; production issuance is not implemented.
import core, { UserTransactionCoordinator as OriginalCoordinator } from './core-worker.js';
import { accounting, guarded, measured, learned } from './guard.js';
import plan from './cost-plan.js';

const ceiling = request => {
  const value = JSON.parse(request.headers.get('x-probe-ceiling') || 'null');
  if (!value || !Number.isSafeInteger(value.rowsRead) || value.rowsRead < 0 || value.rowsRead > 100000 || !Number.isSafeInteger(value.rowsWritten) || value.rowsWritten < 0 || value.rowsWritten > 5000) throw Error('Missing or invalid experiment allowance');
  return value;
};
const settings = env => ({ ...env, BENCH_COST_PLAN: plan });
const timedBucket = bucket => new Proxy(bucket, { get: (target, property) => {
  const value = Reflect.get(target, property, target);
  if (property === 'get') return async (...args) => {
    const started = performance.now();
    try { return await target.get(...args); }
    finally { const scope = accounting.getStore(); if (scope) scope.recoveryWaitMs += performance.now() - started; }
  };
  return typeof value === 'function' ? value.bind(target) : value;
} });
export class UserTransactionCoordinator extends OriginalCoordinator {
  constructor(state, env) {
    super(state, { ...env, DB: guarded(env.DB, settings(env)), ERASURE_BUCKET: timedBucket(env.ERASURE_BUCKET) });
    this.env = env;
    this.state = state;
  }
  fetch(request) {
    if (new URL(request.url).pathname === '/__probe/delete' && request.headers.get('x-fidy-bench') === this.env.BENCH_TOKEN) return this.state.storage.deleteAll().then(() => new Response(null, { status: 204 }));
    if (new URL(request.url).pathname === '/__probe/plan' && this.env.BENCH_LOCAL_CALIBRATION === 'true') return Promise.resolve(Response.json(Object.fromEntries(learned)));
    return measured(ceiling(request), () => super.fetch(request));
  }
}

const unavailable = () => new Response(null, { status: 503 });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const encodeParameter = value => value instanceof Uint8Array
  ? value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
  : Array.isArray(value) ? new Uint8Array(value).buffer : typeof value === 'boolean' ? Number(value) : value;

function localDatabase(storage) {
  const execute = query => {
    const cursor = storage.sql.exec(query.sql, ...query.params.map(encodeParameter));
    const results = cursor.toArray();
    const rowsRead = cursor.rowsRead, rowsWritten = cursor.rowsWritten;
    const info = storage.sql.exec('SELECT changes() AS changes,last_insert_rowid() AS id').one();
    return { success: true, results, meta: {
      changed_db: rowsWritten > 0, changes: rowsWritten > 0 ? info.changes : 0,
      last_row_id: info.id, rows_read: rowsRead, rows_written: rowsWritten,
      // Native deployed timers do not measure synchronous SQL CPU. Not timing evidence.
      duration: 0, size_after: storage.sql.databaseSize,
    } };
  };
  const batch = async statements => storage.transactionSync(() => statements.map(statement => execute(statement.query)));
  const unsupported = () => { throw Error('Unsupported feasibility operation'); };
  const prepare = query => ({
    query,
    bind: (...params) => prepare({ ...query, params }),
    all: () => batch([prepare(query)]).then(rows => rows[0]),
    run: () => batch([prepare(query)]).then(rows => rows[0]),
    first: column => batch([prepare(query)]).then(rows => column === undefined ? rows[0].results[0] ?? null : rows[0].results[0]?.[column] ?? null),
    raw: unsupported,
  });
  return { prepare: sql => prepare({ sql, params: [] }), batch, withSession: unsupported, exec: unsupported, dump: unsupported };
}

export class LocalUser {
  constructor(state, env) {
    this.state = state;
    // The real recovery wrapper, not this adapter, fetches R2 before every native unit.
    const DB = guarded(env.BENCH_INLINE_D1 === 'true' ? env.DB : localDatabase(state.storage), settings(env));
    const ERASURE_BUCKET = new Proxy(timedBucket(env.ERASURE_BUCKET), { get: (target, property) => {
      if (property === 'get') return async (...args) => {
        const result = await target.get(...args);
        if (args[0] === 'recovery/generation' && this.fault && --this.fault.remaining === 0) {
          const fault = this.fault;
          this.fault = undefined;
          // Private native fixture race injection, not an application operation.
          await DB.batch(fault.commands.map(query => DB.prepare(query.sql).bind(...query.params)));
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    const USER_TRANSACTION_COORDINATOR = { getByName: name => ({ fetch: request => name === state.id.name ? this.coordinator.fetch(request) : Promise.resolve(unavailable()) }) };
    this.environment = { ...env, DB, ERASURE_BUCKET, USER_TRANSACTION_COORDINATOR, ERASURE_REQUIRED: 'true' };
    // Keep the original held User turn. No unmerged direct-read concurrency tradeoff.
    this.coordinator = new OriginalCoordinator(state, this.environment);
  }
  async fetch(request) {
    if (request.headers.get('x-probe-user') !== this.state.id.name) return unavailable();
    if (new URL(request.url).pathname === '/__probe/delete') { await this.state.storage.deleteAll(); return new Response(null, { status: 204 }); }
    if (new URL(request.url).pathname === '/__probe/plan' && this.environment.BENCH_LOCAL_CALIBRATION === 'true') return Response.json(Object.fromEntries(learned));
    return measured(ceiling(request), () => this.execute(request));
  }
  async execute(request) {
    if (new URL(request.url).pathname === '/__probe/fault') {
      this.fault = await request.json();
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/__probe/sql') {
      try {
        const queries = await request.json();
        return Response.json(await this.environment.DB.batch(queries.map(query => this.environment.DB.prepare(query.sql).bind(...query.params))));
      } catch { return unavailable(); }
    }
    return core.fetch(request, this.environment, this.state);
  }
  alarm() { return this.coordinator.alarm(); }
}
export class D1User extends LocalUser {
  constructor(state, env) { super(state, { ...env, BENCH_INLINE_D1: 'true' }); }
}

export default { async fetch(request, env, context) {
  // No existing application route, database, bucket, User or secret is used by this probe.
  if (!env.BENCH_TOKEN || request.headers.get('x-fidy-bench') !== env.BENCH_TOKEN) return new Response(null, { status: 404 });
  const path = new URL(request.url).pathname;
  const headers = new Headers(request.headers);
  headers.delete('x-probe-user');
  if (path === '/__probe/recovery' && request.method === 'PUT') { await env.ERASURE_BUCKET.put('recovery/generation', await request.text()); return new Response(null, { status: 204 }); }
  if (path === '/__probe/cleanup' && request.method === 'DELETE') {
    for (const name of env.BENCH_USERS.split(',')) {
      for (const namespace of [env.LOCAL_USER, env.D1_USER, env.USER_TRANSACTION_COORDINATOR].filter(Boolean)) {
        const response = await namespace.getByName(name).fetch('https://probe.invalid/__probe/delete', { headers: { 'x-probe-user': name, 'x-fidy-bench': env.BENCH_TOKEN } });
        if (response.status !== 204) throw Error('Fixture cleanup refused');
      }
    }
    await env.ERASURE_BUCKET.delete('recovery/generation');
    return new Response(null, { status: 204 });
  }
  if (path === '/__probe/plan') {
    if (env.BENCH_LOCAL_CALIBRATION !== 'true') return new Response(null, { status: 404 });
    const combined = Object.fromEntries(learned);
    for (const name of env.BENCH_USERS.split(',')) {
      for (const namespace of [env.LOCAL_USER, env.D1_USER, env.USER_TRANSACTION_COORDINATOR].filter(Boolean)) {
        const response = await namespace.getByName(name).fetch('https://probe.invalid/__probe/plan', { headers: { 'x-probe-user': name } });
        if (!response.ok) throw Error('Cost calibration unavailable');
        for (const [sql, cost] of Object.entries(await response.json())) {
          const previous = combined[sql] || { rowsRead: 0, rowsWritten: 0 };
          combined[sql] = { rowsRead: Math.max(previous.rowsRead, cost.rowsRead), rowsWritten: Math.max(previous.rowsWritten, cost.rowsWritten) };
        }
      }
    }
    return Response.json(combined);
  }
  if (headers.get('x-probe-storage') === 'd1' || (headers.get('x-probe-storage') === 'd1-setup' && env.SETUP_DB)) {
    return measured(ceiling(request), async () => {
    const DB = guarded(headers.get('x-probe-storage') === 'd1-setup' ? env.SETUP_DB : env.DB, settings(env));
    if (path === '/__probe/sql') {
      try {
        const queries = await request.json();
        return Response.json(await DB.batch(queries.map(query => DB.prepare(query.sql).bind(...query.params.map(value => Array.isArray(value) ? new Uint8Array(value) : value)))));
      } catch { return unavailable(); }
    }
    const USER_TRANSACTION_COORDINATOR = { getByName: name => ({ fetch: async (...args) => {
      const forwarded = new Request(...args), childHeaders = new Headers(forwarded.headers);
      const scope = accounting.getStore();
      const remaining = { rowsRead: scope.ceiling.rowsRead - scope.rowsRead - scope.child.rowsRead - scope.reserved.rowsRead, rowsWritten: scope.ceiling.rowsWritten - scope.rowsWritten - scope.child.rowsWritten - scope.reserved.rowsWritten };
      if (remaining.rowsRead < 0 || remaining.rowsWritten < 0) throw Error('Child allowance exhausted');
      childHeaders.set('x-probe-ceiling', JSON.stringify(remaining));
      scope.reserved.rowsRead += remaining.rowsRead; scope.reserved.rowsWritten += remaining.rowsWritten;
      let response; const started = performance.now();
      try { response = await env.USER_TRANSACTION_COORDINATOR.getByName(name).fetch(new Request(forwarded, { headers: childHeaders })); }
      catch (error) { scope.unaccounted = true; scope.failed = true; throw error; }
      finally { scope.coordinatorWaitMs += performance.now() - started; scope.reserved.rowsRead -= remaining.rowsRead; scope.reserved.rowsWritten -= remaining.rowsWritten; }
      const cost = JSON.parse(response.headers.get('x-bench-cost') || 'null');
      if (!cost) { scope.unaccounted = true; throw Error('Missing child cost'); }
      scope.child.rowsRead += cost.rowsRead; scope.child.rowsWritten += cost.rowsWritten; scope.child.batches += cost.batches;
      scope.child.storageWaitMs += cost.storageWaitMs; scope.child.recoveryWaitMs += cost.recoveryWaitMs;
      if (cost.unaccounted) scope.unaccounted = true;
      if (cost.failed || cost.unaccounted) { scope.failed = true; throw Error('Child cost refusal'); }
      return response;
    } }) };
    return core.fetch(request, { ...env, DB, USER_TRANSACTION_COORDINATOR, ERASURE_BUCKET: timedBucket(env.ERASURE_BUCKET) }, context);
    });
  }
  let user;
  if (path === '/__probe/sql' || path === '/__probe/fault') user = headers.get('x-probe-seed-user');
  else {
    const cookies = (headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith('__Host-fidy_session='));
    if (cookies.length !== 1) return new Response(null, { status: 401 });
    const credential = /^__Host-fidy_session=([a-f0-9-]+)\.([A-Za-z0-9_-]{43})$/u.exec(cookies[0]);
    if (!credential) return new Response(null, { status: 401 });
    user = credential[1];
    // Routing grants no authority. Core still checks the exact original bearer and binding
    // against records that exist only in this User's separate SQLite database.
    headers.set('cookie', '__Host-fidy_session=' + credential[2]);
  }
  if (!uuid.test(user ?? '') || !(env.BENCH_USERS ?? '').split(',').includes(user)) return new Response(null, { status: 401 });
  headers.set('x-probe-user', user);
  return (headers.get('x-probe-storage') === 'do-d1' ? env.D1_USER : env.LOCAL_USER).getByName(user).fetch(new Request(request, { headers }));
} };
