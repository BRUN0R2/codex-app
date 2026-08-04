# Dynamic Context Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implementar compactação dinâmica de contexto com a mesma máquina de estados do Codex, evitando requisições previsivelmente grandes e recuperando um estouro inesperado na próxima submissão.

**Architecture:** O `NativeEngine` ganhará uma política pura de janela de contexto e um executor dedicado de Remote Compaction V2. O agente continuará orquestrando turnos, enquanto provider e storage preservarão respectivamente a identidade tipada do erro e a instalação atômica do checkpoint.

**Tech Stack:** Rust 2024, Tokio, Tauri 2, reqwest 0.13, rusqlite 0.40, serde/serde_json, testes unitários Rust e verificação pnpm.

## Global Constraints

- O backend Rust `NativeEngine` é o único proprietário da política, rede, ferramentas e persistência.
- Não adicionar dependência do CLI, app-server, endpoint `/responses/compact`, tokenizer ou pacote novo.
- Não adicionar migration, adapter, alias, fallback silencioso ou caminho de retrocompatibilidade.
- Manter Remote Compaction V2 com `compaction_trigger`, exatamente um checkpoint `compaction` e orçamento de retenção textual de 64.000 tokens.
- Um estouro inesperado não repete a amostragem no mesmo turno; ele falha visivelmente e prepara compactação para a próxima submissão.
- Persistir antes de emitir eventos concluídos e não instalar estado parcial em erro ou cancelamento.
- Preservar alterações não relacionadas, especialmente o arquivo não rastreado `CodexDev.bat`.
- Usar commits pequenos com mensagens imperativas em inglês e identidade Git apenas no escopo do comando quando necessário.

---

## Mapa de arquivos

- Criar `src-tauri/src/engine/native/context_window.rs`: estimativa, decisão, preparação e retenção puras.
- Criar `src-tauri/src/engine/native/compaction.rs`: ciclo de rede e instalação Remote Compaction V2.
- Modificar `src-tauri/src/error.rs`: erro tipado e classificação central do provider.
- Modificar `src-tauri/src/engine/native/provider/client.rs`: preservar código em erros HTTP.
- Modificar `src-tauri/src/engine/native/provider/responses.rs`: preservar código em erros SSE.
- Modificar `src-tauri/src/engine/native/storage.rs`: snapshot com modelo e instalação atômica.
- Modificar `src-tauri/src/engine/native/agent.rs`: preflight antes de toda amostragem e marcador de janela cheia.
- Modificar `src-tauri/src/engine/native/mod.rs`: registrar os dois módulos internos.
- Modificar `docs/ENGINE.md` e `docs/REFERENCE.md`: documentar a nova máquina de estados.

### Task 1: Preservar o estouro de contexto como erro de domínio

**Files:**
- Modify: `src-tauri/src/error.rs:5-64`
- Modify: `src-tauri/src/engine/native/provider/client.rs:251-310`
- Modify: `src-tauri/src/engine/native/provider/client.rs:432-545`
- Modify: `src-tauri/src/engine/native/provider/responses.rs:526-576`
- Modify: `src-tauri/src/engine/native/provider/responses.rs:922-944`
- Modify: `src-tauri/src/engine/native/provider/responses.rs:944-1066`

**Interfaces:**
- Consumes: `error.code`, `error.type` e `error.message` dos contratos HTTP/SSE existentes.
- Produces: `AppError::ContextWindowExceeded(String)` e `AppError::from_provider_rejection(status: Option<u16>, code: Option<&str>, message: String) -> AppError`.

- [ ] **Step 1: Escrever testes falhos do erro público e do SSE**

Adicionar em `error.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::{AppError, CommandError};

    #[test]
    fn context_window_exceeded_is_explicit_and_not_retryable() {
        let error = AppError::from_provider_rejection(
            None,
            Some("context_length_exceeded"),
            "request is too large".into(),
        );
        let public = CommandError::from(error);
        assert_eq!(public.code, "contextWindowExceeded");
        assert!(!public.retryable);
    }
}
```

Adicionar ao módulo de testes de `responses.rs`:

