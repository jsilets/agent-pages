# The assistant sandbox

A person writes `@claude` in a comment. The host starts the unmodified Claude Code program in a sandbox. Claude Code uses the Claude sign-in of that person. It reads the comment through the MCP connector, edits the page, and replies.

A comment with `@chatgpt` starts the unmodified Codex program in the same way. Codex uses the ChatGPT sign-in of that person. See "The Codex engine" below.

This folder is a test. It proves the loop on one machine and measures the time. `CLOUD.md` describes where the sandbox can run later.

## How a run works

1. A person posts a comment with `@claude`. The Worker stores the comment and answers.
2. `runSandboxAgent` in `host/src/sandbox.ts` makes a new connector token for the run. The token has the label `claude`, it reaches only the page of the comment, and it ends after 15 minutes. The function adds a row to `agent_runs` with the status `running`, and it sends the job to `SANDBOX_RUNNER_URL`.
3. The runner answers 202 at once. It starts `run-comment.mjs`.
4. `run-comment.mjs` asks Claude Code if it has a sign-in (`claude auth status --json`). With no sign-in, the run ends with the status `not_signed_in`.
5. `run-comment.mjs` writes an MCP config that points at the connector. It starts `claude -p` with a fixed prompt.
6. Claude calls `list_comments`, `get_page`, `edit_page` and `reply_to_comment`.
7. `run-comment.mjs` sends the result to `POST /s/_run/<run id>`. The Worker stores `done` or `failed`, and it deletes the connector token of the run.
8. The viewer reads the run status with the comments every 5 seconds. It shows "Claude is working…" while the run is active. It shows "Claude: not connected" when the sandbox has no sign-in. It shows "Claude did not finish." for each other failure. For a `@chatgpt` run, the name in these lines is "ChatGPT".

The Worker does not wait for the run. A Worker gets 30 seconds in `waitUntil` after it answers, and a run can take longer. A run that sends no result shows as failed after 5 minutes.

## The job

```json
{ "mcp_url": "https://<host>/s/_mcp/<token>", "comment_id": "<24 hex>", "slug": "<group>/<name>", "agent_label": "claude", "engine": "claude", "user": "<the author of the comment>", "callback_url": "https://<host>/s/_run/<run id>" }
```

`engine` is `claude` or `codex`. The default is `claude`. For a `@chatgpt` comment the host sends `"agent_label": "chatgpt"` and `"engine": "codex"`. `user` and `callback_url` are optional for `run-comment.mjs`. An optional `model` sets the model of the engine.

The prompt is fixed text in `run-comment.mjs`, and it is the same for both engines. It contains the comment id, the slug and the label, and each one must have its exact shape. It never contains the comment text. The assistant reads the comment with `list_comments`.

## The environment of the child program

`run-comment.mjs` gives Claude Code and Codex an environment that it builds itself. The child gets `HOME`, `USER`, `PATH`, and `LOGNAME`, `TMPDIR`, `LANG` and `USE_BUILTIN_RIPGREP` when the parent has them. Claude Code also gets `CLAUDE_CONFIG_DIR`, with the default `$HOME/.claude`. Codex also gets `CODEX_HOME` when the parent has it. The child gets no other variable of the parent, so no API key and no token of the parent reaches it.

`run-comment.mjs` fails the run when `HOME` or `USER` is missing. `local-runner.mjs` in host mode does not start when `HOME` or `USER` is missing. On macOS, Claude Code finds its Keychain entry by `USER`. With no `USER` it reports "OAuth session expired", which looks like a sign-in problem and is not one.

## What Claude Code can do in a run

| Flag | Effect |
|---|---|
| `--mcp-config <file> --strict-mcp-config` | The connector is the only MCP server. |
| `--tools ""` | No built-in tool: no Bash, no file tool, no web tool. |
| `--allowedTools mcp__pages__list_comments,…` | The four connector tools run with no prompt. |
| `--disallowedTools mcp__pages__list_pages` | Claude does not get `list_pages`. |
| `--permission-mode dontAsk --permission-prompts none` | Claude Code denies each call that the allow list does not cover. |
| `--setting-sources ""` | No user, project or local settings. The sign-in is not a setting, and it stays. |
| `--disable-slash-commands --no-session-persistence` | No skills, and no transcript on disk. |
| `--output-format stream-json --verbose` | One line for each event. The runner times the first tool call. The last line is the result object that `--output-format json` prints. |

A check with Claude Code 2.1.322 showed these tools in the `init` event, and no other tool: `mcp__pages__edit_page`, `mcp__pages__get_page`, `mcp__pages__list_comments`, `mcp__pages__reply_to_comment`.

