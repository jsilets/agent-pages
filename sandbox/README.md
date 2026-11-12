# The assistant sandbox

A person writes `@claude` in a comment. The host starts the unmodified Claude Code program in a sandbox. Claude Code uses the Claude sign-in of that person. It reads the comment through the MCP connector, edits the page, and replies.

A comment with `@chatgpt` starts the unmodified Codex program in the same way. Codex uses the ChatGPT sign-in of that person.

This folder is a test. It proves the loop on one machine and measures the time. `PERF.md` has the measurements. `COST.md` has the price on Cloudflare for each warm policy. `CLOUD.md` describes where the sandbox can run later.

| File | Purpose |
|---|---|
| `local-runner.mjs` | The runner: an HTTP server that takes jobs, with a queue for each user. In docker mode it owns the containers. |
| `run-comment.mjs` | One run: the arguments of the program, the readers of its output, the progress events, the result. |
| `egress-proxy.mjs` | The only way out of the network of the containers. It also keeps the connector token away from them. |
| `Dockerfile` | Three images: one for Claude Code, one for Codex, and the egress image (Node and the proxy). |
| `connect.mjs` | Signs one person in to Claude or ChatGPT in their volume. |
| `verify-controls.mjs` | Tries each forbidden thing in a real container. |
| `fake-progress.mjs` | Replays the progress events of a run, for work on the viewer. |
| `measure.mjs` | Writes one comment and prints the times. |
| `codex-standin.mjs` | Runs `codex exec` in the Codex image with a stand-in model and a stand-in connector. |
| `cost.mjs`, `cost-inputs.json` | The price of each warm policy, from the measured inputs. `COST.md` explains them. |
| `samples/` | Recorded output of Claude Code and Codex, for the tests. |

## How a run works

1. A person posts a comment with `@claude`. The Worker stores the comment and answers.
2. `runSandboxAgent` in `host/src/sandbox.ts` makes a new connector token for the run. The token has the label `claude`, it reaches only the page of the comment, and it ends after 15 minutes. The function adds a row to `agent_runs` with the status `running`, and it sends the job to `SANDBOX_RUNNER_URL`.
3. The runner checks the secret and the job, puts the job in the queue of the user, and answers 202.
4. docker mode: the runner checks that the user has a sign-in volume for the engine. With none, the run ends as `not_signed_in` at once, and no container starts. Else the runner starts the container of the user for that engine, or takes the one that waits. It tells the egress proxy the connector URL of the run.
5. `run-comment.mjs` gives the prompt to Claude Code on stdin. In docker mode the program can be one that waits already.
6. Claude calls `list_comments` and `get_page`. For an edit it calls `edit_page` with `reply`, so one call stores the edit and the answer. For a question it calls `reply_to_comment`. The runner reads each event of the program and sends progress events to the host.
7. When the result of the stored reply arrives, the runner sends the result to `POST /s/_run/<run id>`. The Worker stores `done` or `failed`, and it deletes the connector token of the run. Claude then writes one last line, and the program ends.
8. docker mode: the runner starts the next program, which waits for the next job of this user. After 90 seconds with no job (`SANDBOX_IDLE_MS`), the runner removes the container.

The Worker does not wait for the run. A run that sends no result shows as failed after 5 minutes.

docker mode checks one thing before a run: that the sign-in volume of the user for the engine exists. `connect.mjs` makes the volume at a sign-in, removes it at a sign-out, and removes it after a sign-in that did not finish. The runner never makes a volume. So with no volume the run ends as `not_signed_in` in about 50 ms, and no container starts. The check is one `docker volume inspect`.

A volume can still hold a sign-in that has ended. The run finds that. Claude Code with no sign-in ends by itself with "Not logged in", and the run reports `not_signed_in` after 0.6 to 2.4 seconds. Codex with no sign-in tries the model for about 15 seconds, so `codex login status` runs at the same time as the job and ends it in about 1.5 seconds. The runner then removes the container at once.

## The job

```json
{ "mcp_url": "https://<host>/s/_mcp/<token>", "comment_id": "<24 hex>", "slug": "<group>/<name>", "agent_label": "claude", "engine": "claude", "user": "<the author of the comment>", "callback_url": "https://<host>/s/_run/<run id>" }
```

