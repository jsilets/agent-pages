import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

/**
 * `vite` runs the Worker in workerd with local bindings. `vite build` writes the output
 * that `cf deploy --prebuilt` deploys. The Worker imports ../kit/explain.css, so Vite may
 * read the repo root. CF_STATE_DIR moves the local D1 and R2 state, so two dev servers can run
 * from one checkout. The default is .cloudflare/state. A local sandbox container reaches the dev
 * server as host.docker.internal, so the dev server takes that host name too.
 */
const persistState = process.env.CF_STATE_DIR ? { persistState: { path: process.env.CF_STATE_DIR } } : {};
export default defineConfig({ plugins: [cloudflare(persistState)], server: { fs: { allow: ['..'] }, allowedHosts: ['host.docker.internal'] } });