```rust
#[test]
fn preserves_context_window_exceeded_from_sse() {
    let mut parser = SseParser::default();
    let mut events = VecDeque::new();
    let error = parser
        .push(
            br#"data: {"type":"response.failed","response":{"error":{"code":"context_length_exceeded","message":"too large"}}}

"#,
            &mut events,
        )
        .expect_err("context overflow should fail the stream");
    assert!(matches!(error, crate::error::AppError::ContextWindowExceeded(_)));
    assert!(events.is_empty());
}
```

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml context_window_exceeded -- --nocapture
```

Expected: FAIL de compilação porque a variante e o construtor ainda não existem.

- [ ] **Step 3: Implementar a classificação central do erro**

Adicionar a variante e o construtor em `error.rs`:

```rust
#[error("model context window exceeded: {0}")]
ContextWindowExceeded(String),

pub(crate) fn from_provider_rejection(
    status: Option<u16>,
    code: Option<&str>,
    message: String,
) -> Self {
    if code == Some("context_length_exceeded") {
        Self::ContextWindowExceeded(message)
    } else if let Some(status) = status {
        Self::ProviderHttp { status, message }
    } else {
        Self::Provider(message)
    }
}
```

Mapear a nova variante para `contextWindowExceeded` em `code()` e deixá-la fora
de `retryable()`.

Em `responses.rs`, acrescentar `#[serde(default, rename = "type")] kind` a
`ResponseErrorWire` e substituir o retorno final de `stream_failure` por:

```rust
let code = error
    .as_ref()
    .and_then(|error| error.code.as_deref().or(error.kind.as_deref()));
let message = error
    .and_then(|error| error.message)
    .filter(|message| !message.trim().is_empty())
    .unwrap_or_else(|| "response stream failed without a message".into());
AppError::from_provider_rejection(None, code, message)
```

Evitar empréstimo após move extraindo `code` para uma `String` antes de consumir
o wire, se o compilador exigir.

- [ ] **Step 4: Escrever e executar o teste HTTP tipado**

Trocar o helper de corpo em `client.rs` por:

```rust
#[derive(Debug, PartialEq, Eq)]
struct DecodedProviderError {
    code: Option<String>,
    message: String,
}
```

Adicionar este teste antes da implementação do decoder:

```rust
#[test]
fn provider_error_body_preserves_context_code() {
    let decoded = decode_provider_error_body(
        br#"{"error":{"code":"context_length_exceeded","type":"invalid_request_error","message":"too large"}}"#.to_vec(),
    );
    assert_eq!(decoded.code.as_deref(), Some("context_length_exceeded"));
    assert_eq!(decoded.message, "too large (provider type: invalid_request_error)");
    assert!(matches!(
        AppError::from_provider_rejection(Some(400), decoded.code.as_deref(), decoded.message),
        AppError::ContextWindowExceeded(_)
    ));
}
```

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml provider_error_body_preserves_context_code -- --nocapture
```

Expected: FAIL porque `decode_provider_error_body` ainda não existe.

- [ ] **Step 5: Implementar o decoder HTTP e fazer os testes passarem**

Fazer `decode_provider_error_body(Vec<u8>) -> DecodedProviderError` conservar
`error.code`, usando `error.type` apenas quando `code` estiver ausente. Continuar
limitando e normalizando a mensagem com `bounded_error_text`. Em
`response_error`, construir o erro assim:

```rust
let decoded = match read_limited(response, MAX_ERROR_BYTES).await {
    Ok(bytes) if bytes.is_empty() => DecodedProviderError {
        code: None,
        message: "the provider returned an empty error body".into(),
    },
    Ok(bytes) => decode_provider_error_body(bytes),
    Err(error) => DecodedProviderError {
        code: None,
        message: format!("the provider error body could not be read: {error}"),
    },
};
AppError::from_provider_rejection(Some(status), decoded.code.as_deref(), decoded.message)
```

Atualizar os testes existentes para ler `.message` do resultado decodificado.

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml provider_errors_are_bounded_and_human_readable -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml context_window_exceeded -- --nocapture
```

Expected: PASS.

- [ ] **Step 6: Formatar e commitar o erro tipado**

Run:

```powershell
pnpm format:rust
git add src-tauri/src/error.rs src-tauri/src/engine/native/provider/client.rs src-tauri/src/engine/native/provider/responses.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Preserve context overflow errors"
```

Expected: commit criado apenas com o domínio e os dois decoders de provider.

### Task 2: Criar a política pura de ocupação ativa

**Files:**
- Create: `src-tauri/src/engine/native/context_window.rs`
- Modify: `src-tauri/src/engine/native/mod.rs:1-7`

**Interfaces:**
- Consumes: `ResponseItem`, `ResponseContent`, `TokenUsage`, `ModelContextWindow` e ferramentas `serde_json::Value`.
- Produces: `ContextUsageSnapshot`, `ContextWindowStatus` e `evaluate_context_window` com a assinatura definida na Step 3.

