# Jarvis — top-level developer commands (Node / TypeScript runtime).
#
# The Rust runtime was decommissioned (P8.2); Jarvis now runs entirely on the
# Node workspace under packages/* + apps/jarvis-web. `make help` prints the menu.
#
# Conventions:
#   * Every target is .PHONY (no file outputs whose freshness make tracks
#     across pnpm + vite + docker).
#   * Targets call sub-tools directly so failure messages stay readable.

.DEFAULT_GOAL := help

PNPM          ?= pnpm
NPM           ?= npm
NODE          ?= node
DOCKER        ?= docker
COMPOSE       ?= docker compose
IMAGE         ?= jarvis:local
WEB_DIR       := apps/jarvis-web
WEB_DIST      := $(WEB_DIR)/dist

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
.PHONY: help
help: ## Show this help (default target)
	@printf "Jarvis — make targets\n\n"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_.-]+:.*##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\n"

# ---------------------------------------------------------------------------
# Dev
# ---------------------------------------------------------------------------
.PHONY: install
install: ## Install the pnpm workspace dependencies
	$(PNPM) install

.PHONY: web-deps
web-deps: ## Install web dependencies (npm ci — the SPA is a standalone npm app)
	cd $(WEB_DIR) && $(NPM) ci --no-audit --no-fund

.PHONY: web
web: web-deps ## Build the web bundle into apps/jarvis-web/dist
	cd $(WEB_DIR) && $(NPM) run build

.PHONY: web-dev
web-dev: web-deps ## Run the Vite dev server (hot reload)
	cd $(WEB_DIR) && $(NPM) run dev

.PHONY: dev
dev: web ## Build web + run the Node server (one process, embedded UI)
	JARVIS_WEB_DIST=$(CURDIR)/$(WEB_DIST) \
		$(NODE) --experimental-strip-types packages/jarvis-app/src/main.ts serve

# ---------------------------------------------------------------------------
# Quality gates (CI mirrors these)
# ---------------------------------------------------------------------------
.PHONY: typecheck
typecheck: ## tsc --noEmit across every package
	$(PNPM) -r typecheck

.PHONY: lint
lint: ## eslint (CI gate)
	$(PNPM) lint

.PHONY: test
test: ## Node test runner across every package
	$(PNPM) -r test

.PHONY: check
check: typecheck lint test ## Run typecheck + lint + tests, what CI runs

.PHONY: perf
perf: ## Run the Node harness perf baseline (P8.3)
	$(NODE) --experimental-strip-types --expose-gc scripts/perf-baseline.ts

# ---------------------------------------------------------------------------
# Docker / Compose
# ---------------------------------------------------------------------------
.PHONY: docker
docker: ## Build the runtime image (tag: $(IMAGE))
	DOCKER_BUILDKIT=1 $(DOCKER) build -t $(IMAGE) .

.PHONY: docker-run
docker-run: ## Run the image in the foreground (Ctrl-C to stop)
	$(DOCKER) run --rm -it \
		-p 127.0.0.1:7001:7001 \
		--env-file .env \
		-v jarvis-data:/data \
		-v $(CURDIR)/workspace:/workspace \
		$(IMAGE)

.PHONY: compose-up
compose-up: ## Start the stack via docker compose (detached)
	$(COMPOSE) up -d --build

.PHONY: compose-down
compose-down: ## Stop the stack and remove containers
	$(COMPOSE) down

.PHONY: compose-logs
compose-logs: ## Tail logs from the running stack
	$(COMPOSE) logs -f --tail=200

# ---------------------------------------------------------------------------
# Cleanup
# ---------------------------------------------------------------------------
.PHONY: clean
clean: ## Wipe web dist/ + node_modules
	rm -rf $(WEB_DIST) $(WEB_DIR)/node_modules node_modules packages/*/node_modules

.PHONY: distclean
distclean: clean ## clean + drop docker image and volumes (destructive)
	-$(DOCKER) image rm $(IMAGE)
	-$(COMPOSE) down -v
