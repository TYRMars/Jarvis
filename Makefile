# Jarvis — top-level developer commands.
#
# `make help` (or just `make`) prints the menu. Targets are grouped:
#
#   dev / build       — local cargo + vite workflow
#   check             — lint + tests, what CI runs
#   docker / compose  — container workflow
#   clean             — wipe build artefacts
#
# Conventions:
#   * Every target is .PHONY (we have no file outputs whose freshness make
#     could check sensibly across cargo + vite + docker).
#   * Targets call sub-tools directly rather than wrapping them in shell
#     scripts so failure messages stay readable.

.DEFAULT_GOAL := help

CARGO         ?= cargo
NPM           ?= npm
DOCKER        ?= docker
COMPOSE       ?= docker compose
IMAGE         ?= jarvis:local
WEB_DIR       := apps/jarvis-web
WEB_DIST      := $(WEB_DIR)/dist

# `jarvis-desktop` is a Tauri shell that requires WebKitGTK + GObject system
# libs on Linux (libgtk-3-dev, libwebkit2gtk-4.1-dev, librsvg2-dev, ...).
# Linux CI excludes it (see .github/workflows/rust.yml) so the default
# workspace targets stay buildable on a stock Ubuntu box without the GTK
# toolchain. Mirror the exclusion here so `make check` matches CI.
# Override `WORKSPACE_EXCLUDE=` (empty) on a machine with the GTK deps
# installed to lint / test the desktop crate too.
WORKSPACE_EXCLUDE ?= --exclude jarvis-desktop

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
.PHONY: help
help: ## Show this help (default target)
	@printf "Jarvis — make targets\n\n"
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_.-]+:.*##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)
	@printf "\n"

# ---------------------------------------------------------------------------
# Dev (local cargo + vite, no Docker)
# ---------------------------------------------------------------------------
.PHONY: web-deps
web-deps: ## Install web dependencies (npm ci)
	cd $(WEB_DIR) && $(NPM) ci --no-audit --no-fund

.PHONY: web
web: web-deps ## Build the web bundle into apps/jarvis-web/dist
	cd $(WEB_DIR) && $(NPM) run build

.PHONY: web-dev
web-dev: web-deps ## Run the Vite dev server (hot reload, separate from cargo)
	cd $(WEB_DIR) && $(NPM) run dev

.PHONY: dev
dev: web ## Build web + run jarvis in dev mode (one process, embedded UI)
	$(CARGO) run -p jarvis -- serve

.PHONY: build
build: web ## Release-build the jarvis binary into target/release/jarvis
	$(CARGO) build --release --locked -p jarvis
	@echo
	@echo "→ binary: $(CURDIR)/target/release/jarvis"

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------
.PHONY: fmt
fmt: ## Format Rust code (rustfmt)
	$(CARGO) fmt --all

.PHONY: lint
lint: ## Clippy with -D warnings (CI gate)
	$(CARGO) clippy --workspace --all-targets $(WORKSPACE_EXCLUDE) -- -D warnings

.PHONY: test
test: ## Run the workspace test suite
	$(CARGO) test --workspace $(WORKSPACE_EXCLUDE)

.PHONY: check
check: lint test ## Run clippy + tests, what CI runs

# ---------------------------------------------------------------------------
# Rust → TypeScript type codegen (see docs/conventions/rust-ts-codegen.md)
# ---------------------------------------------------------------------------
# Every `#[derive(TS)]` type emits its own `<TypeName>.ts` under
# `apps/jarvis-web/src/types/generated/` when the embedded export
# test runs. Crates with annotated types today: harness-channel,
# harness-project. Add more by following the convention doc.
#
# Output goes in git so the SPA-only Vite build doesn't need a
# Rust toolchain. `make ts-codegen` is the canonical "I changed a
# wire type, regenerate" target; CI's `make test` covers it as a
# side effect.
.PHONY: ts-codegen
ts-codegen: ## Regenerate TS types from Rust (`#[derive(TS)]`)
	$(CARGO) test -p harness-channel -p harness-project --lib --quiet
	@printf "\ngenerated:\n"
	@ls apps/jarvis-web/src/types/generated/ | sed 's/^/  /'

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
clean: ## Wipe cargo target/, web dist/, web node_modules/
	$(CARGO) clean
	rm -rf $(WEB_DIST) $(WEB_DIR)/node_modules

.PHONY: distclean
distclean: clean ## clean + drop docker image and volumes (destructive)
	-$(DOCKER) image rm $(IMAGE)
	-$(COMPOSE) down -v
