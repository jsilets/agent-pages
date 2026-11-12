# Speed of a run

Dates: 2026-11-11, and 2026-11-12 for the first section. One Mac (Apple silicon), OrbStack with Docker 29.4.0, Claude Code 2.1.311 in the image, Codex 0.167.2.

The page of each test is `page.html` below: 1 KB, three paragraphs, a typo in the heading. Each run after run 9 had a new page with one comment. Each number is one run. The model is not exact from run to run, so a difference of less than about 0.5 s between two rows means nothing.

All times are from the comment POST unless a column says something else.

## 2026-11-12: the reply in edit_page, warm on intent, one image for each engine

Same Mac, same page, model `claude-sonnet-5-5`, docker mode. "Before" is commit e2e241e (its host on port 8805, its runner and its image `agent-pages-sandbox`). "After" is this code. Each cell is one run on a new page. Times are from the comment POST to the reply in the comments API.

### The reply in edit_page

| Comment | Before: reply stored | After: reply stored | Before: tool calls | After: tool calls |
|---|---|---|---|---|
| fix the typo in the title, first run of the runner (no container) | 6.77 s | 5.34 s | 4 | 3 |
| make the second paragraph shorter, next run | 4.88 s | 4.42 s | 4 | 3 |
| fix the typo in the title, next run | 4.21 s | 3.44 s (and 3.55 s, 3.65 s in two more runs) | 4 | 3 |
| make it better, next run | 3.59 s (a question) | 3.79 s (a question) in one run. 5.85 s in another run, where Claude made an edit. | 3 | 3 |

- A run with an edit has 4 model turns in place of 5, and it makes 3 tool calls in place of 4. The reply comes 0.5 to 1.4 s earlier.
- The replies were as good as before: one sentence that says what changed, and the thread resolved.
- **A quality change to watch.** In one of two runs of "make it better", Claude fixed the typo and split the long sentence, and resolved the thread. Before, and in the other run, it asked one question with choices and made no edit. Two runs cannot show if the new step 4 of the prompt causes this. Test more runs of unclear comments before a release.
- A failed edit stores no reply, and the model gets the error (unit tests in `host/src/mcp.test.ts`). No real run had a failed edit in this test.
- Codex in host mode, "fix the typo in the title": 3 tool calls, the reply in `edit_page`, reply stored after 11.3 s (1 run). The runs of the old code with 4 tool calls took 13.7 to 14.7 s on another comment.

### Warm on intent

| Run | First tool call after the job | Reply stored after the comment POST |
|---|---|---|
| Cold: a new runner, no container, no `POST /warm` | 2.65 s (container 0.40 s, program `init` 1.51 s, first token 2.25 s) | 5.34 s |
| Warm on intent: a new runner, `POST /api/assistants/warm` on the host, 3 s wait, then the comment | 0.89 s (`init` 43 ms after the job) | 3.65 s |

- The host sent `/warm` to the runner. The runner started the container and the program in 397 ms. The program was ready about 1.5 s later, so 3 s of typing is enough.
- Before this change, the first job after a runner start never got a program that waits: the proxy had no stored connector answers yet. Now the runner gets them from `<host>/s/_mcp/discover` with its shared secret when the proxy starts (76 to 102 ms), and gives them to the proxy with `PUT /cache`. The proxy never gets the secret.

### CPU limit and speed

| CPU limit of the container | Reply stored, warm on intent | Note |
|---|---|---|
| 2 (the local default) | 3.65 s | |
| 1/2 vCPU (`standard-1`) | 3.55 s | The waiting program was ready 2.5 s after `/warm`. |
| 1/4 vCPU (`basic`) | 9.20 s | The waiting program was not ready after 10 s. `init` came 4.0 s after the job, and the cgroup throttled the container 326 times. |

### Memory and CPU of a container

