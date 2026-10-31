BINARY := server
PKG := ./cmd/$(BINARY)
VERSION ?= $(shell git describe --tags --always)

.DEFAULT_GOAL := build

build:
	go build -ldflags "-X main.version=$(VERSION)" -o bin/$(BINARY) $(PKG)

test:
	go test ./... -race -cover

lint: ## run golangci-lint
	golangci-lint run

docker-build docker-push: docker-%:
	docker $* $(IMAGE):$(VERSION)

ifeq ($(OS),Windows_NT)
EXE := .exe
else
EXE :=
endif
