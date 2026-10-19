# syntax=docker/dockerfile:1

FROM node:22-alpine AS web
WORKDIR /src/web
RUN corepack enable
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ ./
COPY server/api/openapi.yaml /src/server/api/openapi.yaml
RUN pnpm build

FROM golang:1.24-alpine AS server
WORKDIR /src/server
COPY server/go.mod server/go.sum ./
RUN go mod download
COPY server/ ./
COPY --from=web /src/web/dist ./internal/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o /out/hotfm ./cmd/hotfm

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=server /out/hotfm /hotfm
ENV HOTFM_ADDR=:8080 HOTFM_DATA_DIR=/data
VOLUME /data
EXPOSE 8080
ENTRYPOINT ["/hotfm"]