| Engine | State | Memory | CPU |
|---|---|---|---|
| Claude | One program waits, no job | 134 MB `memory.current` (110 MB anonymous), 146 MB peak | Program start 0.75 to 1.2 s. Then 0.017 vCPU-s each second with no CPU limit, about 0.05 at 1/2 vCPU. |
| Claude | Peak of a run | 175 to 392 MB (9 runs). This includes the file cache of the binary and two programs at the end of a run. | 0.5 to 0.8 s for each run with a waiting program. 2.2 s for a cold run with its program start. |
| Codex | No job | About 1 MB: Codex takes its prompt as an argument, so no program waits. | 0 |
| Codex | One `codex exec` with one tool call, stand-in model | 249 to 260 MB peak when the binary is not in the page cache of the machine (2 runs), 26 to 41 MB when it is (8 runs). The cgroup counts the file pages that the program reads. | 2.2 to 2.5 s with a cold page cache, 0.13 to 0.49 s after |

The runner logs the life of each container (`container_stopped`): billable seconds, runs, CPU seconds and peak memory. `COST.md` has the four lifetimes of this test and the price.

### The images

| Image | Size | `docker save \| gzip` | What it has |
|---|---|---|---|
| `agent-pages-sandbox` (before) | 713 MB | 296 MB | Claude Code and Codex |
| `agent-pages-sandbox-claude` | 301 MB | 135 MB | Claude Code 2.1.311 from the apk repository, `libgcc`, `libstdc++`, `ripgrep` |
| `agent-pages-sandbox-codex` | 360 MB | 146 MB | Codex 0.167.2: `bin/codex` (279 MB), `bin/codex-code-mode-host` (72 MB), `codex-package.json` |
| `agent-pages-egress` | 76 MB | 29 MB | Node and `egress-proxy.mjs` |

- Container start (`docker run -d`): 180 to 300 ms for each image. The first program start in a new container: `claude --version` 1.1 s the first time and 90 ms after that, `codex --version` 80 ms.
- The Codex image leaves out the voice host and its libraries (`codex-resources/voice`, 53 MB), `codex-path/rg` (4.5 MB) and `codex-resources/bwrap` (0.5 MB). A stand-in model and a stand-in connector proved it: `codex exec` in the image, with the arguments of docker mode, made its connector tool call and ended with exit code 0. `node sandbox/codex-standin.mjs` repeats the test.
- `codex-code-mode-host` must stay. With the model name `gpt-6.1-sol`, Codex gives the model the JavaScript tool `exec`, and it starts the host for it. In an image with no host, Codex printed "Code Mode is unavailable because failed to spawn code-mode host … Code mode will fail closed", and the model still got an `exec` tool that cannot work. `--disable code_mode` would remove the tool and allow a 288 MB image, but it changes what the model gets, and no real run tested it.
- The Claude image keeps `ripgrep`, because the Anthropic page lists it as a runtime package for Alpine. It is 3 MB.

## Before and after (2026-11-11)

| Setup | Model | First tool call | Reply stored | Run ended | Runs |
|---|---|---|---|---|---|
| Before: one container for each run, sign-in check, the host gets the result at the end | `claude-opus-5-5` | 6.2 s | 13.6 s | 16.3 s | 1 |
| After, first run of a user (new container, new program) | `claude-opus-5-5` | 3.8 to 3.9 s | 11.1 to 12.3 s | 11.2 to 12.4 s | 2 |
| After, next runs (container and program wait) | `claude-opus-5-5` | 2.1 to 2.3 s | 9.8 s (edit) | 9.9 s | 2 |
| After, first run of a user | `claude-sonnet-5-5` | 1.8 to 2.0 s | 5.4 to 6.1 s (edit), 8.4 s in the run with a failed first edit | 5.4 to 8.6 s | 4 |
| **After, next runs: the default** | `claude-sonnet-5-5` | **0.7 to 0.9 s** | **4.2 to 5.2 s (edit), 2.9 s (question)** | 4.2 to 5.3 s | 4 |
| After, next runs | `claude-haiku-5-5` | 1.6 to 1.8 s | 7.9 s (edit), 5.3 s (question) | 8.1 s | 2 |

"Before" is the code of commit d853782 with the image of that commit. The task text gives one more "before" run on a 96 KB page: first tool call 7.3 s, reply 16.5 s, run end 19.3 s.

