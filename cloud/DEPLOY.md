# Deploy the cloud runner

This runbook deploys the runner Worker `agent-pages-runner` and connects the host to it. Do the steps in order. Each step tells you what to check before the next one.

Nothing in this runbook has run against Cloudflare yet. On 2026-11-12, `cf build --mode production` built the Worker and both images. The deploy steps are not tested.

## What you need

- The Cloudflare account that holds the host. The host must already run as the Worker `agent-pages`. See "Deploy the host" in the main `README.md`.
- The Workers Paid plan. Containers need it.
- Docker, running. `cf deploy` builds the two images on your machine and pushes them to the Cloudflare registry.
- Bun and Node 22 or later.
- The Access service token of the host CLI: `AGENT_PAGES_URL`, `AGENT_PAGES_CLIENT_ID` and `AGENT_PAGES_CLIENT_SECRET`.

## 1. Check the account

```sh
cf auth whoami
```

The output must show the personal account. If it shows another account, stop. Switch with `cf auth login` or `--profile`, then run `cf auth whoami` again.

## 2. Install and test

```sh
cd cloud
bun install
node --test test/*.test.mjs
```

All 27 tests must pass. The drift tests compare the runner with `sandbox/run-comment.mjs`. If a drift test fails, run `node dev/sync-models.mjs` for the models. For any other drift, fix the code before you continue.

## 3. Check the image controls

```sh
docker build -f agentd/claude.Dockerfile -t agent-pages-agentd-claude ..
node dev/verify-controls.mjs
```

The last line must be `all checks passed`. This proves the firewall, the proxy allow list, the read-only root, the user 10001 with no capabilities, and the limits. No sign-in and no model request are needed.

## 4. Make the shared secret

The host and the runner use one shared secret. Make it in a file that only you can read. Do not put it in your shell history.

```sh
umask 077
mkdir -p "$HOME/.agent-pages-deploy"
node -e 'const s=require("crypto").randomBytes(32).toString("base64url"); console.log(JSON.stringify({RUNNER_SECRET:s,RUNNER_DISABLED:"0"}))' > "$HOME/.agent-pages-deploy/runner-secrets.json"
node -e 'const r=require(process.argv[1]); console.log(JSON.stringify({SANDBOX_RUNNER_SECRET:r.RUNNER_SECRET}))' "$HOME/.agent-pages-deploy/runner-secrets.json" > "$HOME/.agent-pages-deploy/host-secrets.json"
```

## 5. Deploy the runner

This is the one command that changes the account. Set `HOST_ORIGINS` to the origin of the host. Set `HOST_WORKER` only if the host Worker has a name other than `agent-pages`.

```sh
HOST_ORIGINS=https://<hostname> bunx cf deploy --mode production --secrets-file "$HOME/.agent-pages-deploy/runner-secrets.json"
```

The command does these things:

- It builds the Worker and the two images, `claude` and `codex`.
- It pushes the images to the Cloudflare registry.
- It creates the R2 bucket `agent-pages-runner-credentials`.
- It creates the Durable Object namespace `UserRunner` with SQLite storage.
- It creates the container application `agent-pages-runner`.
- It uploads `RUNNER_SECRET` and `RUNNER_DISABLED` with the version.

The Worker has no public URL (`workersDev: false`, `previewUrls: false`). Only the host can call it.

Check the result:

```sh
cf workers versions list --worker-id agent-pages-runner
cf containers applications instances list
```

The first command must show one version. The second command must show no instances yet. A container starts only for a run, a warm or a sign-in.

If the deploy fails on the container or the Durable Object, see "Wrangler fallback" at the end.

## 6. Apply the host patch

```sh
cd ..
git apply --check cloud/host.patch
git apply cloud/host.patch
cd host
bun run typecheck
bun run test
```

`cloud/HOST-PATCH.md` explains each change.

## 7. Deploy the host

Apply the D1 migrations first. The branch adds `0013_comment_edits_assistants.sql`.

```sh
bunx cf d1 migrations apply <database id> --dir migrations
bunx vite build --mode production
bunx cf deploy --prebuilt --mode production --secrets-file "$HOME/.agent-pages-deploy/host-secrets.json"
```

The migrations command does not exit after it prints the list of migrations. Stop it with Ctrl-C.

Delete the secret files after both deploys:

```sh
rm -r "$HOME/.agent-pages-deploy"
```

