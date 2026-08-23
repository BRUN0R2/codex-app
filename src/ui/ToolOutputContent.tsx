import { createMemo, For, Match, Switch } from "solid-js";

import type { ToolOutputPresentation } from "../contracts/types";
import { ImagePreview } from "./ImagePreview";
import { SyntaxTokens } from "./syntax/SyntaxTokens";
import {
  projectImageToolOutput,
  projectSearchOutput,
  projectSourceOutput,
  splitOutputLines,
} from "./toolOutputProjection";

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
  const imageSource = createMemo(() =>
    props.presentation.type === "image" ? projectImageToolOutput(props.text) : null,
  );

  return (
    <Switch fallback={<pre class="command-card-output">{props.text}</pre>}>
      <Match when={props.presentation.type === "image"}>
        <div class="tool-image-output">
          <Switch
            fallback={<span class="tool-image-output-error">Prévia de imagem indisponível.</span>}
          >
            <Match when={imageSource()}>
              {(source) => (
                <ImagePreview
                  alt="Imagem visualizada pela ferramenta"
                  class="tool-image-preview"
                  name="Imagem visualizada"
                  source={source()}
                />
              )}
            </Match>
          </Switch>
        </div>
      </Match>
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
