# HotFM — Go API + TypeScript web app.
#   make dev      run API (:18347) and Vite dev server (:18348) together
#   make build    build web, embed it, produce ./bin/hotfm
#   make test     Go + web unit tests
#   make gen      regenerate TS API types from server/api/openapi.yaml

SHELL := /bin/bash
export GOTOOLCHAIN := local

WEB_DIST := server/internal/webui/dist
PNPM ?= pnpm

.PHONY: dev dev-api dev-web build web server test test-go test-web gen lint clean

dev:
	@node scripts/dev.mjs

dev-api:
	@node scripts/dev.mjs api

dev-web:
	@node scripts/dev.mjs web

web:
	cd web && $(PNPM) install --frozen-lockfile && $(PNPM) build
	rm -rf $(WEB_DIST) && mkdir -p $(WEB_DIST) && cp -R web/dist/. $(WEB_DIST)/

server:
	cd server && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o ../bin/hotfm ./cmd/hotfm

build: web server

test: test-go test-web

test-go:
	cd server && go test ./...

test-web:
	cd web && $(PNPM) test && $(PNPM) typecheck

gen:
	cd web && $(PNPM) gen:api

lint:
	cd server && go vet ./... && test -z "$$(gofmt -l .)"

clean:
	rm -rf bin web/dist
	git checkout -- $(WEB_DIST) 2>/dev/null || true
