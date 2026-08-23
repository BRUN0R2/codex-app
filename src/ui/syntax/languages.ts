import type { SyntaxLanguage } from "./contracts";
import { unionWords as union, words } from "./wordSet";

export interface SyntaxStringDelimiter {
  readonly end: string;
  readonly escape: "backslash" | "double" | "none";
  readonly multiline: boolean;
  readonly start: string;
}

export interface SyntaxProfile {
  readonly blockComments: readonly {
    readonly end: string;
    readonly start: string;
  }[];
  readonly capitalizedIdentifiersAreTypes: boolean;
  readonly caseInsensitive: boolean;
  readonly decorators: boolean;
  readonly hashAttributes: boolean;
  readonly hashDirectives: boolean;
  readonly keywords: ReadonlySet<string>;
  readonly language: SyntaxLanguage;
  readonly lineComments: readonly string[];
  readonly mode: "code" | "markdown" | "markup";
  readonly nestedBlockComments: boolean;
  readonly propertySeparators: readonly string[];
  readonly strings: readonly SyntaxStringDelimiter[];
  readonly types: ReadonlySet<string>;
  readonly variablePrefix: string | null;
}

const C_LIKE_KEYWORDS = words(
  "abstract as async await break case catch class const continue default do else enum export extends false finally for from if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try typeof undefined var void while yield",
);
const C_LIKE_TYPES = words(
  "Array bigint boolean Date Error Map never number object Promise ReadonlyMap ReadonlySet Record Set string symbol unknown void",
);
const RUST_KEYWORDS = words(
  "as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while",
);
const RUST_TYPES = words(
  "Arc BTreeMap BTreeSet bool Box char Cow f32 f64 HashMap HashSet i8 i16 i32 i64 i128 isize Mutex Option Path PathBuf Rc Result RwLock str String u8 u16 u32 u64 u128 usize Vec",
);
const PYTHON_KEYWORDS = words(
  "and as assert async await break case class continue def del elif else except False finally for from global if import in is lambda match None nonlocal not or pass raise return True try while with yield",
);
const PYTHON_TYPES = words("bool bytes dict float frozenset int list object set str tuple type");
const SQL_KEYWORDS = words(
  "all alter and as asc between by case check column constraint create cross database default delete desc distinct drop else end exists false foreign from full group having in index inner insert into is join key left like limit not null offset on or order outer primary references right select set table then true union unique update values view when where with",
);
const SHELL_KEYWORDS = words(
  "break case continue do done elif else esac fi for function if in local readonly return select then time until while",
);
const POWERSHELL_KEYWORDS = words(
  "begin break catch class continue data default do dynamicparam else elseif end enum exit filter finally for foreach from function hidden if in inlinescript moduleparam param process return static switch throw trap try until using var while workflow",
);
const C_KEYWORDS = words(
  "alignas alignof auto break case const continue default do else enum extern false for goto if inline register restrict return sizeof static struct switch typedef union volatile while",
);
const C_TYPES = words(
  "bool char double float int int8_t int16_t int32_t int64_t long ptrdiff_t short signed size_t uint8_t uint16_t uint32_t uint64_t unsigned void wchar_t",
);
const CPP_KEYWORDS = union(
  C_KEYWORDS,
  words(
    "and and_eq asm bitand bitor catch class compl concept consteval constexpr constinit const_cast co_await co_return co_yield decltype delete dynamic_cast explicit export friend mutable namespace new noexcept not not_eq nullptr operator or or_eq private protected public reinterpret_cast requires static_assert static_cast template this thread_local throw true try typeid typename using virtual xor xor_eq",
  ),
);
const CPP_TYPES = union(
  C_TYPES,
  words(
    "array auto deque map optional set shared_ptr span string string_view unique_ptr unordered_map vector weak_ptr",
  ),
);
const CSHARP_KEYWORDS = words(
  "abstract as async await base break case catch checked class const continue decimal default delegate do else enum event explicit extern false finally fixed for foreach goto if implicit in interface internal is lock namespace new null object operator out override params private protected public readonly record ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while",
);
const JAVA_KEYWORDS = words(
  "abstract assert boolean break byte case catch char class const continue default do double else enum extends false final finally float for goto if implements import instanceof int interface long native new null package private protected public return short static strictfp super switch synchronized this throw throws transient true try void volatile while",
);
const GO_KEYWORDS = words(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var",
);
const GO_TYPES = words(
  "any bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 uint32 uint64 uintptr",
);

