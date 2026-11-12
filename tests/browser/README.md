# Browser tests of the viewer

`run.mjs` drives the viewer with a real mouse, real keys and real scrolling in Chromium, WebKit and Firefox. The tests check the single scroll bar, the place of each card, selections, the keyboard, edit and delete, an `@claude` run, a deck, the medium and narrow widths, the two sign-ins of "Assistants", the boxes that replace the Highlight API, and an old version.

Playwright is not a dependency of this repo. Install it in a folder of your choice:

```bash
mkdir -p /tmp/pw && cd /tmp/pw && npm init -y && npm i playwright && npx playwright install chromium webkit firefox
```

Start the fake runner and the host in development mode. The fake runner must start with Claude connected:

```bash
node host/dev/simulate-run.mjs --port 8813 --connected claude
cd host && CF_STATE_DIR=.cloudflare/state-test SANDBOX_RUNNER_URL=http://localhost:8813/run bunx vite --port 8802 --strictPort
```

Run the tests. `PLAYWRIGHT` is the path of the `playwright` package. The argument is the base URL of the host:

```bash
PLAYWRIGHT=/tmp/pw/node_modules/playwright node tests/browser/run.mjs http://localhost:8802
```

Options:

- `--engines chromium,webkit,firefox` sets the browsers. The default is all three.
- `--only word,word` runs the tests whose name has one of the words.
- `--shots <dir>` saves screenshots, and a screenshot of each failure.
- `--video <dir>` records a video of each test. `--slow <ms>` waits after each action, so a video is easy to follow.
- `--dark` runs with the dark color scheme.

The tests publish their own pages under `browser-tests/` and delete them at the end. The script prints a table with the result of each test in each browser, and it exits with 1 when a test fails.
