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
- The host counts the views of each share link with no name, no cookie and no IP address. A visitor is a hash of the IP address and the browser with a random salt of one day, and the host deletes each salt after two days. A view records the active time, how far the reader got, the time on each section or slide, the device class, the country, the host of the referring page, and downloads. Link previews and headless browsers do not count. The owner sees the views in the Share menu of the page.
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
| `DELETE /api/pages/<group>/<name>` | Access | Delete the page, its versions, its share links and their views |
| `GET`, `POST /api/pages/<group>/<name>/shares` | Access | List or make share links. POST body: `{ "version": n }` or `{ "version": "latest" }` |
| `DELETE /api/shares/<token>` | Access | Revoke a share link and delete its views |
| `GET /api/activity` | Access | The pages, the activity list and what the reader opened, for the library to poll |
| `GET`, `POST /api/folders` | Access | List or make folders. POST body: `{ "name", "color", "parent_id" }` |
| `PATCH`, `DELETE /api/folders/<id>` | Access | Rename, recolor or move a folder, or delete it and move its pages and folders to its parent |
| `PUT /api/pages/<group>/<name>/folder` | Access | Move a page to a folder. Body: `{ "folder_id" }`, or null for no folder |
| `GET /api/pages/<group>/<name>/views` | Access | The views of the share links of a page: a line for each link, the time on each part, and the newest views |
| `PUT /api/pages/<group>/<name>/seen` | Access | Record that the reader saw a version in Activity. Body: `{ "version": n }` |
| `GET /s/<token>` | Token | The shared page |
| `GET /s/<token>/pdf` | Token | The shared document or deck as a PDF attachment |
| `POST /s/<token>/view`, `POST /s/<token>/ping` | Token, same origin | The share page starts a view and reports the reading time. Other origins get 403. |

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

```bash
bunx cf d1 migrations apply 00000000-0000-4000-8000-00000000a271 --local --persist-to .cloudflare/state --dir migrations
bunx vite --port 8787
AGENT_PAGES_URL=http://localhost:8787 agent-pages publish <page>
```

## License

MIT. `NOTICE.md` lists the code and design values that come from other projects.