- [ ] **Step 1: Registrar o módulo e escrever os testes falhos de accounting**

Adicionar `mod context_window;` em `native/mod.rs` e criar o arquivo com os tipos
e testes abaixo, deixando a função chamada pelos testes ausente inicialmente:

```rust
#[derive(Debug, Clone)]
pub(super) struct ContextUsageSnapshot {
    pub model: String,
    pub usage: TokenUsage,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) struct ContextWindowStatus {
    pub active_tokens: u64,
    pub should_compact: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(role: &str, value: &str) -> ResponseItem {
        ResponseItem::Message {
            id: None,
            role: role.into(),
            content: vec![ResponseContent::InputText { text: value.into() }],
            phase: None,
        }
    }

    fn usage(total_tokens: u64) -> TokenUsage {
        TokenUsage {
            input_tokens: total_tokens,
            cached_input_tokens: 0,
            output_tokens: 0,
            reasoning_output_tokens: 0,
            total_tokens,
        }
    }

    #[test]
    fn adds_local_items_after_the_last_model_item() {
        let history = vec![text("assistant", "done"), text("user", &"x".repeat(400))];
        let snapshot = ContextUsageSnapshot { model: "gpt-test".into(), usage: usage(900) };
        let status = evaluate_context_window(
            "gpt-test", "", &history, &[], Some(&snapshot), Some(1_000), None,
        );
        assert!(status.active_tokens >= 1_000);
        assert!(status.should_compact);
    }

    #[test]
    fn current_request_estimate_covers_larger_instructions() {
        let history = vec![text("assistant", "done")];
        let snapshot = ContextUsageSnapshot { model: "gpt-test".into(), usage: usage(10) };
        let status = evaluate_context_window(
            "gpt-test",
            &"i".repeat(4_000),
            &history,
            &[],
            Some(&snapshot),
            Some(900),
            None,
        );
        assert!(status.should_compact);
    }

    #[test]
    fn incompatible_model_uses_the_current_request_only() {
        let snapshot = ContextUsageSnapshot { model: "gpt-large".into(), usage: usage(900_000) };
        let status = evaluate_context_window(
            "gpt-small", "short", &[text("user", "hello")], &[], Some(&snapshot), Some(1_000), None,
        );
        assert!(!status.should_compact);
    }
}
```

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml context_window::tests -- --nocapture
```

Expected: FAIL de compilação porque `evaluate_context_window` não existe.

- [ ] **Step 3: Implementar estimativa saturante e decisão pelos dois limites**

Implementar esta interface:

```rust
pub(super) fn evaluate_context_window(
    model_id: &str,
    instructions: &str,
    history: &[ResponseItem],
    tools: &[Value],
    snapshot: Option<&ContextUsageSnapshot>,
    auto_compact_limit: Option<u64>,
    context_window: Option<&ModelContextWindow>,
) -> ContextWindowStatus
```

Usar o seguinte núcleo:

```rust
let estimated_request = estimate_text_tokens(instructions)
    .saturating_add(history.iter().map(estimate_item_tokens).fold(0, u64::saturating_add))
    .saturating_add(estimate_json_tokens(tools));
let measured_with_local_delta = snapshot
    .filter(|snapshot| snapshot.model == model_id)
    .and_then(|snapshot| {
        let last_model_item = history.iter().rposition(is_model_generated_item)?;
        let local = history[last_model_item + 1..]
            .iter()
            .map(estimate_item_tokens)
            .fold(0, u64::saturating_add);
        Some(snapshot.usage.total_tokens.saturating_add(local))
    });
let active_tokens = measured_with_local_delta
    .map_or(estimated_request, |measured| measured.max(estimated_request));
let should_compact = auto_compact_limit.is_some_and(|limit| active_tokens >= limit)
    || context_window.is_some_and(|window| active_tokens >= window.usable_tokens);
