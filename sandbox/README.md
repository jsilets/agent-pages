# The assistant sandbox

A person writes `@claude` in a comment. The host starts the unmodified Claude Code program in a sandbox. Claude Code uses the Claude sign-in of that person. It reads the comment through the MCP connector, edits the page, and replies.

A comment with `@chatgpt` starts the unmodified Codex program in the same way. Codex uses the ChatGPT sign-in of that person.

This folder is a test. It proves the loop on one machine and measures the time. `PERF.md` has the measurements. `COST.md` has the price on Cloudflare for each warm policy. `CLOUD.md` describes where the sandbox can run later. `MODELS.md` has the model evaluation and the default model of each engine.

| File | Purpose |
|---|---|
| `local-runner.mjs` | The runner: an HTTP server that takes jobs, with a queue for each user. In docker mode it owns the containers. |
| `run-comment.mjs` | One run: the arguments of the program, the readers of its output, the progress events, the result. |
| `egress-proxy.mjs` | The only way out of the network of the containers. It also keeps the connector token away from them. |
| `Dockerfile` | Three images: one for Claude Code, one for Codex, and the egress image (Node and the proxy). |
| `signin.mjs` | The sign-in commands of each program, and the readers of their output. The runner and `connect.mjs` use it. |
| `connect.mjs` | Signs one person in to Claude or ChatGPT from a terminal, with the code of `POST /connect`. |
| `verify-controls.mjs` | Tries each forbidden thing in a real container. |
| `codex-path.mjs` | Runs the full docker path of a `@chatgpt` comment with a stand-in model, the real proxy and the real connector. |
| `runner-check.mjs` | Real runs against a runner: two users at the same moment, and a queue of comments from one user. |
| `eval/` | The model evaluation: documents, tasks, the harness `run.mjs`, the rubric `judge.md`, and the results. |
| `fake-progress.mjs` | Replays the progress events of a run, for work on the viewer. |
| `measure.mjs` | Writes one comment and prints the times. |
| `codex-standin.mjs` | Runs `codex exec` in the Codex image with a stand-in model and a stand-in connector. |
| `cost.mjs`, `cost-inputs.json` | The price of each warm policy, from the measured inputs. `COST.md` explains them. |
| `samples/` | Recorded output of Claude Code and Codex, for the tests. |

## How a run works

1. A person posts a comment with `@claude`. The Worker stores the comment and answers.
2. `runSandboxAgent` in `host/src/sandbox.ts` makes a new connector token for the run. The token has the label `claude`, it reaches only the page of the comment, and it ends after 15 minutes. The function adds a row to `agent_runs` with the status `running`, and it sends the job to `SANDBOX_RUNNER_URL`.
3. The runner checks the secret and the job, puts the job in the queue of the user, and answers 202.
4. docker mode: the runner checks that the user has a sign-in volume for the engine. With none, the run ends as `not_signed_in` at once, and no container starts. Else the runner starts the container of the user for that engine, or takes the one that waits. It tells the egress proxy the connector URL of the run and the hosts of a run of that engine.
5. `run-comment.mjs` gives the prompt to Claude Code on stdin. In docker mode the program can be one that waits already.
6. Claude calls `list_comments` and `get_page`. For an edit it calls `edit_page` with `reply`, so one call stores the edit and the answer. For a question it calls `reply_to_comment`. The runner reads each event of the program and sends progress events to the host.
7. When the result of the stored reply arrives, the runner sends the result to `POST /s/_run/<run id>`. The Worker stores `done` or `failed`, and it deletes the connector token of the run. Claude then writes one last line, and the program ends.
8. docker mode: the runner starts the next program, which waits for the next job of this user. After 90 seconds with no job (`SANDBOX_IDLE_MS`), the runner removes the container. It ends each Claude program by the end of its input, and never before the program is 30 seconds old. See "The minimum age of a Claude process".

The Worker does not wait for the run. A run that sends no result shows as failed after 5 minutes.

docker mode checks one thing before a run: that the sign-in volume of the user for the engine exists. A sign-in (`POST /connect` or `connect.mjs`) makes the volume. A sign-out removes it, and a sign-in that did not finish removes the volume that it made. A run never makes a volume. So with no volume the run ends as `not_signed_in` in about 50 ms, and no container starts. The check is one `docker volume inspect`.

