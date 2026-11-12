// The models of each engine that POST /status returns: models.json, which dev/sync-models.mjs writes from MODELS of
// sandbox/run-comment.mjs. The Worker cannot import that file (it starts programs). test/drift.test.mjs fails when they differ.
export { default as MODELS } from './models.json' with { type: 'json' };

/** The checks of jobError() in sandbox/run-comment.mjs, for the Worker. test/drift.test.mjs runs both on the same jobs. */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const httpUrl = (v) => { try { const u = new URL(v); return u.protocol === 'https:' || u.protocol === 'http:'; } catch { return false; } };
export function jobError(job) {
  if (!job || typeof job !== 'object') return 'the job is not a JSON object';
  if (!httpUrl(job.mcp_url)) return 'mcp_url must be an http or https URL';
  if (!/^[0-9a-f]{24}$/.test(job.comment_id)) return 'comment_id must be 24 hex characters';
  if (!/^[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/.test(job.slug) || job.slug.length > 120) return 'slug must be <group>/<name>';
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(job.agent_label)) return 'agent_label must be 1 to 40 characters: a-z, 0-9, _ and -';
  if (job.engine !== undefined && job.engine !== 'claude' && job.engine !== 'codex') return 'engine must be claude or codex';
  if (job.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._\[\]-]{0,79}$/.test(job.model)) return 'model must be a model name';
  if (job.effort !== undefined && !EFFORTS.includes(job.effort)) return `effort must be one of ${EFFORTS.join(', ')}`;
  if (job.callback_url !== undefined && !httpUrl(job.callback_url)) return 'callback_url must be an http or https URL';
  return null;
}
