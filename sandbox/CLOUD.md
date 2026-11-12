# Where the sandbox can run

This file is research. Nothing in it is deployed. A person must decide before a cloud deployment.

Date of the research: 2026-11-11. The measured numbers come from one Mac (Apple silicon, Docker 29.4.0).

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

Docker, image `agent-pages-sandbox` (Alpine 3.22, Claude Code 2.1.311 from the apk repository):

| Measure | Value |
|---|---|
| Image size | 366 MB. The Claude Code binary is 273 MB of it. |
| First start to the output of `claude --version` | 519 ms |
| Later starts to the output of `claude --version` | 320 to 410 ms |
| Start of an empty command in the container | about 310 ms |
| A run with no sign-in, from the comment POST to the stored failure | 3.3 s |

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
- `claude setup-token` makes "a one-year OAuth token". "It does not save the token anywhere; copy it and set it as the `CLAUDE_CODE_OAUTH_TOKEN` environment variable". The service would have to store that token for the person. The policy forbids that, so this design does not use `setup-token`.
- `/login` is a command of the interactive terminal interface. The docs say that such commands "aren't available" in `-p` mode. `claude auth login` is the command for a script.

## "Connect Claude" in the web app

The goal is the fewest steps, with the credential inside the sandbox of that person.

1. The viewer shows "Claude: not connected" with one button. The person clicks it.
2. The host starts the sandbox of that person and runs `claude auth login` there. It reads the URL from the output and returns it to the browser.
3. The browser opens the URL in a new tab. The person signs in at Anthropic and approves. This is the flow of Anthropic. The service shows no login form of its own.
4. The Anthropic page shows a code. The person copies it, goes back to the viewer, and pastes it in one field.
5. The host writes the code to the standard input of the waiting `claude auth login` process. Claude Code gets the token itself and writes it to `/claude-config`.
6. The host runs `claude auth status --json`. The viewer shows "connected" with the plan and the expiry date. The host saves the config folder for that person.

The person does 4 actions: click, approve, copy, paste. A later "Disconnect" runs `claude auth logout` and deletes the saved config folder.

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
- The container needs outbound access to Anthropic and to the MCP connector. Cloudflare can route outbound traffic of a container through a Worker ("Handle outbound traffic"). Use that to permit only those hosts.

### Instance type

| Type | vCPU | Memory | Disk |
|---|---|---|---|
| lite | 1/16 | 256 MiB | 2 GB |
| basic | 1/4 | 1 GiB | 4 GB |
| standard-1 | 1/2 | 4 GiB | 8 GB |

Claude Code states "4 GB+ RAM" as its requirement (https://code.claude.com/docs/en/setup.md). `standard-1` meets it. The small run used 275 MB, so `basic` can work, but it is below the stated requirement. `lite` is too small.

### Disk and the sign-in

Cloudflare states: "All disk is ephemeral by default." and "When a Container instance goes to sleep, the next time it starts, it uses a fresh disk from the container image." (https://developers.cloudflare.com/containers/faq/)

Three ways to keep `/claude-config` for each person:

1. **Container snapshot.** `this.ctx.container.snapshotContainer({ name })` saves the whole filesystem, and `this.ctx.container.start({ containerSnapshot })` restores it. The Durable Object of the person stores the handle. Limits: 20 GB, and a life of 30 days from the last restore. A snapshot is tied to the image version, so a new image makes each person sign in again unless the service moves the folder.
2. **Directory backup to R2.** `DirectoryBackup` from `@cloudflare/sandbox` saves one folder as one R2 object and restores it. The sandbox gets no R2 credential. It survives a new image. It needs the new dependency.
3. **R2 mounted with FUSE.** The container needs R2 credentials for it. This is the weakest choice for a credential file.

Each way must save the folder after each run, because Claude Code refreshes the token. Nobody measured the time of a save or a restore.

### Cold start

Cloudflare states: "Container cold starts can often be in the 1-3 second range" (https://developers.cloudflare.com/containers/faq/). The 366 MB image and a restore of the config folder add to that. Nobody measured it. With the measured 9 to 18 seconds for a run, expect 12 to 25 seconds from the comment to the end of a run on a cold container.

### Price for one run

Rates (https://developers.cloudflare.com/containers/pricing/): memory $0.0000025 for each GiB-second, CPU $0.000020 for each vCPU-second, disk $0.00000007 for each GB-second. Memory and disk count for the whole instance type while the container runs. "CPU usage is based on active usage only." Charges "start when a request is sent to the container" and "stop after the container instance goes to sleep".

| | standard-1 | basic |
|---|---|---|
| Each second, with the CPU fully active | $0.0000206 | $0.0000078 |
| Each idle second (memory and disk) | $0.0000106 | $0.0000028 |
| One run: 3 s start + 18 s work | $0.00043 | $0.00016 |
| The same run, plus 30 s idle before sleep | $0.00075 | $0.00025 |

These are upper limits, because Claude Code waits for the network most of the time. The Workers Paid plan includes 25 GiB-hours of memory, 375 vCPU-minutes and 200 GB-hours of disk each month. On `standard-1` that covers about 1,000 runs of 21 seconds. Worker requests, Durable Object time, R2 storage and logs cost extra, and each is small for this load.

So the sandbox costs less than $0.001 for a run. The sleep timeout decides most of it: a short timeout costs less, and a long timeout makes the next comment faster.

## Other hosts

- **Fly Machines.** One Machine and one Fly Volume for each person. The volume is persistent and mounts at `/claude-config`, so Claude Code refreshes its token in place with no save step. A volume attaches to one Machine and "exists on one server in a single region". A stopped Machine costs storage only. The price was not checked.
- **E2B.** One sandbox for each person, paused between runs. A pause saves the filesystem and the memory. A resume takes about 1 second, and a pause takes about 4 seconds for each GiB of memory. A paused sandbox stays until the service deletes it. The price was not checked.
- **Modal.** A Sandbox with a named Volume for each person (`Volume.from_name(…, create_if_missing=True)`). Changes need a commit before another container sees them. A Volume is made for files that change seldom, so check it with a token file that changes on each refresh. The price was not checked.

A real volume (Fly) or a paused sandbox (E2B) fits a credential file that changes better than snapshots do. Cloudflare keeps everything on one platform with the Worker.

## Not verified

- No signed-in run in docker mode. The test stopped at the sign-in, because the sign-in needs the person.
- No cloud deployment, no cold start from a registry, and no save or restore of the config folder.
- The life of a `/login` sign-in. On the test machine `claude auth status` showed an expiry date 16 days after the test, and the date of the sign-in is not known.
- The answers of Anthropic to the policy points above.
