# The Cloudflare image for Codex: the sandbox image of sandbox/Dockerfile (target `codex`), plus Node and agentd.
#   docker build -f cloud/agentd/codex.Dockerfile -t agent-pages-agentd-codex .
# test/images.test.mjs fails when the Codex install steps here and in sandbox/Dockerfile differ.
FROM alpine:3.22 AS codex-package
ARG CODEX_VERSION=0.167.2
RUN apk add --no-cache nodejs npm \
 && npm install -g --no-audit --no-fund @openai/codex@${CODEX_VERSION} \
 && cd /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*-unknown-linux-musl \
 && mkdir -p /codex/bin \
 && cp -p bin/codex bin/codex-code-mode-host /codex/bin/ \
 && cp -p codex-package.json /codex/ \
 && /codex/bin/codex --version

FROM alpine:3.22
RUN apk add --no-cache nodejs iptables ip6tables \
 && adduser -D -u 10001 runner && mkdir /work /codex-home && chown runner:runner /codex-home
COPY --from=codex-package /codex /opt/codex
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex
COPY sandbox/run-comment.mjs sandbox/egress-proxy.mjs sandbox/signin.mjs /opt/agentd/sandbox/
COPY cloud/agentd/agentd.mjs /opt/agentd/cloud/agentd/
ENV HOME=/tmp USER=runner CODEX_HOME=/codex-home AGENTD_ENGINE=codex
WORKDIR /work
EXPOSE 8080
ENTRYPOINT ["node", "/opt/agentd/cloud/agentd/agentd.mjs"]