```

Para `estimate_item_tokens`:

- serializar itens ordinários e usar `bytes.div_ceil(4)`;
- descontar a parte base64 de `data:image/<media>;base64,<payload>` e somar 4.096 bytes;
- para `Reasoning` criptografado e `Compaction`, usar
  `encoded_len.saturating_mul(3) / 4`, subtrair 650 e converter por quatro;
- retornar `u64::MAX` em qualquer conversão/serialização que não possa ser
  representada com segurança.

Classificar como item gerado pelo modelo:

```rust
matches!(
    item,
    ResponseItem::Message { role, .. } if role == "assistant"
) || matches!(
    item,
    ResponseItem::Reasoning { .. }
        | ResponseItem::FunctionCall { .. }
        | ResponseItem::CustomToolCall { .. }
        | ResponseItem::WebSearchCall { .. }
        | ResponseItem::Compaction { .. }
)
```

- [ ] **Step 4: Acrescentar casos de ferramenta, janela útil, imagem e checkpoint**

Adicionar testes que:

```rust
#[test]
fn either_available_limit_can_trigger_compaction() {
    let window = ModelContextWindow {
        tokens: 2_000,
        usable_tokens: 100,
        usable_percent: 95,
        maximum_tokens: None,
    };
    let status = evaluate_context_window(
        "gpt-test", &"x".repeat(400), &[], &[], None, Some(10_000), Some(&window),
    );
    assert!(status.should_compact);
}

#[test]
fn encrypted_checkpoint_has_a_bounded_visible_estimate() {
    let item = ResponseItem::Compaction {
        id: Some("compact-1".into()),
        encrypted_content: "x".repeat(4_000),
        internal_chat_message_metadata_passthrough: None,
    };
    assert_eq!(estimate_item_tokens(&item), (3_000_u64 - 650).div_ceil(4));
}
```

Também verificar que uma imagem inline enorme custa aproximadamente 1.024
tokens, e que `FunctionCallOutput` após a última chamada é somado ao snapshot.

- [ ] **Step 5: Executar, formatar e commitar a política**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml context_window::tests -- --nocapture
pnpm format:rust
git add src-tauri/src/engine/native/context_window.rs src-tauri/src/engine/native/mod.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Add active context policy"
```

Expected: todos os testes do novo módulo passam e o commit contém apenas a
política pura e o registro do módulo.

### Task 3: Tornar snapshot e instalação de compactação atômicos

**Files:**
- Modify: `src-tauri/src/engine/native/storage.rs:658-762`
- Modify: `src-tauri/src/engine/native/storage.rs:1490-1580`

**Interfaces:**
- Consumes: `ContextUsageSnapshot` criado na Task 2.
- Produces: `latest_context_usage(String) -> Result<Option<ContextUsageSnapshot>, AppError>` e `install_compacted_history(thread_id: String, turn_id: String, items: Vec<ResponseItem>, compaction_id: String) -> Result<(), AppError>`.

- [ ] **Step 1: Atualizar o teste do snapshot e escrever o teste de instalação**

No teste existente de substituição, trocar `usage.total_tokens` por
`usage.usage.total_tokens` e validar `usage.model == "gpt-test"`.

Adicionar um teste assíncrono que inicia thread/turno, persiste usage e chama:

```rust
storage
    .install_compacted_history(
        thread.id.clone(),
        turn.id.clone(),
        vec![ResponseItem::Compaction {
            id: Some("checkpoint-1".into()),
            encrypted_content: "encrypted".into(),
            internal_chat_message_metadata_passthrough: None,
        }],
        "compaction-1".into(),
    )
    .await
    .expect("compacted history and marker should install");
```

Depois verificar histórico com um checkpoint, último item visível
`ThreadItem::ContextCompaction { id: "compaction-1" }` e snapshot `None`.

- [ ] **Step 2: Escrever o teste de rollback transacional**

Persistir previamente um thread item com ID `duplicate-compaction`, chamar
`install_compacted_history` com o mesmo ID e um histórico substituto, esperar
erro de unique constraint e confirmar que `provider_history` ainda contém o
item antigo. Esse teste deve provar rollback, não apenas validação anterior.

