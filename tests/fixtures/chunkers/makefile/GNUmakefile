NAME = widget
VERSION = 1.0.0
OBJS = main.o util.o \
       parser.o \
       lexer.o

all: $(NAME)

$(NAME): $(OBJS)
	$(CC) -o $@ $(OBJS)

%.o: %.c
	$(CC) -c $<

.PHONY: all
