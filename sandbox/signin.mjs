// The sign-in of one person to Claude or ChatGPT: the commands of the unmodified programs, and the readers of their output.
// It has no dependencies. local-runner.mjs runs the commands in a container (POST /connect), and connect.mjs uses the runner.
//
// The sign-in goes from the program to its maker. This file reads no credential and stores none: the program writes its
// own file in the volume of the person. The code that a person pastes goes to the standard input of the program one
// time, and no log, no answer and no detail has it.

/** The commands of each engine. `status` runs with no network and a read-only volume, so it cannot renew or change a sign-in. */
export const SIGNIN = {
  claude: {
    name: 'Claude',
    login: ['claude', 'auth', 'login', '--claudeai'],
    status: ['claude', 'auth', 'status', '--json'],
    logout: ['claude', 'auth', 'logout'],
    needs_code: true,
  },
  codex: {
    name: 'ChatGPT',
    login: ['codex', 'login', '--device-auth'],
    status: ['codex', 'login', 'status'],
    logout: ['codex', 'logout'],
    needs_code: false,
  },
};

/** The time that a sign-in waits for the person. */
export const SIGNIN_TIMEOUT_MS = 10 * 60 * 1000;

/** Removes the color codes of a terminal. */
const plain = (text) => String(text ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/**
 * Reads the output of `claude auth login --claudeai` with no terminal. Claude Code prints
 *   If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…
 *   Paste code here if prompted >
 * Returns { url, waiting }: the URL is null until the line is complete, and `waiting` is true at the prompt.
 */
export function parseClaudeLogin(text) {
  const t = plain(text);
  const m = /(https:\/\/[a-z0-9.-]+\/[^\s]*oauth\/authorize\?[^\s]+)\s/i.exec(t);
  return { url: m ? m[1] : null, waiting: /Paste code here if prompted\s*>/i.test(t) };
}

/**
 * Reads the output of `codex login --device-auth`. Codex prints
 *   1. Open this link in your browser and sign in to your account
 *      https://auth.openai.com/codex/device
 *   2. Enter this one-time code (expires in 15 minutes)
 *      DHB4-MFRHG
 * Returns { url, user_code, expires_min }, each null until it is in the text.
 */
export function parseCodexLogin(text) {
  const t = plain(text);
  const url = /(https:\/\/auth\.openai\.com\/codex\/device[^\s]*)/i.exec(t)?.[1] ?? null;
  const after = t.slice(t.search(/one-time code/i) >= 0 ? t.search(/one-time code/i) : t.length);
  const code = /\(expires in \d+ minutes?\)\s*\n\s*([A-Z0-9]{4,}-[A-Z0-9]{4,})\s*(\n|$)/i.exec(after)?.[1] ?? null;
  const exp = /expires in (\d+) minutes?/i.exec(t);
  return { url, user_code: code, expires_min: exp ? +exp[1] : null };
}

/** `claude auth status --json`: true for "loggedIn": true. Text that is not JSON is "not connected". */
export function parseClaudeStatus(text) {
  const t = String(text ?? '');
  try {
    return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)).loggedIn === true;
  } catch {
    return false;
  }
}

/** `codex login status`: "Logged in using ChatGPT" or "Not logged in". */
export const parseCodexStatus = (text) => /^logged in\b/im.test(plain(text));

/** Each value in `secrets` and each run of 32 or more token characters becomes <cut>. The text has at most `max` characters. */
export function scrub(text, secrets = [], max = 300) {
  let t = plain(text);
  for (const s of secrets) if (s && s.length >= 4) t = t.split(s).join('<cut>');
  // A URL keeps its host and path, and loses its query: the query of a sign-in URL holds the state and the challenge.
  const urls = [];
  t = t.replace(/https?:\/\/[^\s?#]+([?#][^\s]*)?/g, (u, q) => { urls.push(q ? u.slice(0, u.length - q.length) + '?<cut>' : u); return `\u0000${urls.length - 1}\u0000`; });
  t = t.replace(/[A-Za-z0-9_\-+/=.#]{32,}/g, '<cut>').replace(/\u0000(\d+)\u0000/g, (_, i) => urls[+i]);
  return t.trim().slice(0, max);
}

/**
 * The detail of a sign-in that failed, for the person: one plain sentence, then the last line of the program with no
 * secret. `output` is the whole output of the program, `code` is the pasted code (only to remove it).
 */
export function failureDetail(engine, output, { code = null, exitCode = null } = {}) {
  // Claude Code writes its error on the line of the prompt, after "Paste code here if prompted > ".
  const lines = plain(output).split('\n').map((l) => l.replace(/^.*paste code here if prompted\s*>\s*/i, '').trim()).filter(Boolean);
  const last = scrub(lines.filter((l) => !/^(if the browser didn.t open|opening browser)/i.test(l)).pop() ?? '', [code]);
  const t = plain(output);
  let what;
  if (engine === 'claude' && /login failed|accepted|invalid|expired|not valid|bad request|failed to exchange|token exchange/i.test(t)) what = 'Anthropic did not accept the code. Start the sign-in again, and paste the newest code from the Anthropic page.';
  else if (engine === 'codex' && /expired|timed out|time out/i.test(t)) what = 'The one-time code expired. Start the sign-in again.';
  else if (engine === 'codex' && /denied|declined|access_denied/i.test(t)) what = 'The sign-in was declined on the ChatGPT page.';
  else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network|proxy|403 Forbidden|tunnel/i.test(t)) what = 'The sign-in could not reach the sign-in service.';
  else what = `The sign-in of ${SIGNIN[engine].name} did not finish${exitCode != null ? ` (exit code ${exitCode})` : ''}.`;
  return last ? `${what} The program said: "${last}"` : what;
}

/** A pasted code: printable ASCII with no space and no line break, 8 to 512 characters. Returns the cause of a refusal, or null. */
export function codeError(code) {
  if (typeof code !== 'string') return 'code must be a string';
  if (code.length < 8 || code.length > 512) return 'code must have 8 to 512 characters';
  if (!/^[\x21-\x7e]+$/.test(code)) return 'code must be one line of printable characters with no space';
  return null;
}
