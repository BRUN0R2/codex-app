# App Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Corrigir o contrato `movePath`, concluir turnos imediatamente pelo evento terminal e separar tarefas de projetos da seção “Recentes”.

**Architecture:** O storage retorna uma projeção terminal completa produzida pela mesma transação que conclui o turno; o frontend aplica essa projeção por reducers puros antes de qualquer refresh de thread. Caminhos continuam estritos e canônicos, e o banco local defeituoso é reparado uma única vez fora do runtime com backup verificado.

**Tech Stack:** Rust 2024, Serde, rusqlite, Tauri 2, SolidJS, TypeScript 7, Vitest.

## Global Constraints

- Rust `NativeEngine` continua proprietário de persistência e eventos.
- O wire aceita somente camelCase; não adicionar alias para `move_path`.
- Não adicionar migration, adapter, fallback ou versão paralela de contrato.
- Persistir antes de emitir e usar timestamps do storage, nunca do relógio do frontend.
- Preservar `.planning/`, `CodexDev.bat` e mudanças não relacionadas.
- Criar um commit pequeno para cada entrega testável.

---

### Task 1: Canonizar alterações de arquivo e testar o wire

**Files:**
- Modify: `src-tauri/src/engine/contracts.rs:491-515`
- Modify: `src/contracts/decode.test.ts`

**Interfaces:**
- Consumes: `FileChange`, `FileChangeKind` e `decodeFileChange` existentes.
- Produces: wire estrito `{ type: "update", movePath: string | null }`.

- [ ] **Step 1: Escrever testes Rust e TypeScript falhos**

Adicionar ao módulo de testes de `contracts.rs`:

```rust
#[test]
fn file_change_update_uses_camel_case_variant_fields() {
    let value = serde_json::to_value(FileChangeKind::Update {
        move_path: Some("src/new.rs".into()),
    })
    .expect("file change kind should serialize");
    assert_eq!(value, serde_json::json!({
        "type": "update",
        "movePath": "src/new.rs"
    }));
}
```

Em `decode.test.ts`, criar um `item.completed` `fileChange` com `movePath` e
confirmar o valor; duplicar o fixture com `move_path` e esperar `ContractError`.

- [ ] **Step 2: Confirmar a falha específica**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml file_change_update_uses_camel_case_variant_fields -- --nocapture
pnpm vitest run src/contracts/decode.test.ts
```

Expected: Rust mostra `move_path`; o teste TypeScript canônico já passa e o de
snake_case confirma que o decoder permanece fechado.

- [ ] **Step 3: Corrigir o serializer da enum**

Alterar somente o atributo:

```rust
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FileChangeKind {
    Add,
    Delete,
    Update { move_path: Option<String> },
}
```

- [ ] **Step 4: Validar e commitar**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml file_change_update_uses_camel_case_variant_fields -- --nocapture
pnpm vitest run src/contracts/decode.test.ts
pnpm format:rust
git add src-tauri/src/engine/contracts.rs src/contracts/decode.test.ts
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Canonicalize file change fields"
```

Expected: ambos os formatos são cobertos e somente `movePath` passa.

### Task 2: Emitir a projeção terminal persistida

**Files:**
- Modify: `src-tauri/src/engine/contracts.rs:128-141,650-675`
- Modify: `src-tauri/src/engine/native/storage.rs:795-833`
- Modify: `src-tauri/src/engine/native/mod.rs:879-990`

**Interfaces:**
- Consumes: `NativeStorage::complete_turn(thread_id, turn_id, status, error)`.
- Produces: `CompletedTurn { id, status, error, updated_at }` dentro de
  `TurnCompletedNotification`.

- [ ] **Step 1: Escrever o teste de storage falho**

No módulo de testes de `storage.rs`, iniciar um turno, reler seu `created_at`,
concluí-lo como `Interrupted` com erro `None` e verificar:

```rust
let created_at = storage
    .read_thread(thread.id.clone())
    .await
    .expect("thread should load")
    .turns[0]
    .created_at;
let completed = storage
    .complete_turn(thread.id, turn.id, TurnStatus::Interrupted, None)
    .await
    .expect("turn should complete");
assert_eq!(completed.status, TurnStatus::Interrupted);
assert_eq!(completed.error, None);
assert!(completed.updated_at >= created_at);
```