const C_STYLE_STRINGS: readonly SyntaxStringDelimiter[] = [
  { end: '"', escape: "backslash", multiline: false, start: '"' },
  { end: "'", escape: "backslash", multiline: false, start: "'" },
];
const JAVASCRIPT_STRINGS: readonly SyntaxStringDelimiter[] = [
  { end: "`", escape: "backslash", multiline: true, start: "`" },
  ...C_STYLE_STRINGS,
];
const PYTHON_STRINGS: readonly SyntaxStringDelimiter[] = [
  { end: '"""', escape: "backslash", multiline: true, start: '"""' },
  { end: "'''", escape: "backslash", multiline: true, start: "'''" },
  ...C_STYLE_STRINGS,
];
const SQL_STRINGS: readonly SyntaxStringDelimiter[] = [
  { end: "'", escape: "double", multiline: true, start: "'" },
  { end: '"', escape: "double", multiline: true, start: '"' },
];
const POWERSHELL_STRINGS: readonly SyntaxStringDelimiter[] = [
  { end: '"@', escape: "none", multiline: true, start: '@"' },
  { end: "'@", escape: "none", multiline: true, start: "@'" },
  { end: '"', escape: "backslash", multiline: false, start: '"' },
  { end: "'", escape: "double", multiline: false, start: "'" },
];

const PROFILES: Readonly<Record<SyntaxLanguage, SyntaxProfile>> = {
  bash: profile({
    keywords: SHELL_KEYWORDS,
    language: "bash",
    lineComments: ["#"],
    strings: C_STYLE_STRINGS,
    variablePrefix: "$",
  }),
  c: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    hashDirectives: true,
    keywords: C_KEYWORDS,
    language: "c",
    lineComments: ["//"],
    types: C_TYPES,
  }),
  cpp: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    hashDirectives: true,
    keywords: CPP_KEYWORDS,
    language: "cpp",
    lineComments: ["//"],
    types: CPP_TYPES,
  }),
  csharp: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    decorators: true,
    keywords: CSHARP_KEYWORDS,
    language: "csharp",
    lineComments: ["//"],
    types: words(
      "bool byte char decimal double dynamic float int long nint nuint object sbyte short string uint ulong ushort",
    ),
  }),
  css: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    decorators: true,
    keywords: words("important inherit initial none revert unset"),
    language: "css",
    lineComments: [],
    propertySeparators: [":"],
    types: words("calc clamp cubic-bezier env linear-gradient max min repeat rgb rgba var"),
  }),
  go: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    keywords: GO_KEYWORDS,
    language: "go",
    lineComments: ["//"],
    strings: [{ end: "`", escape: "none", multiline: true, start: "`" }, ...C_STYLE_STRINGS],
    types: GO_TYPES,
  }),
  html: profile({
    blockComments: [{ end: "-->", start: "<!--" }],
    language: "html",
    lineComments: [],
    mode: "markup",
    strings: C_STYLE_STRINGS,
  }),
  java: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    decorators: true,
    keywords: JAVA_KEYWORDS,
    language: "java",
    lineComments: ["//"],
    types: words(
      "ArrayList BigDecimal Boolean Byte Character Class Double Exception Float Integer List Long Map Object Optional Set Short String",
    ),
  }),
  javascript: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    decorators: true,
    keywords: C_LIKE_KEYWORDS,
    language: "javascript",
    lineComments: ["//"],
    strings: JAVASCRIPT_STRINGS,
    types: C_LIKE_TYPES,
  }),
  json: profile({
    keywords: words("false null true"),
    language: "json",
    lineComments: [],
    propertySeparators: [":"],
    strings: [{ end: '"', escape: "backslash", multiline: false, start: '"' }],
  }),
  markdown: profile({
    language: "markdown",
    lineComments: [],
    mode: "markdown",
    strings: [],
  }),
  plainText: profile({
    language: "plainText",
    lineComments: [],
    strings: [],
  }),
  powershell: profile({
    blockComments: [{ end: "#>", start: "<#" }],
    capitalizedIdentifiersAreTypes: true,
    decorators: true,
    keywords: POWERSHELL_KEYWORDS,
    language: "powershell",
    lineComments: ["#"],
    strings: POWERSHELL_STRINGS,
    types: words(
      "array bool byte char datetime decimal double float guid hashtable int long object regex scriptblock string switch timespan type xml",
    ),
    variablePrefix: "$",
  }),
  python: profile({
    capitalizedIdentifiersAreTypes: true,
    decorators: true,
    keywords: PYTHON_KEYWORDS,
    language: "python",
    lineComments: ["#"],
    strings: PYTHON_STRINGS,
    types: PYTHON_TYPES,
  }),
  rust: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    hashAttributes: true,
    keywords: RUST_KEYWORDS,
    language: "rust",
    lineComments: ["//"],
    nestedBlockComments: true,
    types: RUST_TYPES,
  }),
  sql: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    caseInsensitive: true,
    keywords: SQL_KEYWORDS,
    language: "sql",
    lineComments: ["--"],
    strings: SQL_STRINGS,
    types: words(
      "bigint binary bit blob boolean char date datetime decimal double float int integer json numeric real smallint text time timestamp uuid varchar",
    ),
  }),
  toml: profile({
    keywords: words("false true"),
    language: "toml",
    lineComments: ["#"],
    propertySeparators: ["="],
    strings: PYTHON_STRINGS,
  }),
  typescript: profile({
    blockComments: [{ end: "*/", start: "/*" }],
    capitalizedIdentifiersAreTypes: true,
    decorators: true,
    keywords: union(
      C_LIKE_KEYWORDS,
      words("declare infer is keyof namespace satisfies type unique"),
    ),
    language: "typescript",
    lineComments: ["//"],
    strings: JAVASCRIPT_STRINGS,
    types: C_LIKE_TYPES,
  }),
  yaml: profile({
    keywords: words("false null true yes no"),
    language: "yaml",
    lineComments: ["#"],
    propertySeparators: [":"],
    strings: C_STYLE_STRINGS,
  }),
};

