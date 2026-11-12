/**
 * The runner Worker (`agent-pages-runner`), deployed with `cf deploy` from this folder. DEPLOY.md has each step.
 *
 * `--mode production` evaluates the deployed Worker. Any other mode evaluates `development`, for `cf dev`.
 * Values for production come from the environment of the deploy command, so no personal value is in this file:
 *   HOST_ORIGINS   the origin of the host, for example https://pages.example.com. A job with another origin gets 400.
 *   HOST_WORKER    the name of the host Worker for the service binding HOST. Default: agent-pages.
 * Secrets (`cf workers secrets update`): RUNNER_SECRET (the same value as SANDBOX_RUNNER_SECRET of the host) and
 * RUNNER_DISABLED (the kill switch: "1" refuses new runs).
 */
import { bindings, defineConfig, defineContainer, exports } from 'cf/config';
import type { ConfigContext } from 'cf/config';

const NAME = 'agent-pages-runner';

export default defineConfig(({ mode }: ConfigContext) => {
  const production = mode === 'production';
  if (production && !process.env.HOST_ORIGINS) throw new Error('Set HOST_ORIGINS to the origin of the host, for example https://pages.example.com.');
  const name = production ? NAME : `${NAME}-development`;
  // One container application. The Durable Object picks the image (one for each engine) and the instance type at each start.
  const sandbox = defineContainer({
    name,
    schedulingPolicy: 'durable-object',
    images: {
      claude: { dockerfile: './agentd/claude.Dockerfile', buildContext: '..' },
      codex: { dockerfile: './agentd/codex.Dockerfile', buildContext: '..' },
    },
    // A container holds the sign-in of a person. Nobody gets a shell in it, not even an account member with write access.
    ssh: { enabled: false },
    observability: { enabled: true, logs: { enabled: true } },
  });
  return {
    worker: {
      name,
      entrypoint: './src/worker.mjs',
      compatibilityDate: '2026-08-30',
      observability: { enabled: true },
      // No public URL: the host reaches the runner through its service binding only.
      workersDev: false,
      previewUrls: false,
      exports: {
        UserRunner: exports.durableObject({ storage: 'sqlite', container: sandbox }),
        Outbound: exports.worker(),
      },
      env: {
        CREDENTIALS: bindings.r2({ name: `${name}-credentials` }),
        ...(production ? { HOST: bindings.worker({ worker: process.env.HOST_WORKER || 'agent-pages' }) } : {}),
        HOST_ORIGINS: bindings.text(production ? process.env.HOST_ORIGINS! : process.env.HOST_ORIGINS || ''),
        LINGER_MS: bindings.text(process.env.LINGER_MS || '90000'),
        WARM_MS: bindings.text(process.env.WARM_MS || '60000'),
        RUN_TIMEOUT_MS: bindings.text(process.env.RUN_TIMEOUT_MS || '180000'),
        INSTANCE_CLAUDE: bindings.text(process.env.INSTANCE_CLAUDE || 'standard-1'),
        INSTANCE_CODEX: bindings.text(process.env.INSTANCE_CODEX || 'standard-1'),
        // 1: refuse a container whose firewall did not start. DEPLOY.md step 8 checks it on the first container.
        REQUIRE_EGRESS: bindings.text(process.env.REQUIRE_EGRESS ?? (production ? '1' : '0')),
        RUNNER_SECRET: bindings.secret(),
        RUNNER_DISABLED: bindings.secret(),
      },
    },
    containers: [sandbox],
  };
});
