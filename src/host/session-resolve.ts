// Which WhatsApp session a delivery is sent from.
//
// The host answers this by binding the ingress instance to a session, and when it has, that answer wins
// — this module never overrides it. But the host cannot always answer it. The dashboard's field is free
// text labelled "Session scope (optional)" with the placeholder "Leave blank for all sessions", it is
// stored verbatim with no lookup (`sessionScope: opts.sessionScope || null`), and the Sessions page
// renders `session.id.substring(0, 12)` with no copy control — so the full id an operator would have to
// paste is not obtainable from the UI at all. Left alone, the common outcome is an unbound instance,
// which looks exactly like a working install right up until every delivery dead-letters as `no_session`.
//
// The rule that makes filling the gap safe rather than a guess: fall back ONLY when exactly one session
// is ready. One ready session means there is no other session it could have meant, so there is no wrong
// choice to make. With two or more, the ambiguity is real and this fails loudly and names them instead.
//
// It also covers the case a hard binding cannot: a session that is deleted and re-paired comes back with
// a NEW id, so a stored binding silently rots. Resolving per delivery self-corrects; a binding does not.

import { gatewayRequest } from './gateway.ts';
import type { GatewayDeps } from './gateway.ts';

/** The fields this module needs from GET /api/sessions. */
export interface SessionInfo {
  id: string;
  name: string;
  status: string;
}

export type SessionChoice =
  | { ok: true; sessionId: string; /** The binding named a session that no longer exists. */ stale: boolean }
  | { ok: false; detail: string };

/** Only a `ready` session can send; anything else is pairing, stopped or broken. */
function ready(sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => s.status === 'ready');
}

function nameList(sessions: SessionInfo[]): string {
  return sessions.map((s) => `"${s.name}"`).join(', ');
}

/**
 * Decide, given the instance's binding and the sessions that exist. Pure, so every branch is testable
 * without a gateway.
 */
export function chooseSession(bound: string | undefined, sessions: SessionInfo[]): SessionChoice {
  const live = ready(sessions);

  if (bound) {
    if (live.some((s) => s.id === bound)) return { ok: true, sessionId: bound, stale: false };

    // The bound session EXISTS but cannot send. Falling through to another one here would contradict an
    // explicit instruction from the operator, which is the one thing this must never do — so say what is
    // wrong with the session they picked and stop.
    const named = sessions.find((s) => s.id === bound);
    if (named) {
      return { ok: false, detail: `the instance is bound to session "${named.name}", which is ${named.status}, not ready` };
    }

    // The bound session is GONE — deleted, or re-paired under a new id. There is no instruction left to
    // contradict, so the single-ready rule applies as it would to an unbound instance.
    if (live.length === 1) return { ok: true, sessionId: live[0].id, stale: true };
  }

  if (live.length === 1) return { ok: true, sessionId: live[0].id, stale: false };

  if (live.length === 0) {
    return { ok: false, detail: 'no WhatsApp session is connected — pair one on the Sessions page' };
  }

  return {
    ok: false,
    detail:
      `${live.length} WhatsApp sessions are connected (${nameList(live)}), so there is no single one to ` +
      `send from — bind this instance to the one you want under Configure > Instances`,
  };
}

export interface SessionLookupDeps extends GatewayDeps {
  /** Milliseconds since the epoch; injected so the cache is testable. */
  clock?: () => number;
}

/** One gateway round trip per minute is plenty: sessions change when an operator acts, not on their own. */
export const SESSION_CACHE_MS = 60_000;

interface Cache {
  at: number;
  sessions: SessionInfo[];
}
let cache: Cache | null = null;

/** Drop the memo — for tests, and after a send fails on a session this module chose. */
export function clearSessionCache(): void {
  cache = null;
}

function parseSessions(body: string): SessionInfo[] {
  const raw: unknown = JSON.parse(body);
  if (!Array.isArray(raw)) throw new Error('the gateway did not return a session list');
  return raw
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.id === 'string')
    .map((r) => ({
      id: r.id as string,
      name: typeof r.name === 'string' ? r.name : (r.id as string),
      status: typeof r.status === 'string' ? r.status : 'unknown',
    }));
}

