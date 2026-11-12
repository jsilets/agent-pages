# Two images come from this file.
#   docker build -t agent-pages-sandbox sandbox                      the sandbox: Claude Code and Codex, and no other program of ours
#   docker build --target egress -t agent-pages-egress sandbox       the egress proxy: Node and egress-proxy.mjs
# local-runner.mjs builds both when one is missing.

# Codex as OpenAI publishes it on npm (https://developers.openai.com/codex/cli: `npm install -g @openai/codex`).
# The npm package holds a Node launcher and the native program. The sandbox takes the folder of the native program
# as npm installed it, so the sandbox image needs no Node.
FROM alpine:3.22 AS codex
ARG CODEX_VERSION=0.167.2
RUN apk add --no-cache nodejs npm \
 && npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION} \
 && mv /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*-unknown-linux-musl /codex \
 && /codex/bin/codex --version

# The egress proxy. It is the only way out of the network of the sandbox containers.
FROM alpine:3.22 AS egress
RUN apk add --no-cache nodejs && adduser -D -u 10002 proxy
COPY egress-proxy.mjs /app/egress-proxy.mjs
USER proxy
ENTRYPOINT ["node", "/app/egress-proxy.mjs"]

FROM alpine:3.22 AS sandbox
# Claude Code comes from the signed apk repository of Anthropic (https://code.claude.com/docs/en/setup.md,
# "Install with Linux package managers"). The checksum of the repository key is the one that page gives.
# A package install does not update itself, so one image always runs one version.
# libgcc, libstdc++ and ripgrep are the runtime packages that the same page lists for Alpine.
RUN apk add --no-cache libgcc libstdc++ ripgrep \
 && wget -q -O /etc/apk/keys/claude-code.rsa.pub https://downloads.claude.ai/keys/claude-code.rsa.pub \
 && echo "395759c1f7449ef4cdef305a42e820f3c766d6090d142634ebdb049f113168b6  /etc/apk/keys/claude-code.rsa.pub" | sha256sum -c - \
 && echo "https://downloads.claude.ai/claude-code/apk/stable" >> /etc/apk/repositories \
 && apk add --no-cache claude-code \
 && adduser -D -u 10001 runner \
 && mkdir /claude-config /codex-home /work \
 && chown runner:runner /claude-config /codex-home
COPY --from=codex /codex /opt/codex
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex

# Claude Code keeps the sign-in of one user in CLAUDE_CONFIG_DIR, and Codex keeps it in CODEX_HOME.
# The runner mounts one volume for each user on each folder. A new named volume takes the owner of the folder,
# so the user `runner` can write to it. Docker sets no USER, and Claude Code needs one.
# The root file system is read-only in a run, so HOME is the tmpfs at /tmp.
ENV CLAUDE_CONFIG_DIR=/claude-config \
    CODEX_HOME=/codex-home \
    USE_BUILTIN_RIPGREP=0 \
    HOME=/tmp \
    USER=runner
VOLUME ["/claude-config", "/codex-home"]
USER runner
WORKDIR /work
# The container does nothing by itself. The runner starts each program in it with `docker exec`.
CMD ["sleep", "infinity"]
