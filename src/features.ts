// Feature switches. Every retrieval/packing behaviour that was added after the 2.1.0 baseline can be
// disabled individually so that benchmarks can report ablations and users can bisect regressions.
//
//   RSQ_FEATURES="-prf,-git"      disable two features, keep the defaults for everything else
//   RSQ_FEATURES="none"           disable every optional feature (closest to the 2.1.0 behaviour)
//   RSQ_FEATURES="+git"           enable a feature that is off by default
export const FEATURE_NAMES = [
  'compactfmt', // short header, short receipts, no END markers (token diet)
  'windows', // query-dense contiguous windows with the signature kept, instead of a single best line
  'pointers', // spend leftover budget on one-line pointers (path:range + signature) to the next-best definitions
  'priors', // down-weight tests/docs/generated/vendored files unless the query asks for them
  'prf', // pseudo-relevance feedback (expansion terms from the first-pass top results)
  'phrase', // phrase and identifier proximity bonuses computed on the candidate set
  'frames', // exact stack-frame localisation
  'git', // version-history priors (recency, churn, co-change, dirty files)
  'redact', // in-place secret redaction instead of dropping files
  'condense', // condense long issue/log text instead of rejecting it
] as const;

export type FeatureName = (typeof FEATURE_NAMES)[number];
export type FeatureSet = ReadonlySet<FeatureName>;

// Features that are not (yet) proven by the benchmarks stay out of the default set.
export const DEFAULT_FEATURES: readonly FeatureName[] = FEATURE_NAMES;

export function resolveFeatures(spec: string | undefined = process.env.RSQ_FEATURES, defaults: readonly FeatureName[] = DEFAULT_FEATURES): FeatureSet {
  const enabled = new Set<FeatureName>(defaults);
  if (!spec) return enabled;
  for (const raw of spec.split(',').map(part => part.trim().toLowerCase()).filter(Boolean)) {
    if (raw === 'none' || raw === 'baseline') { enabled.clear(); continue; }
    if (raw === 'all') { FEATURE_NAMES.forEach(name => enabled.add(name)); continue; }
    const off = raw.startsWith('-');
    const name = raw.replace(/^[-+]/, '') as FeatureName;
    if (!(FEATURE_NAMES as readonly string[]).includes(name)) throw new Error(`Unknown feature "${name}". Known: ${FEATURE_NAMES.join(', ')}`);
    if (off) enabled.delete(name); else enabled.add(name);
  }
  return enabled;
}
