# Codex Timeline and Workspace Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Substituir cartões verbosos por grupos de trabalho no padrão Codex e adicionar resumo de alterações com painel de revisão Git completo e incremental.

**Architecture:** A timeline bruta permanece lossless e ganha uma projeção pura no frontend. Um `WorkspaceReviewManager` Rust cria sessões efêmeras: lê metadados Git em streaming, pagina a lista e materializa somente diffs solicitados em cache temporário paginado. O controller compartilha um resumo autoritativo entre o chip e o painel.

**Tech Stack:** Rust 2024, Tokio process/io, Git plumbing, tempfile, SHA-256, Tauri 2, SolidJS, TypeScript 7, Vitest, CSS responsivo.

## Global Constraints

- Não persistir grupos visuais nem diffs de revisão no SQLite.
- Não devolver o diff inteiro do repositório em uma resposta IPC.
- Paginação é transporte, não truncamento: todo cursor deve alcançar o fim.
- Remover os caps globais antigos de 512 mudanças, 524 KiB e dois segundos.
- Não mostrar stage, undo, commit ou edição sem implementação real.
- Sucesso visual é neutro; falhas permanecem explícitas e expansíveis.
- Preservar acessibilidade, movimento reduzido e dados brutos completos.
- Preservar `.planning/`, `CodexDev.bat` e mudanças não relacionadas.

---

### Task 1: Projetar grupos de trabalho de forma pura

**Files:**
- Create: `src/state/timelineProjection.ts`
- Create: `src/state/timelineProjection.test.ts`

**Interfaces:**
- Consumes: `VisibleThreadTurn[]` e `VisibleThreadItem[]`.
- Produces:

```ts
export type TimelineEntry =
  | { readonly type: "userMessage"; readonly item: UserMessageItem }
  | { readonly type: "agentMessage"; readonly item: AgentMessageItem }
  | { readonly type: "contextCompaction"; readonly item: ContextCompactionItem }
  | { readonly type: "workGroup"; readonly group: WorkGroup };

export interface WorkGroup {
  readonly id: string;
  readonly turnId: string;
  readonly items: readonly WorkItem[];
  readonly summary: string;
  readonly status: "active" | "completed" | "failed" | "interrupted";
  readonly durationMs: number | null;
}

export function projectTimeline(turns: readonly VisibleThreadTurn[]): readonly TimelineEntry[];
```

- [ ] **Step 1: Escrever testes de fronteira e losslessness**

Cobrir comandos contíguos, arquivos+comandos, comentário entre grupos,
compactação, resposta final, dois turnos, falha, interrupção e turno ativo.
Achatar `group.items` mais entradas simples deve reproduzir todos os IDs de
entrada na mesma ordem.

- [ ] **Step 2: Implementar classificação e resumo**

Atividades (`commandExecution`, `fileChange`, `reasoning`, `toolExecution`)
entram no grupo corrente; mensagens e compactação fecham o grupo. Status falho
se qualquer filho falhou, ativo se o turno está `inProgress`, interrompido se o
turno terminou assim, senão concluído. Singular/plural são derivados por
contagens de comandos e arquivos únicos.

- [ ] **Step 3: Implementar duração**

Para grupo que representa toda a atividade pré-final de um turno concluído,
usar `turn.updatedAt - turn.createdAt`. Para grupo parcial, somar apenas
`durationMs` conhecidos de comandos; se nenhum existe, retornar `null`.

- [ ] **Step 4: Validar e commitar**

```powershell
pnpm vitest run src/state/timelineProjection.test.ts
pnpm typecheck
git add src/state/timelineProjection.ts src/state/timelineProjection.test.ts
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Project compact timeline groups"
```

### Task 2: Renderizar a timeline compacta

**Files:**
- Create: `src/ui/WorkGroup.tsx`
- Create: `src/ui/FileDiff.tsx`
- Modify: `src/ui/Timeline.tsx`
- Modify: `src/styles/global.css:1977-3035`
- Modify: `src/ui/timelineScroll.test.ts`