## Where the time goes

Milliseconds from the moment the runner gets the job. Each column is one run of "make the second paragraph shorter" or "fix the typo in the title".

| Step | Before, opus | After, opus, first run | After, opus, next run | After, sonnet, first run | After, sonnet, next run |
|---|---|---|---|---|---|
| Container ready | 836 | 908 | 0 | 345 | 0 |
| Sign-in check ends | 2751 | none | none | none | none |
| Program started (`docker exec`) | 2751 | 910 | 1 | 346 | 0 |
| `init` event (program ready, connector connected) | not measured | 1710 | 69 | 1064 | 72 |
| First model token = first tool call (`list_comments`) | 6177 | 3870 | 2147 | 1771 | 888 |
| `get_page` call starts (same model turn) | 6230 | 4645 | 2888 | 2165 | 1280 |
| Both tool results back | not measured | 4702 | 3016 | 2466 | 1647 |
| Turn 2 first token | not measured | 6690 | 4810 | 3181 | 2230 |
| `edit_page` call starts | 10160 | 7041 | 4811 | 3181 | 2231 |
| `focus` event sent (`old_text` known) | none | 7788 | 5827 | 3719 | 2816 |
| `edit_page` result | not measured | 8953 | 6743 | 3952 | 3658 |
| Turn 3 first token = `reply_to_comment` starts | 13496 | 11170 | 8617 | 4602 | 4233 |
| Reply stored, and the host gets the result | 13530 (reply only) | 12258 | 9723 | 5294 | 5135 |
| Program ended | 16498 | 15384 | 12840 | 6333 | 6271 |

What the table shows:

- The model is most of the time. A run with an edit has three model turns before the reply. `claude-opus-5-5` needs about 2.1 s for the first token of each turn. `claude-sonnet-5-5` needs 0.6 to 0.8 s.
- The container and the start of the program are 1.2 to 1.7 s of a first run, and about 0.07 s of a next run.
- The last model turn writes one line that no person reads. It takes 1.1 to 3.1 s. The host now gets the result before that turn.

## What changed, and what each change gave

| Change | Effect | Kept |
|---|---|---|
| No `claude auth status` before the run. Claude Code with no sign-in ends by itself with "Not logged in", and `saysNotSignedIn` reads that. | 1.6 to 1.9 s less on each run. A run with no sign-in reports `not_signed_in` in 0.6 to 2.4 s. | Yes |
| One container for each user that stays 10 minutes (`SANDBOX_IDLE_MS`). A job is one `docker exec`. | A new container takes 340 to 910 ms. `docker exec` takes about 100 ms. | Yes |
| A Claude Code program that starts before the next job arrives (`SANDBOX_PREWARM`). It takes one job and then ends. | Job to `init`: 70 ms in place of 700 to 1000 ms. Job to the model request: about 0.1 s in place of 0.5 s. | Yes, on by default |
| The host gets the result when the tool result of `reply_to_comment` arrives, and not when the program ends. | "Run ended" is 1.1 to 3.1 s earlier. | Yes |
| Model `sonnet` in place of the default model of the account. | About 1.4 s less for each model turn: 4 to 5 s less on a run with an edit. | Yes, as the default |
| `--effort low` with `sonnet`. | Init to reply 5.1 s, the same as 5.0 s with no flag (1 run each). | No. `SANDBOX_CLAUDE_EFFORT` and the job field `effort` can set it. |
| A prompt that asks for `list_comments` and `get_page` in one turn. | Claude made both calls in one turn before the change, so nothing changed for Claude. Codex got 5 s slower to its first tool call (9.5 to 11.1 s in place of 3.9 to 4.4 s). | No. The prompt has its two steps again. |
| `DISABLE_AUTOUPDATER=1`, `ENABLE_CLAUDEAI_MCP_SERVERS=false` | Start to exit with no sign-in: median 682 ms with the two variables and 659 ms with none (5 runs each). No effect on time. | Yes. Each one removes a request that a run does not need. |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Median 486 ms on the same test: 170 ms less. | No. It also stops the feature flags of Claude Code. No test with a sign-in ran with it. A program that waits makes this time zero in any case. |
| `--bare` | Not possible. Bare mode does not read a subscription sign-in. | No |
| One long program for many jobs, with `/clear` between them. | Not safe, see below. | No |
| A smaller image. | One image for each engine (2026-11-12): 301 MB for Claude, 360 MB for Codex, in place of 713 MB for both. | Yes. See "The images" at the top. |