`engine` is `claude` or `codex`. The default is `claude`. For a `@chatgpt` comment the host sends `"agent_label": "chatgpt"` and `"engine": "codex"`. `user` and `callback_url` are optional for `run-comment.mjs`.

Two optional fields set the model of one job: `model` (a model name) and `effort` (`low`, `medium`, `high`, `xhigh` or `max`). With no `model`, Claude Code uses `sonnet`, and Codex uses the default of the account. See "Environment of the runner".

The prompt is fixed text in `run-comment.mjs`, and it is the same for both engines. It contains the comment id, the slug and the label, and each one must have its exact shape. It never contains the comment text. The assistant reads the comment with `list_comments`.

## The runner

```bash
node sandbox/local-runner.mjs [--mode host|docker] [--port 8811]
```

| Route | Does |
|---|---|
| `POST /run` | Takes a job. 202 with `callback_url`. With no `callback_url` it waits and answers with the JSON of the run. 400 for a bad job, 401 for a bad secret, 429 for a full queue. |
| `POST /warm` | Body `{ "user": "…", "engine": "claude" }`. `engine` is optional, and the default is `claude`. docker mode: starts the container and the program before a job exists. The host calls it when a person opens a comment box (`POST /api/assistants/warm`). The runner starts nothing for an engine that the user has not connected. 202, or 200 with `warm: false` when warming is off. |
| `GET /health` | `{ "ok": true }` |

