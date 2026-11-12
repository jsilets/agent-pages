// The assistant settings of each person: the sign-in state of Claude and ChatGPT, the sign-in itself, and the model.
// The sandbox runner holds the sign-ins. The host only passes each request on, with the person's identity and the
// shared secret, and it checks each answer of the runner before the viewer gets it. The host never stores, logs or
// returns the code that a person pastes from Claude: it goes straight to the runner.
import { readJson, runnerFetch } from './lib';
import type { Assistant, Env } from './types';

export const ASSISTANTS: readonly Assistant[] = ['claude', 'chatgpt'];
/** The program that the runner starts for each assistant. */
export const ENGINES = { claude: 'claude', chatgpt: 'codex' } as const;
export const isAssistant = (s: string): s is Assistant => (ASSISTANTS as readonly string[]).includes(s);

/** The limit for an answer of the runner and for a request body of the viewer. */
const MAX_BYTES = 16 * 1024;
/** A code from Claude's sign-in page is about 100 characters. */
export const MAX_CODE = 2048;
/** A sign-in that the runner says ends later than this ends at this time. */
const MAX_FLOW_MS = 30 * 60 * 1000;
const MODEL_ID = /^[\w.:/@-]{1,100}$/;
const FLOW_ID = /^[\w-]{8,128}$/;

export interface Model {
  id: string;
  label: string;
  note: string;
}

export interface AssistantState {
  /** True when the runner handles this assistant (SANDBOX_AGENTS). */
  handled: boolean;
  /** The sign-in state from the runner, or null when the runner did not answer. */
  connected: boolean | null;
  models: Model[];
  default_model: string | null;
  /** The model that the person chose, or null for the default. */
  model: string | null;
  /** Set when the runner answered but could not check this sign-in. The host gives its own text, never the text of the runner. */
  error?: string;
}

export interface ConnectStart {
  id: string;
  url: string;
  user_code?: string;
  needs_code: boolean;
  expires_at: string;
}

export type FlowStatus = 'pending' | 'connected' | 'failed' | 'expired';
const STATUSES: readonly FlowStatus[] = ['pending', 'connected', 'failed', 'expired'];

export class RunnerError extends Error {}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * Sends POST <runner origin><path> with a JSON body and the shared secret, and returns the JSON object of the answer.
 * It throws RunnerError with no part of the body in its message, so a code never reaches a log.
 */
/**
 * The calls that can start a container, or stop one and start another for the other assistant. The runner allows a
 * container 30 seconds to start, so 10 seconds is too short for these.
 */
const SLOW = new Set(['/connect', '/connect/code', '/disconnect']);

export async function callRunner(env: Env, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.SANDBOX_RUNNER_URL) throw new RunnerError('no sandbox runner');
  let res: Response;
  try {
    res = await runnerFetch(env, new URL(path, env.SANDBOX_RUNNER_URL).href, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(env.SANDBOX_RUNNER_SECRET ? { 'x-runner-secret': env.SANDBOX_RUNNER_SECRET } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SLOW.has(path) ? 60_000 : 10_000),
    });
  } catch {
    throw new RunnerError(`the sandbox runner did not answer ${path}`);
  }
  const text = await res.text();
  if (!res.ok) throw new RunnerError(`the sandbox runner answered ${path} with ${res.status}`);
  if (text.length > MAX_BYTES) throw new RunnerError(`the answer of the sandbox runner to ${path} is too large`);
  try {
    return obj(JSON.parse(text));
  } catch {
    throw new RunnerError(`the answer of the sandbox runner to ${path} is not JSON`);
  }
}

