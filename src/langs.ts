import type Parser from 'web-tree-sitter';

type Node = Parser.SyntaxNode;

/** How the parser treats one node found by the type search. */
export interface Role {
  /** The node becomes a chunk (when it spans more than one line). */
  definition: boolean;
  /** The node contributes its name to the scope breadcrumb of nodes inside it. */
  container: boolean;
  /** Chunk kind; defaults to the node type. */
  kind?: string;
}

export interface Profile {
  /** Label reported by `languageFor`. */
  language: string;
  /** `tree-sitter-<grammar>.wasm` file stem. */
  grammar: string;
  extensions: string[];
  /** Node types that become chunks. Verified against real code for every grammar. */
  definitions: string[];
  /** Extra chunk kinds enabled by the `rich` parse option (off by default so boundaries match earlier releases). */
  rich?: string[];
  /** Node types that name a scope (class-like) even when they are not chunks. */
  containers?: string[];
  /** Node types whose text is collected into `refs`. */
  identifiers: string[];
  comments: string[];
  /** Decorator / attribute nodes that can sit on their own lines above a definition. */
  attributes?: string[];
  /** Child types that open the body when the grammar has no `body` field. */
  bodyTypes?: string[];
  /** Definition type -> parent types where it counts (e.g. members but not local variables inside function bodies). */
  onlyInside?: Record<string, string[]>;
  /** Files with more characters than this are not parsed (slow grammars); they fall back to line windows. */
  maxChars?: number;
  /** Replaces the type-based classification for some nodes: a `Role`, `null` to skip the node, `undefined` to use the type tables. */
  classify?: (node: Node) => Role | null | undefined;
  name?: (node: Node) => string | undefined;
  /** Implicit enclosing type that is not an ancestor node (Go receivers, C++ qualified names). */
  owner?: (node: Node) => string | undefined;
  /** Rejects candidates that are not really attributes (Elixir `-x` versus `@doc`). */
  isAttribute?: (node: Node, text: string) => boolean;
  docstring?: (node: Node) => string | undefined;
}

const clip = (value: string | undefined, max = 120): string | undefined => value?.slice(0, max);
const firstChild = (node: Node, ...types: string[]): Node | undefined => node.namedChildren.find(child => types.includes(child.type));
const field = (node: Node, name: string): Node | undefined => node.childForFieldName(name) ?? undefined;

// ---- name helpers -------------------------------------------------------------------------------

/** `const a = 1, b = 2` -> `a`; destructuring patterns have no single name. */
function declaratorName(node: Node): string | undefined {
  const declarator = firstChild(node, 'variable_declarator');
  const name = declarator && (field(declarator, 'name') ?? declarator.firstNamedChild ?? undefined);
  return name && (name.type === 'identifier' || name.type === 'property_identifier') ? name.text : '';
}

/** `self.x = ...` and `x = ...` name an assignment; tuples, subscripts and calls do not. */
function assignmentName(node: Node): string | undefined {
  const left = field(node, 'left');
  if (!left) return '';
  const simple = ['identifier', 'attribute', 'member_expression', 'constant', 'instance_variable', 'class_variable', 'global_variable', 'scope_resolution', 'property_identifier'];
  return simple.includes(left.type) ? clip(left.text) : '';
}

function lastIdentifier(text: string): string {
  const parts = text.split(/::|\./);
  return parts[parts.length - 1] ?? text;
}

const DECLARATOR_WRAPPERS = new Set(['function_declarator', 'pointer_declarator', 'reference_declarator', 'parenthesized_declarator', 'array_declarator', 'attributed_declarator', 'init_declarator']);

/** C-family declarator chain down to the declared identifier. */
function declaratorIdentifier(node: Node): Node | undefined {
  let current = field(node, 'declarator');
  for (let depth = 0; current && depth < 10; depth++) {
    if (!DECLARATOR_WRAPPERS.has(current.type)) return current;
    current = field(current, 'declarator') ?? current.firstNamedChild ?? undefined;
  }
  return undefined;
}