- [ ] **Step 3: Executar os testes e confirmar a falha**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml installs_compacted_history -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml rolls_back_compacted_history -- --nocapture
```

Expected: FAIL de compilação porque o novo método ainda não existe.

- [ ] **Step 4: Extrair validação compartilhada de histórico**

Criar:

```rust
fn encode_provider_history(items: Vec<ResponseItem>) -> Result<Vec<String>, AppError>
```

Ela deve manter exatamente os limites atuais de 1 a `MAX_HISTORY_ITEMS`,
`MAX_ITEM_BYTES` por item e `MAX_HISTORY_BYTES` no total. Fazer
`replace_provider_history` reutilizar essa função sem mudar sua semântica.

- [ ] **Step 5: Implementar snapshot com modelo e instalação em uma transação**

Decodificar `ThreadItem::ContextUsage { model, usage, .. }` como:

```rust
Ok(Some(ContextUsageSnapshot { model, usage }))
```

Em `install_compacted_history`, validar/serializar tudo antes de abrir a
transação. Dentro dela, executar nesta ordem:

```rust
let active: bool = transaction.query_row(
    "SELECT EXISTS(
         SELECT 1 FROM turns
         JOIN threads ON threads.id = turns.thread_id
         WHERE turns.id = ?1 AND turns.thread_id = ?2
           AND turns.status = 'inProgress' AND threads.archived = 0
     )",
    params![turn_id, thread_id],
    |row| row.get(0),
)?;
// retornar AppError::State se !active
transaction.execute("DELETE FROM provider_items WHERE thread_id = ?1", [&thread_id])?;
// inserir cada payload em provider_items
transaction.execute(
    "INSERT INTO thread_items (turn_id, item_id, payload) VALUES (?1, ?2, ?3)",
    params![turn_id, compaction_id, compaction_payload],
)?;
transaction.execute(
    "UPDATE threads SET updated_at = ?1 WHERE id = ?2",
    params![unix_timestamp()?, thread_id],
)?;
transaction.commit()?;
```

Converter todos os erros rusqlite com `storage_error`, conforme o restante do
arquivo.

- [ ] **Step 6: Executar, formatar e commitar a persistência**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml compacted_history -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml replaces_only_the_active_provider_context_transactionally -- --nocapture
pnpm format:rust
git add src-tauri/src/engine/native/storage.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Install compacted context atomically"
```

Expected: snapshot, instalação e rollback passam sem alterar schema.

### Task 4: Extrair e endurecer Remote Compaction V2

**Files:**
- Create: `src-tauri/src/engine/native/compaction.rs`
- Modify: `src-tauri/src/engine/native/context_window.rs`
- Modify: `src-tauri/src/engine/native/agent.rs:439-771`
- Modify: `src-tauri/src/engine/native/mod.rs:1-8`

**Interfaces:**
- Consumes: `install_compacted_history`, helpers de request/evento do agente e política pura.
- Produces: `compaction::compact_context` com a assinatura movida de `agent.rs`, além das duas funções puras com assinaturas definidas na Step 1.

- [ ] **Step 1: Escrever testes falhos de preparação e retenção**

Em `context_window.rs`, adicionar testes para estas interfaces:

```rust
pub(super) fn prepare_compaction_history(
    instructions: &str,
    history: &[ResponseItem],
    tools: &[Value],
    hard_limit: Option<u64>,
) -> Vec<ResponseItem>;

pub(super) fn build_compacted_history(
    prompt_input: &[ResponseItem],
    checkpoint: ResponseItem,
) -> Vec<ResponseItem>;
```

Casos obrigatórios:

```rust
#[test]
fn rewrites_only_the_contiguous_tool_output_suffix() {
    let huge_output = "x".repeat(4_000);
    let history = vec![
        text("user", "keep"),
        ResponseItem::FunctionCallOutput { call_id: "call-1".into(), output: huge_output },
    ];
    let prepared = prepare_compaction_history("", &history, &[], Some(200));
    assert!(matches!(
        prepared.last(),
        Some(ResponseItem::FunctionCallOutput { output, .. })
            if output == "Output exceeded the available model context and was truncated"
    ));
    assert_ne!(serde_json::to_string(&history).unwrap(), serde_json::to_string(&prepared).unwrap());
}

#[test]
fn truncates_an_oversized_newest_user_message_instead_of_skipping_it() {
    let newest = text("user", &"n".repeat((64_000 + 10) * 4));
    let checkpoint = ResponseItem::Compaction {
        id: Some("checkpoint-1".into()),
        encrypted_content: "encrypted".into(),
        internal_chat_message_metadata_passthrough: None,
    };
    let compacted = build_compacted_history(&[text("user", "old"), newest], checkpoint);
    assert_eq!(compacted.len(), 2);
    assert!(matches!(&compacted[0], ResponseItem::Message { role, .. } if role == "user"));
    assert!(matches!(compacted.last(), Some(ResponseItem::Compaction { .. })));
}
```

Acrescentar um caso em que texto é truncado mas `InputImage` da mesma mensagem
permanece.

- [ ] **Step 2: Executar os testes e confirmar a falha**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml rewrites_only_the_contiguous_tool_output_suffix -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml truncates_an_oversized_newest_user_message_instead_of_skipping_it -- --nocapture
```

Expected: FAIL de compilação porque as duas funções ainda não existem.

- [ ] **Step 3: Implementar preparação sem mutar o histórico original**

Definir as constantes:

```rust
const COMPACTION_OUTPUT_TRUNCATION: &str =
    "Output exceeded the available model context and was truncated";