### Environment of the runner

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_RUNNER_SECRET` | none | With a value, `POST /run` and `POST /warm` need the same value in the header `x-runner-secret`. The host sends the header when its own `SANDBOX_RUNNER_SECRET` has a value. |
| `SANDBOX_CONNECTOR_ORIGINS` | none | A comma list of origins, for example `https://pages.example.com`. A job with another origin in `mcp_url` or `callback_url` gets 400. |
| `SANDBOX_CLAUDE_MODEL` | `sonnet` | The model of a Claude job that names none. An empty value gives the default model of the account. |
| `SANDBOX_CLAUDE_EFFORT` | none | `--effort` for a Claude job that names none. |
| `SANDBOX_CODEX_MODEL`, `SANDBOX_CODEX_EFFORT` | none | The same for Codex (`-m`, and `model_reasoning_effort`). |
| `RUN_TIMEOUT_MS` | `180000` | The time limit of one run. |
| `SANDBOX_MAX_QUEUE` | `5` | How many jobs of one user can wait while one runs. |
| `SANDBOX_IDLE_MS` | `90000` | docker mode: how long the container of a user stays after a run. `0` gives each run its own container. |
| `SANDBOX_WARM_MS` | `60000` | docker mode: how long a container from `POST /warm` stays with no job. `0` turns `/warm` off. A later `/warm` or run can make the time longer, never shorter. |
| `SANDBOX_DISCOVER_ORIGIN` | the first of `SANDBOX_CONNECTOR_ORIGINS`, then the origin of the last job | docker mode, with `SANDBOX_RUNNER_SECRET`: the host that answers `POST /s/_mcp/discover`. See "The egress proxy". |
| `SANDBOX_PREWARM` | `1` | docker mode: `0` starts no program before its job arrives. |
| `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `SANDBOX_PIDS` | `1g`, `2`, `256` | docker mode: the limits of one container. |
| `SANDBOX_EGRESS_ALLOW` | see "The egress proxy" | docker mode: a comma list of hosts, in place of the default list. |
| `SANDBOX_CLAUDE_IMAGE`, `SANDBOX_CODEX_IMAGE`, `SANDBOX_EGRESS_IMAGE` | `agent-pages-sandbox-claude`, `agent-pages-sandbox-codex`, `agent-pages-egress` | docker mode: the three images. The runner builds a missing image from its target in `Dockerfile`. It does not rebuild an image that exists, so build again after a change. |
| `SANDBOX_RECORD_DIR` | none | For tests: a folder that gets each output line of each program. The lines have page text. |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | host mode: another binary. |

### The log

The runner prints one JSON object on each line. A run gives one line:

```json
{"at":"2026-11-12T04:54:23.031Z","ev":"run","comment_id":"…","slug":"sandbox-perf/hp-1794459257","user":"25bf8e1a2393f110","engine":"claude","model":"claude-sonnet-5-5","status":"done","mode":"docker","warm":true,"cold_container":false,"ms_queue":1,"ms_container":0,"ms_init":72,"ms_first_token":888,"ms_first_tool":888,"ms_reply":5135,"ms_callback":5135,"ms_engine":6271,"ms_runner":6481,"num_turns":5,"total_cost_usd":0.0200475,"peak_memory_mb":214,"tools":"list_comments@889 get_page@1280 edit_page@2231 reply_to_comment@4233","timeline":"engine@0 init@72 message@888 …","callback_status":200,"progress_sent":9,"progress_accepted":9}
```

`user` is a hash. No line has the connector URL, the callback URL, a token or the secret. Other lines have `ev` as `start`, `infra`, `build`, `refused`, `discovered`, `discover_failed`, `container_started`, `container_stopped`, `warm`, `warm_failed` or `infra_failed`.

One `container_stopped` line gives what a cloud host bills for the life of one container:

```json
{"ev":"container_stopped","user":"25bf8e1a2393f110","engine":"claude","why":"idle","started_by":"warm","runs":2,"ms_start":259,"s_billable":117.212,"cpu_s":7.162865,"peak_memory_mb":366}
```

`s_billable` is the time from `docker run` to `docker rm`. `cpu_s` is `usage_usec` of the cgroup `cpu.stat`, read just before the stop. `why` is `idle`, `warm unused`, `timeout`, `not signed in`, `run end` or `exited`. A run line also has `container_cpu_s`: the CPU seconds of the container so far. The egress proxy has its own log (`docker logs agent-pages-egress-<port>`): one line for each tunnel, each refusal and each connector request, with the tool name and never the URL.

## Progress events

While a run is active, `run-comment.mjs` sends events to `POST <callback_url>/progress`. Nothing waits for the answer. A failed POST changes nothing in the run. Each POST has a time limit of 2 seconds.

```json
{ "seq": 1, "at": "2026-11-12T04:54:17.800Z", "kind": "started" }
{ "seq": 2, "at": "…", "kind": "tool", "tool": "list_comments" }
{ "seq": 5, "at": "…", "kind": "focus", "quote": "<the old_text of the edit>" }
{ "seq": 6, "at": "…", "kind": "typing", "quote": "<the old_text>", "text": "<the new_text so far>" }
```

| Kind | When |
|---|---|
| `started` | The program has the job. |
| `tool` | The model starts a tool call. `tool` is `list_comments`, `get_page`, `edit_page` or `reply_to_comment`. |
| `focus` | One time for each edit of an `edit_page` call: when `old_text` is complete, or when it has 80 characters. `quote` has at most 500 characters. When the event goes out at 80 characters, `quote` is the start of `old_text`. |
| `typing` | While `new_text` arrives: at most one event each 300 ms, then one event with the full text. `text` has at most 2000 characters. `quote` is `old_text`, at most 500 characters. |

`seq` starts at 1 for each run and grows by 1. The POSTs do not wait for each other, so the receiver must use `seq` for the order.

Claude Code runs with `--include-partial-messages`, so the runner reads the input of a tool call while the model writes it. `partialEdits` in `run-comment.mjs` reads `old_text` and `new_text` from JSON text that is not complete. In the tests, the `focus` event went out 0.5 to 1.0 s after the `tool` event of `edit_page`, and 0.2 to 1.2 s before the edit was stored.

Codex prints a tool call when its arguments are complete. So an edit gives `tool`, one `focus` and one `typing` at the same moment.

The final result still goes to `callback_url`: `{ "status": "done" | "failed" | "not_signed_in" | "timeout", "detail": "…" }`.

`fake-progress.mjs` replays a run with no assistant:

```bash
node sandbox/fake-progress.mjs http://localhost:8802/s/_run/<run id> ["old text" ["new text"]] [--result done|failed|not_signed_in] [--speed 2] [--dry]
```

## What Claude Code can do in a run

| Flag | Effect |
|---|---|
| `--mcp-config <file or JSON> --strict-mcp-config` | The connector is the only MCP server. |
| `--tools ""` | No built-in tool: no Bash, no file tool, no web tool. |
| `--allowedTools mcp__pages__list_comments,…` | The four connector tools run with no prompt. |
| `--disallowedTools mcp__pages__list_pages` | Claude does not get `list_pages`. |
| `--permission-mode dontAsk --permission-prompts none` | Claude Code denies each call that the allow list does not cover. |
| `--setting-sources ""` | No user, project or local settings. The sign-in is not a setting, and it stays. |
| `--disable-slash-commands --no-session-persistence` | No skills, and no transcript on disk. |
| `-p --input-format stream-json` | The prompt arrives on stdin as one JSON line. So the program can start before its job. |
| `--output-format stream-json --verbose --include-partial-messages` | One line for each event, with the parts of a message as they arrive. |
| `--model <name>`, `--effort <level>` | From the job or from the environment of the runner. |

A check with Claude Code 2.1.311 showed these tools in the `init` event, and no other tool: `mcp__pages__edit_page`, `mcp__pages__get_page`, `mcp__pages__list_comments`, `mcp__pages__reply_to_comment`.

No flag changes how Claude Code signs in. `--bare` is not in the list, because bare mode does not read a subscription sign-in.

The program also gets `DISABLE_AUTOUPDATER=1` and `ENABLE_CLAUDEAI_MCP_SERVERS=false`. The first stops the update check. The second stops the request for the claude.ai connectors of the account, which `--strict-mcp-config` ignores in any case.

One program takes one job. A second message to the same program would see the first conversation, and `/clear` does not work in this mode (`PERF.md` has the test).

## The environment of the child program in host mode

`run-comment.mjs` gives Claude Code and Codex an environment that it builds itself. The child gets `HOME`, `USER`, `PATH`, and `LOGNAME`, `TMPDIR`, `LANG` and `USE_BUILTIN_RIPGREP` when the parent has them. Claude Code also gets `CLAUDE_CONFIG_DIR`, with the default `$HOME/.claude`, and the two variables above. Codex also gets `CODEX_HOME` when the parent has it. The child gets no other variable of the parent, so no API key, no token and no runner secret reaches it.

`run-comment.mjs` fails the run when `HOME` or `USER` is missing. `local-runner.mjs` in host mode does not start when `HOME` or `USER` is missing. On macOS, Claude Code finds its Keychain entry by `USER`. With no `USER` it reports "OAuth session expired", which looks like a sign-in problem and is not one.

## The output

`runJob` returns one JSON object, and `run-comment.mjs` prints it:

| Field | Meaning |
|---|---|
| `ok`, `status` | `status` is `done`, `failed`, `not_signed_in` or `timeout`. `ok` is true for `done`. A run is `done` only when a reply is stored: a result of `reply_to_comment` with no error, or a result of `edit_page` with a `reply` that has an id. An `edit_page` result with `reply_error` stored the edit and no reply. |
| `engine`, `model` | `claude` or `codex`, and the model. For Codex with no model in the job, `model` is `default`, because `codex exec --json` does not print the model. |
| `warm` | True when the job went to a program that waited. |
| `ms_init`, `ms_first_token`, `ms_first_tool`, `ms_reply`, `ms_callback`, `ms_engine`, `ms_total` | Milliseconds from the start of `runJob`: the `init` event, the first model token, the first tool call, the stored reply, the POST of the result, the end of the program. |
| `tool_calls`, `timeline` | Each tool call with its time, and each event that the runner timed. |
| `progress_sent`, `progress_accepted` | How many progress events went out, and how many the host took. |
| `result`, `num_turns`, `duration_ms`, `duration_api_ms` | From the result of Claude Code. For Codex, `result` is the last message. |
| `total_cost_usd`, `usage`, `model_usage` | The estimate that Claude Code prints. A subscription pays no such amount for each run. Codex gives `usage` only. |
| `error`, `stderr_tail`, `exit_code` | For a failure. |

The runner adds `mode`, `ms_queue`, `ms_container`, `cold_container`, `peak_memory_mb` and `ms_runner`.

## Docker mode and its controls

```bash
node sandbox/local-runner.mjs --mode docker      # builds an image when it is missing
node sandbox/verify-controls.mjs                 # proves each control below for both images, with no sign-in and no model request
```

The runner makes three kinds of Docker objects. Their names have the port of the runner.

- The network `agent-pages-sandbox-<port>`. It is internal: it has no route to the outside.
- The container `agent-pages-egress-<port>` with `egress-proxy.mjs`. It is on that network and on the normal network.
- One container for each user and engine, `agent-pages-sbx-<port>-<engine>-<hash of the user>`, on the internal network only. It does nothing by itself. Each program starts in it with `docker exec`. The Claude container has the image `agent-pages-sandbox-claude` and the Claude volume of the user. The Codex container has `agent-pages-sandbox-codex` and the ChatGPT volume.

The runner removes all three when it gets SIGINT or SIGTERM, and when it starts.

Each control, and the check in `verify-controls.mjs` that proves it:

| Control | How | The check |
|---|---|---|
| Read-only root file system | `--read-only` | `touch` in `/etc`, `/work`, `/usr/bin` and `/home/runner` fails with "Read-only file system". |
| The only places to write | `--tmpfs /tmp` (64 MB, `noexec`), and the sign-in volume of the user for the engine | A write to `/tmp` and to the volume works. A copy of `busybox` in `/tmp` does not run. `docker inspect` shows one mount. |
| One program in each image | Two images from two targets of `Dockerfile` | The Claude image has `claude` and no `codex`, no Node and no `/codex-home`. The Codex image has the reverse. |
| Not root, no capability | `--user 10001:10001 --cap-drop ALL --security-opt no-new-privileges` | `id -u` is 10001. `CapPrm`, `CapEff` and `CapBnd` are 0. `NoNewPrivs` is 1. `chown` and `su` fail. |
| Limits | `--pids-limit 256 --memory 1g --memory-swap 1g --cpus 2` | The cgroup files have 256, 1073741824, 0 and `200000 100000`. A loop that starts 400 processes gets "can't fork". A program that takes more than 1 GB is killed (`oom_kill 1`). |
| No inbound port | No `-p`. The network is internal. | `docker inspect` shows no port and one network, and the network has `Internal: true`. |
| Egress allow list | The internal network, and the proxy as `HTTPS_PROXY` | A direct connection to `1.1.1.1` fails with "Network unreachable". No outside name resolves. `CONNECT` to `example.com:443`, to port 80, to an IP address and to `host.docker.internal:8804` gets 403. `CONNECT` to the model hosts gets 200. Plain HTTP through the proxy gets 403. |
| The connector token stays outside | The program gets `http://<proxy>:3128/mcp`. The proxy knows the real URL for the address of the container, only while the run is active. | A connector request gets 503 before the run, 200 in the run, 503 after it. The token is not in a command line of the container, in its environment, in `docker inspect`, or in the proxy log. |
| The proxy control port | A secret of 32 random bytes that the runner makes at its start. It reaches the proxy in the environment of the `docker` program, not as an argument. | A request from a container to port 3129 gets 401. |
| Time limit | After `RUN_TIMEOUT_MS` the runner removes the container (`docker rm -f`), with every process in it. | A program that sleeps 600 s: the run reports `timeout` after 2.1 s, and `docker ps -a` has no such container. |
| One run for each user, and a queue limit | `userQueue` in `local-runner.mjs` | A unit test: two jobs of one user never run together, and the job after `SANDBOX_MAX_QUEUE` waiting jobs gets no place (429). |
| The shared secret | `x-runner-secret`, compared with `timingSafeEqual` over SHA-256 of both values | A unit test starts the real runner: no header and a wrong header get 401. |
| Logs with no secret | See "The log" | The unit tests search the logs of the runner and of the proxy for the token and for `/s/_mcp/`. |

