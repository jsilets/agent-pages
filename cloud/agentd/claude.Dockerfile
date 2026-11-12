# The Cloudflare image for Claude Code: the sandbox image of sandbox/Dockerfile (target `claude`), plus Node and agentd.
# The build context is the repository root, so the image takes sandbox/run-comment.mjs, sandbox/egress-proxy.mjs and
# sandbox/signin.mjs as they are. claude.Dockerfile.dockerignore keeps every other file out of the context.
#   docker build -f cloud/agentd/claude.Dockerfile -t agent-pages-agentd-claude .
# test/images.test.mjs fails when the Claude Code install steps here and in sandbox/Dockerfile differ.
FROM alpine:3.22
# Claude Code comes from the signed apk repository of Anthropic (https://code.claude.com/docs/en/setup.md,
# "Install with Linux package managers"), as in sandbox/Dockerfile. No file of it changes.
# nodejs runs agentd. iptables is the firewall that agentd sets for the programs.
RUN apk add --no-cache libgcc libstdc++ ripgrep nodejs iptables ip6tables \
 && wget -q -O /etc/apk/keys/claude-code.rsa.pub https://downloads.claude.ai/keys/claude-code.rsa.pub \
 && echo "395759c1f7449ef4cdef305a42e820f3c766d6090d142634ebdb049f113168b6  /etc/apk/keys/claude-code.rsa.pub" | sha256sum -c - \
 && echo "https://downloads.claude.ai/claude-code/apk/stable" >> /etc/apk/repositories \
 && apk add --no-cache claude-code \
 && adduser -D -u 10001 runner && mkdir /work /claude-config && chown runner:runner /claude-config
COPY sandbox/run-comment.mjs sandbox/egress-proxy.mjs sandbox/signin.mjs /opt/agentd/sandbox/
COPY cloud/agentd/agentd.mjs /opt/agentd/cloud/agentd/
# agentd starts as root to set the firewall and to start each program as uid 10001 (runner).
ENV HOME=/tmp USER=runner CLAUDE_CONFIG_DIR=/claude-config USE_BUILTIN_RIPGREP=0 AGENTD_ENGINE=claude
WORKDIR /work
EXPOSE 8080
ENTRYPOINT ["node", "/opt/agentd/cloud/agentd/agentd.mjs"]
