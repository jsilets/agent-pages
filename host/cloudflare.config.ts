/**
 * The agent-pages Worker, deployed with `cf deploy`.
 *
 * `--mode production` evaluates the deployed Worker. Any other mode evaluates
 * `development`, which runs with local D1 and R2 and no Access check.
 *
 * Personal values (the hostname and the Access team and AUD) are not committed.
 * Copy `deploy.example.json` to `deploy.local.json` and fill it in before a deploy.
 * Run `cf auth whoami` before each deploy and confirm the account.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindings, defineConfig } from 'cf/config';
import type { ConfigContext } from 'cf/config';

const NAME = 'agent-pages';

/** The ID of the local D1 simulator database. It names no Cloudflare database. */
const LOCAL_D1_ID = '00000000-0000-4000-8000-00000000a271';

interface DeployProfile {
  /** The custom domain, for example `pages.example.com`. Access protects this hostname. */
  hostname: string;
  /** The Access team name: the `<team>` in `<team>.cloudflareaccess.com`. */
  accessTeam: string;
  /** The Application Audience (AUD) tag of the main Access application. */
  accessAud: string;
  /** Optional. The name of the Worker, the D1 database and the R2 bucket. Default: `agent-pages`. */
  name?: string;
}

function readProfile(): DeployProfile {
  const file = join(dirname(fileURLToPath(import.meta.url)), 'deploy.local.json');
  if (!existsSync(file)) throw new Error('host/deploy.local.json is missing. Copy deploy.example.json and fill it in.');
  return JSON.parse(readFileSync(file, 'utf8')) as DeployProfile;
}

export default defineConfig(({ mode }: ConfigContext) => {
  const production = mode === 'production';
  const profile: DeployProfile = production ? readProfile() : { hostname: '', accessTeam: '', accessAud: '' };
  const name = profile.name || NAME;
  return {
    worker: {
      name: production ? name : `${NAME}-development`,
      entrypoint: './src/worker.ts',
      compatibilityDate: '2026-08-30',
      observability: { enabled: true },
      // Access protects a hostname on a zone. It cannot protect a workers.dev origin,
      // so the Worker has no workers.dev origin and serves only the custom domain.
      workersDev: false,
      ...(production ? { domains: [profile.hostname] } : {}),
      env: {
        DB: bindings.d1(production ? { name } : { name: `${NAME}-development`, id: LOCAL_D1_ID }),
        PAGES: bindings.r2({ name: production ? name : `${NAME}-development` }),
        // Browser Rendering takes the thumbnails at publish time. The local simulator has no
        // screenshot action, so development uses the real service too.
        BROWSER: bindings.browser({ dev: { remote: true } }),
        ENVIRONMENT: bindings.text(production ? 'production' : 'development'),
        ACCESS_TEAM: bindings.text(profile.accessTeam),
        ACCESS_AUD: bindings.text(profile.accessAud),
        // Development only: sandbox/local-runner.mjs. Production has no runner until a person decides where it runs.
        ...(!production && process.env.SANDBOX_RUNNER_URL ? { SANDBOX_RUNNER_URL: bindings.text(process.env.SANDBOX_RUNNER_URL) } : {}),
        // Development only: the shared secret of the runner. The host sends it as the header x-runner-secret with each job.
        ...(!production && process.env.SANDBOX_RUNNER_SECRET ? { SANDBOX_RUNNER_SECRET: bindings.text(process.env.SANDBOX_RUNNER_SECRET) } : {}),
        // Development only: the mentions that the runner handles. Default: claude,chatgpt. Example: SANDBOX_AGENTS=claude.
        ...(!production && process.env.SANDBOX_AGENTS ? { SANDBOX_AGENTS: bindings.text(process.env.SANDBOX_AGENTS) } : {}),
      },
    },
  };
});