`verify-controls.mjs` checks the container of each image. It prints 19 lines with `PASS` for each image, then `all checks passed`. `node sandbox/verify-controls.mjs claude` checks one image. `SANDBOX_DOCKER_TESTS=1 node --test tests/sandbox.test.mjs` runs it as a test.

Real runs with the controls on: 27 Claude runs in docker mode went through the proxy (15 on 2026-11-11, 12 on 2026-11-12). Its log for one run had tunnels to `api.anthropic.com` only, the four tool calls, and two refused tunnels to `http-intake.logs.us5.datadoghq.com` (telemetry of Claude Code).

### The egress proxy

The default allow list, port 443 only:

| Host | Needed for |
|---|---|
| `api.anthropic.com` | The model, for Claude Code. The only host that a run used. |
| `platform.claude.com` | Claude Code renews the sign-in here. No run used it. |
| `claude.ai`, `claude.com` | Sign-in of a Claude account. |
| `chatgpt.com` | The model, for Codex with a ChatGPT sign-in. The only host that a Codex run used. |
| `auth.openai.com` | The sign-in of ChatGPT. No run used it. The list has it so that Codex can renew a sign-in. |
| `api.openai.com` | Codex with an API key. Codex with no sign-in also tries this host. |

Source for Claude Code: https://code.claude.com/docs/en/network-config.md, "Network access requirements". `chatgpt.com` and `api.openai.com` come from the proxy log of Codex runs.