const RETAINED_MESSAGE_TOKEN_BUDGET: usize = 64_000;
const MESSAGE_TRUNCATION_MARKER: &str = "\n[message truncated for context compaction]";
```

Clonar `history`, estimar instruções + clone + ferramentas +
`ResponseItem::compaction_trigger()`, e percorrer índices em ordem reversa.
Enquanto estiver acima do limite, substituir somente
`FunctionCallOutput.output` ou `CustomToolCallOutput.output`. Interromper no
primeiro item que não seja uma dessas saídas. Atualizar o total por subtração
saturante da estimativa antiga e adição saturante da nova.

- [ ] **Step 4: Implementar retenção nova-para-antiga com truncamento UTF-8**

Filtrar somente `Message { role: "user", .. }`. Contar texto e refusal por
`len().div_ceil(4)` e imagens como zero no orçamento textual. Ao exceder o
restante, reconstruir a mensagem na ordem original:

- copiar conteúdos textuais inteiros enquanto couberem;
- truncar no último boundary UTF-8 que caiba em `remaining * 4` bytes;
- usar `MESSAGE_TRUNCATION_MARKER` somente quando também couber no orçamento;
- manter `InputImage` da mensagem truncada;
- parar de reter mensagens mais antigas depois de consumir o orçamento;
- inverter as mensagens selecionadas e anexar o checkpoint.

Executar novamente os testes da Step 2 e esperar PASS.

- [ ] **Step 5: Mover o ciclo de compactação para `compaction.rs`**

Adicionar `mod compaction;` em `native/mod.rs`. Mover `compact_context` de
`agent.rs` sem mudar o contrato de rede e substituir a montagem do input por:

```rust
let history = load_prompt_history(inner, app, &run.thread_id).await?;
let tools = provider_tools(inner, &run.config);
let mut compaction_input = prepare_compaction_history(
    instructions,
    &history,
    &tools,
    run.model.context_window().as_ref().map(|window| window.tokens),
);
let retained_input = compaction_input.clone();
compaction_input.push(ResponseItem::compaction_trigger());
```

Manter a validação de `response.completed` e exatamente um checkpoint. Depois
do stream, instalar e emitir nesta ordem:

```rust
let compacted = build_compacted_history(&retained_input, checkpoint);
inner.storage.install_compacted_history(
    run.thread_id.clone(),
    run.turn_id.clone(),
    compacted,
    compaction_item.id().to_string(),
).await?;
emit_completed_item(inner, app, &run.thread_id, &run.turn_id, compaction_item)?;
```

Para evitar persistência duplicada, separar a emissão concluída de
`persist_and_emit_item` ou adicionar um helper explícito que somente emite após
o commit. Tornar `TurnProviderState`, `load_prompt_history`, `provider_tools`,
`handle_provider_control_event` e `validate_response_item` `pub(super)` apenas
onde `compaction.rs` realmente precisar. Expor o turn state por método de
leitura, não tornando o campo público.

- [ ] **Step 6: Remover o código antigo e validar a extração**

Remover de `agent.rs` o limite de 64k, `context_limit_reached`,
`compact_context`, `build_compacted_history` e `estimate_message_tokens`.
Fazer `run_compaction` chamar `compaction::compact_context`.

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml compaction -- --nocapture
cargo check --locked --manifest-path src-tauri/Cargo.toml
pnpm format:rust
```

Expected: testes de protocolo, retenção e storage passam; o crate compila com
o ciclo fora de `agent.rs`.

- [ ] **Step 7: Commitar a extração**

Run:

```powershell
git add src-tauri/src/engine/native/agent.rs src-tauri/src/engine/native/compaction.rs src-tauri/src/engine/native/context_window.rs src-tauri/src/engine/native/mod.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Extract remote context compaction"
```

Expected: commit autocontido que mantém compactação manual funcional e usa a
instalação atômica.

### Task 5: Aplicar preflight dinâmico e recuperação na próxima submissão

**Files:**
- Modify: `src-tauri/src/engine/native/context_window.rs`
- Modify: `src-tauri/src/engine/native/agent.rs:168-437`
- Modify: `src-tauri/src/engine/native/agent.rs:940-994`

