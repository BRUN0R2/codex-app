# Native Apply Patch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Disponibilizar ao modelo um `apply_patch` freeform nativo, seguro e transacional, com add/update/delete/move e um único evento canônico de alteração.

**Architecture:** Um parser puro e pequeno implementa a gramática Lark anunciada ao provider. Um planejador assíncrono resolve o patch inteiro em memória e valida paths/snapshots; um commit journal grava temporários e restaura o estado original em qualquer falha. O loop do agente passa a aceitar custom tool calls e devolver `custom_tool_call_output` sem shell.

**Tech Stack:** Rust 2024, Tokio, Serde JSON, SHA-256, tempfile, Responses API custom tools.

## Global Constraints

- Não importar nem copiar o crate completo do Codex de referência.
- Não executar `patch`, `git apply`, PowerShell ou outro sidecar.
- Não adicionar fallback para `edit_file`/`write_file` quando o patch falhar.
- Validar todos os hunks e caminhos antes do primeiro write.
- Confinar fontes e destinos ao workspace canônico e rejeitar symlinks.
- Persistir um único `ThreadItem::FileChange` somente depois do commit.
- Usar o limite de item já imposto pelo protocolo; não criar um limite menor
  exclusivo para patches.
- Preservar `.planning/`, `CodexDev.bat` e mudanças não relacionadas.

---

### Task 1: Anunciar a ferramenta freeform e aceitar custom calls

**Files:**
- Create: `src-tauri/src/engine/native/apply_patch/apply_patch.lark`
- Modify: `src-tauri/src/engine/native/tools.rs:120-205,1180-1190`
- Modify: `src-tauri/src/engine/native/provider/responses.rs:164-180`
- Modify: `src-tauri/src/engine/native/agent.rs:226-433`

**Interfaces:**
- Consumes: `ResponseItem::CustomToolCall { call_id, name, input }`.
- Produces: `ResponseItem::custom_output(call_id, output)` e
  `ToolRegistry::prepare_custom(item_id, name, input)`.

- [ ] **Step 1: Adicionar a gramática oficial fechada**

O arquivo Lark deve conter exatamente:

```lark
start: begin_patch hunk+ end_patch
begin_patch: "*** Begin Patch" LF
end_patch: "*** End Patch" LF?
hunk: add_hunk | delete_hunk | update_hunk
add_hunk: "*** Add File: " filename LF add_line+
delete_hunk: "*** Delete File: " filename LF
update_hunk: "*** Update File: " filename LF change_move? change?
filename: /(.+)/
add_line: "+" /(.*)/ LF -> line
change_move: "*** Move to: " filename LF
change: (change_context | change_line)+ eof_line?
change_context: ("@@" | "@@ " /(.+)/) LF
change_line: ("+" | "-" | " ") /(.*)/ LF
eof_line: "*** End of File" LF
%import common.LF
```

- [ ] **Step 2: Escrever testes falhos do spec e output custom**

Nos testes de `tools.rs`, localizar a definição `apply_patch` e comparar:

```rust
assert_eq!(tool["type"], "custom");
assert_eq!(tool["name"], "apply_patch");
assert_eq!(tool["format"]["type"], "grammar");
assert_eq!(tool["format"]["syntax"], "lark");
```

Nos testes de `responses.rs`, verificar que `custom_output` serializa
`type=custom_tool_call_output`, `call_id` e `output`.

- [ ] **Step 3: Implementar a definição freeform**

Adicionar a `definitions()`:

```rust
json!({
    "type": "custom",
    "name": "apply_patch",
    "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    "format": {
        "type": "grammar",
        "syntax": "lark",
        "definition": include_str!("apply_patch/apply_patch.lark")
    }
})
```

Adicionar `ResponseItem::custom_output` ao lado de `function_output`.

- [ ] **Step 4: Generalizar a fila de ferramentas**

Definir:

```rust
enum ToolOutputKind { Function, Custom }

struct PendingTool {
    call_id: String,
    output_kind: ToolOutputKind,
    prepared: PreparedTool,
}
```

`FunctionCall` usa `prepare`/`Function`. `CustomToolCall` aceita somente
`apply_patch`, usa `prepare_custom`/`Custom`; nomes desconhecidos continuam erro
de provider. Depois da execução, persistir `function_output` ou `custom_output`
conforme a variante.

- [ ] **Step 5: Executar testes e commitar o plumbing**

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml apply_patch_tool_definition -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml custom_tool_output -- --nocapture
cargo check --locked --manifest-path src-tauri/Cargo.toml
pnpm format:rust
git add src-tauri/src/engine/native/apply_patch/apply_patch.lark src-tauri/src/engine/native/tools.rs src-tauri/src/engine/native/provider/responses.rs src-tauri/src/engine/native/agent.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Wire native apply patch calls"
```

### Task 2: Implementar o parser puro

**Files:**
- Create: `src-tauri/src/engine/native/apply_patch/mod.rs`
- Create: `src-tauri/src/engine/native/apply_patch/parser.rs`
- Modify: `src-tauri/src/engine/native/mod.rs:1-10`

**Interfaces:**
- Produces:

```rust
pub(super) fn parse_patch(input: &str) -> Result<ParsedPatch, AppError>;