**Interfaces:**
- Consumes: `TimelineEntry`, `WorkGroup`, `FileChange.diff`.
- Produces: grupos expansíveis, linhas compactas e diff acessível.

- [ ] **Step 1: Extrair renderização de diff**

`FileDiff` recebe `diff`, separa linhas por prefixo e mostra números antigos e
novos, `data-kind=addition|deletion|context|header`, botão de copiar e
scroll horizontal. Linhas enormes continuam selecionáveis e não alteram o
conteúdo.

- [ ] **Step 2: Implementar `WorkGroup`**

Usar `<button aria-expanded>` como cabeçalho. Estado inicial: ativo/falho aberto,
concluído/interrompido fechado. Ao fechar um turno ativo, preservar escolha do
usuário somente enquanto o mesmo ID existir. Filhos usam:

```text
Comando executado: <comando resumido>
Arquivo editado: <path> +A -D
<descrição curta de leitura/busca>
```

Falha mostra saída automaticamente. Remover selos “Concluído”; manter texto
“Falhou” somente no item falho.

- [ ] **Step 3: Trocar o loop bruto pela projeção**

`Timeline` chama `projectTimeline(controller.turns())`, mantém navegação por
mensagens do usuário e renderiza final answer fora do grupo. Compactação vira
linha discreta com ícone e texto “Contexto compactado automaticamente”. Remover
`TurnDuration` solto depois das mensagens.

- [ ] **Step 4: Ajustar o estilo oficial**

Reduzir bordas/fundos de atividades, usar altura de linha compacta, resposta
final plana e bolha de usuário à direita. Estados de hover/foco não devem mover
layout. Em `prefers-reduced-motion`/config reduzida, desabilitar transições.

- [ ] **Step 5: Validar e commitar**

```powershell
pnpm vitest run src/state/timelineProjection.test.ts src/ui/timelineScroll.test.ts src/ui/turnFailure.test.ts
pnpm lint
pnpm typecheck
git add src/ui/WorkGroup.tsx src/ui/FileDiff.tsx src/ui/Timeline.tsx src/styles/global.css src/ui/timelineScroll.test.ts
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Render Codex style work groups"
```

### Task 3: Definir contratos paginados de revisão

**Files:**
- Create: `src-tauri/src/workspace_review.rs`
- Modify: `src-tauri/src/commands.rs:35-65,218-225,505-595`
- Modify: `src-tauri/src/lib.rs:6-50`
- Modify: `src/contracts/types.ts:21-38`
- Modify: `src/contracts/decode.ts:193-230`
- Modify: `src/contracts/decode.test.ts`
- Modify: `src/infrastructure/codexClient.ts:269-280`

**Interfaces:**
- Produces:

```ts
export type RepositoryHead =
  | { readonly type: "branch"; readonly name: string }
  | { readonly type: "detached"; readonly revision: string }
  | { readonly type: "unborn"; readonly name: string | null };

export interface WorkspaceChange {
  readonly path: string;
  readonly previousPath: string | null;
  readonly kind: "added" | "conflicted" | "deleted" | "modified" | "renamed";
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export type WorkspaceReviewStartResponse =
  | { readonly type: "none" }
  | {
      readonly type: "git";
      readonly reviewId: string;
      readonly head: RepositoryHead;
      readonly filesChanged: number;
      readonly additions: number;
      readonly deletions: number;
      readonly changes: readonly WorkspaceChange[];
      readonly nextCursor: string | null;
    };

export interface WorkspaceChangePage {
  readonly reviewId: string;
  readonly changes: readonly WorkspaceChange[];
  readonly nextCursor: string | null;
}

export interface WorkspaceDiffLine {
  readonly kind: "addition" | "context" | "deletion" | "header" | "hunk" | "notice";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly text: string;
  readonly continued: boolean;
}

export interface WorkspaceDiffPage {
  readonly reviewId: string;
  readonly path: string;
  readonly lines: readonly WorkspaceDiffLine[];
  readonly nextCursor: string | null;
}
```

- [ ] **Step 1: Escrever decoder tests falhos**

Fixtures cobrem branch, detached, unborn, none, rename, binary, cursor e todas
as espécies de linha. Campos desconhecidos, kind desconhecido e `reviewId`
divergente devem falhar.