No flag changes how Claude Code signs in. `--bare` is not in the list, because bare mode does not read a subscription sign-in.

## The output

`run-comment.mjs` prints one JSON object:

| Field | Meaning |
|---|---|
| `ok`, `status` | `status` is `done`, `failed`, `not_signed_in` or `timeout`. `ok` is true for `done`. A run is `done` only when Claude called `reply_to_comment`. |
| `engine`, `model` | `claude` or `codex`, and the model. For Codex with no `model` in the job, `model` is `default`, because `codex exec --json` does not print the model. |
| `ms_total`, `ms_auth`, `ms_engine` | The whole run, the sign-in check, and the `claude -p` or `codex exec` process. |
| `ms_first_tool`, `t_first_tool`, `tool_calls` | The time from the start of the engine process to each tool call. |
| `result`, `num_turns`, `duration_ms`, `duration_api_ms` | From the result of Claude Code. For Codex, `result` is the last message and `num_turns` is 1. |
| `total_cost_usd`, `usage`, `model_usage` | The estimate that Claude Code prints. A subscription pays no such amount for each run. Codex gives `usage` only. |
| `error`, `stderr_tail`, `exit_code` | For a failure. |

The time limit is 180 seconds. `RUN_TIMEOUT_MS` changes it.

## The Codex engine

A comment with `@chatgpt` always goes to the runner. Codex signs in with the ChatGPT plan of the person.

The host sends a `@chatgpt` comment to the runner when `SANDBOX_AGENTS` has `chatgpt`. The default is `claude,chatgpt`.

`run-comment.mjs` asks Codex if it has a sign-in (`codex login status`). Then it starts `codex exec` with the same fixed prompt:

| Argument | Effect |
|---|---|
| `--json --ephemeral --skip-git-repo-check` | One JSON line for each event. No transcript on disk. |
| `--ignore-user-config --ignore-rules` | No `config.toml` and no `.rules` of the person: none of their MCP servers and hooks. The sign-in stays. |
| `-C <empty folder> -s read-only -c approval_policy="never"` | The working folder is empty. Nothing can write a file, and nobody can approve more. |
| `--disable shell_tool` | No tool that runs a command. |
| `--disable apps`, `plugins`, `skill_search`, `memories`, `hooks`, and 7 more | No apps of the ChatGPT account, no plugins, no skills, no memories, no hooks. `CODEX_OFF` in `run-comment.mjs` has the full list. |
| `-c agents.enabled=false -c web_search="disabled"` | No agent tools and no web search. |
| `-c skills.bundled.enabled=false -c skills.include_instructions=false` | No skill text in the prompt. |
| `-c features.code_mode.excluded_tool_namespaces=["functions","clock"]` | The JavaScript tool `exec` stays, and its script has no tool to call. |
| `-c mcp_servers.pages.url=…` | The connector is the only MCP server. |
| `-c mcp_servers.pages.enabled_tools=[…]` | The four connector tools. Codex does not get `list_pages`. |
| `-c mcp_servers.pages.omit_tools_from=["deferred","code_mode"]` | The model gets the four tools as direct tools. |
| `-c mcp_servers.pages.default_tools_approval_mode="approve"` | Each connector call runs with no prompt. |

A check with Codex 0.167.1 showed what the model gets. A stand-in model provider stored the request that Codex sends. The request had these tools and no other tool: `mcp__pages.edit_page`, `mcp__pages.get_page`, `mcp__pages.list_comments`, `mcp__pages.reply_to_comment`, `functions.exec`, `functions.wait`, `functions.request_user_input` and `functions.request_user_input_async`. A run with the real model gave the same list. In that run, the script of `exec` had an empty `tools` object, and `apply_patch`, `exec_command` and `shell` were not functions.

What the isolation does not cover:

- **The connector token is on the command line of Codex.** Codex has no config file for one run that keeps the sign-in. A separate `CODEX_HOME` would hold such a file, but the sign-in is in `CODEX_HOME` too, and the only way to move it is a copy of the credential file. So the run uses the normal Codex home and passes each setting with `-c`. Another process of the same machine can read the command line while the run is active. The token reaches one page, ends after 15 minutes, and stops when the run ends.
- **Codex reads the global `AGENTS.md` of the person** (`$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md`). No flag turns it off. The file is the person's own text, and it goes to the model with the prompt. A sandbox with a new Codex home has no such file.
- `exec` runs JavaScript in an isolate with no file system and no network. `wait` and `request_user_input` do nothing useful in a run.
- `codex exec --json` does not print the model. A run without `--json` and with the same arguments printed `model: gpt-6.1-sol`, the default of the signed-in account.
- Docker mode has no Codex. The image has Claude Code only, so a `codex` job in docker mode fails with "cannot start codex".