**Interfaces:**
- Consumes: `evaluate_context_window`, `ContextUsageSnapshot`, `compact_context` e `ContextWindowExceeded`.
- Produces: preflight antes de cada requisição comum e `full_context_usage(&ModelContextWindow) -> TokenUsage`.

- [ ] **Step 1: Escrever o teste falho da medição cheia**

Em `context_window.rs`:

```rust
#[test]
fn full_context_usage_forces_the_next_preflight_to_compact() {
    let window = ModelContextWindow {
        tokens: 272_000,
        usable_tokens: 258_400,
        usable_percent: 95,
        maximum_tokens: Some(400_000),
    };
    let usage = full_context_usage(&window);
    assert_eq!(usage.input_tokens, 272_000);
    assert_eq!(usage.total_tokens, 272_000);

    let snapshot = ContextUsageSnapshot { model: "gpt-test".into(), usage };
    let status = evaluate_context_window(
        "gpt-test",
        "",
        &[text("assistant", "last response")],
        &[],
        Some(&snapshot),
        Some(244_800),
        Some(&window),
    );
    assert!(status.should_compact);
}
```

- [ ] **Step 2: Executar o teste e confirmar a falha**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml full_context_usage_forces_the_next_preflight_to_compact -- --nocapture
```

Expected: FAIL porque `full_context_usage` não existe.

- [ ] **Step 3: Implementar a medição cheia**

Adicionar:

```rust
pub(super) fn full_context_usage(window: &ModelContextWindow) -> TokenUsage {
    TokenUsage {
        input_tokens: window.tokens,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: window.tokens,
    }
}
```

Executar novamente o teste da Step 2 e esperar PASS.

- [ ] **Step 4: Preparar uma entrada já avaliada antes de toda amostragem**

Em `agent.rs`, criar:

```rust
struct SamplingInput {
    history: Vec<ResponseItem>,
    tools: Vec<serde_json::Value>,
}

async fn prepare_sampling_input(
    inner: &NativeEngineInner,
    app: &AppHandle,
    run: &mut TurnRun,
    instructions: &str,
    provider_state: &mut TurnProviderState,
) -> Result<Option<SamplingInput>, AppError>
```

O corpo deve:

1. carregar histórico normalizado uma vez;
2. montar ferramentas uma vez;
3. carregar `latest_context_usage`;
4. chamar `evaluate_context_window` com modelo, instruções, histórico,
   ferramentas, limites automático e útil;
5. retornar os dados sem compactar quando `should_compact == false`;
6. chamar `compaction::compact_context` quando verdadeiro;
7. retornar `None` em cancelamento;
8. recarregar somente o histórico depois de compactação bem-sucedida e manter
   as mesmas ferramentas.

Antes do `loop`, obter o primeiro `SamplingInput`. No fim de cada continuação,
depois das saídas de ferramenta e steers já persistidos, obter o próximo. Usar
os campos preparados diretamente em `ResponseRequest::new`, removendo o uso de
`completed_usage` como gatilho.

- [ ] **Step 5: Persistir janela cheia em um estouro comum**

Criar em `agent.rs`:

```rust
async fn persist_full_context_usage(
    inner: &NativeEngineInner,
    app: &AppHandle,
    run: &TurnRun,
) -> Result<(), AppError> {
    let Some(context_window) = run.model.context_window() else {
        return Ok(());
    };
    persist_and_emit_item(
        inner,
        app,
        &run.thread_id,
        &run.turn_id,
        ThreadItem::ContextUsage {
            id: Uuid::now_v7().to_string(),
            model: run.model.id().into(),
            usage: full_context_usage(&context_window),
            context_window: Some(context_window),
        },
        false,
    )
    .await
}
```

Tratar tanto o erro de `start_response` quanto o erro de `next_event`:

```rust
Err(error) => {
    if matches!(&error, AppError::ContextWindowExceeded(_)) {
        persist_full_context_usage(&inner, &app, &run).await?;
    }
    return Err(error);
}
```

Não aplicar esse branch dentro de `compaction.rs`.

- [ ] **Step 6: Validar a orquestração sem criar provider falso**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml context_window::tests -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml provider -- --nocapture
cargo check --locked --manifest-path src-tauri/Cargo.toml
pnpm format:rust
```

Expected: todos passam. A validação cobre decisão e transporte em unidades
puras; não se cria uma abstração de provider apenas para o teste.

- [ ] **Step 7: Revisar as fronteiras do fluxo**

Usar `rg` para confirmar:

