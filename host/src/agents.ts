// The hook that runs after a person writes a comment. It hands the comment to each agent trigger.
import { runSandboxAgent } from './sandbox';
import type { Comment, Env } from './types';

/**
 * Runs inside ctx.waitUntil, after the API stored the comment. It runs for each comment and reply
 * that a person writes, with or without a mention. It does not run for a reply from the MCP connector.
 */
export async function onCommentCreated(env: Env, ctx: ExecutionContext, comment: Comment, origin: string): Promise<void> {
  const done = await Promise.allSettled([runSandboxAgent(env, comment, origin)]);
  for (const d of done) if (d.status === 'rejected') console.error('comment hook', comment.id, d.reason);
}