### One long program for many jobs: why not

`claude -p --input-format stream-json` stays alive and takes one message after another from stdin. Two tests with `haiku` showed the limits:

- The second message sees the first conversation. Message 1 was "Remember the secret word: PINEAPPLE." Message 2 was "What was the secret word?" The answer was "PINEAPPLE".
- `/clear` does not work there. The answer was "/clear isn't available in this environment."
- The MCP config is fixed when the program starts.

So one program takes one job. The runner starts the next program right after a job ends, and that program waits for its prompt on stdin. This gives the same speed, and no job can see another job.

The connector URL is different for each run, because it has the token. A program that waits cannot know it. The egress proxy solves this: the program always gets `http://<proxy>:3128/mcp`, and the proxy sends each request to the connector URL of the run that the container has at that moment. A program that waits gets a stored answer for `server/discover`, `initialize` and `tools/list`. Those answers are the same for each token. On 2026-11-11 the first job after the start of the runner had no stored answer, so it started its own program. Now the runner gets the answers from the host before the first job (see "Warm on intent" at the top).

### The start of the program, measured

From the debug log of Claude Code 2.1.311 in a container (`--debug-file`), one run with `haiku`:

| Step | Time from process start |
|---|---|
| Settings, certificates, plugins, commands | 150 ms |
| MCP connection to the connector (202 ms by itself) | 392 ms |
| Model request sent | 472 ms |
| First byte of the model answer | 2155 ms (1683 ms after the request) |

The same prompt to a program that had waited 3 s: model request 70 ms after the message, first byte 1313 ms after the request.

## Models

Three comments, the same page. Times are from the comment POST. "Next run" rows have a container and a program that wait.

| Model | Comment | First tool | Reply stored | Result |
|---|---|---|---|---|
| `claude-opus-5-5` (default of the account) | make the second paragraph shorter | 2.1 s | 9.8 s | Good. 65 words to 28, two sentences, the meaning stays. |
| | fix the typo in the title | 3.8 s (first run) | 11.1 s | Good. Changed `pmups` in the heading only. |
| | make it better | 2.3 s | 7.1 s | Good. One question that names the two real problems of the page. No edit. |
| `claude-sonnet-5-5` | make the second paragraph shorter | 0.8 to 0.9 s | 5.2 s | Good. One or two sentences, the meaning stays. In one of six runs with an edit, the first `edit_page` call had input that was not JSON. Claude Code returned an error to the model, and the second call was correct. That run took 2.4 s more. |
| | fix the typo in the title | 0.8 s | 4.2 s | Good. Heading only. The reply says that the `<title>` tag was correct already. |
| | make it better | 0.7 s | 2.9 s | Good. One question with choices. No edit. |
| `claude-haiku-5-5` | make the second paragraph shorter | 2.5 s (first run) | 10.1 s | The edit is good. The reply has a third sentence about other threads of the page that nobody asked for. |
| | fix the typo in the title | 1.8 s | 7.9 s | Good. |
| | make it better | 1.6 s | 5.3 s | A good question, plus a remark about another thread. |

- `haiku` was slower than `sonnet` in each run. It thinks for 1 to 2.7 s before the `edit_page` call and before the reply. Its first token also came later (1.4 to 1.8 s).
- The `haiku` runs and the first three `sonnet` runs had old threads of earlier tests on the page. Both models wrote about those threads in a reply. The `opus` runs on the same kind of page did not. On a clean page, `sonnet` did not.
- `--model` takes `sonnet`, `opus`, `haiku`, `fable`, or a full name such as `claude-sonnet-5-5`.