```powershell
rg -n "latest_context_usage|evaluate_context_window|compact_context|ContextWindowExceeded|persist_full_context_usage" src-tauri/src/engine/native src-tauri/src/error.rs
```

Expected:

- `evaluate_context_window` aparece no preflight único;
- `compact_context` aparece no preflight e no comando manual;
- `ContextWindowExceeded` é tratado somente na amostragem comum;
- nenhuma comparação antiga `usage.total_tokens >= limit` permanece em
  `agent.rs`.

- [ ] **Step 8: Commitar o fluxo dinâmico**

Run:

```powershell
git add src-tauri/src/engine/native/agent.rs src-tauri/src/engine/native/context_window.rs
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Compact active context before sampling"
```

Expected: commit contém o novo preflight e a recuperação oficial da próxima
submissão.

### Task 6: Documentar e verificar a implementação completa

**Files:**
- Modify: `docs/ENGINE.md`
- Modify: `docs/REFERENCE.md`
- Verify: all files changed by Tasks 1-5

**Interfaces:**
- Consumes: máquina de estados implementada nas Tasks 1-5.
- Produces: documentação arquitetural atualizada e evidência final de qualidade.

- [ ] **Step 1: Atualizar a documentação do motor**

Adicionar a `docs/ENGINE.md` uma seção “Dynamic context compaction” com estes
fatos explícitos:

```text
- active context = max(current request estimate, last compatible server usage + local suffix)
- checks run before the first sampling request and every in-turn continuation
- remote compaction V2 installs retained user messages plus one encrypted checkpoint atomically
- unexpected context_length_exceeded fails the current turn, marks the window full, and compacts before the next submission
```

Descrever que instruções e ferramentas entram na estimativa atual e que o
frontend apenas renderiza eventos/estado.

- [ ] **Step 2: Atualizar a rastreabilidade com o Codex de referência**

Em `docs/REFERENCE.md`, registrar os arquivos de referência comparados:

```text
codex-rs/core/src/context_manager/history.rs
codex-rs/core/src/session/context_window.rs
codex-rs/core/src/session/turn.rs
codex-rs/core/src/compact_remote.rs
codex-rs/core/src/compact_remote_v2.rs
```

Explicar a adaptação local: sem world-state histórico nem `comp_hash`, o motor
recompõe instruções por request e usa o máximo entre medição e estimativa.

- [ ] **Step 3: Executar verificações direcionadas**

Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml context_window -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml compact -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml provider_error -- --nocapture
cargo test --locked --manifest-path src-tauri/Cargo.toml context_window_exceeded -- --nocapture
```

Expected: PASS sem teste ignorado ou panic inesperado.

- [ ] **Step 4: Executar a verificação completa do repositório**

Run:

```powershell
pnpm verify
```

Expected: lint, frontend tests, build, dependências transitivas, cargo check,
format check, clippy e todos os testes Rust passam.

- [ ] **Step 5: Tentar validação ao vivo com segurança**

Verificar primeiro, sem ler conteúdo de conversa, se o app possui sessão
autenticada e pode iniciar uma thread descartável. Se disponível, criar uma
conversa descartável com entrada suficientemente grande para cruzar o limite
automático e confirmar a sequência observável:

```text
item.started(contextCompaction)
item.completed(contextCompaction)
requisição comum continua sem providerHttpError de contexto
```

Se não houver sessão utilizável, registrar “live provider validation
unavailable: no authenticated local session” no relatório final; não alterar
credenciais nem fabricar resultado.

- [ ] **Step 6: Revisar diff, whitespace e arquivos não relacionados**

Run:

```powershell
git diff --check
git status --short
git diff --stat HEAD~5..HEAD
```

Expected: nenhuma falha de whitespace; `.planning/` e `CodexDev.bat` continuam
fora dos commits; nenhuma alteração fora do escopo aparece.

- [ ] **Step 7: Commitar documentação e eventuais ajustes verificados**

Run:

```powershell
git add docs/ENGINE.md docs/REFERENCE.md
git -c user.name=BRUN0R2 -c user.email=90096510+BRUN0R2@users.noreply.github.com commit -m "Document dynamic context recovery"
```

Se a verificação exigir correção em código, incluir somente os arquivos dessa
correção e usar uma mensagem imperativa que descreva o ajuste real.

- [ ] **Step 8: Confirmar histórico e estado final**

Run:

```powershell
git log --oneline -8
git status --short
```

Expected: design, plano e cada mudança lógica aparecem separadamente; somente
artefatos pré-existentes ou de planejamento permanecem não rastreados.