pub(super) struct ParsedPatch { pub hunks: Vec<PatchHunk> }
pub(super) enum PatchHunk {
    Add { path: PathBuf, contents: String },
    Delete { path: PathBuf },
    Update { path: PathBuf, move_path: Option<PathBuf>, chunks: Vec<UpdateChunk> },
}
pub(super) struct UpdateChunk {
    pub context: Option<String>,
    pub old_lines: Vec<String>,
    pub new_lines: Vec<String>,
    pub end_of_file: bool,
}
```

- [ ] **Step 1: Escrever a matriz de testes falhos**

Cobrir: envelope ausente, patch vazio, marker desconhecido, add sem `+`, delete,
update, move, múltiplos arquivos, múltiplos chunks, `@@ contexto`, `@@`, EOF,
CRLF normalizado, Unicode e linha inválida com número exato.

Fixture principal:

```rust
let patch = "*** Begin Patch\n\
*** Update File: src/a.rs\n\
*** Move to: src/b.rs\n\
@@ fn old()\n\
-old\n\
+new\n\
*** End Patch";
let parsed = parse_patch(patch).expect("patch should parse");
assert!(matches!(parsed.hunks.as_slice(), [PatchHunk::Update { move_path: Some(path), .. }] if path == Path::new("src/b.rs")));
```

- [ ] **Step 2: Confirmar falha de compilação**

Run: `cargo test --locked --manifest-path src-tauri/Cargo.toml apply_patch::parser -- --nocapture`

- [ ] **Step 3: Implementar parser determinístico por linhas**

Normalizar apenas `\r\n` para `\n`; preservar conteúdo e newline final.
Consumir o envelope e cada hunk com um cursor `{ line, index }`. Um update
acumula contexto/linhas até o próximo marker de arquivo ou fim. Rejeitar hunk
vazio, path vazio, marker duplicado e linha que não começa por `+`, `-`, espaço,
`@@` ou EOF. Toda falha inclui `invalid patch at line N: ...`.

- [ ] **Step 4: Executar, formatar e commitar**

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml apply_patch::parser -- --nocapture
pnpm format:rust
git add src-tauri/src/engine/native/apply_patch/mod.rs src-tauri/src/engine/native/apply_patch/parser.rs src-tauri/src/engine/native/mod.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Parse freeform file patches"
```

### Task 3: Resolver todos os hunks antes de escrever

**Files:**
- Create: `src-tauri/src/engine/native/apply_patch/plan.rs`
- Modify: `src-tauri/src/engine/native/apply_patch/mod.rs`

**Interfaces:**
- Consumes: `ParsedPatch`, workspace canônico.
- Produces:

```rust
pub(super) async fn prepare_patch(
    workspace: &Path,
    parsed: ParsedPatch,
) -> Result<PreparedPatch, AppError>;

pub(super) struct PreparedPatch {
    pub changes: Vec<PreparedChange>,
    pub thread_changes: Vec<FileChange>,
}
```

Cada `PreparedChange` contém source/destination absolutos, snapshot original
(`exists`, bytes, permissões, SHA-256) e bytes finais.

- [ ] **Step 1: Escrever testes de matching e paths**

Cobrir add existente, delete ausente, update ausente, chunk único, múltiplos
chunks em ordem, contexto de função, match ambíguo, EOF, CRLF, path absoluto,
`..`, destino duplicado, source/destination sobrepostos e symlink.

- [ ] **Step 2: Implementar confinamento fechado**

Para todo path: exigir relativo, componentes `Normal`, parent existente
canônico dentro do workspace e `symlink_metadata.file_type().is_symlink() ==
false` em cada componente existente. Rejeitar duplicidade no conjunto de
fontes e destinos antes de ler arquivos.

- [ ] **Step 3: Aplicar chunks em memória**

Separar texto preservando newline. Para cada chunk, procurar `context` depois do
cursor anterior e então `old_lines`. Zero ocorrências retorna erro “context not
found”; mais de uma ocorrência válida retorna “ambiguous context”. EOF exige
que o match termine no final. Produzir bytes UTF-8 finais sem modificar disco.

- [ ] **Step 4: Produzir `FileChange` canônico**

Add usa `FileChangeKind::Add`, delete usa `Delete`, update/move usa
`Update { move_path }`. O `path` é relativo com `/`; `movePath` também. O campo
`diff` recebe somente a seção normalizada daquele arquivo, truncada pelo limite
de timeline já existente sem alterar a aplicação completa.