A volume can still hold a sign-in that has ended. The run finds that. Claude Code with no sign-in ends by itself with "Not logged in", and the run reports `not_signed_in` after 0.6 to 2.4 seconds. Codex with no sign-in tries the model for about 15 seconds, so `codex login status` runs at the same time as the job and ends it in about 1.5 seconds. The runner then removes the container at once.

## The job

```json
{ "mcp_url": "https://<host>/s/_mcp/<token>", "comment_id": "<24 hex>", "slug": "<group>/<name>", "agent_label": "claude", "engine": "claude", "user": "<the author of the comment>", "callback_url": "https://<host>/s/_run/<run id>" }
```

`engine` is `claude` or `codex`. The default is `claude`. For a `@chatgpt` comment the host sends `"agent_label": "chatgpt"` and `"engine": "codex"`. `user` and `callback_url` are optional for `run-comment.mjs`.

Two optional fields set the model of one job: `model` (a model name) and `effort` (`low`, `medium`, `high`, `xhigh` or `max`). The `model` of the job wins over the default of the runner. With no `model`, Claude Code uses `sonnet`, and Codex uses `gpt-6.1-sol`. `MODELS.md` explains the choice. See "Environment of the runner".

The prompt is fixed text in `run-comment.mjs`, and it is the same for both engines. It contains the comment id, the slug and the label, and each one must have its exact shape. It never contains the comment text. The assistant reads the comment with `list_comments`.

## The runner

```bash
node sandbox/local-runner.mjs [--mode host|docker] [--port 8811]
```

Each route but `GET /health` takes POST with a JSON body. With `SANDBOX_RUNNER_SECRET`, each one needs the header `x-runner-secret`, and a wrong or missing header gets 401. `engine` is `claude`, `codex` or `chatgpt` (the same as `codex`).

| Route | Body | Answer |
|---|---|---|
| `/run` | The job | 202 with `callback_url`. With no `callback_url` it waits and answers with the JSON of the run. 400 for a bad job, 429 for a full queue. |
| `/warm` | `{ "user", "engine"?, "model"?, "effort"? }` | docker mode: starts the container and the program before a job exists. The host calls it when a person opens a comment box. The runner starts nothing for an engine that the user has not connected. A program that waits with another model is replaced at the job. 202, or 200 with `warm: false` when warming is off. |
| `/status` | `{ "user" }` | `{ "assistants": { "claude": { "connected", "models", "default_model" }, "chatgpt": { … } } }`. An entry can also have `signing_in: true` (a sign-in waits), `mode: "host"`, or `error`. `models` is the list of `MODELS` in `run-comment.mjs`: `{ "id", "label", "note" }`. |
| `/connect` | `{ "user", "engine" }` | docker mode only, else 400. Starts the sign-in of the program and answers when the program printed its link: `{ "id", "url", "user_code"?, "needs_code", "expires_at" }`. Claude has `needs_code: true`. Codex has `user_code` and `needs_code: false`. 502 when the program printed no link in 30 s. A new `/connect` for the same user and engine cancels the old one. |
| `/connect/code` | `{ "id", "code" }` | Writes the pasted code to the program one time. `{ "status" }`. 400 for a bad code or for a sign-in that takes no code, 404 for an unknown id, 409 when a code went already or the sign-in ended. |
| `/connect/status` | `{ "id" }` | `{ "status", "detail"? }`. `status` is `pending`, `connected`, `failed` or `expired`. `detail` is one plain sentence and the last line of the program, with no code and no URL query. |
| `/connect/cancel` | `{ "id" }` | Ends the sign-in. `{ "status": "failed" }`, with the detail "The sign-in was canceled." |
| `/disconnect` | `{ "user", "engine" }` | Runs the sign-out of the program, then removes the volume. `{ "connected": false }`. |
| `GET /health` | | `{ "ok": true, "mode" }` |

The runner keeps the sign-ins in memory. A result stays for 10 minutes. A sign-in waits 10 minutes for the person (`SANDBOX_CONNECT_TIMEOUT_MS`), then its status is `expired`. During a sign-in, a run of the same user and engine ends as `not_signed_in` with the detail "a sign-in ... is in progress", because two programs must not share one sign-in folder.

