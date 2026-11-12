// The types that the Worker, the MCP connector and the agent hooks share. This file imports only types.
import type { Mention } from './lib';

export interface Env {
  DB: D1Database;
  PAGES: R2Bucket;
  BROWSER: BrowserRun;
  ENVIRONMENT: string;
  ACCESS_TEAM: string;
  ACCESS_AUD: string;
  /** Development only: the URL of the sandbox runner that starts Claude Code for a comment. Not set means no runs. */
  SANDBOX_RUNNER_URL?: string;
  /** Development only: the mentions that the runner handles, as a comma list of 'claude' and 'chatgpt'. Default: 'claude,chatgpt'. */
  SANDBOX_AGENTS?: string;
  /** Development only: the shared secret of the sandbox runner. The host sends it as the header x-runner-secret with each job. */
  SANDBOX_RUNNER_SECRET?: string;
}

/** The two assistants of the viewer. The runner calls the program for ChatGPT 'codex'. */
export type Assistant = 'claude' | 'chatgpt';

/** One row of the comments table. A reply has parent_id set to the first comment of its thread. */
export interface Comment {
  id: string;
  slug: string;
  /** The page version the comment was written on. */
  version: number;
  /** An element id or a claim id, or null for a comment on the whole page. */
  anchor: string | null;
  /** The text the comment is about, or null. */
  quote: string | null;
  /** The page text just before the quote and just after it, or null. The viewer finds the quote again with them. */
  prefix: string | null;
  suffix: string | null;
  /** The id of the slide that has the quote, for a deck, or null. */
  slide: string | null;
  body: string;
  /** The Access identity of a person, or the label of a connector token. */
  author: string;
  mention: Mention | null;
  parent_id: string | null;
  status: 'open' | 'resolved';
  created_at: string;
  /** The time of the last change of the body, or null for a comment that nobody changed. */
  edited_at?: string | null;
}

/** The first comment of a thread, with its replies, oldest first. */
export interface Thread extends Comment {
  replies: Comment[];
}

/** Why a store function did not store, with the HTTP status for it. */
export interface Refusal {
  error: string;
  status: number;
}

/** What publish and edit_page return for a new version. */
export interface Stored {
  slug: string;
  version: number;
  kind: string;
  title: string;
  url: string;
  versionUrl: string;
  audit?: unknown;
}

/** Stores the HTML as a new version of the page. worker.ts owns it, and the MCP connector gets it as an argument. */
export type StoreVersion = (env: Env, ctx: ExecutionContext, slug: string, html: string, origin: string) => Promise<Stored | Refusal>;

/** What a JSON-RPC handler knows about the caller of the MCP connector. */
export interface McpContext {
  token: string;
  /** The label of the connector token. */
  label: string;
  origin: string;
  /** The page scope of the connector token. Not set means every page. */
  slug?: string;
  /** The secret id of the sandbox run that owns the connector token. Not set for a token that a person made. */
  run?: string;
}

/**
 * One JSON-RPC method of the MCP connector. params is the `params` member of the request, not checked.
 * The return value is the JSON-RPC `result`. Throw an RpcError to answer with a JSON-RPC error.
 * For a notification (a request with no id) the connector drops the result and answers 202.
 */
export type Handler = (env: Env, params: unknown, ctx: McpContext) => Promise<unknown>;

/** A JSON-RPC error that a Handler throws. -32602 means bad params. */
export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}