/** The models of one assistant from the /status answer, checked: at most 8, each with an id, a short label and a note. */
export function readModels(v: unknown): { models: Model[]; default_model: string | null } {
  const a = obj(v);
  const models = (Array.isArray(a.models) ? a.models : [])
    .slice(0, 64)
    .map((m) => { const o = obj(m); return { id: str(o.id, 100), label: str(o.label, 40), note: str(o.note, 120) }; })
    .filter((m, i, all) => MODEL_ID.test(m.id) && m.label && all.findIndex((x) => x.id === m.id) === i)
    .slice(0, 8);
  const d = str(a.default_model, 100);
  return { models, default_model: models.some((m) => m.id === d) ? d : (models[0]?.id ?? null) };
}

/** The saved model of each assistant for one person. */
async function savedModels(env: Env, user: string): Promise<Record<string, string>> {
  const { results } = await env.DB.prepare('SELECT assistant, model FROM assistant_prefs WHERE user = ?').bind(user).all<{ assistant: string; model: string }>();
  return Object.fromEntries(results.map((r) => [r.assistant, r.model]));
}

/** The model that a run of this assistant uses for this person, or null for the default of the runner. */
export async function modelFor(env: Env, user: string, assistant: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT model FROM assistant_prefs WHERE user = ? AND assistant = ?').bind(user, assistant).first<{ model: string }>();
  return row?.model ?? null;
}

/** GET /api/assistants: each assistant with its sign-in state, its models and the choice of the person. */
export async function assistantStates(env: Env, user: string, handled: string[]): Promise<{ runner: boolean; error?: string; assistants: Record<Assistant, AssistantState> }> {
  const saved = await savedModels(env, user);
  let status: Record<string, unknown> | null = null;
  let error: string | undefined;
  if (env.SANDBOX_RUNNER_URL) {
    try {
      status = obj((await callRunner(env, '/status', { user })).assistants);
    } catch (e) {
      error = e instanceof RunnerError ? e.message : 'the sandbox runner did not answer';
    }
  } else error = 'no sandbox runner';
  const assistants = Object.fromEntries(ASSISTANTS.map((a) => {
    const s = status ? obj(status[a]) : {};
    const { models, default_model } = readModels(s);
    const model = saved[a] && models.some((m) => m.id === saved[a]) ? saved[a] : null;
    const failed = status && str(s.error, 200) ? { error: 'the sandbox runner could not check the sign-in' } : {};
    return [a, { handled: handled.includes(a), connected: status ? s.connected === true : null, models, default_model, model, ...failed }];
  })) as Record<Assistant, AssistantState>;
  return { runner: !!status, ...(error ? { error } : {}), assistants };
}

/** PUT /api/assistants/<name>: stores the model, after the runner confirms that the assistant has it. null goes back to the default. */
export async function chooseModel(env: Env, user: string, assistant: Assistant, req: Request): Promise<{ model: string | null } | { status: number; error: string }> {
  const body = obj(await readJson(req, MAX_BYTES));
  const model = body.model === null ? null : str(body.model, 101);
  if (model !== null && !MODEL_ID.test(model)) return { status: 400, error: 'send { "model": "<id>" } with an id from GET /api/assistants, or { "model": null }' };
  if (model === null) {
    await env.DB.prepare('DELETE FROM assistant_prefs WHERE user = ? AND assistant = ?').bind(user, assistant).run();
    return { model: null };
  }
  const { models } = readModels(obj((await callRunner(env, '/status', { user })).assistants)[assistant]);
  if (!models.some((m) => m.id === model)) return { status: 400, error: `${assistant} has no model ${model}` };
  await env.DB.prepare('INSERT INTO assistant_prefs (user, assistant, model, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user, assistant) DO UPDATE SET model = excluded.model, updated_at = excluded.updated_at')
    .bind(user, assistant, model, new Date().toISOString())
    .run();
  return { model };
}

/**
 * A sign-in page from the runner. It must be https. Development also takes http on localhost, for the fake runner.
 * Returns the URL as text, or null.
 */