`/status` in docker mode runs the status command of the program (`claude auth status --json` or `codex login status`) in a container with `--network none` and the volume mounted read-only. With no network, the program cannot renew or change the sign-in. With no volume, no container starts. The answer stays for 30 seconds. A run, a sign-in and a sign-out change it at once. Host mode starts no program for `/status`. It reports `connected: true` until a run finds no sign-in.

### Environment of the runner

| Variable | Default | Meaning |
|---|---|---|
| `SANDBOX_RUNNER_SECRET` | none | With a value, `POST /run` and `POST /warm` need the same value in the header `x-runner-secret`. The host sends the header when its own `SANDBOX_RUNNER_SECRET` has a value. |
| `SANDBOX_CONNECTOR_ORIGINS` | none | A comma list of origins, for example `https://pages.example.com`. A job with another origin in `mcp_url` or `callback_url` gets 400. |
| `SANDBOX_CLAUDE_MODEL` | `sonnet` | The model of a Claude job that names none. An empty value gives the default model of the account. |
| `SANDBOX_CLAUDE_EFFORT` | none | `--effort` for a Claude job that names none. |
| `SANDBOX_CODEX_MODEL` | `gpt-6.1-sol` | The same for Codex (`-m`). An empty value gives the default model of the account. |
| `SANDBOX_CODEX_EFFORT` | none | `model_reasoning_effort` for a Codex job that names none. |
| `SANDBOX_CLAUDE_MIN_AGE_MS` | `30000` | The youngest age at which the runner may end a Claude process, outside the time limit of a run. |
| `SANDBOX_CONNECT_TIMEOUT_MS` | `600000` | How long a sign-in waits for the person. |
| `SANDBOX_HOST_EGRESS` | none | host mode: `1` sends each run through its own `egress-proxy.mjs` on 127.0.0.1, with the hosts of a run of that engine. The program gets the connector at the proxy, so its command line has no token. The runner log gets one line for each host. |
| `RUN_TIMEOUT_MS` | `180000` | The time limit of one run. |
| `SANDBOX_MAX_QUEUE` | `5` | How many jobs of one user can wait while one runs. |
| `SANDBOX_IDLE_MS` | `90000` | docker mode: how long the container of a user stays after a run. `0` gives each run its own container. |
| `SANDBOX_WARM_MS` | `60000` | docker mode: how long a container from `POST /warm` stays with no job. `0` turns `/warm` off. A later `/warm` or run can make the time longer, never shorter. |
| `SANDBOX_DISCOVER_ORIGIN` | the first of `SANDBOX_CONNECTOR_ORIGINS`, then the origin of the last job | docker mode, with `SANDBOX_RUNNER_SECRET`: the host that answers `POST /s/_mcp/discover`. See "The egress proxy". |
| `SANDBOX_PREWARM` | `1` | docker mode: `0` starts no program before its job arrives. |
| `SANDBOX_MEMORY`, `SANDBOX_CPUS`, `SANDBOX_PIDS` | `1g`, `2`, `256` | docker mode: the limits of one container. |
| `SANDBOX_EGRESS_ALLOW` | see "The egress proxy" | docker mode: a comma list of hosts for each container, in place of the lists for each engine. |
| `SANDBOX_CLAUDE_IMAGE`, `SANDBOX_CODEX_IMAGE`, `SANDBOX_EGRESS_IMAGE` | `agent-pages-sandbox-claude`, `agent-pages-sandbox-codex`, `agent-pages-egress` | docker mode: the three images. See "The images". |
| `SANDBOX_RECORD_DIR` | none | For tests: a folder that gets each output line of each program. The lines have page text. |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | host mode: another binary. |

### The log

The runner prints one JSON object on each line. A run gives one line:

```json
{"at":"2026-11-12T04:54:23.031Z","ev":"run","comment_id":"…","slug":"sandbox-perf/hp-1794459257","user":"25bf8e1a2393f110","engine":"claude","model":"claude-sonnet-5-5","status":"done","mode":"docker","warm":true,"cold_container":false,"ms_queue":1,"ms_container":0,"ms_init":72,"ms_first_token":888,"ms_first_tool":888,"ms_reply":5135,"ms_callback":5135,"ms_engine":6271,"ms_runner":6481,"num_turns":5,"total_cost_usd":0.0200475,"peak_memory_mb":214,"tools":"list_comments@889 get_page@1280 edit_page@2231 reply_to_comment@4233","timeline":"engine@0 init@72 message@888 …","callback_status":200,"progress_sent":9,"progress_accepted":9}
```