The proxy opens a tunnel and does not read it. It never sees a model request, a sign-in or a credential.

The connector is not on the list. The proxy itself calls the connector, at the URL that the runner gave it for the run.

A container that has no run gets a stored answer for `server/discover`, `initialize`, `notifications/initialized` and `tools/list`. They are the same for each token, because the connector has no session. This lets a program connect before its job arrives. The proxy gets these answers in two ways:

- The runner asks the host for them at `POST <host>/s/_mcp/discover`, with its secret in `x-runner-secret`, when the proxy starts and before it starts a program that waits. It sends the four requests that Claude Code 2.1.311 sends at its start, and it gives the answers to the proxy with `PUT /cache` on the control port. The proxy never gets the secret. This needs `SANDBOX_RUNNER_SECRET` on both sides and an origin (`SANDBOX_DISCOVER_ORIGIN`).
- The proxy keeps the answers of each real run.

With neither, the first job after a runner start starts its own program. After a deploy that changes the tools of the connector, restart the runner.

What the controls do not cover:

- Docker containers share the kernel of the machine. A kernel bug can pass each control here. `CLOUD.md` lists hosts that give each user a virtual machine.
- A program in a container can ask the Docker DNS for a name. The DNS of an internal network does not ask the outside (the check gets `SERVFAIL`). This was tested on OrbStack only.
- The model hosts can carry data out. The assistant has no tool that reads a file or runs a command, so it has only the page and the comments to send.
- The run id in `callback_url` and the token in `mcp_url` are in the memory of the runner and the proxy while the run is active.

