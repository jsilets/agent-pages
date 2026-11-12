# Three images come from this file. Each sandbox image has one program, so a run of one engine never pulls the other.
#   docker build --target claude -t agent-pages-sandbox-claude sandbox     Claude Code, and no other program of ours
#   docker build --target codex  -t agent-pages-sandbox-codex  sandbox     Codex, and no other program of ours
#   docker build --target egress -t agent-pages-egress sandbox             the egress proxy: Node and egress-proxy.mjs
# local-runner.mjs builds an image when it is missing.

# Codex as OpenAI publishes it on npm (https://developers.openai.com/codex/cli: `npm install -g @openai/codex`).
# The npm package holds a Node launcher and one folder for each platform. The image takes the files of this platform
# that `codex exec` uses, as npm installed them. No file changes.
#   bin/codex                 the program
#   bin/codex-code-mode-host  the host of the JavaScript tool `exec`. Codex starts it with each session.
#   codex-package.json        the description of the folder
# The image leaves out what a run with the connector as its only tool never starts: the voice host and its libraries
# (53 MB), `rg` (the file search of the shell tool) and `bwrap` (the sandbox of the shell tool). PERF.md has the test.
FROM alpine:3.22 AS codex-package
ARG CODEX_VERSION=0.167.2
RUN apk add --no-cache nodejs npm \
 && npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION} \
 && cd /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*-unknown-linux-musl \
 && mkdir -p /codex/bin \
 && cp -p bin/codex bin/codex-code-mode-host /codex/bin/ \
 && cp -p codex-package.json /codex/ \
 && /codex/bin/codex --version

# The egress proxy. It is the only way out of the network of the sandbox containers.
FROM alpine:3.22 AS egress
RUN apk add --no-cache nodejs && adduser -D -u 10002 proxy
COPY egress-proxy.mjs /app/egress-proxy.mjs
USER proxy
ENTRYPOINT ["node", "/app/egress-proxy.mjs"]

# What the two sandbox images share: the user, the empty working folder, and a container that does nothing by itself.
# Docker sets no USER variable, and Claude Code needs one. The root file system is read-only in a run, so HOME is the
# tmpfs at /tmp. The runner starts each program with `docker exec`.
FROM alpine:3.22 AS base
RUN adduser -D -u 10001 runner && mkdir /work
ENV HOME=/tmp \
    USER=runner
WORKDIR /work
CMD ["sleep", "infinity"]

FROM base AS codex
RUN mkdir /codex-home && chown runner:runner /codex-home
COPY --from=codex-package /codex /opt/codex
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex
# Codex keeps the sign-in of one user in CODEX_HOME. The runner mounts the volume of the user on it.
# A new named volume takes the owner of the folder, so the user `runner` can write to it.
ENV CODEX_HOME=/codex-home
VOLUME ["/codex-home"]
USER runner

FROM base AS claude
# Claude Code comes from the signed apk repository of Anthropic (https://code.claude.com/docs/en/setup.md,
# "Install with Linux package managers"). The checksum of the repository key is the one that page gives.
# A package install does not update itself, so one image always runs one version.
# libgcc, libstdc++ and ripgrep are the runtime packages that the same page lists for Alpine.
RUN apk add --no-cache libgcc libstdc++ ripgrep \
 && wget -q -O /etc/apk/keys/claude-code.rsa.pub https://downloads.claude.ai/keys/claude-code.rsa.pub \
 && echo "395759c1f7449ef4cdef305a42e820f3c766d6090d142634ebdb049f113168b6  /etc/apk/keys/claude-code.rsa.pub" | sha256sum -c - \
 && echo "https://downloads.claude.ai/claude-code/apk/stable" >> /etc/apk/repositories \
 && apk add --no-cache claude-code \
 && mkdir /claude-config \
 && chown runner:runner /claude-config
# Claude Code keeps the sign-in of one user in CLAUDE_CONFIG_DIR. The runner mounts the volume of the user on it.
ENV CLAUDE_CONFIG_DIR=/claude-config \
    USE_BUILTIN_RIPGREP=0
VOLUME ["/claude-config"]
USER runner