**The default is `sonnet`.** It gives the reply in about half the time of `claude-opus-5-5`, and the edits in these tests were as good. `SANDBOX_CLAUDE_MODEL` sets another model for the runner, and an empty value gives the default of the account. The job field `model` sets it for one job.

## Codex

Host mode, Codex 0.167.2, the default model of the signed-in account, the comment "make the second paragraph shorter". Times are from the start of the program.

| Setup | First tool | Reply stored | Program ended | Runs |
|---|---|---|---|---|
| Code of commit d853782 | 3.9 s | about 13 s | 14.9 s | 1 |
| This code | 4.4 s | 14.7 s | 16.9 s | 1 |
| This code, effort `low` | 4.5 s | 13.7 s | 15.9 s | 1 |
| This code, through `egress-proxy.mjs` (model and connector), with the prompt that asked for parallel calls | 11.1 s | 20.4 s | 22.6 s | 1 |
| This code, no proxy, with the prompt that asked for parallel calls | 9.5 s | 18.5 s | 20.9 s | 1 |

- Codex makes one tool call in each model turn, and each turn takes 2 to 5 s. No setting in these tests made it faster.
- The run through the proxy proves that Codex works with `HTTPS_PROXY` and with the connector behind the proxy. Codex needed only `chatgpt.com`. The proxy refused `ab.chatgpt.com`, and the run was correct.
- `codex exec --json` prints a tool call when its arguments are complete. So an edit gives one `focus` event and one `typing` event, at the same moment as the `tool` event.
- No Codex run was in a container, because the container has no ChatGPT sign-in.

## Fewer turns: what the connector could do

Change 1 is done (2026-11-12): `edit_page` takes `reply`. The table at the top has the result. Change 2 is not done.

The runner cannot change the connector. Two changes to the host would save model time. The numbers are from the `sonnet` and `opus` rows of "Where the time goes".

1. **A reply inside `edit_page`.** An optional `reply: { body, resolve }` in the input of `edit_page`. The host stores the edit and the reply together, and stores no reply when the edit fails. This removes the third model turn: about 1.5 s with `sonnet` and 3.3 s with `opus`.
2. **One tool for the thread and the page.** `get_comment_context({ comment_id })` returns the thread of the comment and the HTML of its page. Claude makes the two calls in one turn today, so this saves no turn. It saves the time that the model needs to write the second call, and the text of the other threads: about 0.4 s with `sonnet` and 0.7 s with `opus`. For Codex it saves one whole turn (2 to 3 s), because Codex makes one call in each turn.

## The image (2026-11-11)

| Image | Size |
|---|---|
| `agent-pages-sandbox` before: Alpine, Node, Claude Code | 366 MB |
| `agent-pages-sandbox` after: Alpine, Claude Code, Codex, no Node | 713 MB |
| `agent-pages-egress`: Alpine, Node, `egress-proxy.mjs` | 76 MB |

- Claude Code is one file of 273 MB. The Codex folder is 392 MB: `codex` 266 MB, `codex-code-mode-host` 69 MB, voice files 53 MB, `rg` and `bwrap` 5 MB. The image keeps the folder as npm installs it.
- Node left the sandbox image (49 MB), because `run-comment.mjs` now runs in the runner and not in the container.
- An image with Claude Code only would be 317 MB.
- The image has 2 layers of its own in place of 3. The start time of a container did not change: 340 to 910 ms for `docker run -d`, with the image on the local disk.

## Memory (2026-11-11)

`memory.peak` of the container cgroup after a run: 152 to 315 MB for one Claude Code program, and 508 MB when a second program waits for the next job. The limit is 1 GB.

## How to repeat the measurements