### Sign in for docker mode

```bash
node sandbox/connect.mjs claude [user]       # Claude
node sandbox/connect.mjs chatgpt [user]      # ChatGPT
node sandbox/connect.mjs claude [user] --status
node sandbox/connect.mjs chatgpt [user] --logout
```

`user` is the author name that the host sends with a job. In development it is `local`, and that is the default. The command prints the two volume names of the user, `agent-pages-claude-<hash>` and `agent-pages-codex-<hash>`. It starts the sign-in of the program in the right volume, in a container of the image of that engine, with the same limits as a run and with the normal network. `--status` starts no container when the volume does not exist, so it makes no empty volume. `--logout` signs out and removes the volume.

Claude (`claude auth login`):

1. Claude Code prints a URL that starts with `https://claude.com/cai/oauth/authorize`. Open it in a browser.
2. Sign in on the Anthropic page and approve.
3. The Anthropic page shows a code. Paste it at the prompt `Paste code here if prompted >`.
4. Claude Code writes `/claude-config/.credentials.json` with mode `0600`. The file stays in the volume.

ChatGPT (`codex login --device-auth`):

1. Codex prints this text:
   ```
   Follow these steps to sign in with ChatGPT using device code authorization:

   1. Open this link in your browser and sign in to your account
      https://auth.openai.com/codex/device

   2. Enter this one-time code (expires in 15 minutes)
      DHB4-MFRHG
   ```
2. Open the link, sign in to ChatGPT, and type the code.
3. Codex writes its sign-in to `auth.json` in `CODEX_HOME`, which is `/codex-home`. The file stays in the volume. Source: https://developers.openai.com/codex/auth

Device code sign-in must be on for the ChatGPT account. A person turns it on in the security settings of ChatGPT. In a workspace, the admin turns it on in the workspace permissions. OpenAI calls this sign-in a beta.

Do not copy a credential file, and do not use `claude setup-token` for a hosted user. `setup-token` prints a token that the caller must store, and the Anthropic policy does not let a host store the Claude credentials of its users. See `CLOUD.md`.

## The Codex engine

A comment with `@chatgpt` goes to the runner when `SANDBOX_AGENTS` of the host has `chatgpt`. The default is `claude,chatgpt`.

