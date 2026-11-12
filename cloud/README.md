# Cloud runner

This folder holds the production runner for the sandbox agents on Cloudflare. It serves the same job contract as `sandbox/local-runner.mjs`, so the host only needs a service binding (`HOST-PATCH.md`). `DEPLOY.md` is the runbook. `COST.md` has the cost tables.

Evidence labels: READ means that a primary doc says it, with the URL. GUESS means that no doc says it, and a deploy must check it. MEASURED means that a local run produced it.

## Architecture

1. The host calls the Worker `agent-pages-runner` through a service binding only. The Worker has no public URL. Each call carries `x-runner-secret`. A deployed runner with no secret refuses all calls.
2. Each user has one Durable Object, `UserRunner`. Its name is `sha256("agent-pages-user:v1:" + user)` in hex. The object holds the queue (one run at a time, at most 5 waiting), the warm policy, the alarms, and the key of the archive.
3. Each object starts at most one container with `ctx.container.start()`, with the image of the engine (`claude` or `codex`). READ: the container API of a Durable Object, the `durable_object` scheduling policy, and the images map. https://developers.cloudflare.com/containers/api/durable-object-container/ and https://developers.cloudflare.com/containers/configuration/scheduling-policy/
4. Warm policy: `/warm` (a person starts to type) starts the container. A run then gets a container that waits. After a run, the container waits 90 s for the next run. Then the object drains it (ends the programs, saves) and stops it. No container means no alarm.
5. agentd in the container runs each job with `runJob()` of `sandbox/run-comment.mjs` and keeps one Claude Code process ready with `warmClaude()`. The image copies the sandbox files as they are. `test/drift.test.mjs` fails if the runner and the sandbox differ.
6. Egress: the container has internet (`enableInternet: true`). agentd holds the allow list. It sets iptables owner rules for user 10001: a reset for each TCP connection that is not to loopback. The programs reach only the agentd proxy, which opens CONNECT tunnels to the model and sign-in hosts on port 443. TLS stays end to end. An unlisted host gets 403 at once.
7. The connector token stays in the object. The CLI calls `http://127.0.0.1:3128/mcp`. agentd sends that to `http://runner.internal/mcp`. The object intercepts it (`interceptOutboundHttp`, READ: https://developers.cloudflare.com/containers/configuration/outbound-traffic/), adds the `mcp_url` of the run, and calls the host through the `HOST` binding. The callbacks use the same path with a nonce.
8. Sign-in persistence: agentd packs the sign-in folder with `tar` as user 10001 and seals it with AES-256-GCM. The key is random for each user and lives in the object. The AAD binds the archive to the user and the engine. R2 holds the sealed archive at `cred/v1/<user key>/<engine>`. Nobody parses the folder.
9. Refresh safety: agentd saves only when no program runs, after a run, after a sign-in, and at the drain. The drain waits for a young Claude process (30 s) before it ends it. The object never destroys a container with no drain first, except at the hard time limit. One run at a time for each user means that two refreshes never race.
10. Controls: the kill switch `RUNNER_DISABLED`, `REQUIRE_EGRESS=1`, a read-only root, `noexec` `/tmp`, user 10001 with no capabilities, no SSH, and audit logs with no secret.

## Decisions and evidence

| Decision | Why | Evidence |
|---|---|---|
| `ctx.container` on a Durable Object, not the `Container` class of `@cloudflare/containers` | The class is deprecated and maintained until Dec 31, 2026. | READ: https://developers.cloudflare.com/containers/guides/migrate-to-durable-object-container-api/ |
| One object for each user, named by a hash | `getByName()` gives the same object for the same name everywhere. The hash keeps emails out of logs and ids. SHA-256 has no practical collision. The name is not secret, but only the Worker can call an object, so a name gives no access. | READ: https://developers.cloudflare.com/durable-objects/ |
| A sign-in id is `<user key>-<agentd session id>` | The Worker finds the object from the id alone. The host also checks that the flow belongs to the person. The object checks that the id is its own. | MEASURED: `test/core.test.mjs` "the HTTP front" |
| The allow list inside the container, not in the platform | A platform allow list for HTTPS needs `interceptOutboundHttps`, which decrypts TLS in our Worker. Then the OAuth token of the person would pass through our code. Anthropic says that we may not "collect, store, or intermediate" these tokens. A plain HTTP intercept sees only `runner.internal`. | READ: https://developers.cloudflare.com/containers/configuration/outbound-traffic/ and https://code.claude.com/docs/en/legal-and-compliance |
| `enableInternet: true` | With `enableInternet: false`, an unlisted name does not resolve, and the program waits for its DNS time out. With the firewall, it gets a reset in 52 ms. | MEASURED: `dev/verify-controls.mjs`. READ: outbound-traffic page |
| An encrypted archive in R2, not snapshots | A snapshot is tied to the image and ends after 30 days. A new image would sign out every person. The archive survives image updates. | READ: https://developers.cloudflare.com/containers/guides/snapshots/ |
| Save only when no program runs; drain before stop | A refresh rotates the token. A copy taken during a refresh, or a stop during one, can lose the new token (issue 102265). | READ: https://github.com/anthropics/claude-code/issues/102265 |
| Instance `standard-1` (1/2 vCPU, 4 GiB, 8 GB), set by `INSTANCE_CLAUDE` and `INSTANCE_CODEX` | At 1/4 vCPU (`basic`), a warm run took 12.4 s in place of 4.6 s. `start({ instance })` takes a named type or a custom size. | READ: https://developers.cloudflare.com/containers/api/durable-object-container/. MEASURED: `sandbox/cost-inputs.json` |
| `cf` config, no Wrangler | `cf` 1.0.0-beta.13 expressed the container, the object, the images, the R2 bucket and the bindings. `cf build --mode production` built the Worker and both images. | MEASURED: `cf build`. `DEPLOY.md` has a Wrangler fallback. |

## Compliance position

- Each person signs in with their own Claude or ChatGPT account, in their own container. The runner runs the unmodified Claude Code and Codex binaries. It does not wrap them, and it does not weaken their sign-in.
- The pasted code goes from the viewer to the host, to the object, to agentd, and to the program on stdin, one time. No part logs it or stores it. The tests check the logs for the code.
- The OAuth tokens stay inside the container of that person. The programs send them to Anthropic or OpenAI over TLS from inside the container. Our Worker sees only ciphertext of those connections, because it does not intercept HTTPS.
- To keep a person signed in after the container stops, agentd saves the sign-in folder as an archive. The archive is sealed with a key for that person. Our code never opens, parses or logs the folder.
- Open question for the owner: the archive and its key are both in our Cloudflare account. An account member who can deploy code could write code that opens an archive. So our position is "we store an encrypted copy that our code never reads", not "we cannot read it". Anthropic forbids us to "store" these tokens. Whether a sealed archive counts as storing them is a question for Anthropic or a lawyer. The other choice is no persistence: each person signs in again after each container stop. `RUNNER_DISABLED` and deleting the R2 bucket remove all archives at once.

## Security compared with the local runner

| Control | Local runner (`sandbox/`) | Cloud runner |
|---|---|---|
| Who can call the runner | A shared secret on a port of one machine | A service binding only, plus the shared secret. No public URL. |
| Isolation between people | One container for each person on one Docker host | One Cloudflare container (its own VM) for each person |
| Egress | Docker network with a proxy | Firewall for user 10001, plus the proxy allow list, plus a reset at once |
| Connector token | Not in the container | Not in the container. It stays in the object. |
| Sign-in at rest | A Docker volume, not encrypted | AES-256-GCM archive. The key is for one person and lives in the object. |
| Shell access | `docker exec` by the owner of the machine | SSH off. No `exec` route in the Worker. |
| Kill switch | Stop the process | `RUNNER_DISABLED=1` |
| Audit | Runner log | Worker log with `ev` events, user key and run ids, no tokens and no codes |

## What is proven locally

Run these from `cloud/`. None of them needs a deploy.

- `node --test test/*.test.mjs`: 27 tests. They cover the state machine of the object with fakes, agentd, and the drift against the sandbox.
- `node dev/verify-controls.mjs`: the controls of the image in a real container.
- `node dev/archive-roundtrip.mjs`: it packs and seals the signed-in folder of a Docker volume, then restores it into a new container with no network. Then `claude auth status` reports signed in. A wrong key is refused. Nothing prints or parses the folder.
- `node dev/local-cloud.mjs`: the real core and agentd with Docker in place of `ctx.container`, on port 8815. Point the host at `http://localhost:8815/run`.
- `npx vite --port 8806`: the Cloudflare local simulator with the real Worker, object and container.

## If the firewall does not start

The local simulator gave the container no `NET_ADMIN`, so agentd reported `egress: proxy-only`. GUESS: a deployed Cloudflare container gives root its normal capabilities, because "Processes have root's Linux capabilities" (READ: https://developers.cloudflare.com/containers/guides/execute-commands/). The deploy must check it (DEPLOY.md step 8).

If the deployed container has no `NET_ADMIN`, `REQUIRE_EGRESS=1` refuses it. Do not set `REQUIRE_EGRESS=0`: then a program could connect to any host directly. Build this fallback instead (not built, GUESS):

- Set `enableInternet: false`.
- agentd sends each allowed CONNECT tunnel as a WebSocket to `http://egress.internal/<host>`. The object intercepts it with `interceptOutboundHttp`.
- The `Outbound` Worker checks the host against the allow list, opens a TCP socket with `connect()` to `<host>:443`, and copies the bytes both ways.
- TLS still ends inside the container, so the Worker sees only ciphertext.
- An unlisted host gets 403 from agentd at once, as now.

## Files

| File | What it does |
|---|---|
| `cloudflare.config.ts` | The Worker, the object, the container application, the images, the bindings |
| `src/worker.mjs` | `UserRunner` (the object), `Outbound` (the intercept), and the HTTP front |
| `src/core.mjs` | The logic of the object: queue, warm policy, alarms, sign-in, archive, callbacks |
| `src/models.mjs`, `src/models.json` | The models and `jobError()`, kept the same as the sandbox by the drift test |
| `agentd/agentd.mjs` | The supervisor in the container |
| `agentd/*.Dockerfile` | The images. The claude image is 374 MB (160 MB compressed). |
| `test/` | Unit tests and drift tests |
| `dev/` | Local harness, controls check, archive round trip, model sync |
| `cost.mjs`, `cost-inputs.json`, `COST.md` | The cost model |
| `measure-after-deploy.mjs` | The measurements after a deploy |
| `host.patch`, `HOST-PATCH.md` | The change to the host |
| `DEPLOY.md` | The runbook |