- [ ] **Step 2: Criar requests fechados Rust**

Adicionar `WorkspaceReviewPageRequest { cwd, review_id, cursor }` e
`WorkspaceDiffPageRequest { cwd, review_id, path, cursor }`, ambos
`deny_unknown_fields`. As respostas Rust espelham exatamente os tipos acima em
camelCase.

- [ ] **Step 3: Registrar manager e comandos**

`WorkspaceReviewManager::default()` entra em `.manage()`. Registrar:

```text
workspace_review_start
workspace_review_changes_page
workspace_review_diff_page
```

Remover `workspace_repository_read` e seu contrato antigo no mesmo commit; não
manter alias IPC.

- [ ] **Step 4: Implementar client TypeScript**

Adicionar `startWorkspaceReview(cwd)`, `readWorkspaceReviewChanges(...)` e
`readWorkspaceReviewDiff(...)`, todos via `invokeDecoded` estrito.

- [ ] **Step 5: Validar contrato e commitar**

```powershell
pnpm vitest run src/contracts/decode.test.ts
pnpm typecheck
cargo check --locked --manifest-path src-tauri/Cargo.toml
pnpm format:rust
git add src-tauri/src/workspace_review.rs src-tauri/src/commands.rs src-tauri/src/lib.rs src/contracts/types.ts src/contracts/decode.ts src/contracts/decode.test.ts src/infrastructure/codexClient.ts
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Define incremental workspace review"
```

### Task 4: Ler status e estatísticas sem caps globais

**Files:**
- Modify: `src-tauri/src/workspace_review.rs`
- Modify: `src-tauri/src/commands.rs`

**Interfaces:**
- Consumes: workspace validado e `WorkspaceReviewManager`.
- Produces: `start_review(cwd)`, `changes_page(review_id, cursor)`.

- [ ] **Step 1: Escrever testes de parser Git**

Cobrir porcelain v2 ordinary, rename com path NUL separado, untracked, staged,
unstaged, conflito e bytes UTF-8 inválidos. Cobrir `--numstat -z` textual e
binário (`-\t-`). Gerar fixture com 10.050 mudanças e ler todas em páginas,
sem erro nem perda.

- [ ] **Step 2: Implementar geração cancelável**

O manager mantém `AtomicU64 generation` e `RwLock<Option<ReviewSession>>`.
`begin()` incrementa a geração; loops de stdout verificam o valor e matam o
child em troca de workspace. Spawn usa stdin nulo, stderr pipe, `kill_on_drop`
e argumentos individuais, nunca shell.

- [ ] **Step 3: Detectar identidade Git**

Executar `rev-parse --is-inside-work-tree`, `symbolic-ref --short HEAD` e
`rev-parse --verify --short=12 HEAD`. Falha do primeiro retorna `type:none`;
branch sem HEAD produz `unborn`.

- [ ] **Step 4: Consumir status/numstat como stream**

Usar:

```text
git -C <cwd> status --porcelain=v2 -z --untracked-files=all -- .
git -C <cwd> diff --numstat -z --find-renames HEAD -- .
```

Parsear stdout incrementalmente por NUL. Em repositório unborn, contar o estado
final dos arquivos como adições por leitura em stream. Binários mantêm stats
nulos. Unir por path canônico, ordenar por path e calcular totais saturantes.

- [ ] **Step 5: Paginar sem truncar**

Guardar metadados completos na sessão efêmera. Cursor é o índice decimal
validado; cada resposta retorna até 200 registros e um cursor até `len`. Não há
erro por quantidade total.

- [ ] **Step 6: Remover inspeção limitada e commitar**