`run-comment.mjs` starts `codex exec` with the same fixed prompt:

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
| `-m <model>`, `-c model_reasoning_effort=…` | From the job or from the environment of the runner. |

A check with Codex 0.167.1 showed what the model gets. A stand-in model provider stored the request that Codex sends. The request had these tools and no other tool: `mcp__pages.edit_page`, `mcp__pages.get_page`, `mcp__pages.list_comments`, `mcp__pages.reply_to_comment`, `functions.exec`, `functions.wait`, `functions.request_user_input` and `functions.request_user_input_async`. A run with the real model gave the same list. In that run, the script of `exec` had an empty `tools` object, and `apply_patch`, `exec_command` and `shell` were not functions.

Codex in docker mode:

- The image `agent-pages-sandbox-codex` has Codex 0.167.2 from the npm package `@openai/codex`, and no Claude Code. The build installs the package with `npm install -g` and copies three files of this platform into the image: `bin/codex`, `bin/codex-code-mode-host` and `codex-package.json`. No file changes. The image leaves out the voice host, `rg` and `bwrap`, which a run with only the connector never starts. The Node launcher of the package is not in the image, because the image has no Node. `node sandbox/codex-standin.mjs` runs `codex exec` in the image with a stand-in model and connector.
- `CODEX_HOME` is `/codex-home`, the ChatGPT volume of the user. The Codex container mounts no other volume.
- **The connector token is not on the command line.** The command line has `http://<proxy>:3128/mcp`, and the proxy has the real URL.
- **No `AGENTS.md` of the person loads.** `CODEX_HOME` is a volume that holds only what Codex writes. After a first start, the folder had the sign-in lock files, the SQLite files, `installation_id`, `log`, `tmp` and `shell_snapshots`, and no `AGENTS.md`.
- With no ChatGPT volume, a job ends in about 50 ms with `not_signed_in`, and no container starts. With a volume and no sign-in in it, the job ends in about 1.5 s. The viewer shows "ChatGPT: not connected".
- No program waits in a Codex container: `codex exec` takes its prompt as an argument.
- No real Codex run was made in a container, because no volume has a ChatGPT sign-in. One real run on this machine went through `egress-proxy.mjs` for the model and for the connector, with the same arguments as docker mode, and it was correct.

Codex in host mode:

- **The connector token is on the command line of Codex.** Codex has no config file for one run that keeps the sign-in. Another process of the same machine can read the command line while the run is active. The token reaches one page, ends after 15 minutes, and stops when the run ends.
- **Codex reads the global `AGENTS.md` of the person** (`$CODEX_HOME/AGENTS.md`, default `~/.codex/AGENTS.md`). No flag turns it off.

For both modes:

- `exec` runs JavaScript in an isolate with no file system and no network. `wait` and `request_user_input` do nothing useful in a run.
- `codex exec --json` does not print the model. A run without `--json` and with the same arguments printed `model: gpt-6.1-sol`, the default of the signed-in account.

## Run it: host mode

Host mode uses the `claude` and the `codex` that are installed and signed in on this machine. Use it only with your own sign-ins. It has none of the controls of docker mode, and each run starts a new program.

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

`measure.mjs` writes one comment and prints the times from the comment POST. The runner log has one line for each run, with the time of each tool call.

Host mode starts `claude` or `codex` from `PATH`. Node starts the binary with no shell, so no shell alias applies.

## Run it: docker mode

```bash
node sandbox/connect.mjs claude                  # one time for each user
node sandbox/local-runner.mjs --mode docker
```

Start the host as in host mode. To use the shared secret, give the host and the runner the same `SANDBOX_RUNNER_SECRET`.

A container reaches the dev server as `host.docker.internal`. The runner changes `localhost` in `mcp_url` for the proxy, and `host/vite.config.ts` lets the dev server take that host name. The runner itself posts the result and the progress, so `callback_url` stays as it is.

## Tests

```bash
node --test tests/sandbox.test.mjs                              # 32 tests, no Docker, no sign-in, no network
SANDBOX_DOCKER_TESTS=1 node --test tests/sandbox.test.mjs       # adds verify-controls.mjs
cd host && npm run typecheck && npm run test
```

The tests of the stream readers use `samples/claude-edit.jsonl` and `samples/codex-edit.jsonl`: the output of one real run of each program, with the tool results cut.