`user` is a hash. No line has the connector URL, the callback URL, a token, a pasted code or the secret. The other values of `ev`:

| `ev` | When |
|---|---|
| `start`, `stopping`, `infra`, `infra_failed` | The runner starts or stops, and the network and the proxy are ready or failed. |
| `build`, `built`, `build_failed` | An image builds, with `why` (`missing` or `inputs changed`), the new hash `inputs` and the old hash `was`. |
| `run_start`, `queued`, `refused` | A job starts, waits behind `ahead` jobs of the same user, or gets no place (`cause` is `secret` or `queue`). |
| `container_started`, `container_stopped` | See below. |
| `warm`, `warm_failed`, `discovered`, `discover_failed` | `POST /warm`, and the stored connector answers. |
| `signin_start`, `signin_ready`, `signin_code_sent`, `signin_end`, `signout` | A sign-in and its result (`status`, `ms`, `code_sent`, `detail`), and a sign-out. |
| `egress_opened`, `egress_refused`, `egress_mcp` | Each tunnel and each refusal of the egress proxy, with `user`, `engine`, `kind` (`run`, `signin` or `host-run`), `profile` and `host`. Each connector call, with its tool. |

One `container_stopped` line gives what a cloud host bills for the life of one container:

```json
{"ev":"container_stopped","user":"25bf8e1a2393f110","engine":"claude","why":"idle","started_by":"warm","runs":2,"ms_start":259,"s_billable":117.212,"cpu_s":7.162865,"peak_memory_mb":366}
```

`s_billable` is the time from `docker run` to `docker rm`. `cpu_s` is `usage_usec` of the cgroup `cpu.stat`, read just before the stop. `cpu_throttled` is `nr_throttled` of the same file. `programs_stopped` gives how each program ended (`eof`, `sigint`, `sigkill`, `ended` or `left`). `why` is `idle`, `warm unused`, `timeout`, `not signed in`, `run end`, `sign-in`, `sign-out`, `shutdown` or `exited`. A run line also has `container_cpu_s` and `container_throttled`. The egress proxy has its own log (`docker logs agent-pages-egress-<port>`), and the runner copies each of its lines into its own log as `egress_*`, with the user and the engine.

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
| Egress allow list | The internal network, the proxy as `HTTPS_PROXY`, and one list for each container | A direct connection to `1.1.1.1` fails with "Network unreachable". No outside name resolves. `CONNECT` to `example.com:443`, to port 80, to an IP address and to `host.docker.internal:8804` gets 403. `CONNECT` to the hosts of a run of the engine gets 200. A Claude container gets 403 for the hosts of Codex and for `claude.ai`. Plain HTTP through the proxy gets 403. |
| The connector token stays outside | The program gets `http://<proxy>:3128/mcp`. The proxy knows the real URL for the address of the container, only while the run is active. | A connector request gets 503 before the run, 200 in the run, 503 after it. The token is not in a command line of the container, in its environment, in `docker inspect`, or in the proxy log. |
| The proxy control port | A secret of 32 random bytes that the runner makes at its start. It reaches the proxy in the environment of the `docker` program, not as an argument. | A request from a container to port 3129 gets 401. |
| Time limit | After `RUN_TIMEOUT_MS` the runner removes the container (`docker rm -f`), with every process in it. | A program that sleeps 600 s: the run reports `timeout` after 2.1 s, and `docker ps -a` has no such container. The next container of the user starts and reaches the hosts of a run. |
| The minimum age of a Claude process | `stopGently` in `run-comment.mjs` | The runner ends a waiting program by the end of its input, and not before `SANDBOX_CLAUDE_MIN_AGE_MS` (2.5 s in the check). Unit tests check that a fake process gets no SIGKILL before its minimum age, except on the hard time limit. |
| One run for each user, and a queue limit | `userQueue` in `local-runner.mjs` | A unit test: two jobs of one user never run together, and the job after `SANDBOX_MAX_QUEUE` waiting jobs gets no place (429). |
| The shared secret | `x-runner-secret`, compared with `timingSafeEqual` over SHA-256 of both values | A unit test starts the real runner: no header and a wrong header get 401, on each route. |
| Logs with no secret | See "The log" | The unit tests search the logs of the runner and of the proxy for the token and for `/s/_mcp/`. |

