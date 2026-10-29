# RepoSqueeze

Local, budgeted repository context for Copilot and MCP coding agents. Runs as a **VS Code extension**, **Node.js CLI**, or **MCP server**. MIT licensed.

RepoSqueeze finds task-relevant code, packs verbatim excerpts into a token budget, and lets the agent expand any cited range. Optional local embeddings add semantic retrieval. Structured JSON can be converted to TOON when a verified round trip is smaller. Concise-answer instructions address output length before generation.

**This is an evaluated prototype, not a guarantee of perfect repository understanding or reduced bills on every task.** It does not intercept all Copilot prompts or inline completions. The agent must use its tools; additional reads and retries can offset savings.

## What was measured

An 80:20 repository-disjoint development/test split uses 10 pinned open-source repositories and 50 source-location questions. No model is trained. On the 10 held-out questions at a 3,000-token budget:

| Retrieval method | Complete expected evidence found |
| --- | ---: |
| Equal-budget BM25 baseline | 6/10 |
| RepoSqueeze structural retrieval | 8/10 |
| RepoSqueeze + local embeddings | 9/10 |

All tested excerpts matched source and respected the configured `o200k_base` budget. This is **evidence retrieval**, not answer accuracy. The 99% size reduction against entire repositories is an intentionally broad baseline and **must not be quoted as 99% Copilot credit savings**. See [evaluation and raw results](docs/EVALUATION.md), including the separate live Copilot experiment.

In a separate 16-call Copilot experiment on four fresh randomized-value questions, packed context with ordinary instructions used **16.9% fewer provider input tokens** than whole relevant files, with all requested facts recovered. The concise-instruction arm did **not** reliably save output tokens because reasoning increased. Read the [complete results and negative findings](docs/LIVE_RESULTS.md) before extrapolating to your workload.

## Install and use

Requires Node.js 20.19 or newer. Node 22 is the CI target. The npm registry and VS Code Marketplace releases are not published yet; use this GitHub source or the built packages.

```sh
git clone https://github.com/2002-rokkam/reposqueeze.git
cd reposqueeze
npm ci
npm run check
npm test
node dist/cli.cjs context --root /absolute/path/to/your/repo --query "Where is authentication checked?" --budget 3000
```

`npm ci` builds the CLI and extension through the `prepare` script. You can also install directly from GitHub:

```sh
npm install -g github:2002-rokkam/reposqueeze
reposqueeze --help
```

For a reproducible installation, replace the GitHub branch with a reviewed commit: `github:2002-rokkam/reposqueeze#COMMIT_SHA`. Do not use `npx reposqueeze` until a registry release is announced here: an unrelated package could own that name.

### VS Code and Copilot

```sh
npm run package
code --install-extension releases/reposqueeze-0.1.0.vsix
```

Open your repository in a trusted VS Code workspace. In Copilot Chat's agent mode, enable **RepoSqueeze Context** and **RepoSqueeze Expand** in the tool picker. Start a prompt with `#reposqueeze`, for example: `#reposqueeze Find the retry policy and explain where to change its limit.`

Run **RepoSqueeze: Install Copilot Instructions** from the Command Palette to add a repository instruction file. It asks the agent to retrieve first, expand incomplete evidence, and answer concisely. Existing instruction files are never overwritten. This is guidance, not enforcement. **Build Context Pack** and **Show Repository Map** also work without a model account.

Settings: `reposqueeze.tokenBudget` defaults to 3000; `reposqueeze.semanticModel` is empty by default. The extension supplies two native tools. Use the MCP integration instead if you need all five tools; avoid enabling duplicate tools unnecessarily.

### Copilot CLI and other MCP clients

After installing the CLI, add this entry to `~/.copilot/mcp-config.json`, merging with any existing configuration:

```json
{
  "mcpServers": {
    "reposqueeze": {
      "type": "stdio",
      "command": "reposqueeze",
      "args": ["mcp", "--root", "/absolute/path/to/your/repo"],
      "tools": ["*"]
    }
  }
}
```

If your client cannot find global binaries, use `"command": "node"` with `"args": ["/absolute/path/to/reposqueeze/dist/cli.cjs", "mcp", "--root", "/absolute/path/to/your/repo"]`.

