import { createMemo, For, Match, Switch } from "solid-js";

import type { ToolOutputPresentation } from "../contracts/types";
import { utf8ByteLength } from "../utf8";
import type { SyntaxLine } from "./syntax/contracts";
import { syntaxLanguageFromPath } from "./syntax/languages";
import { SyntaxTokens } from "./syntax/SyntaxTokens";
import { SyntaxLineTokenizer } from "./syntax/tokenizer";

const MAX_SOURCE_HIGHLIGHT_BYTES: number = 256 * 1_024;
const MAX_SOURCE_LINE_CHARACTERS: number = 4 * 1_024;

interface SourceOutputLine {
  readonly content: string;
  readonly number: number;
  readonly tokens: SyntaxLine | null;
}

type SearchOutputLine =
  | {
      readonly content: string;
      readonly lineNumber: number;
      readonly path: string;
      readonly tokens: SyntaxLine | null;
      readonly type: "match";
    }
  | { readonly content: string; readonly type: "text" };

export function ToolOutputContent(props: {
  readonly presentation: ToolOutputPresentation;
  readonly text: string;
}) {
  const sourceLines = createMemo(() =>
    props.presentation.type === "sourceFile"
      ? projectSourceOutput(props.text, props.presentation.path)
      : null,
  );
  const searchLines = createMemo(() =>
    props.presentation.type === "searchResults" ? projectSearchOutput(props.text) : null,
  );
  const filePaths = createMemo(() =>
    props.presentation.type === "fileList" ? splitOutputLines(props.text) : [],
  );

  return (
    <Switch fallback={<pre class="command-card-output">{props.text}</pre>}>
      <Match when={props.presentation.type === "sourceFile" && sourceLines()}>
        {(lines) => (
          <table aria-label="Código lido do arquivo" class="tool-source-output">
            <tbody>
              <For each={lines()}>
                {(line) => (
                  <tr class="tool-source-line">
                    <th class="tool-source-line-number" scope="row">
                      {line.number}
                    </th>
                    <td>
                      <code>
                        <SyntaxTokens content={line.content} tokens={line.tokens} />
                      </code>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        )}
      </Match>
      <Match when={props.presentation.type === "searchResults" && searchLines()}>
        {(lines) => (
          <table aria-label="Resultados da busca no projeto" class="tool-search-output">
            <tbody>
              <For each={lines()}>
                {(line) => (
                  <Switch
                    fallback={
                      <tr class="tool-search-text-line">
                        <td colSpan={2}>
                          <code>{line.content}</code>
                        </td>
                      </tr>
                    }
                  >
                    <Match when={line.type === "match" ? line : null}>
                      {(match) => (
                        <tr class="tool-search-result-line">
                          <th class="tool-search-location" scope="row">
                            <code>
                              {match().path}:{match().lineNumber}
                            </code>
                          </th>
                          <td>
                            <code>
                              <SyntaxTokens content={match().content} tokens={match().tokens} />
                            </code>
                          </td>
                        </tr>
                      )}
                    </Match>
                  </Switch>
                )}
              </For>
            </tbody>
          </table>
        )}
      </Match>
      <Match when={props.presentation.type === "fileList"}>
        <ul aria-label="Arquivos encontrados" class="tool-file-list-output">
          <For each={filePaths()}>
            {(path) => (
              <li>
                <code>{path}</code>
              </li>
            )}
          </For>
        </ul>
      </Match>
    </Switch>
  );
}

export function projectSourceOutput(
  text: string,
  path: string,
): readonly SourceOutputLine[] | null {
  const parsed = splitOutputLines(text).map((line) => {
    const match = /^(\d+): (.*)$/u.exec(line);
    if (match === null) {
      return null;
    }
    const number = Number(match[1]);
    const content = match[2];
    return Number.isSafeInteger(number) && number > 0 && content !== undefined
      ? { content, number }
      : null;
  });
  if (parsed.some((line) => line === null)) {
    return null;
  }

  const language = syntaxLanguageFromPath(path);
  const tokenizer = language === "plainText" ? null : new SyntaxLineTokenizer(language);
  let highlightedBytes = 0;
  let highlighting = tokenizer !== null;
  return parsed.map((line) => {
    if (line === null) {
      throw new Error("A saída de leitura mudou depois de ser validada.");
    }
    const lineBytes = utf8ByteLength(line.content) + 1;
    highlighting =
      highlighting &&
      line.content.length <= MAX_SOURCE_LINE_CHARACTERS &&
      highlightedBytes + lineBytes <= MAX_SOURCE_HIGHLIGHT_BYTES;
    const tokens = highlighting ? (tokenizer?.tokenize(line.content) ?? null) : null;
    highlightedBytes += lineBytes;
    return { ...line, tokens };
  });
}

export function projectSearchOutput(text: string): readonly SearchOutputLine[] {
  return splitOutputLines(text).map((line) => {
    const match = /^(.+?):(\d+):(.*)$/u.exec(line);
    if (match === null) {
      return { content: line, type: "text" };
    }
    const path = match[1];
    const lineNumber = Number(match[2]);
    const content = match[3];
    if (
      path === undefined ||
      content === undefined ||
      !Number.isSafeInteger(lineNumber) ||
      lineNumber <= 0
    ) {
      return { content: line, type: "text" };
    }
    const language = syntaxLanguageFromPath(path);
    const tokens =
      language === "plainText" || content.length > MAX_SOURCE_LINE_CHARACTERS
        ? null
        : new SyntaxLineTokenizer(language).tokenize(content);
    return { content, lineNumber, path, tokens, type: "match" };
  });
}

function splitOutputLines(text: string): readonly string[] {
  const normalized = text.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  return lines;
}
