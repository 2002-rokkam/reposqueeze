/** Language plug-ins for the brace scanner: how preludes and statements are named, and what they reference. */
import { type Scan, RefSet, Source, lastSegment, tidy, walk, type TreeNode } from './common.js';
import { type BraceInfo, type BraceLang, scanBraces } from './braces.js';

const info = (name: string, kind: string, anchor = false): BraceInfo => ({ name: tidy(name, 120), kind, anchor: anchor || undefined });

// ---- CSS / SCSS / LESS -------------------------------------------------------------------------

function cssLang(flavor: 'css' | 'scss' | 'less'): BraceLang {
  return {
    lineComments: flavor === 'css' ? [] : ['//'],
    blockComments: true,
    quotes: '"\'',
    urls: true,
    embedded: flavor === 'scss' ? ['#{'] : flavor === 'less' ? ['@{'] : [],
    statements: 'semicolon',
    statementDepth: 'root',
    block(prelude) {
      if (!prelude || prelude.endsWith(':')) return undefined;
      if (prelude[0] === '@') {
        const m = /^@([\w-]+)\s*(.*)$/.exec(prelude);
        if (!m) return undefined;
        const at = m[1].toLowerCase();
        const rest = m[2];
        if (['if', 'else', 'each', 'for', 'while', 'at-root', 'content'].includes(at)) return undefined;
        if (at === 'mixin' || at === 'function') return info(`@${at} ${rest.split('(')[0].trim()}`, at === 'mixin' ? 'css_mixin' : 'css_function');
        if (at === 'include') return info(`@include ${rest.split('(')[0].trim()}`, 'css_at_rule');
        if (at === 'font-face') return info('@font-face', 'css_at_rule');
        return info(`@${at} ${rest}`, 'css_at_rule');
      }
      if (flavor === 'less' && /^[.#][\w-]+\s*\(/.test(prelude)) return info(prelude.replace(/\s*when\b.*$/, ''), 'css_mixin');
      return info(prelude, 'css_rule');
    },
    statement(text) {
      if (text[0] === '$' || (flavor === 'less' && /^@[\w-]+\s*:/.test(text))) return info(text.split(':')[0].trim(), 'css_statement');
      if (/^@(?:import|use|forward|charset|namespace|plugin)\b/.test(text)) return info(text, 'css_statement');
      return undefined;
    },
  };
}

const CSS_CLASS = /(?:^|[\s,>+~(])[.#]([A-Za-z_][\w-]*)/g;
const CSS_USES = /var\(\s*(--[\w-]+)|@include\s+([\w.-]+)|@extend\s+[.%#]?([\w-]+)|animation(?:-name)?\s*:\s*([A-Za-z_][\w-]*)|--[\w-]+(?=\s*:)/g;

function cssRefs(src: Source) {
  return (start: number, end: number, nodes: readonly TreeNode[]): string[] => {
    const refs = new RefSet();
    walk(nodes, node => {
      if (node.kind !== 'css_rule' || node.name.length > 200) return;
      for (const m of node.name.matchAll(CSS_CLASS)) refs.add(m[1]);
    });
    for (let n = start; n <= end && !refs.full; n++) {
      const line = src.lines[n - 1];
      if (line.length > 1000) continue;
      for (const m of line.matchAll(CSS_USES)) refs.add(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[0]);
    }
    return refs.list;
  };
}

export function scanCss(src: Source, flavor: 'css' | 'scss' | 'less'): Scan {
  return { roots: scanBraces(src, cssLang(flavor)), plan: { refs: cssRefs(src) } };
}

// ---- HCL / Terraform ---------------------------------------------------------------------------

const HCL_BLOCK = /^([A-Za-z_][\w-]*)((?:\s+(?:"[^"]*"|[\w.-]+))*)$/;

const hclLang: BraceLang = {
  lineComments: ['#', '//'],
  blockComments: true,
  quotes: '"',
  interpolation: true,
  heredoc: true,
  statements: 'none',
  statementDepth: 'root',
  block(prelude, depth) {
    const m = HCL_BLOCK.exec(prelude);
    if (!m) return undefined;
    const labels = [...m[2].matchAll(/"([^"]*)"|([\w.-]+)/g)].map(l => l[1] ?? l[2]);
    const word = m[1];
    if (depth === 0) {
      const [first, second] = labels;
      switch (word) {
        case 'resource': if (first && second) return info(`${first}.${second}`, 'hcl_resource', true); break;
        case 'data': if (first && second) return info(`data.${first}.${second}`, 'hcl_data', true); break;
        case 'module': if (first) return info(`module.${first}`, 'hcl_module', true); break;
        case 'variable': if (first) return info(`var.${first}`, 'hcl_variable', true); break;
        case 'output': if (first) return info(`output.${first}`, 'hcl_output', true); break;
        case 'provider': if (first) return info(`provider.${first}`, 'hcl_provider', true); break;
        case 'locals': return info('locals', 'hcl_locals', true);
        case 'terraform': return info('terraform', 'hcl_block', true);
      }
    }
    return info([word, ...labels].join(' '), 'hcl_block');
  },
};

const HCL_REF = /\b(?:var|local|module|data|each|count|path|self)\.[A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)?|\b[a-z][a-z0-9]*_[a-z0-9_]+\.[A-Za-z_][\w-]*/g;

export function scanHcl(src: Source): Scan {
  return {
    roots: scanBraces(src, hclLang),
    plan: {
      refs: (start, end) => {
        const refs = new RefSet();
        for (let n = start; n <= end && !refs.full; n++) {
          const line = src.lines[n - 1];
          if (line.length > 1000 || /^\s*(?:#|\/\/)/.test(line)) continue;
          for (const m of line.matchAll(HCL_REF)) refs.add(m[0]);
        }
        return refs.list;
      },
    },
  };
}

// ---- protobuf ----------------------------------------------------------------------------------

const protoLang: BraceLang = {
  lineComments: ['//'],
  blockComments: true,
  quotes: '"\'',
  statements: 'semicolon',
  statementDepth: 'root',
  block(prelude) {
    const m = /^(message|enum|service|oneof|extend|group)\s+([\w.]+)/.exec(prelude);
    if (m) return info(m[2], `proto_${m[1]}`, true);
    const rpc = /^rpc\s+(\w+)/.exec(prelude);
    return rpc ? info(`rpc ${rpc[1]}`, 'proto_rpc', true) : undefined;
  },
  statement(text) {
    const m = /^(syntax|package|import|option|edition)\b\s*(?:public\s+|weak\s+)?=?\s*(.*)$/.exec(text);
    return m ? info(`${m[1]} ${m[2].replace(/["';=]/g, '').trim()}`, 'proto_statement') : undefined;
  },
};

const THRIFT_KIND: Record<string, string> = { struct: 'thrift_struct', union: 'thrift_union', exception: 'thrift_exception', enum: 'thrift_enum', senum: 'thrift_enum', service: 'thrift_service' };

const thriftLang: BraceLang = {
  lineComments: ['//', '#'],
  blockComments: true,
  quotes: '"\'',
  statements: 'line',
  statementDepth: 'root',
  block(prelude) {
    const m = /^(struct|union|exception|enum|senum|service)\s+(\w+)/.exec(prelude);
    return m ? info(m[2], THRIFT_KIND[m[1]], true) : undefined;
  },
  statement(text) {
    const m = /^(namespace|include|cpp_include|typedef|const)\b\s*(.*)$/.exec(text);
    if (!m) return undefined;
    const rest = m[2].replace(/\s*=.*$/, '').replace(/["';]/g, '');
    return info(`${m[1]} ${m[1] === 'typedef' || m[1] === 'const' ? rest.split(/\s+/).pop() : rest}`, 'thrift_statement');
  },
};

const PROTO_TYPE = /\b[A-Z][A-Za-z0-9_]*(?:\.[A-Z][A-Za-z0-9_]*)*\b/g;
const IMPORT_PATH = /^\s*(?:import|include)\s+(?:public\s+)?["']([^"']+)["']/;

function typeRefs(src: Source, skip: ReadonlySet<string>) {
  return (start: number, end: number): string[] => {
    const refs = new RefSet();
    for (let n = start; n <= end && !refs.full; n++) {
      const line = src.lines[n - 1];
      if (line.length > 1000 || /^\s*(?:\/\/|#|\*|\/\*)/.test(line)) continue;
      const imp = IMPORT_PATH.exec(line);
      if (imp) {
        refs.add(imp[1]);
        refs.add(lastSegment(imp[1]));
      }
      for (const m of line.matchAll(PROTO_TYPE)) if (!skip.has(m[0])) refs.add(m[0]);
    }
    return refs.list;
  };
}

const NO_TYPES: ReadonlySet<string> = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'True', 'False', 'TRUE', 'FALSE']);

export function scanProto(src: Source): Scan {
  return { roots: scanBraces(src, protoLang), plan: { refs: typeRefs(src, NO_TYPES) } };
}

export function scanThrift(src: Source): Scan {
  return { roots: scanBraces(src, thriftLang), plan: { refs: typeRefs(src, NO_TYPES) } };
}

// ---- GraphQL -----------------------------------------------------------------------------------

const GRAPHQL_KIND: Record<string, string> = {
  type: 'graphql_type', input: 'graphql_input', interface: 'graphql_interface', enum: 'graphql_enum', union: 'graphql_union',
  scalar: 'graphql_scalar', schema: 'graphql_schema', directive: 'graphql_directive', fragment: 'graphql_fragment',
  query: 'graphql_operation', mutation: 'graphql_operation', subscription: 'graphql_operation',
};

const graphqlLang: BraceLang = {
  lineComments: ['#'],
  blockComments: false,
  quotes: '"',
  tripleQuotes: true,
  docStrings: true,
  anonymousRoot: { name: 'query', kind: 'graphql_operation', anchor: true },
  statements: 'line',
  statementDepth: 'root',
  block(prelude) {
    const m = /^(extend\s+)?(type|input|interface|enum|union|scalar|schema|directive|fragment|query|mutation|subscription)\b\s*@?(\w*)/.exec(prelude);
    if (!m) return undefined;
    const name = m[3] || m[2];
    if (m[1]) return info(`extend ${m[2]} ${m[3]}`.trim(), 'graphql_extend', true);
    return info(name, GRAPHQL_KIND[m[2]], true);
  },
  statement(text) {
    const m = /^(extend\s+)?(scalar|union|directive|schema)\b\s*@?(\w*)/.exec(text);
    if (!m) return undefined;
    return info(m[1] ? `extend ${m[2]} ${m[3]}`.trim() : m[3] || m[2], m[1] ? 'graphql_extend' : GRAPHQL_KIND[m[2]], true);
  },
};

export function scanGraphql(src: Source): Scan {
  return { roots: scanBraces(src, graphqlLang), plan: { refs: typeRefs(src, NO_TYPES) } };
}

// ---- Gradle / Groovy / Kotlin DSL / Jenkinsfile --------------------------------------------------

const CONTROL_FLOW = /^(?:if|else|for|while|try|catch|finally|switch|when|do|synchronized)\b/;

/** `implementation 'org.x:y:1'` -> `implementation org.x:y:1`; `stage('Build')` -> `stage Build`. */
function gradleName(text: string): string {
  return text.replace(/\(\s*(['"])([^'"]*)\1\s*\)/g, ' $2').replace(/(['"])(.*?)\1/g, '$2');
}

const gradleLang: BraceLang = {
  lineComments: ['//'],
  blockComments: true,
  quotes: '"\'',
  tripleQuotes: true,
  interpolation: true,
  statements: 'line',
  statementDepth: 'all',
  block(prelude) {
    if (!prelude || CONTROL_FLOW.test(prelude) || prelude.endsWith('->')) return undefined;
    return info(gradleName(prelude), 'gradle_block');
  },
  statement(text) {
    if (text.endsWith('->') || /^[)\]},]/.test(text) || CONTROL_FLOW.test(text)) return undefined;
    return info(gradleName(text), 'gradle_statement');
  },
};

const GRADLE_COORDINATE = /['"]([\w.-]+:[\w.-]+(?::[\w.${}+-]+)?)['"]/g;
const GRADLE_PLUGIN = /\bid\s*\(?\s*['"]([\w.-]+)['"]/g;

export function scanGradle(src: Source): Scan {
  return {
    roots: scanBraces(src, gradleLang),
    plan: {
      refs: (start, end) => {
        const refs = new RefSet();
        for (let n = start; n <= end && !refs.full; n++) {
          const line = src.lines[n - 1];
          if (line.length > 1000 || /^\s*\/\//.test(line)) continue;
          for (const m of line.matchAll(GRADLE_COORDINATE)) {
            const parts = m[1].split(':');
            refs.add(`${parts[0]}:${parts[1]}`);
            refs.add(parts[1]);
          }
          for (const m of line.matchAll(GRADLE_PLUGIN)) refs.add(m[1]);
        }
        return refs.list;
      },
    },
  };
}

// ---- nginx-style configuration ----------------------------------------------------------------------

const confLang: BraceLang = {
  lineComments: ['#'],
  blockComments: false,
  quotes: '"\'',
  statements: 'semicolon',
  statementDepth: 'all',
  block(prelude) {
    return prelude ? info(prelude, 'conf_block') : undefined;
  },
  statement(text) {
    return info(text, 'conf_statement');
  },
};

export function scanConf(src: Source): Scan {
  return {
    roots: scanBraces(src, confLang),
    plan: {
      refs: (start, end) => {
        const refs = new RefSet();
        for (let n = start; n <= end && !refs.full; n++) {
          const m = /^\s*(?:include|proxy_pass|fastcgi_pass|root|alias|ssl_certificate|upstream)\s+(\S+?);?\s*$/.exec(src.lines[n - 1]);
          if (m) refs.add(m[1].replace(/^https?:\/\//, ''));
        }
        return refs.list;
      },
    },
  };
}
