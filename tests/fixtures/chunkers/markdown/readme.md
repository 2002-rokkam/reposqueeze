<p align="center">
  <img src="docs/logo.svg" alt="Squeezer" width="120">
</p>

# Squeezer

[![CI](https://example.com/ci.svg)](https://example.com/ci) [![npm](https://example.com/npm.svg)](https://example.com/npm)

Squeezer turns large repositories into small, citable context packs.

## Installation

Install the CLI globally:

```bash
# this is a comment, not a heading
npm install --global squeezer
squeezer --version
```

### Docker

Run the published image:

```sh
# also not a heading
docker run --rm -v "$PWD:/repo" squeezer/squeezer pack "fix the login bug"
```

### From source

```bash
git clone https://example.com/squeezer.git
cd squeezer && npm ci && npm run build
```

## Usage

| Option | Default | Description |
|--------|---------|-------------|
| `--budget` | `3000` | Token budget for the pack |
| `--json` | `false` | Emit machine readable output |
| `--root` | `.` | Repository root |
| `--map` | `false` | Print the repository map |

See [the architecture notes](docs/ARCHITECTURE.md#pipeline) and `Engine.context()` for details.

## License

MIT
