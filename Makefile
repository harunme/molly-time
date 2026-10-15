SHELL := /bin/bash
.DEFAULT_GOAL := help

.PHONY: help dev tv web site server init build build-tv build-web build-site build-server test test-tv test-web test-site clean

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "%-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

dev: ## Start API, TV web, parent web, and website with live reload
	@bash tools/run-dev.sh

tv: ## Start only the TV web development server
	bash tools/run-tv-web.sh

web: ## Start only the parent web development server
	pnpm --dir apps/web dev

site: ## Start the public website at http://127.0.0.1:4321
	pnpm --dir apps/site dev

server: ## Start only the API server
	bash tools/run-server.sh

init: ## Initialise the local API database and admin user
	bash tools/init-server.sh

build: build-server build-tv build-web ## Build all web apps and prepare the API environment

build-server: ## Create the API virtual environment and install dependencies
	bash tools/build-server.sh

build-tv: ## Build and package the TV web app
	bash tools/build-tv-web.sh

build-web: ## Build the parent web app and public website
	bash tools/build-web.sh

build-site: ## Build and stage the public website in the release
	bash tools/build-site.sh

test-tv: ## Run TV web tests
	pnpm --dir apps/tv/web test

test-web: ## Run parent web tests
	pnpm --dir apps/web test

test-site: ## Run public website browser tests (build-site first)
	pnpm --dir apps/site test

clean: ## Remove generated web build outputs
	rm -rf apps/tv/web/dist apps/web/dist apps/site/dist