/** `Foo::bar` -> `bar`; plain identifiers are returned unchanged. */
function cName(node: Node): string | undefined {
  const id = declaratorIdentifier(node);
  return id ? clip(lastIdentifier(id.text)) : '';
}

/** `A::B::run` -> `A::B`. */
function cOwner(node: Node): string | undefined {
  const id = declaratorIdentifier(node);
  if (id?.type !== 'qualified_identifier') return undefined;
  const cut = id.text.lastIndexOf('::');
  return cut > 0 ? clip(id.text.slice(0, cut)) : undefined;
}

function goTypeName(node: Node): string | undefined {
  const spec = firstChild(node, 'type_spec', 'type_alias');
  return spec ? clip(field(spec, 'name')?.text) : '';
}

function goReceiver(node: Node): string | undefined {
  if (node.type !== 'method_declaration') return undefined;
  const receiver = field(node, 'receiver');
  const type = receiver && firstChild(receiver, 'parameter_declaration') && field(firstChild(receiver, 'parameter_declaration')!, 'type');
  if (!type) return undefined;
  const base = type.type === 'pointer_type' ? type.firstNamedChild : type;
  const id = base?.type === 'generic_type' ? field(base, 'type') : base;
  return clip(id?.text.replace(/\[.*$/, ''));
}

function rustImplName(node: Node): string | undefined {
  const type = field(node, 'type');
  if (!type) return '';
  const id = type.type === 'type_identifier' ? type : type.descendantsOfType('type_identifier')[0];
  return clip(id?.text);
}

// ---- Kotlin (the grammar has no field names) ----------------------------------------------------

function kotlinName(node: Node): string | undefined {
  switch (node.type) {
    case 'function_declaration': return clip(firstChild(node, 'simple_identifier')?.text);
    case 'class_declaration': case 'object_declaration': return clip(firstChild(node, 'type_identifier')?.text);
    case 'property_declaration': {
      const variable = firstChild(node, 'variable_declaration');
      return clip(variable && firstChild(variable, 'simple_identifier')?.text);
    }
    default: return '';
  }
}

// ---- Elixir (definitions are generic `call` nodes) ----------------------------------------------

const ELIXIR_CONTAINERS = new Set(['defmodule', 'defprotocol', 'defimpl']);
const ELIXIR_DEFINITIONS = new Set([...ELIXIR_CONTAINERS, 'def', 'defp', 'defmacro', 'defmacrop', 'defguard', 'defguardp', 'defdelegate', 'defexception', 'test', 'describe']);

function elixirKind(node: Node): string | undefined {
  const target = field(node, 'target');
  return target?.type === 'identifier' && ELIXIR_DEFINITIONS.has(target.text) ? target.text : undefined;
}

function elixirNameOf(first: Node | undefined): string {
  if (!first) return '';
  switch (first.type) {
    case 'alias': case 'identifier': return first.text;
    case 'call': return field(first, 'target')?.text ?? '';
    case 'binary_operator': return elixirNameOf(field(first, 'left'));
    case 'string': return first.text.replace(/^"+|"+$/g, '');
    default: return '';
  }
}

function elixirName(node: Node): string | undefined {
  const args = firstChild(node, 'arguments');
  return clip(elixirNameOf(args?.firstNamedChild ?? undefined));
}

// ---- OCaml -------------------------------------------------------------------------------------

function ocamlName(node: Node): string | undefined {
  switch (node.type) {
    case 'value_definition': return clip(field(firstChild(node, 'let_binding') ?? node, 'pattern')?.text);
    case 'type_definition': return clip(field(firstChild(node, 'type_binding') ?? node, 'name')?.text);
    case 'module_definition': return clip(firstChild(firstChild(node, 'module_binding') ?? node, 'module_name')?.text);
    case 'class_definition': return clip(field(firstChild(node, 'class_binding') ?? node, 'name')?.text);
    case 'module_type_definition': return clip(firstChild(node, 'module_type_name')?.text);
    default: return '';
  }
}

// ---- Objective-C ---------------------------------------------------------------------------------

function objcName(node: Node): string | undefined {
  if (node.type === 'function_definition') return cName(node);
  return clip(firstChild(node, 'identifier')?.text);
}

// ---- Zig -----------------------------------------------------------------------------------------

const ZIG_CONTAINER_VALUES = ['struct_declaration', 'enum_declaration', 'union_declaration', 'opaque_declaration'];

function zigName(node: Node): string | undefined {
  if (node.type === 'variable_declaration') return clip(firstChild(node, 'identifier')?.text);
  if (node.type === 'test_declaration') return clip((firstChild(node, 'string', 'identifier')?.text ?? '').replace(/^"|"$/g, ''));
  return clip(field(node, 'name')?.text);
}

const identifierTypes = ['identifier', 'property_identifier', 'type_identifier'];

export const PROFILES: Profile[] = [
  {
    language: 'javascript', grammar: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'],
    definitions: ['function_declaration', 'method_definition', 'class_declaration', 'lexical_declaration', 'variable_declaration', 'class'],
    rich: ['generator_function_declaration'],
    containers: ['class_declaration', 'class'],
    identifiers: identifierTypes, comments: ['comment'], attributes: ['decorator'],
    name: node => /^(?:lexical|variable)_declaration$/.test(node.type) ? declaratorName(node) : undefined,
  },
  {
    language: 'typescript', grammar: 'typescript', extensions: ['.ts', '.mts', '.cts'],
    definitions: ['function_declaration', 'method_definition', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'lexical_declaration', 'variable_declaration', 'class', 'module'],
    rich: ['generator_function_declaration', 'enum_declaration', 'abstract_class_declaration', 'internal_module'],
    containers: ['class_declaration', 'class', 'abstract_class_declaration', 'interface_declaration', 'internal_module', 'module', 'enum_declaration'],
    identifiers: identifierTypes, comments: ['comment'], attributes: ['decorator'],
    name: node => /^(?:lexical|variable)_declaration$/.test(node.type) ? declaratorName(node) : undefined,
  },
  {
    language: 'tsx', grammar: 'tsx', extensions: ['.tsx'],
    definitions: ['function_declaration', 'method_definition', 'class_declaration', 'interface_declaration', 'type_alias_declaration', 'lexical_declaration', 'variable_declaration', 'class', 'module'],
    rich: ['generator_function_declaration', 'enum_declaration', 'abstract_class_declaration', 'internal_module'],
    containers: ['class_declaration', 'class', 'abstract_class_declaration', 'interface_declaration', 'internal_module', 'module', 'enum_declaration'],
    identifiers: identifierTypes, comments: ['comment'], attributes: ['decorator'],
    name: node => /^(?:lexical|variable)_declaration$/.test(node.type) ? declaratorName(node) : undefined,
  },
  {
    language: 'python', grammar: 'python', extensions: ['.py', '.pyi', '.pyw'],
    definitions: ['function_definition', 'class_definition', 'assignment'],
    containers: ['class_definition'],
    identifiers: identifierTypes, comments: ['comment'], attributes: ['decorator'],
    name: node => node.type === 'assignment' ? assignmentName(node) : undefined,
    docstring: node => {
      const first = field(node, 'body')?.firstNamedChild;
      const string = first?.type === 'expression_statement' ? first.firstNamedChild : undefined;
      return string?.type === 'string' ? string.text : undefined;
    },
  },
  {
    language: 'go', grammar: 'go', extensions: ['.go'],
    definitions: ['function_declaration', 'method_declaration', 'type_declaration'],
    rich: ['const_declaration', 'var_declaration'],
    identifiers: identifierTypes, comments: ['comment'],
    name: node => node.type === 'type_declaration' ? goTypeName(node) : undefined,
    owner: goReceiver,
  },
  {
    language: 'rust', grammar: 'rust', extensions: ['.rs'],
    definitions: ['function_item', 'struct_item', 'enum_item', 'impl_item', 'const_item'],
    rich: ['trait_item', 'mod_item', 'type_item', 'static_item', 'union_item', 'macro_definition'],
    containers: ['impl_item', 'trait_item', 'mod_item'],
    identifiers: identifierTypes, comments: ['line_comment', 'block_comment'], attributes: ['attribute_item'],
    name: node => node.type === 'impl_item' ? rustImplName(node) : undefined,
  },
  {
    language: 'java', grammar: 'java', extensions: ['.java'],
    definitions: ['class_declaration', 'method_declaration', 'interface_declaration'],
    rich: ['constructor_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration', 'compact_constructor_declaration'],
    containers: ['class_declaration', 'interface_declaration', 'enum_declaration', 'record_declaration', 'annotation_type_declaration'],
    identifiers: identifierTypes, comments: ['line_comment', 'block_comment'],
  },
  {
    language: 'c', grammar: 'c', extensions: ['.c', '.h'],
    definitions: ['function_definition'],
    rich: ['struct_specifier', 'enum_specifier', 'union_specifier', 'type_definition', 'preproc_function_def'],
    identifiers: identifierTypes, comments: ['comment'],
    name: cName,
  },
  {
    language: 'cpp', grammar: 'cpp', extensions: ['.cpp', '.hpp', '.cc', '.cxx', '.hh', '.hxx', '.c++', '.h++', '.ino'],
    definitions: ['function_definition'],
    rich: ['class_specifier', 'struct_specifier', 'enum_specifier', 'union_specifier', 'namespace_definition', 'type_definition'],
    containers: ['class_specifier', 'struct_specifier', 'union_specifier', 'namespace_definition'],
    identifiers: identifierTypes, comments: ['comment'],
    name: node => node.type === 'function_definition' ? cName(node) : undefined,
    owner: node => node.type === 'function_definition' ? cOwner(node) : undefined,
  },
  {
    language: 'c_sharp', grammar: 'c_sharp', extensions: ['.cs'],
    definitions: ['class_declaration', 'method_declaration', 'interface_declaration', 'variable_declaration'],
    rich: ['constructor_declaration', 'property_declaration', 'struct_declaration', 'enum_declaration', 'record_declaration', 'namespace_declaration', 'destructor_declaration', 'operator_declaration', 'indexer_declaration'],
    containers: ['namespace_declaration', 'class_declaration', 'struct_declaration', 'interface_declaration', 'record_declaration', 'enum_declaration'],
    identifiers: identifierTypes, comments: ['comment'],
    name: node => node.type === 'variable_declaration' ? declaratorName(node) : undefined,
  },
  {
    language: 'ruby', grammar: 'ruby', extensions: ['.rb', '.rake', '.gemspec'],
    definitions: ['method', 'singleton_method', 'class', 'module', 'assignment'],
    containers: ['class', 'module'],
    identifiers: identifierTypes, comments: ['comment'],
    name: node => node.type === 'assignment' ? assignmentName(node) : undefined,
  },
  // ---- languages added on top of the original eleven ----
  {
    language: 'php', grammar: 'php', extensions: ['.php', '.phtml', '.php5', '.php7'],
    definitions: ['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration', 'method_declaration', 'function_definition'],
    containers: ['class_declaration', 'interface_declaration', 'trait_declaration', 'enum_declaration'],
    identifiers: ['name'], comments: ['comment'],
  },
  {
    language: 'kotlin', grammar: 'kotlin', extensions: ['.kt', '.kts'],
    definitions: ['class_declaration', 'object_declaration', 'function_declaration', 'secondary_constructor', 'property_declaration', 'companion_object'],
    containers: ['class_declaration', 'object_declaration'],
    identifiers: ['simple_identifier', 'type_identifier'], comments: ['line_comment', 'multiline_comment'],
    // The grammar sometimes parses a stand-alone annotation line as a prefix expression.
    attributes: ['prefix_expression'],
    isAttribute: (node, text) => text.charCodeAt(node.startIndex) === 64,
    bodyTypes: ['function_body', 'class_body', 'enum_class_body'],
    onlyInside: { property_declaration: ['source_file', 'class_body', 'enum_class_body'] },
    maxChars: 800_000,
    name: kotlinName,
  },
  {
    language: 'scala', grammar: 'scala', extensions: ['.scala', '.sc'],
    definitions: ['class_definition', 'object_definition', 'trait_definition', 'function_definition', 'function_declaration', 'package_object'],
    containers: ['class_definition', 'object_definition', 'trait_definition', 'package_object'],
    identifiers: ['identifier', 'type_identifier'], comments: ['comment'],
    maxChars: 1_000_000,
  },
  {
    language: 'bash', grammar: 'bash', extensions: ['.sh', '.bash', '.zsh'],
    definitions: ['function_definition'],
    identifiers: ['variable_name', 'command_name'], comments: ['comment'],
  },
  {
    language: 'elixir', grammar: 'elixir', extensions: ['.ex', '.exs'],
    definitions: ['call'], // classification is call-based, see `classify`
    identifiers: ['identifier', 'alias'], comments: ['comment'], attributes: ['unary_operator'],
    bodyTypes: ['do_block'],
    classify: node => {
      if (node.type !== 'call') return undefined;
      const kind = elixirKind(node);
      return kind ? { definition: true, container: ELIXIR_CONTAINERS.has(kind), kind } : null;
    },
    name: elixirName,
    isAttribute: (node, text) => text.charCodeAt(node.startIndex) === 64,
  },
  {
    language: 'ocaml', grammar: 'ocaml', extensions: ['.ml', '.mli'],
    definitions: ['value_definition', 'type_definition', 'module_definition', 'module_type_definition', 'class_definition', 'exception_definition'],
    containers: ['module_definition', 'module_type_definition', 'class_definition'],
    identifiers: ['value_name', 'type_constructor', 'module_name', 'constructor_name'], comments: ['comment'],
    maxChars: 600_000,
    name: ocamlName,
  },
  {
    language: 'objc', grammar: 'objc', extensions: ['.m', '.mm'],
    definitions: ['class_interface', 'class_implementation', 'protocol_declaration', 'method_definition', 'function_definition'],
    containers: ['class_interface', 'class_implementation', 'protocol_declaration'],
    identifiers: ['identifier', 'type_identifier', 'field_identifier'], comments: ['comment'],
    maxChars: 1_000_000,
    name: objcName,
  },
  {
    language: 'solidity', grammar: 'solidity', extensions: ['.sol'],
    definitions: ['contract_declaration', 'interface_declaration', 'library_declaration', 'function_definition', 'constructor_definition', 'modifier_definition', 'fallback_receive_definition', 'struct_declaration', 'enum_declaration'],
    containers: ['contract_declaration', 'interface_declaration', 'library_declaration'],
    identifiers: ['identifier'], comments: ['comment'],
    name: node => node.type === 'constructor_definition' ? 'constructor' : undefined,
  },
  {
    language: 'zig', grammar: 'zig', extensions: ['.zig'],
    definitions: ['function_declaration', 'test_declaration', 'variable_declaration'],
    identifiers: ['identifier'], comments: ['comment'],
    onlyInside: { variable_declaration: ['source_file', ...ZIG_CONTAINER_VALUES] },
    classify: node => {
      if (node.type !== 'variable_declaration') return undefined;
      return { definition: true, container: ZIG_CONTAINER_VALUES.some(type => firstChild(node, type)) };
    },
    name: zigName,
  },
];

const byExtension = new Map<string, Profile>();
for (const profile of PROFILES) for (const extension of profile.extensions) byExtension.set(extension, profile);

/** Profile selected by file extension, or `undefined` for unsupported files. */
export function profileForPath(path: string): Profile | undefined {
  const dot = path.lastIndexOf('.');
  if (dot < 0) return undefined;
  return byExtension.get(path.slice(dot).toLowerCase());
}

export function profileByLanguage(language: string): Profile | undefined {
  return PROFILES.find(profile => profile.language === language);
}
