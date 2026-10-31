import { isAbsolute } from 'node:path';

/**
 * Informational mirror of upstream RepoSqueeze 2.1.0 `allowedPath` (src/repository.ts): files the
 * baseline engine never indexes. A gold file matching it is unreachable for that engine by design.
 * The benchmark reports how many gold files this affects but never removes them from the gold set.
 */
const EXCLUDED_DIRS = /(^|\/)(?:\.git|\.hg|\.svn|node_modules|vendor|\.venv|venv|__pycache__|\.next|\.cache|\.reposqueeze|\.reposqueeze-v2|\.bench-repos|\.vscode-test|dist|build|coverage|target)(\/|$)/;
const SECRET_NAMES = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|ed25519)|credentials(?:\.[^/]*)?|secrets?(?:\.[^/]*)?|[^/]*\.(?:pem|key|p12|pfx|keystore))$/i;
const BINARY_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|jar|wasm|mp[34]|woff2?|ttf|exe|dll|so|dylib|sqlite|db|lock|map|vsix)$/i;
const LOCKFILES = /(^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;

export function excludedByUpstreamPolicy(path: string): boolean {
  return !path || isAbsolute(path) || path.split(/[\\/]/).includes('..') || EXCLUDED_DIRS.test(path) || SECRET_NAMES.test(path) || BINARY_EXTENSIONS.test(path) || LOCKFILES.test(path);
}
