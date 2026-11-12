# Where the sandbox can run

This file is research. Nothing in it is deployed. A person must decide before a cloud deployment.

Date of the research: 2026-11-11, updated 2026-11-12 for the images, the instance type and the price. The measured numbers come from one Mac (Apple silicon, Docker 29.4.0). `COST.md` has the price of each warm policy.

## What the local test measured

Host mode, Claude Code 2.1.322, model `claude-opus-5-5` (the default of the signed-in account), three runs on a 96 KB page. All times are from the comment POST.

| Comment | Run recorded | First tool call | Reply stored | Run ended | Turns | Cost estimate |
|---|---|---|---|---|---|---|
| `@claude make the second paragraph shorter` | 21 ms | 4.4 s | 14.4 s | 17.6 s | 5 | $0.067 |
| `@claude fix the typo in the title` | 10 ms | 3.3 s | 9.8 s | 12.8 s | 5 | $0.056 |
| `@claude make it better` (unclear) | 10 ms | 3.1 s | 6.2 s | 9.2 s | 4 | $0.049 |

- The cost estimate is the `total_cost_usd` that Claude Code prints. A subscription does not pay this amount for each run. The run counts against the usage limits of the plan.
- Claude Code needs about 3 seconds before the first tool call: start, MCP connection, and the first model request.
- About 3 seconds pass between the stored reply and the end of the run. Claude writes its last line in that time.
- One small run used 275 MB of memory at its peak and 1.0 s of CPU time in 3.5 s.

These three runs are from the first version of the runner. `PERF.md` has the measurements of the runner as it is now: with the model `sonnet`, a container that waits and a program that waits, the first tool call comes 0.7 to 0.9 s after the comment, and the reply is stored after 4.2 to 5.2 s.

Docker, one image for each engine since 2026-11-12 (Alpine 3.22, Claude Code 2.1.311 from the apk repository, Codex 0.167.2 from npm):

| Measure | Value |
|---|---|
| Image size | `agent-pages-sandbox-claude` 301 MB (135 MB compressed), `agent-pages-sandbox-codex` 360 MB (146 MB compressed). The one image for both was 713 MB (296 MB compressed). |
| Start of the container of a user (`docker run -d`) | 180 to 360 ms on 2026-11-12, 340 to 910 ms on 2026-11-11 |
| Start of a program in a container that runs (`docker exec`) | about 100 ms |
| Memory of the container at its peak | Claude: 134 MB with one program that waits, 175 to 392 MB in a run (152 to 508 MB on 2026-11-11). Codex with a stand-in model: 26 to 260 MB. |
| First start to the output of `claude --version` | 519 ms |
| Later starts to the output of `claude --version` | 320 to 410 ms |
| Start of an empty command in the container | about 310 ms |
| A run with no sign-in, from the job to the stored failure | About 50 ms with no sign-in volume, and no container. With a volume that has no sign-in: 0.6 to 2.4 s for Claude Code, 1.5 s for Codex. |

The image was on the local disk for each start. No measurement includes a pull from a registry.

## The policy

Source: https://code.claude.com/docs/en/legal-and-compliance.md

The section "Can customers offer Claude Code in their products?" permits a hosted sandbox with these conditions:

> Unless we've mutually agreed otherwise, preinstalling or running Claude Code in your products or services (e.g. in hosted sandboxes or other agent infrastructure) requires agreeing to our Commercial Terms of Service and complying with the conditions below