Excluir `MAX_GIT_STATUS_BYTES`, `MAX_WORKSPACE_CHANGES`,
`GIT_INSPECTION_TIMEOUT`, `inspect_workspace_repository` e parser porcelain v1
de `commands.rs`.

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml workspace_review -- --nocapture
pnpm format:rust
git add src-tauri/src/workspace_review.rs src-tauri/src/commands.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Stream workspace change metadata"
```

### Task 5: Gerar e paginar diffs por arquivo

**Files:**
- Modify: `src-tauri/src/workspace_review.rs`

**Interfaces:**
- Consumes: `review_id`, path conhecido e cursor.
- Produces: `diff_page(review_id, path, cursor): WorkspaceDiffPage`.

- [ ] **Step 1: Escrever testes de diff**

Criar repos temporários para modified, staged+unstaged, add, delete, rename,
untracked, binary, conflict e unborn. Um arquivo com patch acima de 5 MiB deve
ser lido página por página até o último byte lógico sem uma resposta gigante.

- [ ] **Step 2: Verificar que a entrada continua atual**

Antes de gerar ou continuar um diff, executar porcelain v2 somente para o path
e comparar seu registro bruto com o snapshot da sessão. Divergência retorna
erro `workspaceReviewStale`; não mistura stats antigos com conteúdo novo.

- [ ] **Step 3: Materializar somente o arquivo solicitado**

Para tracked com HEAD:

```text
git -C <cwd> diff --no-ext-diff --no-color --find-renames --full-index --unified=3 HEAD -- <path>
```

Redirecionar stdout para arquivo dentro de `TempDir` da sessão. Para untracked
ou unborn textual, gerar cabeçalho/add lines em stream; para binário, gerar uma
linha `notice`. Conflito usa `git diff --cc -- <path>`.

- [ ] **Step 4: Paginar por offset seguro**

Cursor é byte offset decimal. Ler no máximo 256 KiB por página, estender até o
fim da linha quando pequeno e dividir linha maior em segmentos de 16 KiB com
`continued=true`. Parsear headers/hunks e manter números de linha no estado do
cache. Todo byte textual aparece em alguma página.

- [ ] **Step 5: Limpar cache e commitar**

Nova sessão descarta o `TempDir` anterior. Drop do manager remove o cache.
Falha/cancelamento remove arquivo parcial.

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml workspace_review::tests::diff -- --nocapture
pnpm format:rust
git add src-tauri/src/workspace_review.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Page workspace diffs on demand"
```

### Task 6: Compartilhar revisão no controller

**Files:**
- Create: `src/state/workspaceReview.ts`
- Create: `src/state/workspaceReview.test.ts`
- Modify: `src/state/createAppController.ts`

**Interfaces:**
- Produces accessors `workspaceReview`, `workspaceReviewLoading`, métodos
  `refreshWorkspaceReview`, `loadMoreWorkspaceChanges` e
  `readWorkspaceDiffPage`.

- [ ] **Step 1: Escrever reducer tests**

Cobrir start, append de página com reviewId igual, rejeição de reviewId antigo,
refresh que preserva o último resumo enquanto carrega e none que limpa estado.

- [ ] **Step 2: Implementar estado e sequência**

Substituir `workspaceRepository`/`repositoryRequestSequence` pelo estado de
revisão. Cada refresh incrementa sequência; resultado antigo é ignorado.
Mudança de workspace limpa diffs e inicia revisão. Erro preserva último resumo
do mesmo workspace e reporta falha.

- [ ] **Step 3: Atualizar nos eventos corretos**

Após `item.completed` com `fileChange`, agendar um único refresh após o batch.
Também atualizar ao recuperar foco da janela, ao abrir revisão e por botão.
Remover listener no cleanup.

- [ ] **Step 4: Validar e commitar**

```powershell
pnpm vitest run src/state/workspaceReview.test.ts
pnpm typecheck
git add src/state/workspaceReview.ts src/state/workspaceReview.test.ts src/state/createAppController.ts
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Synchronize workspace review state"
```

### Task 7: Adicionar chip e painel dividido

**Files:**
- Create: `src/ui/ChangeSummaryButton.tsx`
- Create: `src/ui/ReviewPanel.tsx`
- Modify: `src/ui/AppShell.tsx`
- Modify: `src/ui/Composer.tsx`
- Modify: `src/styles/global.css`
- Modify: `src/preview/setupBrowserPreview.ts`