`verify-controls.mjs` checks the container of each image. It prints 22 lines with `PASS` for each image, then `all checks passed`. `node sandbox/verify-controls.mjs claude` checks one image. `SANDBOX_DOCKER_TESTS=1 node --test tests/sandbox.test.mjs` runs it as a test.

Real runs with the controls on: more than 70 Claude runs in docker mode went through the proxy from 2026-11-11 to 2026-11-12. Its log for one run had tunnels to `api.anthropic.com` only, the four tool calls, and two refused tunnels to `http-intake.logs.us5.datadoghq.com` (telemetry of Claude Code). The first run of a new program can also open `platform.claude.com`, for the renewal of the sign-in.

### The minimum age of a Claude process

A Claude sign-in has a refresh token that works one time only. Claude Code renews the sign-in at its start when the access token is old, at `platform.claude.com`, and then writes the new tokens to `.credentials.json`. A process that ends between the renewal and the write leaves a refresh token that is no longer valid, and the person must sign in again (Claude Code issue 102265).

So the runner never ends a Claude process that is younger than 30 seconds (`CLAUDE_MIN_AGE_MS` in `run-comment.mjs`), by any signal or by the end of its input. `stopGently` waits for that age, closes the input, then sends SIGINT, and sends SIGKILL only to a process that is old enough. A process that is still young after these steps is left to end by itself. Only the hard time limit of a run (`RUN_TIMEOUT_MS`) ends a younger process. The rule applies to a waiting program that gets no job, to a program with the wrong model, to the end of a container, and to the stop of the runner.

The cost: when the next job of the user arrives less than 30 seconds after the start of a program, the job can wait up to about 1 second for the last turn of the program before.

The proof that a renewal works through the proxy: on 2026-11-12 at 16:09:14 the runner log has `egress_opened` with `kind` `run` and `host` `platform.claude.com`, 2 s after the start of the program of the first run of that runner. The 40 runs after it were all `done`, and `/status` stayed `connected`. So Claude Code renewed the sign-in through the proxy and stored it.

### The images

Each image has the label `agent-pages.inputs`: a hash of the files that its target of `Dockerfile` copies (`inputsHash` in `local-runner.mjs`). At its start, and before a container starts, the runner compares the label with the hash of the files. A missing image or a changed hash starts a build, and the log has a `build` line with the old and the new hash. One image builds one time at a time.

### The egress proxy

Each container has its own list, port 443 only. The runner gives the proxy the list for the address of the container when the container starts (`PUT /allow/<ip>` on the control port), and removes it when the container goes. A container that the proxy does not know reaches no host. `RUN_ALLOW` and `SIGNIN_ALLOW` in `egress-proxy.mjs` hold the lists.

| Host | A Claude run | A Claude sign-in | A Codex run and sign-in | Needed for |
|---|---|---|---|---|
| `api.anthropic.com` | yes | yes | no | The model, for Claude Code. |
| `platform.claude.com` | yes | yes | no | Claude Code renews the sign-in here, and the sign-in gets its tokens here. |
| `claude.ai`, `claude.com` | no | yes | no | The pages of the Claude sign-in. |
| `chatgpt.com` | no | no | yes | The model, for Codex with a ChatGPT sign-in. |
| `auth.openai.com` | no | no | yes | The sign-in of ChatGPT, and its renewal. |
| `api.openai.com` | no | no | yes | Codex with an API key. Codex with no sign-in also tries this host. |

A sign-in container gets the sign-in list only while its sign-in waits. The Claude sign-in of 2026-11-12 reached `platform.claude.com` and `api.anthropic.com` only. The ChatGPT sign-in reached `auth.openai.com` only.

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

A person signs in from the web app (`POST /connect` of the runner), or from a terminal:

```bash
node sandbox/connect.mjs claude [user]       # Claude
node sandbox/connect.mjs chatgpt [user]      # ChatGPT
node sandbox/connect.mjs claude [user] --status
node sandbox/connect.mjs chatgpt [user] --logout
```

