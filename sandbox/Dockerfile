# The sandbox image: Claude Code as Anthropic publishes it, Node for the job runner, and nothing else.
# Build: docker build -t agent-pages-sandbox sandbox
FROM alpine:3.22

# Claude Code comes from the signed apk repository of Anthropic (https://code.claude.com/docs/en/setup.md,
# "Install with Linux package managers"). The checksum of the repository key is the one that page gives.
# A package install does not update itself, so one image always runs one version.
# libgcc, libstdc++ and ripgrep are the runtime packages that the same page lists for Alpine.
RUN apk add --no-cache nodejs libgcc libstdc++ ripgrep \
 && wget -q -O /etc/apk/keys/claude-code.rsa.pub https://downloads.claude.ai/keys/claude-code.rsa.pub \
 && echo "395759c1f7449ef4cdef305a42e820f3c766d6090d142634ebdb049f113168b6  /etc/apk/keys/claude-code.rsa.pub" | sha256sum -c - \
 && echo "https://downloads.claude.ai/claude-code/apk/stable" >> /etc/apk/repositories \
 && apk add --no-cache claude-code \
 && adduser -D -u 10001 runner \
 && mkdir /claude-config /work \
 && chown runner:runner /claude-config /work

COPY run-comment.mjs /app/run-comment.mjs

# Claude Code keeps the sign-in of one user in CLAUDE_CONFIG_DIR. Mount one volume for each user here.
# A new named volume takes the owner of this folder, so the user `runner` can write to it.
# run-comment.mjs refuses to start with no USER, and Docker sets none.
ENV CLAUDE_CONFIG_DIR=/claude-config \
    USE_BUILTIN_RIPGREP=0 \
    USER=runner
VOLUME /claude-config
USER runner
WORKDIR /work
ENTRYPOINT ["node", "/app/run-comment.mjs"]
