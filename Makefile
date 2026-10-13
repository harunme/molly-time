SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help dev tv web server init build build-tv build-web build-server test test-tv test-web clean

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "%-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

dev: ## Start API, TV web, and parent web development servers
	@set -m; \
	  bash tools/run-server.sh & server_pid=$$!; \
	  bash tools/run-tv-web.sh & tv_pid=$$!; \
	  pnpm --dir apps/web dev & web_pid=$$!; \
	  cleanup() { kill $$server_pid $$tv_pid $$web_pid 2>/dev/null || true; wait 2>/dev/null || true; }; \
	  trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM; \
	  while kill -0 $$server_pid 2>/dev/null && kill -0 $$tv_pid 2>/dev/null && kill -0 $$web_pid 2>/dev/null; do sleep 1; done; \
	  status=0; \
	  for pid in $$server_pid $$tv_pid $$web_pid; do \
	    if ! kill -0 $$pid 2>/dev/null; then wait $$pid || status=$$?; fi; \
	  done; \
	  exit $$status

tv: ## Start only the TV web development server
	bash tools/run-tv-web.sh

web: ## Start only the parent web development server
	pnpm --dir apps/web dev

server: ## Start only the API server
	bash tools/run-server.sh

init: ## Initialise the local API database and admin user
	bash tools/init-server.sh

build: build-server build-tv build-web ## Build all web apps and prepare the API environment

build-server: ## Create the API virtual environment and install dependencies
	bash tools/build-server.sh

build-tv: ## Build and package the TV web app
	bash tools/build-tv-web.sh

build-web: ## Build the parent web app
	bash tools/build-web.sh

test-tv: ## Run TV web tests
	pnpm --dir apps/tv/web test

test-web: ## Run parent web tests
	pnpm --dir apps/web test

clean: ## Remove generated web build outputs
	rm -rf apps/tv/web/dist apps/web/dist
