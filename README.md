# agent-pages

agent-pages lets coding agents publish HTML pages to your own Cloudflare account. Each page has versions, a library lists every page, and a share link opens one page with no login.

The repo has four parts:

| Folder | What it holds |
|---|---|
| `skills/explain/` | The `explain` skill creates HTML explanations, lessons, documents, and presentations. It guides content, emphasis, and the choice of prose, tables, charts, or diagrams within each page. `diagrams/` holds 64 diagram templates from diagram-design. |
| `kit/` | `explain.css` and `explain.js`: the look and the runtime that every page shares. |
| `brand/` | The mark. `mark.svg` is the master, `mark-small.svg` is the cut for 16 to 32 px with thicker parts and a bolder heading line (the favicon), and `mark-square.svg` is for platforms that round the corners. `favicon.ico` and `apple-touch-icon.png` are rendered from them. |
| `tools/` | `port-diagram-design.mjs` copies the diagram-design templates into `skills/explain/diagrams/`. Run it again to take a newer version. |
| `cli/` | `agent-pages`: `new`, `check`, `pack`, `serve`, `publish` and `list`. Node 18 or later, no dependencies. |
| `host/` | A Cloudflare Worker: the library, the viewer, the API and the share links. |

## Install the skill and the CLI

1. Link the skill into your agent's skill folder:
   ```bash
   ln -s "$PWD/skills/explain" ~/.claude/skills/explain
   ln -s "$PWD/skills/explain" ~/.codex/skills/explain
   ```
2. Put the CLI on your `PATH`. Install it from npm, or link it from the clone:
   ```bash
   npm install -g agent-pages
   # or
   ln -s "$PWD/cli/agent-pages.mjs" ~/.local/bin/agent-pages
   ```
3. Try it:
   ```bash
   agent-pages check skills/explain/examples/gallery.html
   ```

Without a host, the skill still works. Pages go to `~/.agent/explain/<repo>/`, and the agent shows them inline or in a local preview.

## How the host works

- R2 stores the HTML of each version at `pages/<group>/<name>/<version>.html`. D1 stores the page list, the versions and the share links.
- At publish time, the Worker indexes the text of the page in a D1 FTS5 table, with one row for each claim. Browser Rendering takes a light and a dark screenshot of the top of the page, and R2 stores them as `pages/<group>/<name>/<version>.<theme>.webp`.
- The raw route gives each `.k-claim` section with no id the id `claim-<n>`. A search result links to `/p/<group>/<name>#claim-<n>`, and the viewer passes the hash to the frame.
- The viewer shows each page in an `<iframe>` with the `sandbox` attribute. The page HTML comes from a route that sends `Content-Security-Policy: sandbox`. So the script in a page runs with no origin, and it cannot read the host's cookies or call its API.
- Cloudflare Access protects the whole hostname. A person signs in with Access. The CLI sends an Access service token.
- The Worker checks the Access JWT on each request too. Access at the edge is the first check, and the Worker is the second.
- A page whose `<main>` has the class `k-deck` is a deck, and D1 stores `kind = 'deck'` for it. At publish time, Browser Rendering opens the deck at 1920×1080, and the kit reports the slides that overflow. The publish response returns that audit, and the CLI prints it. The deck thumbnails show the first slide.
- A second Access application bypasses Access for `/s/*`. On that path the Worker checks only the share token, which is 32 random bytes.
- A person writes comments on a page in the viewer. D1 stores them. A comment with `@claude` or `@chatgpt` has that name as its mention.
- An outside assistant reaches pages and comments through the MCP connector at `/s/_mcp/<token>`. The connector token is 32 random bytes, and it is the only check on that path. The connector gives access to pages and comments only.