- [ ] **Step 5: Validar e commitar**

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml apply_patch::plan -- --nocapture
pnpm format:rust
git add src-tauri/src/engine/native/apply_patch/plan.rs src-tauri/src/engine/native/apply_patch/mod.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Validate patch changes before writing"
```

### Task 4: Commit transacional com rollback

**Files:**
- Create: `src-tauri/src/engine/native/apply_patch/transaction.rs`
- Modify: `src-tauri/src/engine/native/apply_patch/mod.rs`

**Interfaces:**
- Consumes: `PreparedPatch`.
- Produces:

```rust
pub(super) async fn commit_patch(
    prepared: PreparedPatch,
    cancellation: &mut watch::Receiver<bool>,
) -> Result<PatchOutcome, AppError>;

pub(super) struct PatchOutcome {
    pub changes: Vec<FileChange>,
    pub output: String,
}
```

- [ ] **Step 1: Escrever testes falhos de atomicidade**

Cobrir commit multi-arquivo, move, preservação de permissões, cancelamento antes
do write, mudança concorrente do source e falha injetada na segunda troca. O
último caso confirma bytes/paths originais e ausência de temporários.

- [ ] **Step 2: Preparar todos os temporários**

Criar temporário no diretório de cada destino, gravar bytes, `sync_all` e copiar
permissões quando substitui arquivo. Rastrear diretórios criados. Nenhum destino
é trocado nesta fase.

- [ ] **Step 3: Revalidar snapshots**

Imediatamente antes do commit, reler cada source/destination e comparar
existência + SHA-256. Divergência retorna `AppError::Tool("file changed while patch was being prepared: ...")` e remove temporários.

- [ ] **Step 4: Aplicar journal e rollback**

Para cada mudança, guardar a operação inversa antes da troca. Usar rename no
mesmo diretório para add/update; moves escrevem o destino final e só então
removem a source. Em erro ou cancelamento, executar inversas em ordem reversa
com writes atômicos. Se rollback falhar, retornar um erro de integridade contendo
todos os paths não restaurados.

- [ ] **Step 5: Validar e commitar**

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml apply_patch::transaction -- --nocapture
pnpm format:rust
git add src-tauri/src/engine/native/apply_patch/transaction.rs src-tauri/src/engine/native/apply_patch/mod.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Apply file patches transactionally"
```

### Task 5: Integrar ao registro, permissões e eventos

**Files:**
- Modify: `src-tauri/src/engine/native/tools.rs`
- Modify: `src-tauri/src/engine/native/apply_patch/mod.rs`
- Modify: `src-tauri/src/engine/native/agent.rs`

**Interfaces:**
- Consumes: `parse_patch`, `prepare_patch`, `commit_patch`.
- Produces: `ToolOperation::ApplyPatch(ParsedPatch)` e um único
  `ThreadItem::FileChange` iniciado/concluído.

- [ ] **Step 1: Implementar `prepare_custom`**

Validar ID e nome, medir o input com o mesmo teto de response item do agente e
parsear. `PreparedTool.description` usa “Apply patch to N files”. Ferramenta
custom desconhecida falha fechada.

- [ ] **Step 2: Integrar estado visual**

`started_item` usa previews canônicos do parser com `InProgress`.
`execute` exige workspace write antes do planejamento e chama o pipeline com o
receiver de cancelamento. `finish_item` usa exatamente as mudanças reais de
`PatchOutcome`; falha usa os previews e status `Failed`.

- [ ] **Step 3: Testar o ciclo completo**

Criar teste em TempDir que chama `prepare_custom`, observa item iniciado,
executa add+update+move, confirma filesystem, item concluído e output custom.
Adicionar casos read-only e patch inválido sem alterações.

- [ ] **Step 4: Executar e commitar**

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml apply_patch -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml tools -- --nocapture
cargo check --locked --manifest-path src-tauri/Cargo.toml
pnpm format:rust
git add src-tauri/src/engine/native/tools.rs src-tauri/src/engine/native/agent.rs src-tauri/src/engine/native/apply_patch
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Execute apply patch natively"
```

### Task 6: Documentar e verificar `apply_patch`

**Files:**
- Modify: `docs/ENGINE.md`
- Modify: `docs/REFERENCE.md`

**Interfaces:**
- Consumes: ferramenta integrada.
- Produces: documentação e evidência final.

- [ ] **Step 1: Documentar fronteiras**

Em `ENGINE.md`, registrar custom call/output, validação total, journal e
rollback. Em `REFERENCE.md`, listar somente os arquivos estudados:
`apply-patch/src/parser.rs`, `seek_sequence.rs`,
`core/src/tools/handlers/apply_patch.lark` e `apply_patch_spec.rs`, explicando
que o runtime local foi implementado sobre suas próprias abstrações.

- [ ] **Step 2: Auditar caminhos proibidos**

```powershell
rg -n 'git apply|patch\.exe|apply_patch.*exec_command|PowerShell' src-tauri/src/engine/native
rg -n 'CustomToolCall|custom_output|prepare_custom|commit_patch' src-tauri/src/engine/native
```

Expected: nenhuma execução lateral; um único pipeline custom.

- [ ] **Step 3: Rodar verificação completa e commitar docs**

```powershell
pnpm verify
git diff --check
git add docs/ENGINE.md docs/REFERENCE.md
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Document native patch execution"
```
