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
- The raw route gives each `.k-claim` section with no id the id `claim-<n>`. A search result links to `/p/<group>/<name>#claim-<n>`. The viewer passes the hash to the frame, and the view scrolls to the claim one time, after the page reports its height.
- The viewer shows each page in an `<iframe>` with the `sandbox` attribute. The page HTML comes from a route that sends `Content-Security-Policy: sandbox`. So the script in a page runs with no origin, and it cannot read the host's cookies or call its API.
- Cloudflare Access protects the whole hostname. A person signs in with Access. The CLI sends an Access service token.
- The Worker checks the Access JWT on each request too. Access at the edge is the first check, and the Worker is the second.
- A page whose `<main>` has the class `k-deck` is a deck, and D1 stores `kind = 'deck'` for it. At publish time, Browser Rendering opens the deck at 1920×1080, and the kit reports the slides that overflow. The publish response returns that audit, and the CLI prints it. The deck thumbnails show the first slide.
- A second Access application bypasses Access for `/s/*`. On that path the Worker checks only the share token, which is 32 random bytes.
- A person writes comments on a page in the viewer. D1 stores them. A comment with `@claude` or `@chatgpt` has that name as its mention.
- An outside assistant reaches pages and comments through the MCP connector at `/s/_mcp/<token>`. The connector token is 32 random bytes, and it is the only check on that path. The connector gives access to pages and comments only.
- The host records the visits to share links on the model of Papermark and DocSend. One load of a link is one visit. The share page counts time only while the tab shows and the reader was active in the last 5 minutes, on the slide or section on screen. It reports every 10 seconds and with `sendBeacon` when the tab hides or closes. Completion is the share of the parts that the visit saw for at least 1 second.
- Sharing follows Google Docs and DocSend. A page has two kinds of share link:
  - A link for one person (`kind = 'person'`). The owner adds the person by name, and the Views page names each visit by that person.
  - The public link (`kind = 'public'`). General access turns it on as "Anyone with the link". When the owner turns General access off, the host revokes the public link. The links for each person keep working.