| Route | Auth | Does |
|---|---|---|
| `GET /` | Access | The library: a grid or a list of thumbnails, pinned pages first, with a filter for each repo and full-text search |
| `GET /p/<group>/<name>` | Access | The viewer for the latest version |
| `GET /p/<group>/<name>/v/<n>` | Access | The viewer for one version |
| `GET /raw/<group>/<name>/<n>` | Access | The page HTML, with the sandbox CSP |
| `GET /t/<group>/<name>/<n>/<light or dark>.webp` | Access | A thumbnail |
| `GET /pdf/<group>/<name>/<n>` | Access | A document or deck as a PDF attachment. The host caches it in R2. |
| `GET /s/_/favicon.svg`, `favicon.ico`, `apple-touch-icon.png` | None | The site icons, which share links show too |
| `GET /api/pages` | Access | The page list as JSON |
| `GET /api/search?q=<words>` | Access | The best match on each page, best page first |
| `PUT`, `DELETE /api/pages/<group>/<name>/pin` | Access | Pin or unpin a page |
| `POST /api/pages/<group>/<name>/refresh` | Access | Index the latest version and take its thumbnails again |
| `PUT /api/pages/<group>/<name>` | Access | Store a new version. The body is the HTML. |
| `DELETE /api/pages/<group>/<name>` | Access | Delete the page, its versions, its share links, its comments and its runs. The route also deletes the connector tokens that have this page as their scope. |
| `GET`, `POST /api/pages/<group>/<name>/shares` | Access | List or make share links. POST body: `{ "version": n }` or `{ "version": "latest" }` |
| `DELETE /api/shares/<token>` | Access | Revoke a share link |
| `GET /api/pages/<group>/<name>/comments` | Access | The comment threads of the page, each with its replies and with `run`, the latest sandbox run of the thread or `null`. `?status=open` or `?status=resolved` keeps one status. |
| `POST /api/pages/<group>/<name>/comments` | Access | Add a comment. Body: `{ "body": "...", "anchor": "...", "quote": "...", "parent_id": "..." }`. Only `body` is necessary. The author is the Access identity. |
| `PUT /api/comments/<id>/resolve` | Access | Resolve a thread |
| `GET`, `POST /api/connector-tokens` | Access | List or make connector tokens. POST body: `{ "label": "..." }`. The POST response has the `id`, the token and the `mcp_url`. The list has the `id`, the last 4 characters of the token, the `label`, the `slug` scope and `expires_at` of each token. |
| `DELETE /api/connector-tokens/<id>` | Access | Revoke a connector token by the `id` from the list. The route takes the whole token too. |
| `POST /s/_mcp/<token>` | Token | The MCP connector: one JSON-RPC 2.0 message for each request, with a JSON answer. `GET` returns 405. |
| `POST /s/_run/<run id>` | Run id | The sandbox runner reports the result of a run. The run id is a secret. |
| `GET /s/<token>` | Token | The shared page |
| `GET /s/<token>/pdf` | Token | The shared document or deck as a PDF attachment |

## The MCP connector

The connector speaks MCP Streamable HTTP with no session and no SSE. It supports the protocol versions `2025-06-18`, `2025-03-26` and `2026-07-28`.

A client of `2025-06-18` or `2025-03-26` starts with `initialize`. A client of `2026-07-28` sends no `initialize`. The connector applies the rules of `2026-07-28` to a request that has that version in the `MCP-Protocol-Version` header or in `params._meta`:

- `server/discover` returns `supportedVersions`, the capabilities (`tools`), the instructions and the server identity.
- `params._meta` must have `io.modelcontextprotocol/protocolVersion` and `io.modelcontextprotocol/clientCapabilities`. If one is missing, the connector answers 400 with the error `-32602`.
- The headers `MCP-Protocol-Version` and `Mcp-Method` must match the body. For `tools/call`, `Mcp-Name` must match the tool name. If a header is missing or different, the connector answers 400 with the error `-32020`.
- A version that the connector does not speak gets 400 with the error `-32022` and the list of supported versions. A method that the connector does not have gets 404 with the error `-32601`. `initialize` and `ping` are not methods of this version.
- Each result has `resultType: "complete"` and the server identity in `_meta`. The results of `tools/list` and `server/discover` have `ttlMs` and `cacheScope`.

The connector does not implement these parts of `2026-07-28`: `subscriptions/listen`, SSE responses, the `Origin` header check, `x-mcp-header` parameters, and the `io.modelcontextprotocol/logLevel` field. No tool needs input from the client, so no result has `resultType: "input_required"`.

| Tool | Does |
|---|---|
| `list_pages` | Lists each page with its slug, title, kind, latest version and number of open threads |
| `get_page` | Returns the title, the kind, the latest version and the stored HTML of one page. A short comment stands in for the kit CSS and for the kit JS, which are about 94 KB. |
| `list_comments` | Lists the threads with their replies. The default is the open threads. `slug`, `mention` and `status` are filters. |
| `edit_page` | Replaces exact text in the HTML of the latest version and stores a new version. Each `old_text` must occur exactly once. If an edit fails, the tool stores nothing. |
| `reply_to_comment` | Adds a reply to a thread. The author is the label of the connector token. `resolve: true` resolves the thread too. |

