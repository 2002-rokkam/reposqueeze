# Build the project with gcc
CC      ?= gcc
CFLAGS  := -O2 -Wall -Wextra
LDFLAGS :=
SRC     := $(wildcard src/*.c)
OBJ     := $(SRC:src/%.c=build/%.o)

include config.mk

.PHONY: all clean test install

all: bin/app

bin/app: $(OBJ)
	@mkdir -p bin
	$(CC) $(LDFLAGS) -o $@ $^

# Compile each source file
build/%.o: src/%.c
	@mkdir -p build
	$(CC) $(CFLAGS) -c $< -o $@

test: bin/app
	./tests/run.sh \
	  --verbose \
	  --color

clean:
	rm -rf build bin

install: all
	install -m 755 bin/app /usr/local/bin/app

define HELP_TEXT
Usage: make [target]
  all      build the binary
  clean    remove artifacts
endef
export HELP_TEXT

help:
	@echo "$$HELP_TEXT"