- The owner can require an email on the public link, as DocSend does. The share page then shows a form for the email before the page. The host stores the email in `share_passes` and sets the `ap_pass` cookie on the path of that one link for 30 days. Without a pass, the page, its raw HTML and its PDF return 403. The host does not verify the email. A person who signed in to the host skips the form.
- A visit keeps no IP address. It keeps an email only when the reader gave one at the form. A visitor is a hash of the IP address and the browser with a random salt of one day, and the host deletes each salt after two days. Link previews, crawlers, headless browsers and people who signed in to the host do not count. The owner sees the visits on the Views page of each document, `/p/<group>/<name>/views`.
- The host records which version of each page a person last saw and when they last opened it. The library uses the record for the blue dot of a new version, for Recent, and for the sort by the last open.

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
| `DELETE /api/pages/<group>/<name>` | Access | Delete the page, its versions, its share links and their visits, its comments and its runs, and what each reader opened. The route also deletes the connector tokens that have this page as their scope. |
| `GET`, `POST /api/pages/<group>/<name>/shares` | Access | List or make share links. POST body: `{ "version": n }` or `{ "version": "latest" }`, and `"kind"`: `"person"` with a `"name"`, or `"public"` with an optional `"require_email": true` |
| `PATCH /api/shares/<token>` | Access | Turn the email requirement of the public link on or off. Body: `{ "require_email": true }` |
| `DELETE /api/shares/<token>` | Access | Revoke a share link. Its visits stay. |
| `GET /api/activity` | Access | The pages, the activity list and what the reader opened, for the library to poll |
| `GET`, `POST /api/folders` | Access | List or make folders. POST body: `{ "name", "color", "parent_id" }` |
| `PATCH`, `DELETE /api/folders/<id>` | Access | Rename, recolor or move a folder, or delete it and move its pages and folders to its parent |
| `PUT /api/pages/<group>/<name>/folder` | Access | Move a page to a folder. Body: `{ "folder_id" }`, or null for no folder |
| `GET /p/<group>/<name>/views` | Access | The Views page of a document: the totals, the average time on each part, each visit, and the links |
| `GET /api/pages/<group>/<name>/views` | Access | The same data as JSON |
| `PUT /api/pages/<group>/<name>/seen` | Access | Record that the reader saw a version in Activity. Body: `{ "version": n }` |
| `GET /api/pages/<group>/<name>/comments` | Access | The comment threads of the page, each with its replies. `run` is the latest sandbox run of the thread or `null`. `runs` has the latest run of each comment that started one, by comment id. `?status=open` or `?status=resolved` keeps one status. |
| `POST /api/pages/<group>/<name>/comments` | Access | Add a comment. Body: `{ "body": "...", "quote": "...", "prefix": "...", "suffix": "...", "anchor": "...", "slide": "...", "parent_id": "..." }`. Only `body` is necessary. `prefix` and `suffix` are the text before and after the quote. The host keeps at most 64 characters of each, next to the quote, and drops them for a comment with no quote. `slide` is the id of the deck slide, at most 200 characters. The host stores the latest version with the comment. The author is the Access identity. |
| `PATCH /api/comments/<id>` | Access | Change the body of your own comment. Body: `{ "body": "..." }`. The host sets `edited_at` and reads the mention again. A changed mention starts no run. The route answers 403 for the comment of another person. |
| `DELETE /api/comments/<id>` | Access | Delete your own comment. The first comment of a thread takes the thread with it: its replies, its runs, their events and their connector tokens. The answer is `{ "deleted": n }`. |
| `PUT`, `DELETE /api/comments/<id>/resolve` | Access | Resolve a thread, or open it again. The route answers 204, or 404 for an unknown id. |
| `POST /api/assistants/warm` | Access | Ask the sandbox runner to get ready for the person. The host sends `POST <runner origin>/warm` with `{ "user": "..." }` and the header `x-runner-secret`, at most one time in 60 seconds for each person. The route answers 202 with `{ "sent": true }` or `{ "sent": false }`. |
| `GET /api/assistants` | Access, same origin | The state of Claude and ChatGPT for the person: `handled`, `connected` (`null` when the runner did not answer), `models`, `default_model`, the saved `model`, and `error` when the runner could not check that sign-in. See "Assistants". |
| `PUT /api/assistants/<claude or chatgpt>` | Access, same origin | Save the model of the person. Body: `{ "model": "<id>" }` with an id from `models`, or `{ "model": null }` for the default. |
| `POST /api/assistants/<claude or chatgpt>/connect` | Access, same origin | Start a sign-in. The answer is `{ id, url, user_code?, needs_code, expires_at }`. |
| `GET /api/assistants/connect/<id>` | Access, same origin | The state of a sign-in of the person: `pending`, `connected`, `failed` or `expired`. |
| `POST /api/assistants/connect/<id>/code` | Access, same origin | Send the code from Claude's page. Body: `{ "code": "..." }`. The host passes the code straight to the runner. It never stores or logs it. |
| `DELETE /api/assistants/<claude or chatgpt>/connection` | Access, same origin | Disconnect the assistant. |
| `POST /api/comments/<id>/run` | Access | Start the run of a comment again. The comment must have `@claude` or `@chatgpt`. The route answers 202, or 409 while a run of the comment is running, or 503 with no sandbox runner. |
| `GET /api/pages/<group>/<name>/activity?since=<cursor>` | Access | The latest version of the page, a `cursor`, and `runs`: the state of each run that is running or that changed after `since`. The answer has no `runs` when the cursor did not move. |
| `GET`, `POST /api/connector-tokens` | Access | List or make connector tokens. POST body: `{ "label": "..." }`. The POST response has the `id`, the token and the `mcp_url`. The list has the `id`, the last 4 characters of the token, the `label`, the `slug` scope and `expires_at` of each token. |
| `DELETE /api/connector-tokens/<id>` | Access | Revoke a connector token by the `id` from the list. The route takes the whole token too. |
| `POST /s/_mcp/<token>` | Token | The MCP connector: one JSON-RPC 2.0 message for each request, with a JSON answer. `GET` returns 405. |
| `POST /s/_run/<run id>` | Run id | The sandbox runner reports the result of a run. The run id is a secret. |
| `POST /s/_run/<run id>/progress` | Run id | The sandbox runner reports one progress event of a run that is running. An unknown run and a run that has ended get 404. |
| `GET /s/<token>` | Token | The shared page, or the email form when the link requires an email and the reader has no pass |
| `GET /s/<token>/pdf` | Token, and a pass when the link requires an email | The shared document or deck as a PDF attachment |
| `POST /s/<token>/pass` | Token, same origin | Give an email at the form. Body: `{ "email" }`. The host sets the `ap_pass` cookie. A bad email gets 400. |
| `POST /s/<token>/view`, `POST /s/<token>/ping` | Token, same origin | The share page starts a visit and reports the time on each part. Other origins get 403. |

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