`user` is the author name that the host sends with a job. In development it is `local`, and that is the default. `connect.mjs` uses the same functions as the routes of the runner (`startSignIn`, `sendCode`, `signInStatus`, `disconnect`), with its own Docker objects on port 8898. It needs no terminal: it reads the code from standard input. Stop a runner that has a container of the same user first, or use the web app.

The sign-in runs the unmodified program (`claude auth login --claudeai` or `codex login --device-auth`) in a container of the image of that engine. The container has the same controls as a run, and it is on the internal network. The proxy gives it the sign-in list. The runner reads the link from the output of the program (`signin.mjs`). The pasted code goes to the standard input of the program one time, and the runner then wipes its buffer. No log and no answer has the code. When the program ends, the status command decides the result. A sign-in that fails, expires or is canceled removes the volume that it made.

Claude:

1. The person opens the link, which starts with `https://claude.com/cai/oauth/authorize`.
2. The person signs in on the Anthropic page and approves.
3. The Anthropic page shows a code. The person pastes it in the web app, or at the prompt of `connect.mjs`.
4. Claude Code writes `/claude-config/.credentials.json` with mode `0600`. The file stays in the volume.

A wrong code gives `failed` with the detail "Anthropic did not accept the code. Start the sign-in again, and paste the newest code from the Anthropic page. The program said: "Login failed: That code wasn't accepted. ..."". The link arrived 0.7 s after `/connect` in the tests.

ChatGPT (`codex login --device-auth`):

1. Codex prints this text:
   ```
   Follow these steps to sign in with ChatGPT using device code authorization:

   1. Open this link in your browser and sign in to your account
      https://auth.openai.com/codex/device

   2. Enter this one-time code (expires in 15 minutes)
      DHB4-MFRHG
   ```
2. Open the link, sign in to ChatGPT, and type the code. The link and the code arrived 3.2 s after `/connect` in the tests.
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
- No real Codex run was made in a container, because no volume has a ChatGPT sign-in. `node sandbox/codex-path.mjs <host URL>` runs the full docker path with a stand-in model: the Codex image, the controls, the proxy with the connector route, the real connector of the host, `runJob`, and the callback. The test user signs in with `codex login --with-api-key` and a key that is not real. Its 9 checks passed on 2026-11-12: the three connector calls, version 2 with the fix, a resolved thread, the progress events, one callback, and no token in the container or in the proxy log.
- 6 real Codex runs in host mode with `SANDBOX_HOST_EGRESS=1` went through the proxy. The proxy opened `chatgpt.com` 68 times and refused `ab.chatgpt.com` 6 times. The runs were all correct.

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
node --test tests/sandbox.test.mjs                              # 40 tests, no Docker, no sign-in, no network
SANDBOX_DOCKER_TESTS=1 node --test tests/sandbox.test.mjs       # adds verify-controls.mjs
cd host && npm run typecheck && npm run test
node sandbox/codex-path.mjs http://localhost:8804               # the docker path of Codex, with a stand-in model
SANDBOX_RUNNER_SECRET=… node sandbox/runner-check.mjs http://localhost:8804 http://localhost:8811 two-users   # or queue
```

The tests of the stream readers use `samples/claude-edit.jsonl` and `samples/codex-edit.jsonl`: the output of one real run of each program, with the tool results cut. The tests of the sign-in readers use `samples/claude-login-wrong-code.txt` and `samples/codex-login-device.txt`: the output of one real sign-in of each program, with the state, the challenge and the one-time code replaced.

`runner-check.mjs` makes real runs. On 2026-11-12:

- The first job after a runner start, posted 0.3 s after the start, was done with its reply at 9.5 s: 2.6 s for the network and the proxy, 0.8 s for the container, and a cold program.
- Three users at the same moment: user A (Claude, docker mode) had its reply 4.25 s after a cold container start. User B (Codex, host mode) was done in 11.9 s. User C (a volume with no sign-in) got `not_signed_in` in 2.0 s. No job waited for another user (`ms_queue` 0).
- Three comments of one user at the same moment ran one after the other, with `ms_queue` 1, 4445 and 9322 ms. Each reply took 3.2 to 3.8 s. Version 4 of the page has all three edits, and all three threads are resolved.