```bash
# The page of the tests
cat > /tmp/page.html <<'EOF'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>How heat pumps work</title>
<style>body{font:16px/1.5 system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem}</style>
</head>
<body>
<h1>How heat pmups work</h1>
<p>A heat pump moves heat from one place to another. It does not burn fuel to make heat.</p>
<p>In winter, the outdoor unit takes heat from the cold air outside, even when the temperature is below zero, and a refrigerant carries that heat through a compressor, which raises its temperature a lot, and then the indoor unit releases the heat into the rooms of the house, where a fan or a set of radiators spreads it around so that every room gets warm.</p>
<p>In summer, the same machine runs the other way and cools the house.</p>
</body>
</html>
EOF

# The host and the runner
cd host && CF_STATE_DIR=.cloudflare/state-run SANDBOX_RUNNER_URL=http://localhost:8811/run bunx vite --port 8804 --strictPort
node sandbox/local-runner.mjs --mode docker                                  # the default: sonnet, a container and a program that wait
SANDBOX_CLAUDE_MODEL= node sandbox/local-runner.mjs --mode docker            # the default model of the account
SANDBOX_CLAUDE_MODEL=haiku node sandbox/local-runner.mjs --mode docker
SANDBOX_CLAUDE_EFFORT=low node sandbox/local-runner.mjs --mode docker
SANDBOX_IDLE_MS=0 node sandbox/local-runner.mjs --mode docker                # one container for each run

# One run: a new page, one comment. The second run of a runner is a "next run".
AGENT_PAGES_URL=http://localhost:8804 node cli/agent-pages.mjs publish /tmp/page.html --slug sandbox-perf/hp-1
node sandbox/measure.mjs http://localhost:8804 sandbox-perf/hp-1 "@claude make the second paragraph shorter"
```

`measure.mjs` prints `ms_reply_stored` and `ms_run_ended` from the comment POST. The runner prints one JSON line for each run. `ms_container`, `ms_init`, `ms_first_token`, `ms_first_tool`, `ms_reply` and `timeline` are from the moment the runner has the job. The first tool call from the comment POST is `ms_container + ms_first_tool`, plus about 20 ms for the host.

The "before" row: `git show d853782:sandbox/local-runner.mjs` and `git show d853782:sandbox/run-comment.mjs` in a temporary folder, with the image that `git show d853782:sandbox/Dockerfile` builds, and `node <folder>/local-runner.mjs --mode docker`.

The start test with no sign-in ran `docker exec -i [-e …] <container> claude -p --input-format stream-json …` five times for each set of variables, in a container whose volume has no sign-in, and took the time to the exit.

The tests of 2026-11-12:

```bash
# The host and the runner share a secret, so the runner can get the connector answers before the first job.
SECRET=$(openssl rand -hex 24)
cd host && SANDBOX_RUNNER_SECRET=$SECRET CF_STATE_DIR=.cloudflare/state-run SANDBOX_RUNNER_URL=http://localhost:8811/run bunx vite --port 8804 --strictPort
SANDBOX_RUNNER_SECRET=$SECRET SANDBOX_DISCOVER_ORIGIN=http://localhost:8804 node sandbox/local-runner.mjs --mode docker
SANDBOX_CPUS=0.5 SANDBOX_RUNNER_SECRET=$SECRET SANDBOX_DISCOVER_ORIGIN=http://localhost:8804 node sandbox/local-runner.mjs --mode docker   # the CPU of standard-1. 0.25 is basic.

# Warm on intent: the call of the viewer, a wait, then the comment.
curl -X POST http://localhost:8804/api/assistants/warm -H 'content-type: application/json' -d '{}'
sleep 3; node sandbox/measure.mjs http://localhost:8804 sandbox-perf/hp-2 "@claude fix the typo in the title"

# The Codex image with a stand-in model and connector: no sign-in, no model request.
node sandbox/codex-standin.mjs

# The price of each warm policy, from the measured inputs.
node sandbox/cost.mjs
```

The "before" columns: `git worktree add --detach <folder> e2e241e`, a link from `<folder>/host/node_modules` to `host/node_modules`, the migrations in a state folder of its own, its host on port 8805 with `SANDBOX_RUNNER_URL=http://localhost:8812/run`, and `node <folder>/sandbox/local-runner.mjs --mode docker --port 8812` with the image `agent-pages-sandbox`.