With `SANDBOX_RUNNER_SECRET` set, the host sends that value as the header `x-runner-secret` with each job. Only development reads it, from the environment.

`SANDBOX_AGENTS` is a comma list of the mentions that the runner handles. The default is `claude,chatgpt`. With `SANDBOX_AGENTS=claude`, a comment with `@chatgpt` starts no run.

Each run gets its own connector token. The token has the page of the comment as its scope, and it ends after 15 minutes. The host deletes the token when the runner reports the result of the run.

## Comments in the viewer

The viewer shows comments in a column at the right of the page, next to the text that they are about.

The view has one scroll bar, at the right edge of the window, under the bar. It scrolls the page and the comment column together, so a card never lags behind its text. The frame of a page is as tall as the page: the kit reports the height (`size`), and the page does not scroll itself in the viewer. The viewer checks each height. It allows at most 200,000 px, and it stops a page that grows with its frame after 6 growths in 2 seconds. Keys that scroll, links to `#id` and the cursor of an assistant ask the viewer to scroll. With cards beside it, the page keeps the width that it reads best at, and the page and the column sit together in the middle of the window, as in Google Docs.

- Select text in the page. The selection can cross inline elements, paragraphs, lists, tables, code and diagram labels. A "Comment" button appears next to the selection. Click it, or press Cmd+Alt+M (Ctrl+Alt+M on Windows and Linux). A comment box opens in the column, level with the text. Enter starts a new line. Cmd+Enter or Ctrl+Enter posts the comment. Esc closes the box.
- The comment button in the bar opens a box for a comment on the whole page. These comments show at the top of the column.
- Each card shows the first lines of its thread. A click on a card or on its marked text opens the card, moves it a little to the left, and shows the replies and a reply box. The other cards move up or down so that no two cards overlap. The cards follow the page when it scrolls.
- The ⋯ menu on your own comment has "Edit" and "Delete". "Delete" asks to confirm. On the first comment of a thread, it deletes the whole thread. An edited comment shows "Edited".
- After a post, the focus goes to the new card. Tab reaches its buttons and its reply box. Esc closes the box or the card, and the focus goes back to where it was: the page or the bar button.
- A card shows the name of the author. An Access email such as `ann.lee@example.com` shows as "Ann Lee" with the initials "AL".
- "Resolve" on a card hides the thread. The bar then shows "N resolved". That button lists the resolved threads, each with "Reopen".
- Type `@` in a box to pick an assistant from a list. The list shows when an assistant is not connected. The viewer asks the runner to warm up when a person focuses a comment box (see `POST /api/assistants/warm`).

The frame sends the selected text to the viewer with `postMessage`. The kit (`Explain.describeSelection`) makes the quote and up to 32 characters of text before and after it. The viewer stores these with the id of the nearest element, the slide id and the version. The viewer checks the type and the length of each field in each message from the frame.

When the page changes, `Explain.anchorQuote` finds each quote again. It finds all copies of the quote and picks the copy whose text before and after matches best. A card has one of these states:

- The quote is in the page: the page marks it.
- The quote changed or is gone: the card shows "Original text changed" and the old quote with a line through it. The card stays next to the start of the quote that is still there, or next to the text that was before it. The page marks no text, so a wrong mark never shows.
- The page has no place for the quote: the card goes to the top of the column.

The page marks text with the CSS Custom Highlight API. A browser with no support for that API gets boxes behind the text. Add `?hl=boxes` to the viewer URL to see the boxes in any browser.

The column changes with the width of the window:

- Wide (1000 px and more): the column is 316 px.
- Medium (700 to 999 px): a strip of 40 px beside the page shows a marker for each thread. A click on a marker opens its card next to the marker.
- Narrow (under 700 px): a gutter of 30 px beside the page shows the markers, so a marker never covers text. A tap on a marker opens the thread in a sheet at the bottom of the window.