/** Read the gateway's session list, memoized for SESSION_CACHE_MS. */
export async function listSessions(deps: SessionLookupDeps): Promise<SessionInfo[]> {
  const now = (deps.clock ?? (() => Date.now()))();
  if (cache && now - cache.at < SESSION_CACHE_MS) return cache.sessions;

  const res = await gatewayRequest(deps, '/api/sessions');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.body.slice(0, 120)}`);
  const sessions = parseSessions(res.body);
  cache = { at: now, sessions };
  return sessions;
}

/**
 * Resolve the session for one delivery.
 *
 * A gateway that cannot be reached must not break an install that was already correct, so a bound
 * instance falls back to its binding and only an unbound one fails. The reverse — refusing to send from
 * a session the operator explicitly named because a loopback call blipped — would make this module a new
 * source of outages rather than a fix for one.
 */
export async function resolveSessionId(deps: SessionLookupDeps, bound: string | undefined): Promise<SessionChoice> {
  let sessions: SessionInfo[];
  try {
    sessions = await listSessions(deps);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (bound) return { ok: true, sessionId: bound, stale: false };
    return { ok: false, detail: `the instance is not bound to a session, and the session list could not be read: ${why}` };
  }
  return chooseSession(bound, sessions);
}

/** The fields this module needs from GET /api/integration/plugins/:id/instances. */
export interface InstanceInfo {
  instanceId: string;
  sessionScope: string | null;
  enabled: boolean;
}

function parseInstances(body: string): InstanceInfo[] {
  const raw: unknown = JSON.parse(body);
  if (!Array.isArray(raw)) throw new Error('the gateway did not return an instance list');
  return raw
    .map((r) => r as Record<string, unknown>)
    .filter((r) => typeof r.instanceId === 'string')
    .map((r) => ({
      instanceId: r.instanceId as string,
      sessionScope: typeof r.sessionScope === 'string' ? r.sessionScope : null,
      enabled: r.enabled !== false,
    }));
}

/**
 * Answer "will a notification actually go out?" for the health button.
 *
 * This is the layer that was missing when an unbound instance dead-lettered every delivery while the
 * health check stayed green: the connection to Seerr was genuinely fine, and nothing looked at the other
 * end of the pipe. Reading it live is safe here in a way the old Setup-tab mirror was not — a health
 * check runs when the operator presses it, so there is no cached copy to drift out of date.
 */
export async function describeSending(deps: SessionLookupDeps): Promise<{ ok: boolean; note: string }> {
  let instances: InstanceInfo[];
  let sessions: SessionInfo[];
  try {
    const res = await gatewayRequest(deps, `/api/integration/plugins/${deps.pluginId}/instances`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    instances = parseInstances(res.body).filter((i) => i.enabled);
    clearSessionCache();
    sessions = await listSessions(deps);
  } catch (err) {
    // Not a verdict: the delivery path has its own fallbacks and may well be fine. Report the blind spot.
    return { ok: true, note: `Could not check which session will send: ${err instanceof Error ? err.message : String(err)}.` };
  }

  if (instances.length === 0) {
    return { ok: false, note: 'No ingress instance yet — create one under Configure > Instances so Seerr has somewhere to post.' };
  }

  const problems: string[] = [];
  const sending = new Set<string>();
  for (const inst of instances) {
    const choice = chooseSession(inst.sessionScope ?? undefined, sessions);
    if (!choice.ok) {
      problems.push(`"${inst.instanceId}" cannot send: ${choice.detail}.`);
      continue;
    }
    const name = sessions.find((s) => s.id === choice.sessionId)?.name ?? choice.sessionId;
    sending.add(choice.stale ? `${name} (the bound session no longer exists)` : name);
  }

  if (problems.length > 0) return { ok: false, note: problems.join(' ') };
  return { ok: true, note: `Sending from ${[...sending].map((n) => `"${n}"`).join(', ')}.` };
}

/**
 * The session a test message should go out from.
 *
 * A test is not tied to an ingress instance — nothing posted it — but it must land where a real delivery
 * would, or it proves the wrong thing. So it borrows the binding from the first enabled instance that has
 * one and resolves from there, which collapses to the same single-ready-session rule when none does.
 */
export async function resolveSessionForTest(deps: SessionLookupDeps): Promise<SessionChoice> {
  let bound: string | undefined;
  try {
    const res = await gatewayRequest(deps, `/api/integration/plugins/${deps.pluginId}/instances`);
    if (res.ok) {
      bound = parseInstances(res.body).filter((i) => i.enabled).find((i) => i.sessionScope)?.sessionScope ?? undefined;
    }
  } catch {
    // An unreadable instance list is not fatal here: with no binding to honour, the single-ready-session
    // rule is exactly what a real delivery would fall back to anyway.
  }
  return resolveSessionId(deps, bound);
}
