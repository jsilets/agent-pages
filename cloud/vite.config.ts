import { cloudflare } from '@cloudflare/vite-plugin';
import { defineConfig } from 'vite';

/**
 * `cf dev` and `cf build` run Vite with the Cloudflare plugin, the same tools as host/. CF_STATE_DIR moves the local
 * state (the Durable Object storage and the R2 bucket). The default is .cloudflare/state-cloud, apart from the host.
 */
export default defineConfig({ plugins: [cloudflare({ persistState: { path: process.env.CF_STATE_DIR || '.cloudflare/state-cloud' } })] });