export function signInUrl(v: unknown, dev: boolean): string | null {
  const s = str(v, 2048);
  try {
    const u = new URL(s);
    if (u.protocol === 'https:' || (dev && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1'))) return u.href;
  } catch {}
  return null;
}

/** POST /api/assistants/<name>/connect: the runner starts a sign-in. The host keeps whose sign-in it is. */
export async function startConnect(env: Env, user: string, assistant: Assistant): Promise<ConnectStart | { status: number; error: string }> {
  const out = await callRunner(env, '/connect', { user, engine: ENGINES[assistant] });
  const id = str(out.id, 129);
  const url = signInUrl(out.url, env.ENVIRONMENT === 'development');
  const code = str(out.user_code, 33);
  if (!FLOW_ID.test(id) || !url || (code && !/^[A-Za-z0-9-]{4,32}$/.test(code))) return { status: 502, error: 'the sandbox runner gave a sign-in that the host cannot use' };
  const now = Date.now();
  const end = Math.min(now + MAX_FLOW_MS, Date.parse(str(out.expires_at, 40)) || now + MAX_FLOW_MS);
  const expires_at = new Date(Math.max(end, now + 60_000)).toISOString();
  await env.DB.prepare('DELETE FROM connect_flows WHERE expires_at <= ?').bind(new Date(now).toISOString()).run();
  await env.DB.prepare('INSERT INTO connect_flows (id, user, assistant, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING').bind(id, user, assistant, expires_at).run();
  return { id, url, ...(code ? { user_code: code } : {}), needs_code: out.needs_code === true, expires_at };
}

/** The sign-in with this id, when this person started it and it has not ended. */
async function flowOf(env: Env, user: string, id: string) {
  if (!FLOW_ID.test(id)) return null;
  return env.DB.prepare('SELECT id, assistant, expires_at FROM connect_flows WHERE id = ? AND user = ?').bind(id, user).first<{ id: string; assistant: string; expires_at: string }>();
}

const readStatus = (out: Record<string, unknown>): { status: FlowStatus; detail?: string } => {
  const status = STATUSES.find((s) => s === out.status) ?? 'failed';
  const detail = str(out.detail, 200);
  return { status, ...(detail ? { detail } : {}) };
};

/** GET /api/assistants/connect/<id>: the state of a sign-in. A sign-in of another person is a 404, the same as an unknown id. */
export async function connectStatus(env: Env, user: string, id: string): Promise<{ status: FlowStatus; detail?: string } | null> {
  const flow = await flowOf(env, user, id);
  if (!flow) return null;
  if (flow.expires_at <= new Date().toISOString()) return { status: 'expired' };
  const out = readStatus(await callRunner(env, '/connect/status', { id }));
  if (out.status !== 'pending') await env.DB.prepare('DELETE FROM connect_flows WHERE id = ?').bind(id).run();
  return out;
}

/** POST /api/assistants/connect/<id>/code: the code from Claude's page goes to the runner. The host keeps no copy of it. */
export async function sendCode(env: Env, user: string, id: string, req: Request): Promise<{ status: FlowStatus; detail?: string } | { status: number; error: string } | null> {
  const flow = await flowOf(env, user, id);
  if (!flow) return null;
  const body = obj(await readJson(req, MAX_BYTES));
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code || code.length > MAX_CODE || /[\u0000-\u001f\u007f\s]/.test(code)) return { status: 400, error: `send { "code": "..." }: the code from the sign-in page, at most ${MAX_CODE} characters with no spaces` };
  const out = readStatus(await callRunner(env, '/connect/code', { id, code }));
  if (out.status === 'connected' || out.status === 'expired') await env.DB.prepare('DELETE FROM connect_flows WHERE id = ?').bind(id).run();
  return out;
}

/** DELETE /api/assistants/<name>/connection: the runner forgets the sign-in of this person. */
export async function disconnect(env: Env, user: string, assistant: Assistant): Promise<{ ok: boolean }> {
  const out = await callRunner(env, '/disconnect', { user, engine: ENGINES[assistant] });
  return { ok: out.ok === true };
}