Other stdio MCP clients use the same command and arguments; follow their configuration format. For VS Code MCP, place the entry under `"servers"` in `.vscode/mcp.json` and omit `tools`. See the official [Copilot CLI configuration](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers) and [VS Code configuration](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

```sh
reposqueeze init --root /absolute/path/to/your/repo
```

Then ask your agent to use `reposqueeze_context` before broad file reads and `reposqueeze_expand` for missing definitions or before editing. The supplied [skill](skills/reposqueeze/SKILL.md) can also be copied into your client's supported skill directory.

### Local semantic retrieval

Install [Ollama](https://ollama.com), then:

```sh
ollama pull all-minilm
reposqueeze context --root /path/to/repo --query "Where are credentials removed after redirects?" --semantic-model all-minilm
```

For the extension, set `reposqueeze.semanticModel` to `all-minilm`; for MCP append `--semantic-model all-minilm` to the server arguments. This explicitly sends eligible source chunks to **localhost:11434**, not a hosted embedding service. The local embedding service must already be running. An embedding failure is surfaced as an error; clear the setting to use lexical retrieval.

Vectors are persisted in `.reposqueeze/`, keyed by source hash and model digest. Changed and deleted code refreshes; the cache stores vectors, not summaries or raw source. Add `.reposqueeze/` to your repository's `.gitignore`. Treat vectors as sensitive derived data. The lexical index and AST chunks are refreshed in memory, and full source remains available through expansion.

## CLI commands

```sh
reposqueeze map --root . --budget 1500
reposqueeze context --root . --query "connection timeout retries" --budget 3000 --json
reposqueeze expand --root . --path src/client.ts --start 20 --end 90
reposqueeze json < data.json
reposqueeze compact --budget 1500 < test-output.log
```

JSON output chooses the smallest of the original input, minified JSON and verified TOON, including its format header. Unsafe numeric conversions and duplicate object keys are rejected. Semantic values are preserved; original whitespace and number spelling are not.

Log compaction folds exact consecutive repeats. When the budget is too small, it selects diagnostic neighborhoods and marks the result **LOSSY/TRUNCATED**. Keep the original log and command exit status. Compress logs before sending them to the model; compressing something the model already read does not refund input tokens. Similarly, shortening an answer after generation does not refund output tokens.

## Design and limits

- Parses JavaScript, TypeScript/TSX, Python, Go, Rust, Java, C, C++, C# and Ruby. Other text uses overlapping line windows. Parsing does not equal full language-server understanding.
- Combines lexical relevance, symbol/path matches, capped identifier-reference hints, diversity and contiguous source windows. Optional embeddings use reciprocal-rank fusion. The reference hints are not a resolved call graph.
- Returns file/line citations and content-based receipts. Suppress repeated chunks only when the caller explicitly confirms that those exact receipts are still in the current conversation. No hidden cross-session assumption.
- Honors ignore rules, skips symlinks, generated/dependency directories, common secret filenames and recognizable secret content. This is not a complete secret scanner. Review exclusions before using sensitive repositories.
- Caps scanning at 12,000 files, 64 MiB total and 1 MiB per file; reports omissions. Semantic search covers at most 6,000 chunks, with lexical search over the full eligible index. Large monorepos need scoped roots.
- Budgets count text with `o200k_base`; provider tokenizers, tool schemas, system prompts, thinking, cached tokens and later tool calls add costs outside that budget.

See [architecture](docs/ARCHITECTURE.md), [research and evidence review](docs/RESEARCH.md), [evaluation](docs/EVALUATION.md), and [third-party notices](THIRD_PARTY_NOTICES.md).

## Reproduce checks

```sh
npm ci
npm run check
npm test
npm run test:editor
npm run bench:formats
npm run bench:fetch
REPOSQUEEZE_BENCH_EMBEDDING=all-minilm npm run bench -- development
REPOSQUEEZE_BENCH_EMBEDDING=all-minilm npm run bench -- test
npm run package
npm pack --pack-destination releases
```

The editor test opens an isolated VS Code test instance; Linux needs `xvfb-run`. `VSCODE_EXECUTABLE_PATH` can select an installed executable. The repository benchmark downloads only pinned source and does not run upstream code. A test run rejects a mismatched frozen fingerprint. Keep recorded results when experimenting, and reserve new repositories for a new held-out evaluation.

`npm run bench:live` makes **16 billable Copilot calls** using your signed-in account, plus any separate smoke tests you choose to run. It creates fresh random constants and overwrites `benchmarks/live/results.json`; archive the existing report first. Set `REPOSQUEEZE_LIVE_MODEL` to a model available on your account. It uses no model tools and a 30-credit per-process ceiling, which is the CLI's minimum accepted ceiling—not a predicted cost. Review the script before running it.

## Claims we do not make

No universal 100% accuracy, guaranteed credit reduction, complete understanding of every repository, or proof that this combination has never been invented. This project makes its implementation, failures, test inputs, source pins and measurements inspectable. Contributions should improve accuracy at a fixed budget and measure end-to-end cost, including recovery reads.