- [ ] **Step 2: Confirmar que o tipo ainda não existe**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml completed_turn_returns_terminal_projection -- --nocapture
```

Expected: FAIL de compilação para campos ausentes.

- [ ] **Step 3: Criar o contrato terminal**

Adicionar:

```rust
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompletedTurn {
    pub id: String,
    pub status: TurnStatus,
    pub error: Option<String>,
    pub updated_at: i64,
}
```

Trocar `TurnCompletedNotification.turn` para `CompletedTurn`. Manter
`TurnSummary` apenas em início de turno e respostas de start.

- [ ] **Step 4: Retornar os valores da mesma transação**

Em `complete_turn`, clonar `error` para o `UPDATE` e retornar depois do commit:

```rust
Ok(CompletedTurn {
    id: turn_id,
    status,
    error,
    updated_at: now,
})
```

Atualizar imports e os dois caminhos de rollback em `native/mod.rs`. O
`OperationFailure` externo continua fornecendo o código público; sua mensagem
deve ser igual a `turn.error` quando não for nula.

- [ ] **Step 5: Testar serialização e persistência**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml completed_turn -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml thread_lifecycle -- --nocapture
cargo check --locked --manifest-path src-tauri/Cargo.toml
pnpm format:rust
```

Expected: projeção terminal e lifecycle passam sem mudar schema.

- [ ] **Step 6: Commitar**

```powershell
git add src-tauri/src/engine/contracts.rs src-tauri/src/engine/native/storage.rs src-tauri/src/engine/native/mod.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Emit persisted turn completion"
```

### Task 3: Aplicar conclusão terminal no cache visual

**Files:**
- Modify: `src/contracts/types.ts:288-295,455-466`
- Modify: `src/contracts/decode.ts:434-445,1074-1080`
- Modify: `src/contracts/decode.test.ts`
- Create: `src/state/turnCompletion.ts`
- Create: `src/state/turnCompletion.test.ts`
- Modify: `src/state/createAppController.ts:414-440`

**Interfaces:**
- Consumes: `CompletedTurn { id, status, error, updatedAt }`.
- Produces:
  `applyTurnCompletion(thread: CodexThread, turn: CompletedTurn): CodexThread`.

- [ ] **Step 1: Fechar o decoder do novo evento**

Definir em TypeScript:

```ts
export interface CompletedTurn {
  readonly id: string;
  readonly status: Exclude<TurnStatus, "inProgress">;
  readonly error: string | null;
  readonly updatedAt: number;
}
```

`decodeCompletedTurn` exige exatamente `error`, `id`, `status`, `updatedAt` e
rejeita `inProgress`. Atualizar `TurnCompletedNotification` para esse tipo.

- [ ] **Step 2: Escrever os testes falhos do reducer**

Cobrir em `turnCompletion.test.ts`:

```ts
const completed = applyTurnCompletion(threadFixture("inProgress"), {
  id: "turn-a",
  status: "interrupted",
  error: null,
  updatedAt: 8,
});
expect(completed.turns[0]).toMatchObject({ status: "interrupted", updatedAt: 8 });
expect(completed.status).toEqual({ type: "idle" });
expect(applyTurnCompletion(completed, completion)).toBe(completed);
```

Adicionar casos de ID ausente e terminal conflitante esperando erro.

- [ ] **Step 3: Implementar o reducer puro**

O reducer localiza exatamente um turno. Para `inProgress`, substitui somente
`status`, `error` e `updatedAt`, atualiza `thread.updatedAt` com o maior valor e
define `thread.status = { type: "idle" }`. Se o estado terminal já é idêntico,
retorna a mesma referência; se diverge, lança erro de contrato.

- [ ] **Step 4: Aplicar tudo em um batch do controller**

No case `turn.completed`, calcular o novo `currentThread`, atualizar também a
entrada correspondente de `threads`, e então limpar runtime e aprovações no
mesmo `batch`. Mostrar o erro externo somente para a thread visível. Não chamar
`thread_read` nem fabricar timestamp.

- [ ] **Step 5: Executar e commitar**

Run:

```powershell
pnpm vitest run src/contracts/decode.test.ts src/state/turnCompletion.test.ts src/state/threadRuntime.test.ts
pnpm typecheck
git add src/contracts/types.ts src/contracts/decode.ts src/contracts/decode.test.ts src/state/turnCompletion.ts src/state/turnCompletion.test.ts src/state/createAppController.ts
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Finalize turns from terminal events"
```

Expected: “Trabalhando” deixa de depender de `thread.updated`.

### Task 4: Reservar Recentes para tarefas sem projeto

**Files:**
- Create: `src/state/sidebarThreads.ts`
- Create: `src/state/sidebarThreads.test.ts`
- Modify: `src/ui/Sidebar.tsx:46-75`