### What the local test measured for Codex

Host mode, Codex 0.167.1, model `gpt-6.1-sol`, date 2026-11-11, one Mac. The page was 889 bytes with no packed kit, so it is smaller than the 96 KB page of the Claude test in `CLOUD.md`. All times are from the comment POST.

| Comment | First tool call | Reply stored | Run ended | Tool calls |
|---|---|---|---|---|
| `@chatgpt make the second paragraph shorter` | 4.2 s | 13.7 s | 16.5 s | `list_comments`, `get_page`, `edit_page`, `reply_to_comment` |
| `@chatgpt fix the typo in the title` | 4.7 s | 12.8 s | 15.4 s | `list_comments`, `get_page`, `edit_page`, `reply_to_comment` |
| `@chatgpt make it better` (unclear) | 3.9 s | 8.1 s | 12.6 s | `list_comments`, `get_page`, `reply_to_comment` |

One `@claude` run on the same page, after these changes: first tool call 3.4 s, reply stored 12.2 s, run ended 15.0 s.

## Run it: host mode

Host mode uses the `claude` and the `codex` that are installed and signed in on this machine. Use it only with your own sign-ins.

```bash
# 1. The host, with its own state folder and the runner URL
cd host
bunx cf d1 migrations apply 00000000-0000-4000-8000-00000000a271 --local --persist-to .cloudflare/state-sandbox --dir migrations
CF_STATE_DIR=.cloudflare/state-sandbox SANDBOX_RUNNER_URL=http://localhost:8811/run bunx vite --port 8802 --strictPort

# 2. The runner, in a second terminal
node sandbox/local-runner.mjs --mode host

# 3. A page, then a comment
AGENT_PAGES_URL=http://localhost:8802 node cli/agent-pages.mjs publish <page.html> --slug sandbox-test/heat-pumps
node sandbox/measure.mjs http://localhost:8802 sandbox-test/heat-pumps "@claude fix the typo in the title"
node sandbox/measure.mjs http://localhost:8802 sandbox-test/heat-pumps "@chatgpt fix the typo in the title"
```

The `cf d1 migrations apply` command applies the migrations and then does not exit. Stop it with Ctrl-C after it prints the list of migrations.

`measure.mjs` writes one comment and prints the times from the comment POST. It prints `t_post`, the time of the POST. The runner log has one line for each run, with `t_first_tool` and the time of each tool call.

Host mode starts `claude` or `codex` from `PATH`. Node starts the binary with no shell, so no shell alias applies. `CLAUDE_BIN` and `CODEX_BIN` name another binary.

## Run it: docker mode

```bash
docker build -t agent-pages-sandbox sandbox
node sandbox/local-runner.mjs --mode docker
```

The image has Alpine, Node, and Claude Code from the signed apk repository of Anthropic. It has no Codex. It runs as the user `runner`, and it sets `USER=runner`, because Docker sets no `USER`. `CLAUDE_CONFIG_DIR` is `/claude-config`.

The runner gives each user one named volume, `agent-pages-claude-<hash of the user>`, and mounts it at `/claude-config`. The sign-in of one user stays in the volume of that user. No run mounts the volume of another user.

A container reaches the dev server as `host.docker.internal`. The runner changes `localhost` in the job URLs for docker mode, and `host/vite.config.ts` lets the dev server take that host name.

### Sign in for docker mode

A new volume has no sign-in. A run then ends with `not_signed_in`. Sign in one time for each user:

```bash
docker run --rm -it -v agent-pages-claude-<hash>:/claude-config --entrypoint claude agent-pages-sandbox auth login
```

`volumeOf(user)` in `local-runner.mjs` gives the volume name. The runner log does not print it, so compute it or read `docker volume ls`.

1. Claude Code prints a URL that starts with `https://claude.com/cai/oauth/authorize`. Open it in a browser.
2. Sign in on the Anthropic page and approve.
3. The Anthropic page shows a code. Paste it at the prompt `Paste code here if prompted >`.
4. Claude Code writes `/claude-config/.credentials.json` with mode `0600`. The file stays in the volume.

Check the result:

```bash
docker run --rm -v agent-pages-claude-<hash>:/claude-config --entrypoint claude agent-pages-sandbox auth status --json
```

Remove a sign-in with `auth logout` in place of `auth status --json`, or delete the volume.

Do not copy the credential file, and do not use `claude setup-token` for a hosted user. `setup-token` prints a token that the caller must store, and the Anthropic policy does not let a host store the Claude credentials of its users. See `CLOUD.md`.

## Tests

```bash
node --test tests/sandbox.test.mjs     # the pure parts of the two scripts
cd host && npm run typecheck && npm run test
```
