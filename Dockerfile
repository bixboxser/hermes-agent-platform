FROM node:20-bullseye

ARG GO_VERSION=1.26.3
ARG TARGETARCH

ENV GOPATH=/root/go \
    GOBIN=/root/go/bin \
    PATH=/root/go/bin:/usr/local/go/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git; \
    rm -rf /var/lib/apt/lists/*; \
    arch="${TARGETARCH:-amd64}"; \
    case "$arch" in \
      amd64) go_arch="amd64" ;; \
      arm64) go_arch="arm64" ;; \
      *) echo "unsupported TARGETARCH=$arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-${go_arch}.tar.gz" -o /tmp/go.tgz; \
    rm -rf /usr/local/go; \
    tar -C /usr/local -xzf /tmp/go.tgz; \
    rm -f /tmp/go.tgz; \
    mkdir -p "$GOBIN"; \
    go version

WORKDIR /app

COPY docker/hermes-entrypoint.sh /usr/local/bin/hermes-entrypoint
COPY scripts/install-printing-press-clis.sh /usr/local/bin/install-printing-press-clis
RUN chmod +x /usr/local/bin/hermes-entrypoint /usr/local/bin/install-printing-press-clis

ENTRYPOINT ["hermes-entrypoint"]