Each tool has a `title` and MCP tool `annotations`. The three read tools have `readOnlyHint: true`. `edit_page` and `reply_to_comment` have `readOnlyHint: false`, `destructiveHint: false` and `openWorldHint: false`, because an edit makes a new version and the old version stays.

A connector token can have a page scope (`slug`) and an end time (`expires_at`). The API makes tokens with no scope and no end time. The host makes a scoped token for each sandbox run.

- A token with a scope sees only its page in `list_pages` and `list_comments`. A tool call for another page, or for a comment on another page, returns a tool error.
- After `expires_at`, the connector answers 404, the same as for an unknown token.

Make a connector token, then call the connector:

```bash
curl -X POST $AGENT_PAGES_URL/api/connector-tokens -H 'content-type: application/json' -d '{"label":"chatgpt"}'
curl -X POST <mcp_url> -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

On the deployed host, the first command needs the Access service token headers too. The second command needs no headers for Access.

After a person writes a comment, the Worker calls `onCommentCreated` in `host/src/agents.ts`. That function calls `runSandboxAgent` in `sandbox.ts`.

For a comment with `@claude` or `@chatgpt`, `runSandboxAgent` sends a job to the sandbox runner at `SANDBOX_RUNNER_URL` and records the run in `agent_runs`. For `@claude`, the runner starts Claude Code with the Claude sign-in of the person. For `@chatgpt`, the runner starts Codex with the ChatGPT sign-in of the person. The assistant answers through the connector. Only development sets `SANDBOX_RUNNER_URL`. See `sandbox/README.md` for the test and `sandbox/CLOUD.md` for the cloud research.

`SANDBOX_AGENTS` is a comma list of the mentions that the runner handles. The default is `claude,chatgpt`. With `SANDBOX_AGENTS=claude`, a comment with `@chatgpt` starts no run.

Each run gets its own connector token. The token has the page of the comment as its scope, and it ends after 15 minutes. The host deletes the token when the runner reports the result of the run.

## Deploy the host

You need a Cloudflare account, a zone for the hostname, and Cloudflare Zero Trust (the free plan is enough). The host uses the `cf` CLI and Bun.

1. Install and test:
   ```bash
   cd host
   bun install
   bun run test
   ```
2. Copy `deploy.example.json` to `deploy.local.json`, and set `hostname` and `accessTeam`. Leave `accessAud` empty for now. Git ignores `deploy.local.json`. An optional `name` sets the name of the Worker, the D1 database and the R2 bucket. The default is `agent-pages`.
3. Create the storage and apply the migrations:
   ```bash
   cf auth whoami                       # confirm the account
   cf d1 create --name agent-pages
   cf r2 buckets create --name agent-pages
   bunx cf d1 migrations apply <database id> --dir migrations
   ```
4. Build and deploy:
   ```bash
   bunx vite build --mode production
   bunx cf deploy --prebuilt --mode production
   ```
   With no `accessAud`, the Worker refuses every request except share links.
5. In Cloudflare Zero Trust:
   - Make a service token for the CLI.
   - Make a self-hosted application for the hostname. Give it an Allow policy for your email and a Service Auth policy for the token.
   - Make a second self-hosted application for `<hostname>/s/*` with a Bypass policy for everyone.
6. Put the AUD tag of the first application in `deploy.local.json` as `accessAud`, then build and deploy again.
7. Set these variables in your shell profile:
   ```bash
   export AGENT_PAGES_URL=https://<hostname>
   export AGENT_PAGES_CLIENT_ID=<service token client ID>
   export AGENT_PAGES_CLIENT_SECRET=<service token client secret>
   ```
8. Publish a page:
   ```bash
   agent-pages publish skills/explain/examples/gallery.html --slug example/gallery
   ```

To run the host locally, apply the migrations to the local database and start Vite. Local mode has no Access check. The local browser simulator cannot take screenshots, so local mode uses the real Browser Rendering service of the account that `cf` signs in to.

In local mode, the dev server prints three lines `Error: internal error; reference = <id>` some seconds after each publish and each `edit_page` call. The cause is the thumbnail task. It calls Browser Rendering through the remote binding after the Worker sent the response. The request itself is not affected. A request that takes its screenshots before the response, such as `POST /api/pages/<group>/<name>/refresh`, prints no such line.

```bash
bunx cf d1 migrations apply 00000000-0000-4000-8000-00000000a271 --local --persist-to .cloudflare/state --dir migrations
bunx vite --port 8787
AGENT_PAGES_URL=http://localhost:8787 agent-pages publish <page>
```

## License

MIT. `NOTICE.md` lists the code and design values that come from other projects.