In a deck, the column shows the threads of the current slide. A slide with no thread gets the whole width. The deck stays in the slide view in the viewer. The slide thumbnails show the number of open threads of each slide.

An old version (`/p/<group>/<name>/v/<n>`) shows its comments read-only, with a note in the column. It has no comment box, no reply box, no Resolve and no menu. A shared page (`/s/<token>`) shows no comments: the people of the share link do not see the discussion.

When a person writes a comment with `@claude` or `@chatgpt`, the assistant cursor starts at the quote of that comment. It does not wait for the first event of the run. When the run ends, the reply appears in the card.

## Run activity

While an assistant works, the viewer shows it in three places:

- The comment gets a reaction with the name of the assistant. A run that fails shows one line with a "Try again" button. A run with no sign-in shows "not connected" with a "Connect" button.
- The bar shows a chip, for example "Claude is editing". A click on the chip scrolls the page to the cursor.
- The page shows a cursor with the name of the assistant. The cursor moves to the text that the assistant replaces. The new text types in at the same place, and the old text fades and goes as the new text grows. The stored page does not change until `edit_page` stores the new version. An `edit_page` call with more than one edit shows each edit in turn.

When the page has a new version, the viewer loads it in a second frame with the same sandbox. The new frame reports its height first. The viewer waits until the cursor has typed its text, at most 4 seconds. Then the viewer puts the new frame over the old frame at the same scroll position, and it updates the version in the bar. The text after the edit does not move. The viewer does not reload.

### The events

The table `run_events` holds a short list of events for each run. The events come from two senders:

- The host stores an event for the start of a run, for each tool call of the run's connector token, for each edit of an `edit_page` call (with the exact old text and new text), for the stored version, and for the end of the run. These events need no support from the runner.
- The sandbox runner sends events to `POST /s/_run/<run id>/progress` while the assistant writes the tool call. These events arrive earlier, so the cursor moves earlier.

A progress event is one JSON object of at most 16 KB:

```json
{ "seq": 1, "at": "2026-01-01T00:00:00.000Z", "kind": "started" }
{ "seq": 2, "at": "...", "kind": "tool", "tool": "get_page" }
{ "seq": 5, "at": "...", "kind": "focus", "quote": "<the old_text, at most 500 characters>" }
{ "seq": 6, "at": "...", "kind": "typing", "quote": "<the old_text>", "text": "<the new_text so far, at most 2000 characters>" }
```

- `seq` is a whole number from 1 to 5000. It increases with each event of the run. The host ignores an event with a `seq` that is not above the highest `seq` that changed the state. So a late event and a repeated event do not move the cursor back.
- `at` is optional. `tool` can be the name that Claude Code uses, such as `mcp__pages__edit_page`. The host keeps the part after the last `__`.
- `quote` and `text` are HTML from the tool call, and they can end in the middle of a tag. The host cuts longer values, converts both to plain text, and stores the plain text. The viewer never gets the HTML.
- For a `focus` event, the host reads the page and adds the text before the quote and the last element id before the quote. The page uses them to select one of two equal quotes.
- A run keeps only its newest `typing` event.
- The route answers 200 with `{ "seq": n }`, 400 for a bad event, and 404 for an unknown run or a run that has ended.

The host does not store the state of a run. `reduceActivity` in `host/src/run-activity.ts` makes the state from the events: `phase` (`starting`, `reading`, `editing`, `replying`, `done` or `failed`), `tool`, `quote`, `text`, `final`, `before`, `anchor` and `version`. After the host saw the `edit_page` call, `final` is true and the text is exact.

### The transport

The viewer polls `GET /api/pages/<group>/<name>/activity?since=<cursor>`. It polls every 500 ms while a run is running on the page and for 10 seconds after a comment. At other times it polls every 2 seconds, so a version that an agent publishes shows within about 2 seconds. A hidden tab does not poll. The route makes one query that reads two rows. When the cursor moved, it makes two more queries: the runs of the page and the events of the page. The host uses polling because a Worker has no memory between requests, so Server-Sent Events from a Worker must poll D1 too.