const EXTENSION_LANGUAGES: Readonly<Record<string, SyntaxLanguage>> = {
  bash: "bash",
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  cxx: "cpp",
  go: "go",
  h: "c",
  hpp: "cpp",
  htm: "html",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsonc: "json",
  jsx: "javascript",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  ps1: "powershell",
  psm1: "powershell",
  py: "python",
  pyw: "python",
  rs: "rust",
  scss: "css",
  sh: "bash",
  sql: "sql",
  toml: "toml",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
};

const LANGUAGE_ALIASES: Readonly<Record<string, SyntaxLanguage>> = {
  csharp: "csharp",
  cs: "csharp",
  html: "html",
  javascript: "javascript",
  js: "javascript",
  json5: "json",
  jsonc: "json",
  jsx: "javascript",
  markdown: "markdown",
  md: "markdown",
  plaintext: "plainText",
  powershell: "powershell",
  ps1: "powershell",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  shell: "bash",
  sh: "bash",
  text: "plainText",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  yml: "yaml",
};

const FILE_NAME_LANGUAGES: Readonly<Record<string, SyntaxLanguage>> = {
  dockerfile: "bash",
  makefile: "bash",
};

export function syntaxLanguageFromAlias(alias: string | null | undefined): SyntaxLanguage {
  if (alias === null || alias === undefined) {
    return "plainText";
  }
  const normalized = alias.trim().toLowerCase().split(/[,\s]/u, 1)[0] ?? "";
  return LANGUAGE_ALIASES[normalized] ?? EXTENSION_LANGUAGES[normalized] ?? "plainText";
}

export function syntaxLanguageFromPath(path: string): SyntaxLanguage {
  const fileName = path.split(/[\\/]/u).at(-1)?.toLowerCase() ?? "";
  const named = FILE_NAME_LANGUAGES[fileName];
  if (named !== undefined) {
    return named;
  }
  const dot = fileName.lastIndexOf(".");
  if (dot < 0 || dot === fileName.length - 1) {
    return "plainText";
  }
  return EXTENSION_LANGUAGES[fileName.slice(dot + 1)] ?? "plainText";
}

export function syntaxProfile(language: SyntaxLanguage): SyntaxProfile {
  return PROFILES[language];
}

function profile(
  value: Pick<SyntaxProfile, "language" | "lineComments"> & Partial<SyntaxProfile>,
): SyntaxProfile {
  return {
    blockComments: value.blockComments ?? [],
    capitalizedIdentifiersAreTypes: value.capitalizedIdentifiersAreTypes ?? false,
    caseInsensitive: value.caseInsensitive ?? false,
    decorators: value.decorators ?? false,
    hashAttributes: value.hashAttributes ?? false,
    hashDirectives: value.hashDirectives ?? false,
    keywords: value.keywords ?? new Set<string>(),
    language: value.language,
    lineComments: value.lineComments,
    mode: value.mode ?? "code",
    nestedBlockComments: value.nestedBlockComments ?? false,
    propertySeparators: value.propertySeparators ?? [],
    strings: value.strings ?? C_STYLE_STRINGS,
    types: value.types ?? new Set<string>(),
    variablePrefix: value.variablePrefix ?? null,
  };
}
