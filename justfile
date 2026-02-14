set shell := ["bash", "-euo", "pipefail", "-c"]

default:
	@just --list

# common quality targets
check:
	pnpm check

lint: check

fmt:
	pnpm format

format: fmt

fix: fmt

# openclaw docker workflow
build-image:
	docker build -t openclaw:local -f Dockerfile .

recreate-gateway:
	docker compose up -d --force-recreate openclaw-gateway

update-docker:
	just build-image
	just recreate-gateway
	ocl doctor
	ocl status --all

status-all:
	ocl status --all

status-deep:
	ocl status --deep

logs-follow:
	ocl logs --follow

latest-release-tag:
	git fetch --tags --quiet
	@tag="$(git for-each-ref --sort=-version:refname --count=1 --format='%(refname:short)' 'refs/tags/v*')"; \
	if [ -z "$tag" ]; then \
		echo "no v* tags found"; \
		exit 1; \
	fi; \
	echo "$tag"