An idle open viewer makes 30 requests a minute (1,800 an hour), each with one query that reads two rows. For a run of 20 seconds, one open viewer makes about 40 requests. About 25 of them find new events. One run costs about 1,500 to 2,500 D1 row reads for each open viewer, and about 30 to 45 D1 writes.

### The page side

The viewer sends the state to the page frame with `postMessage`. The frame keeps its sandbox and its opaque origin. The kit runtime in the page (`kit/explain.js`, `runPresence`) listens only to its parent window, and it adds no element until the first message. It shows each text with `textContent`. The viewer accepts a message only from one of its own frames, and it reads only numbers and booleans from it.

`Explain.findQuote` finds the quote in the text of the page. White space does not count, so a quote can cross inline elements and blocks. The start of a quote counts when the end is not in the page text. A quote that occurs two times needs the text before it or an element id. With neither one, the page marks no text and the cursor stays at the top of the window. In a deck, the page shows the slide that has the quote, unless the reader moved the deck in the last 2.5 seconds.

`host/dev/simulate-run.mjs` is a fake runner for work on the viewer. It plays one run with no assistant: it sends the progress events and it calls the real connector, so the page gets a new version and the thread gets a reply. It answers `POST /warm` with 202 and logs the user. It also fakes the sign-in routes of "Assistants", with a fake provider page for each assistant. `--connected claude,codex` sets the engines that start connected (the default is both). `--auto-approve` connects a ChatGPT sign-in after 3 seconds. A comment with `[multi]` gets an `edit_page` call with two edits.

```bash
node host/dev/simulate-run.mjs --port 8812
cd host && SANDBOX_RUNNER_URL=http://localhost:8812/run bunx vite --port 8787
```

`tests/browser/README.md` tells how to run the browser tests of the viewer in Chromium, WebKit and Firefox.

## Assistants

Each person connects Claude and ChatGPT with their own plan. The sandbox runner holds each sign-in. The host passes each request on with the identity of the person and the header `x-runner-secret`, and it checks each answer. The assistant routes take requests from the viewer of the host only: the host refuses a `Sec-Fetch-Site` of `cross-site` or `same-site`, and a write with another `Origin`.

The ⋯ menu in the bar and the `@` list in a comment box open "Assistants". The library shows the state of each assistant in a row at the bottom of its sidebar. The viewer shows it in a chip in the bar. Under 761 px the library has no sidebar, so its bar shows the chip. A click on the row or on the chip opens "Assistants" too. It shows the state of each assistant, a Connect or Disconnect button, and the models.

- Connect opens one main button, "Continue to Claude" or "Continue to ChatGPT". It opens the page of the provider in a new tab. The person signs in there.
- Claude then shows a code. The person pastes it into the dialog, with Cmd+V or with the Paste button. The dialog sends a pasted code at once.
- ChatGPT needs a short code that the dialog shows in large letters, with a Copy button. The dialog asks for the state every 2 seconds until it says "Connected".
- Disconnect needs a second click to confirm.
- The models come from the runner, for example "Faster" and "More careful". The default has a tag. A click saves the choice at once, and each job of that person carries `model`.

The runner contract: each request is `POST <runner origin><path>` with a JSON body and the header `x-runner-secret`. Each answer is JSON of at most 16 KB.

| Path | Body | Answer |
|---|---|---|
| `/status` | `{ user }` | `{ assistants: { claude: { connected, models: [{ id, label, note }], default_model }, chatgpt: { ... } } }` |
| `/connect` | `{ user, engine: "claude" or "codex" }` | `{ id, url, user_code?, needs_code, expires_at }` |
| `/connect/status` | `{ id }` | `{ status: "pending", "connected", "failed" or "expired", detail? }` |
| `/connect/code` | `{ id, code }` | `{ status, detail? }` |
| `/disconnect` | `{ user, engine }` | `{ ok }` |

The host keeps at most 8 models, each with an id that matches `[\w.:/@-]{1,100}`, a label of at most 40 characters and a note of at most 120. A sign-in `url` must be https (http to localhost in development only). The `id` must match `[\w-]{8,128}`, and a `user_code` must match `[A-Za-z0-9-]{4,32}`. The host keeps a sign-in for 30 minutes at most, and only its person can read it. A code is at most 2048 characters with no white space.

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
