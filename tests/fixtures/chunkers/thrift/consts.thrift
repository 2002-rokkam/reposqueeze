/* Thrift with block comments and defaults */
namespace * example

const map<string, list<i32>> TABLE = {
  "a": [1, 2],
  "b": [3]
}

struct Config {
  1: string name   # trailing hash comment with { brace
  2: set<string> tags,
}

senum Legacy {
  "one",
  "two"
}