**Interfaces:**
- Consumes: `CodexThread[]`, `ProjectRecord[]`, `pathsEqual`.
- Produces:
  `threadsWithoutConfiguredProject(threads, projects): readonly CodexThread[]`.

- [ ] **Step 1: Escrever testes de particionamento**

Cobrir caminho Windows com caixa/separador diferente, duas tarefas de projeto,
uma tarefa sem projeto e lista vazia. A união dos grupos deve conter cada ID
uma vez e “Recentes” somente o ID sem projeto.

- [ ] **Step 2: Confirmar a falha e implementar**

Run: `pnpm vitest run src/state/sidebarThreads.test.ts`

Implementação mínima:

```ts
export function threadsWithoutConfiguredProject(
  threads: readonly CodexThread[],
  projects: readonly ProjectRecord[],
): readonly CodexThread[] {
  return threads.filter(
    (thread) => !projects.some((project) => pathsEqual(thread.cwd, project.path)),
  );
}
```

- [ ] **Step 3: Usar a projeção antes de busca/ordenação**

Em `Sidebar.tsx`, iniciar `ungrouped` com
`threadsWithoutConfiguredProject(controller.threads(), controller.projects())`;
manter busca, ordenação e slice depois desse filtro.

- [ ] **Step 4: Validar e commitar**

```powershell
pnpm vitest run src/state/sidebarThreads.test.ts src/state/projects.test.ts
pnpm typecheck
git add src/state/sidebarThreads.ts src/state/sidebarThreads.test.ts src/ui/Sidebar.tsx
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Separate project tasks from recents"
```

### Task 5: Reparar uma vez o banco desta instalação

**Files:**
- Runtime data: `C:\Users\bruno\AppData\Roaming\dev.codexapp.desktop\native-state-v1.sqlite3`
- Backup: same directory, `native-state-v1.sqlite3.before-move-path-<timestamp>.bak`

**Interfaces:**
- Consumes: serializer canônico já compilado e SQLite CLI existente em
  `C:\Users\bruno\AppData\Local\Android\Sdk\platform-tools\sqlite3.exe`.
- Produces: zero payloads com a chave `move_path`, sem código de manutenção no
  produto.

- [ ] **Step 1: Verificar estado e encerrar somente o app novo**

Confirmar novamente 3 itens afetados e `integrity_check=ok`. Encerrar o processo
cujo executável é `src-tauri\target\release\codex-desktop-next.exe`; não encerrar
o Codex oficial.

- [ ] **Step 2: Criar backup consistente**

Usar o comando `.backup` do SQLite para o caminho com timestamp e executar
`PRAGMA integrity_check` no backup. Não usar cópia de arquivo enquanto houver
WAL aberto.

- [ ] **Step 3: Reescrever somente a chave exata em transação**

Executar:

```sql
BEGIN IMMEDIATE;
UPDATE thread_items
SET payload = replace(payload, '"move_path":', '"movePath":')
WHERE payload LIKE '%"move_path":%';
COMMIT;
```

Esperar `changes() = 3`, zero ocorrências antigas e três ocorrências canônicas.

- [ ] **Step 4: Validar banco e releitura**

Executar `PRAGMA integrity_check`, iniciar o build novo e abrir a thread
afetada. A thread deve decodificar sem toast. Se qualquer verificação falhar,
fechar o app e restaurar o backup antes de prosseguir.

### Task 6: Verificação integrada de estabilidade

**Files:**
- Verify: all files changed in Tasks 1-5
- Modify: `docs/ENGINE.md`

**Interfaces:**
- Consumes: contrato, reducer, sidebar e banco reparado.
- Produces: evidência completa e documentação do evento terminal.

- [ ] **Step 1: Documentar a projeção terminal**

Registrar em `docs/ENGINE.md` que `turn.completed` carrega status, erro e
timestamp persistidos e que `thread.updated` é apenas reconciliação idempotente.

- [ ] **Step 2: Executar a verificação completa**

```powershell
pnpm verify
git diff --check
rg -n 'move_path|movePath|turn\.completed|Recentes|ungrouped' src src-tauri/src
```

Expected: suíte completa passa; `move_path` existe apenas como identificador
Rust interno, não como chave serializada nem alias; nenhum filtro duplicado
permanece.

- [ ] **Step 3: Validar o fluxo local e commitar documentação**

Enviar uma tarefa curta, interromper e confirmar imediatamente status
“interrompido” sem cronômetro ativo. Confirmar que uma tarefa de projeto não
aparece em “Recentes”.

```powershell
git add docs/ENGINE.md
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Document terminal turn state"
```