**Interfaces:**
- Consumes: controller de revisão e preferências de diff.
- Produces: chip `N arquivos alterados +A -D`, abas “Revisão”/“Ambiente” e
  seções de diff carregadas sob demanda.

- [ ] **Step 1: Renderizar o chip autoritativo**

Mostrar somente em review Git com `filesChanged > 0`. Singular/plural correto,
adições verdes e remoções vermelhas com texto/aria-label completos. Clique
executa `openPanel("review")`; carregamento mantém os valores atuais com spinner
discreto.

- [ ] **Step 2: Generalizar estado do painel**

Em `AppShell`, substituir `environmentOpen` por:

```ts
const [panel, setPanel] = createSignal<"closed" | "environment" | "review">("closed");
```

Escape fecha. O botão de painel abre ambiente. O chip abre revisão. O aside
recebe a aba ativa e permite alternar sem desmontar a sessão.

- [ ] **Step 3: Implementar `ReviewPanel`**

Listar mudanças em seções com header status/path/+A/-D. Usar
`IntersectionObserver` para pedir a primeira página do diff quando a seção
entra no viewport e um sentinel para páginas seguintes. Falha fica na seção
com botão “Tentar novamente”. Binário/conflito mostram notice real.

- [ ] **Step 4: Adaptar layout responsivo**

Ambiente mantém 316 px. Revisão usa `clamp(520px, 50vw, 960px)`. Abaixo de
1150 px vira overlay à direita; abaixo de 780 px ocupa toda a área útil com
botão de voltar, em vez de desaparecer. Cabeçalho e composer permanecem
operáveis.

- [ ] **Step 5: Atualizar preview e validar visualmente**

Mockar os três comandos com 3 arquivos, +202/-10, rename e duas páginas de
diff. Abrir preview nos estados limpo, loading, review aberto e erro. Confirmar
foco, teclado, scroll independente e movimento reduzido.

- [ ] **Step 6: Executar e commitar**

```powershell
pnpm test:frontend
pnpm lint
pnpm build
git add src/ui/ChangeSummaryButton.tsx src/ui/ReviewPanel.tsx src/ui/AppShell.tsx src/ui/Composer.tsx src/styles/global.css src/preview/setupBrowserPreview.ts
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Add workspace review experience"
```

### Task 8: Verificação final e documentação

**Files:**
- Modify: `docs/ENGINE.md`
- Modify: `docs/REFERENCE.md`
- Verify: all files changed in Tasks 1-7

**Interfaces:**
- Consumes: timeline e revisão completas.
- Produces: documentação, auditoria de caps e evidência de regressão.

- [ ] **Step 1: Documentar projeção e revisão**

Registrar que eventos persistidos são lossless, grupos são projeção pura e
review sessions são efêmeras/paginadas. Documentar comandos Git exatos,
cancelamento, stale detection e cleanup.

- [ ] **Step 2: Auditar limitações e duplicações**

```powershell
rg -n 'MAX_WORKSPACE_CHANGES|MAX_GIT_STATUS_BYTES|GIT_INSPECTION_TIMEOUT|workspace_repository_read|Concluído' src src-tauri/src
rg -n 'workspace_review_start|workspace_review_changes_page|workspace_review_diff_page|projectTimeline' src src-tauri/src
```

Expected: caps/endpoint/selos antigos ausentes; um caminho novo por operação.

- [ ] **Step 3: Executar verificação completa**

```powershell
pnpm verify
git diff --check
git status --short
```

Expected: frontend, build, cargo check, fmt, clippy e todos os testes passam;
somente `.planning/` e `CodexDev.bat` permanecem fora dos commits.

- [ ] **Step 4: Teste manual proporcional**

No build local: abrir repo limpo, editar externamente, confirmar chip; abrir
revisão; navegar diff grande; enviar uma tarefa que lê/comanda/edita; confirmar
grupo ativo aberto e final recolhido; interromper outro turno; redimensionar a
janela. Nenhum toast de contrato, cronômetro preso ou duplicata em Recentes.

- [ ] **Step 5: Commitar documentação**

```powershell
git add docs/ENGINE.md docs/REFERENCE.md
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Document timeline and workspace review"
```