## 8. Watch the first container

Open a log tail in a second terminal:

```sh
cf o11y telemetry live-tail --script-id agent-pages-runner
```

In the viewer, open Settings and connect Claude. The log must show `"ev":"container_started"` with `"egress":"enforced"` and `"rootfs_ro":true` in `hardening`.

If `egress` is not `enforced`, the runner refuses the container, because `REQUIRE_EGRESS` is `1`. The sign-in then fails with a clear error. This means that the Cloudflare runtime does not give the container `NET_ADMIN`. Stop here and read "If the firewall does not start" in `cloud/README.md`. Do not set `REQUIRE_EGRESS=0` before you read it.

## 9. Measure

```sh
node cloud/measure-after-deploy.mjs
```

The script makes 5 real Claude runs. It takes about 6 minutes, because it waits twice for the container to stop. It prints a table, and the log events to copy into `cloud/cost-inputs.json`. Then run `node cloud/cost.mjs` again.

## Switch the runner off

The kill switch refuses new runs, warms and sign-ins. `/status` still answers, so the viewer shows the state.

```sh
cf workers secrets update RUNNER_DISABLED --worker agent-pages-runner --text 1
```

To switch it on again, set the value to `0`. A run that is in progress ends normally. Its container stops after the linger.

## Roll back

Find the earlier version, then deploy it at 100 %:

```sh
cf workers versions list --worker-id agent-pages-runner
cf workers deployments create --worker agent-pages-runner --versions '[{"version_id":"<earlier version id>","percentage":100}]'
```

A running container keeps the image it started with. The next container uses the image of the version that is deployed.

To disconnect the host from the runner, roll back the host the same way. The host then has no runner. The viewer shows "no sandbox runner", and comments get no run.

## Actions that you cannot undo

Ask before you do any of these:

- Deleting the R2 bucket `agent-pages-runner-credentials` deletes every sign-in. Each person must sign in again.
- Deleting the Durable Object namespace or the Worker deletes the key of each archive. The archives in R2 then cannot be opened. Each person must sign in again.
- Changing `RUNNER_SECRET` on one side only stops all runs until both sides have the same value.

## Wrangler fallback

`cf` 1.0.0-beta.13 expressed the whole design, and `cf build` succeeded. Use this only if `cf deploy` refuses the container or the Durable Object. Put it in `cloud/wrangler.jsonc` and run `npx wrangler deploy` from `cloud/`. Run `npx wrangler whoami` first.

```jsonc
{
  "name": "agent-pages-runner",
  "main": "src/worker.mjs",
  "compatibility_date": "2026-08-30",
  "workers_dev": false,
  "preview_urls": false,
  "observability": { "enabled": true },
  "containers": [
    {
      "class_name": "UserRunner",
      "scheduling_policy": "durable_object",
      "images": {
        "claude": { "image": "./agentd/claude.Dockerfile", "image_build_context": ".." },
        "codex": { "image": "./agentd/codex.Dockerfile", "image_build_context": ".." }
      },
      "ssh": { "enabled": false }
    }
  ],
  "durable_objects": { "bindings": [{ "name": "USER_RUNNER", "class_name": "UserRunner" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["UserRunner"] }],
  "r2_buckets": [{ "binding": "CREDENTIALS", "bucket_name": "agent-pages-runner-credentials" }],
  "services": [{ "binding": "HOST", "service": "agent-pages" }],
  "vars": {
    "HOST_ORIGINS": "https://<hostname>",
    "LINGER_MS": "90000",
    "WARM_MS": "60000",
    "RUN_TIMEOUT_MS": "180000",
    "INSTANCE_CLAUDE": "standard-1",
    "INSTANCE_CODEX": "standard-1",
    "REQUIRE_EGRESS": "1"
  }
}
```

Wrangler needs the R2 bucket first: `npx wrangler r2 bucket create agent-pages-runner-credentials`. Set the secrets with `npx wrangler secret put RUNNER_SECRET` and `npx wrangler secret put RUNNER_DISABLED`. The keys of the `images` map are not checked against the Wrangler schema. Run `npx wrangler deploy --dry-run` first. The Worker uses `ctx.exports.Outbound`. If a log says that `ctx.exports` is undefined, add `"compatibility_flags": ["enable_ctx_exports"]` (GUESS: `cf` set this up through `exports.worker()`).