> The Claude Code binary must not be modified. Claude Code must be installed and run as published by Anthropic, and customers may not remove, disable, or restrict any authentication method built into it (including methods that permit signing in with a Claude account or the user's own API key).

> Customers may not pay for, resell, or intermediate Claude usage on their end users' behalf. Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials, or 3P inference provider credential

The section "Authentication and credential use" adds:

> Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow.

> Nor does it prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription, including where a platform hosts Claude Code as described under *Can customers offer Claude Code in their products?* above.

And about names:

> You can accurately say, in plain text, that your product has Claude Code preinstalled or that it runs Claude Code. But you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name

What this design does to comply:

- The image installs Claude Code from the apk repository of Anthropic and changes no file of it.
- The runner flags limit tools. No flag and no environment variable limits a sign-in method.
- Each run uses the config folder of the person who wrote the comment. A comment from one person never runs with the sign-in of another person.
- The service pays for the sandbox only. Model usage goes to the plan of the person.
- The Worker never reads a credential. The credential file stays in the config folder that Claude Code owns.

## How sign-in works in a container with no browser

Source: https://code.claude.com/docs/en/authentication.md, and a run of the commands in the image.

`claude auth login` in the container, with no terminal and no browser, printed this (the two random values are cut):

```
Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=…&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=…&code_challenge=<cut>&code_challenge_method=S256&state=<cut>
Paste code here if prompted >
```

- The person opens the URL on the site of Anthropic and signs in there. The redirect goes to `platform.claude.com`, which shows a code. The docs say: "If your browser shows a login code instead of redirecting back after you sign in, paste it into the terminal at the `Paste code here if prompted` prompt."
- The person pastes the code into the standard input of the `claude auth login` process. The command works with plain pipes. It needs no terminal.
- The URL has a PKCE challenge (`code_challenge_method=S256`). The matching secret stays in the Claude Code process. So the pasted code alone cannot give a token to a different process. This comes from the URL, not from a statement in the docs.
- Storage: "On Linux, credentials are stored in `~/.claude/.credentials.json` with file mode `0600`." and "If you've set the `CLAUDE_CONFIG_DIR` environment variable, Claude Code keeps the `.credentials.json` file under that directory instead". In the image that is `/claude-config/.credentials.json`.
- `claude auth status --json` prints `loggedIn`, `authMethod`, `subscriptionType` and `loginExpiresAt`. It took 0.15 to 0.5 s and made no model request. With no sign-in it printed `"loggedIn": false` and ended with exit code 1.
- `claude -p` with no sign-in printed a result with `"is_error": true` and `"result": "Not logged in · Please run /login"`. The docs say: "When a failure happens inside the run, such as missing authentication, Claude Code prints the failure as the result on stdout."
- Lifetime: the docs give no number for a `/login` sign-in. They say: "When the login you created with `/login` is within three days of expiring, Claude Code shows a warning at startup" and "Once the stored login expires and can't be refreshed, each model request fails with `Login expired · Please run /login`". Claude Code refreshes the sign-in. The docs do not say where it writes the new token. The config folder is the only place it has, so the sandbox must save the config folder after each run, not only after the first sign-in.
- The refresh goes to `platform.claude.com`. On 2026-11-12 the proxy log had a tunnel to that host 2 s after the start of the first program of a runner, and the 40 runs after it worked. So a run must reach `platform.claude.com` as well as `api.anthropic.com`.
- The refresh token works one time only. A process that ends after the refresh and before the write of the new tokens loses the sign-in (Claude Code issue 102265). The runner therefore never ends a Claude process younger than 30 s, except on the hard time limit (`README.md`, "The minimum age of a Claude process"). A cloud host must keep the same rule: a container must not sleep while a young program runs, and a save of the folder must come after the program ended.
- `claude setup-token` makes "a one-year OAuth token". "It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable". The service would have to store that token for the person. The policy forbids that, so this design does not use `setup-token`.
- `/login` is a command of the interactive terminal interface. The docs say that such commands "aren't available" in `-p` mode. `claude auth login` is the command for a script.

## "Connect Claude" in the web app

The goal is the fewest steps, with the credential inside the sandbox of that person. The local runner has this flow now: `POST /connect`, `/connect/code`, `/connect/status`, `/connect/cancel` and `/disconnect` (`README.md`, "The runner"). The sign-in container is on the internal network, and the proxy lets it reach the sign-in hosts only while the sign-in waits.

1. The viewer shows "Claude: not connected" with one button. The person clicks it.
2. The host starts the sandbox of that person and runs `claude auth login --claudeai` there. It reads the URL from the output and returns it to the browser. Locally this took 0.7 s.
3. The browser opens the URL in a new tab. The person signs in at Anthropic and approves. This is the flow of Anthropic. The service shows no login form of its own.
4. The Anthropic page shows a code. The person copies it, goes back to the viewer, and pastes it in one field.
5. The host writes the code to the standard input of the waiting `claude auth login` process. Claude Code gets the token itself and writes it to `/claude-config`.
6. The host runs `claude auth status --json`. The viewer shows "connected" with the plan and the expiry date. The host saves the config folder for that person.

The person does 4 actions: click, approve, copy, paste. A later "Disconnect" runs `claude auth logout` and deletes the saved config folder.

"Connect ChatGPT" has 3 actions: click, open the link `https://auth.openai.com/codex/device`, and type the one-time code that the viewer shows. The runner runs `codex login --device-auth` and reads the link and the code from its output (3.2 s locally). The person types nothing in the viewer, so no code passes through the Worker. Device code sign-in must be on for the ChatGPT account.

The first run after "Connect" can start at once, so the comment that asked for it needs no second post.

Points that need a decision or an answer from Anthropic:

- The pasted code passes through the Worker on its way to the sandbox. The code is useless without the PKCE secret in the sandbox. But the policy says developers may not "intermediate" credentials, and it does not say if a one-time code counts. A terminal in the browser that connects to the sandbox has the same path. Ask Anthropic before a release.
- The saved config folder holds the credential file on storage that the service runs. The policy permits a hosted sandbox, and a hosted sandbox must keep its disk somewhere. But "may not … store … Claude.ai credentials" can be read to forbid it. Ask Anthropic. Until then, keep the folder as one opaque object for each person, never read it in service code, and delete it on "Disconnect".
- The button offers the subscription sign-in. The policy says the service may not "restrict any authentication method". Offer the Console sign-in (`claude auth login --console`) too.
- The policy limits the use of the name. "Connect Claude" as a feature name and `@claude` as a mention can break that rule. Plain text such as "This runs Claude Code with your own account" is permitted.
- The service must agree to the Commercial Terms of Service of Anthropic.

## Cloudflare Containers

### Can `cloudflare.config.ts` declare it?

Yes, by the types. The installed `cf` 1.0.0-beta.13 re-exports `@cloudflare/config` 0.24.0, and its types have `defineContainer`, `containers` on the config, and `exports.durableObject({ storage: "sqlite", container })` on the Worker. The example in the types:

```ts
import { defineConfig, defineContainer, defineWorker, exports } from "@cloudflare/config";

const myContainer = defineContainer({ name: "my-container", image: { dockerfile: "./Dockerfile" } });
const worker = defineWorker({
  exports: { MyContainerDO: exports.durableObject({ storage: "sqlite", container: myContainer }) },
});
export default defineConfig({ worker, containers: [myContainer] });
```

This repo uses `worker: { … env: { … } }` with `bindings.*`. It has no `exports` and no Durable Object class today. A deployment needs a Durable Object class in the Worker, an `exports` entry for it, and a container with `schedulingPolicy: "durable-object"` (snapshots need that policy). Nobody ran `cf deploy` with a container for this research.

The Sandbox SDK (`@cloudflare/sandbox`) is a layer on Containers with command and file APIs. It is a new npm dependency, and the container image needs a matching `cloudflare/sandbox` base tag. Plain Containers with the Dockerfile of this folder need no new dependency.

### Shape

- One Durable Object for each person, named by the Access identity. It owns one container. That gives one sandbox for each person and one run at a time.
- The Worker calls the Durable Object in place of `SANDBOX_RUNNER_URL`. The Durable Object starts the container, sends the job to `run-comment.mjs`, and writes the result to `agent_runs`. A Durable Object has no 30-second limit, so the callback route is not necessary there.
- `run-comment.mjs` now runs in the runner and not in the container, and the sandbox image has no Node. The runner reads the output of the program, sends the progress and the result, and holds the connector token. On Cloudflare the Durable Object cannot start a program in the container by itself. So this shape needs a small supervisor in the container that does the work of the runner (the image then needs Node again), or the `exec` API of the Sandbox SDK.
- One container for each person and engine, from two images. A Claude run never pulls the Codex image. The Durable Object knows whether it has a saved sign-in folder for an engine. With none, it answers `not_signed_in` and starts no container. This is the local check of the sign-in volume.
- The warm policy on Cloudflare: `sleepAfter` of 60 to 90 s on the container class does the linger after a run. The viewer calls `POST /api/assistants/warm` when a person opens a comment box, and the Durable Object starts the container and the program then. `COST.md` shows that a 10-minute `sleepAfter` costs 2.7 to 5.9 times more than 90 s.
- A program that waits must connect to the connector before its run has a token. The host answers `POST /s/_mcp/discover` with the runner secret: `initialize`, `server/discover` and `tools/list`, and no tool call. On Cloudflare the Durable Object can call that route, or call the same handler in the Worker with no HTTP.
- The container needs outbound access to Anthropic and to the MCP connector. Cloudflare can route outbound traffic of a container through a Worker ("Handle outbound traffic"). Use that to permit only those hosts.
- `egress-proxy.mjs` shows the rule that the outbound Worker must apply: tunnels to the model hosts only, and the connector through the proxy, so the container never has the token.

### Instance type

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |

Claude Code states "4 GB+ RAM" as its requirement (https://code.claude.com/docs/en/setup.md). `standard-1` meets it.

Measured on 2026-11-12: the memory fits `basic` (peak 392 MB). The CPU does not. With a limit of 1/4 vCPU the reply came after 9.2 s, and the program that waited was not ready after 10 s. A program that waited 50 s still gave the reply after 10.6 s, because the run itself is CPU-bound at that limit. With 1/2 vCPU the reply came after 3.55 s, the same as with no limit. **Use `standard-1` for the Claude image.** **Use `basic` for the Codex image.** A Codex stand-in run at 1/4 vCPU took 1.07 to 1.47 s, against 0.85 s with no limit, and Codex has no waiting program. `lite` is too small for both.

Give each container class its own egress list: the hosts of a run of its engine (`RUN_ALLOW` in `egress-proxy.mjs`), and the sign-in hosts only while a sign-in waits (`SIGNIN_ALLOW`).

### Disk and the sign-in

Cloudflare states: "All disk is ephemeral by default." and "When a Container instance goes to sleep, the next time it starts, it uses a fresh disk from the container image." (https://developers.cloudflare.com/containers/faq/)

Three ways to keep `/claude-config` for each person:

1. **Container snapshot.** `this.ctx.container.snapshotContainer({ name })` saves the whole filesystem, and `this.ctx.container.start({ containerSnapshot })` restores it. The Durable Object of the person stores the handle. Limits: 20 GB, and a life of 30 days from the last restore. A snapshot is tied to the image version, so a new image makes each person sign in again unless the service moves the folder.
2. **Directory backup to R2.** `DirectoryBackup` from `@cloudflare/sandbox` saves one folder as one R2 object and restores it. The sandbox gets no R2 credential. It survives a new image. It needs the new dependency.
3. **R2 mounted with FUSE.** The container needs R2 credentials for it. This is the weakest choice for a credential file.

Each way must save the folder after each run, because Claude Code refreshes the token. Nobody measured the time of a save or a restore.

### Cold start

Cloudflare states: "Container cold starts can often be in the 1-3 second range" (https://developers.cloudflare.com/containers/faq/). The image (135 MB compressed for Claude) and a restore of the config folder add to that. Nobody measured it. With the measured 5 to 6 seconds for a first run with `sonnet`, expect 7 to 10 seconds from the comment to the reply on a cold container, and 3 to 5 seconds on a container that waits.

### Price

`COST.md` has the rates, the formula, the measured inputs and the table. `node sandbox/cost.mjs` computes it. For 1,000 users with 20 runs each on `standard-1`:

| Policy | Runs that are alone | Runs in bursts of 4 |
|---|---|---|
| No linger | $3.32 a month | $3.32 |
| 90 s linger | $27.22 | $19.16 |
| 10 min linger | $161.07 | $52.62 |
| Warm on intent + 90 s linger | $40.47 | $22.57 |

Add $5 for the Workers Paid plan. Memory of the instance type is most of each number, because Cloudflare bills it for each second that the container runs, with a job or with none. CPU is billed by use, and it is 8 to 20 percent.

The research of 2026-11-11 said "less than $0.001 for a run". That holds for a run with no linger ($0.00017) and with a 30 s linger ($0.00057). It does not hold with a linger of 90 s ($0.00136 for a run that is alone) or 10 minutes ($0.008).

## Other hosts

- **Fly Machines.** One Machine and one Fly Volume for each person. The volume is persistent and mounts at `/claude-config`, so Claude Code refreshes its token in place with no save step. A volume attaches to one Machine and "exists on one server in a single region". A stopped Machine costs storage only. The price was not checked.
- **E2B.** One sandbox for each person, paused between runs. A pause saves the filesystem and the memory. A resume takes about 1 second, and a pause takes about 4 seconds for each GiB of memory. A paused sandbox stays until the service deletes it. The price was not checked.
- **Modal.** A Sandbox with a named Volume for each person (`Volume.from_name(…, create_if_missing=True)`). Changes need a commit before another container sees them. A Volume is made for files that change seldom, so check it with a token file that changes on each refresh. The price was not checked.

A real volume (Fly) or a paused sandbox (E2B) fits a credential file that changes better than snapshots do. Cloudflare keeps everything on one platform with the Worker.

## Not verified

- No signed-in Codex run in docker mode. Claude Code has more than 70 signed-in runs in docker mode (`PERF.md`, `MODELS.md`). The Codex image ran the full docker path with a stand-in model only (`codex-path.mjs`: the real proxy, the real connector, `runJob` and the callback).
- The billable seconds, CPU and memory on Cloudflare. `COST.md` uses local measurements and lists what it assumes.
- The egress controls on a cloud host. `verify-controls.mjs` proves them on OrbStack only.
- No cloud deployment, no cold start from a registry, and no save or restore of the config folder.
- The life of a `/login` sign-in. On the test machine `claude auth status` showed an expiry date 16 days after the test, and the date of the sign-in is not known.
- The answers of Anthropic to the policy points above.
