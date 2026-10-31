PREFIX ?= /usr/local
BINDIR := $(PREFIX)/bin
MANDIR := $(PREFIX)/share/man/man1

-include local.mk

install-man: man/tool.1
	install -d $(MANDIR)
	install -m 644 $< $(MANDIR)/

uninstall:
	$(RM) $(BINDIR)/tool \
	      $(MANDIR)/tool.1
