export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const KEYWORDS = new Set([
  // JavaScript / TypeScript
  "const",
  "let",
  "var",
  "function",
  "return",
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "break",
  "continue",
  "default",
  "import",
  "export",
  "from",
  "as",
  "async",
  "await",
  "try",
  "catch",
  "finally",
  "throw",
  "new",
  "class",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "public",
  "private",
  "protected",
  "readonly",
  "static",
  "abstract",
  "typeof",
  "instanceof",
  "in",
  "of",
  "void",
  "null",
  "undefined",
  "true",
  "false",
  "this",
  "super",
  // Rust
  "pub",
  "fn",
  "let",
  "mut",
  "struct",
  "enum",
  "trait",
  "impl",
  "use",
  "mod",
  "match",
  "if",
  "else",
  "loop",
  "while",
  "for",
  "in",
  "return",
  "break",
  "continue",
  "where",
  "move",
  "unsafe",
  "ref",
  "self",
  "Self",
  "dyn",
  "type",
  "const",
  "static",
  "async",
  "await",
  "crate",
  "super",
  "true",
  "false",
  // Python
  "def",
  "class",
  "return",
  "if",
  "elif",
  "else",
  "while",
  "for",
  "in",
  "import",
  "from",
  "as",
  "try",
  "except",
  "finally",
  "raise",
  "with",
  "lambda",
  "pass",
  "yield",
  "global",
  "nonlocal",
  "assert",
  "del",
  "None",
  "True",
  "False",
  // SQL
  "select",
  "from",
  "where",
  "insert",
  "into",
  "update",
  "delete",
  "create",
  "table",
  "drop",
  "alter",
  "join",
  "inner",
  "left",
  "right",
  "outer",
  "on",
  "group",
  "by",
  "order",
  "limit",
  "offset",
  "and",
  "or",
  "not",
  "is",
  "null",
  "as",
  "union",
  "all",
  "having",
  "case",
  "when",
  "then",
  "else",
  "end",
]);

const TYPES = new Set([
  "string",
  "number",
  "boolean",
  "any",
  "unknown",
  "never",
  "void",
  "object",
  "symbol",
  "bigint",
  "Record",
  "Array",
  "Promise",
  "Partial",
  "Required",
  "Readonly",
  "Pick",
  "Omit",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "f32",
  "f64",
  "bool",
  "char",
  "String",
  "str",
  "Option",
  "Result",
  "Vec",
  "HashMap",
  "BTreeMap",
  "Arc",
  "Mutex",
  "RwLock",
  "Box",
  "Path",
  "PathBuf",
]);

export function highlightCode(code: string, _language?: string): string {
  const lines = code.split("\n");
  const highlightedLines = lines.map((line) => highlightLine(line));
  return highlightedLines.join("\n");
}

function highlightLine(line: string): string {
  if (line.trim().length === 0) {
    return "";
  }

  let index = 0;
  let result = "";

  while (index < line.length) {
    const char = line[index];
    if (char === undefined) {
      break;
    }

    // Single line comments
    if (
      line.startsWith("//", index) ||
      (line.startsWith("#", index) &&
        !line.startsWith("#include", index) &&
        !line.startsWith("#!", index))
    ) {
      const commentText = line.slice(index);
      result += `<span class="token-comment">${escapeHtml(commentText)}</span>`;
      break;
    }

    // Strings
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      let end = index + 1;
      let escaped = false;
      while (end < line.length) {
        const nextChar = line[end];
        if (nextChar === "\\" && !escaped) {
          escaped = true;
        } else if (nextChar === quote && !escaped) {
          end++;
          break;
        } else {
          escaped = false;
        }
        end++;
      }
      const strText = line.slice(index, end);
      result += `<span class="token-string">${escapeHtml(strText)}</span>`;
      index = end;
      continue;
    }

    // Identifiers & Keywords
    if (isAlphaOrUnderscore(char)) {
      let end = index + 1;
      while (end < line.length && isAlphaNumericOrUnderscore(line[end])) {
        end++;
      }
      const word = line.slice(index, end);
      const isFunctionCall = line[end] === "(";

      if (KEYWORDS.has(word) || KEYWORDS.has(word.toLowerCase())) {
        result += `<span class="token-keyword">${escapeHtml(word)}</span>`;
      } else if (TYPES.has(word)) {
        result += `<span class="token-type">${escapeHtml(word)}</span>`;
      } else if (isFunctionCall) {
        result += `<span class="token-function">${escapeHtml(word)}</span>`;
      } else {
        result += escapeHtml(word);
      }
      index = end;
      continue;
    }

    // Numbers
    if (isDigit(char)) {
      let end = index + 1;
      while (end < line.length) {
        const nextChar = line[end];
        if (
          nextChar !== undefined &&
          (isDigit(nextChar) ||
            nextChar === "." ||
            nextChar === "_" ||
            nextChar === "x" ||
            nextChar === "X")
        ) {
          end++;
        } else {
          break;
        }
      }
      const numText = line.slice(index, end);
      result += `<span class="token-number">${escapeHtml(numText)}</span>`;
      index = end;
      continue;
    }

    // Operators
    if (isOperator(char)) {
      result += `<span class="token-operator">${escapeHtml(char)}</span>`;
      index++;
      continue;
    }

    // Other characters
    result += escapeHtml(char);
    index++;
  }

  return result;
}

function isAlphaOrUnderscore(char: string | undefined): boolean {
  if (char === undefined) return false;
  return (
    (char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$"
  );
}

function isAlphaNumericOrUnderscore(char: string | undefined): boolean {
  if (char === undefined) return false;
  return isAlphaOrUnderscore(char) || isDigit(char);
}

function isDigit(char: string | undefined): boolean {
  if (char === undefined) return false;
  return char >= "0" && char <= "9";
}

function isOperator(char: string | undefined): boolean {
  if (char === undefined) return false;
  return "+-*/%=&|^~<>!?".includes(char);
}
