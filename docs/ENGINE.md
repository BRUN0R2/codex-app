# Contrato do engine

`NativeEngine` é o único backend do produto. Ele usa OAuth ChatGPT, HTTPS/SSE e
SQLite sem executar ou importar dados do Codex CLI.

| Contrato | Valor atual |
| --- | --- |
| schema IPC | `19` |
| schema SQLite | `4` |
| provider Codex | ChatGPT Codex Responses |
| transporte | HTTPS/SSE |
| sidecar | `rg.exe` 15.2.0 validado por hash |

## Comandos Tauri

Cada comando possui request e response fechados. Não existe RPC genérico nem
JSON arbitrário.

| Área | Comandos |
| --- | --- |
| lifecycle | `engine_start`, `engine_runtime_diagnostic_report` |
| conta | `engine_account_read`, `engine_account_profile_read`, `engine_account_rate_limits_read`, `engine_account_usage_resets_read`, `engine_account_usage_reset_redeem`, `engine_account_auto_top_up_read`, `engine_account_auto_top_up_enable`, `engine_account_auto_top_up_update`, `engine_account_auto_top_up_disable` |
| sessão | `engine_login_chatgpt`, `engine_login_cancel`, `engine_logout` |
| tarefas | `engine_thread_start`, `engine_thread_list`, `engine_thread_resume`, `engine_thread_read`, `engine_thread_set_name`, `engine_thread_archive`, `engine_thread_unarchive`, `engine_thread_delete`, `engine_thread_fork` |
| turnos e saída | `engine_turn_start`, `engine_turn_steer`, `engine_turn_interrupt`, `engine_output_read` |
| automações | `engine_automation_list`, `engine_automation_create`, `engine_automation_update`, `engine_automation_delete`, `engine_automation_run_now`, `engine_automation_run_mark_reviewed` |
| modelos e configuração | `engine_config_update`, `engine_model_list`, `engine_chat_model_list` |
| aprovações | `engine_server_request_respond` |
| anexos | `attachment_inspect`, `attachment_read_image`, `attachment_save_pasted_image` |
| browser | `browser_tab_create`, `browser_tab_navigate`, `browser_tab_back`, `browser_tab_forward`, `browser_tab_reload`, `browser_tab_close`, `browser_viewport_set`, `browser_surface_sync` |
| desktop | `application_preferences_read`, `application_preferences_update`, `application_workspace_open` |

`application_workspace_open` aceita somente diretório absoluto, existente e
canonicalizado. O WebView não recebe permissão para abrir paths diretamente.

## Eventos

| Canal | Conteúdo |
| --- | --- |
| `engine://runtime-status` | `starting`, `ready`, `failed` ou `stopped` |
| `engine://runtime-diagnostic` | falha operacional estruturada |
| `engine://notification` | auth, tarefa, turno, item, modelo e automação |
| `engine://server-request` | `approval.command` ou `approval.browserOrigin` |
| `browser://state` | estado autoritativo da aba |
| `browser://new-window` | URL HTTP(S) validada para nova aba controlada |
| `browser://agent-activity` | conversa, ação e abertura do painel |
| `browser://metric` | amostra limitada de QA e latência |

Notificações aceitas: `auth.loginCompleted`, `auth.sessionChanged`,
`thread.created`, `thread.updated`, `thread.archived`, `thread.unarchived`,
`thread.deleted`, `turn.started`, `turn.completed`, `item.started`,
`item.completed`, `item.streamDeltas`, `model.rerouted`, `model.verification`,
`model.safetyBufferingUpdated`, `automation.changed`, `automation.deleted` e
`automation.runUpdated`. Métodos desconhecidos falham no decoder.

Fixtures golden em `src/contracts/fixtures` travam Rust e TypeScript. Para
regenerá-las intencionalmente:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml engine::contracts_fixtures::tests::regenerate_golden_contract_fixtures -- --ignored
```

## Modelos, instruções e contexto

Chat consumidor e Codex usam protocolos e catálogos separados. O catálogo Codex
é mantido apenas em memória por cinco minutos; ETag igual renova a validade e
ETag diferente invalida a entrada. Não existe cache persistente de modelos.

As instruções-base vêm de `model_messages.instructions_template`, com
`base_instructions` apenas para catálogo legado. O runtime adiciona, em itens
separados e limitados, instruções do repositório, permissões, colaboração e
ambiente. Não existe prompt universal local duplicando o protocolo do modelo.

`tool_mode` e `multi_agent_version` são enums fechados. Um modelo
`code_mode_only` é bloqueado enquanto o host Code Mode não existir. Ultra é
bloqueado enquanto multiagente v2 não existir; o literal `ultra` nunca é enviado
ao provider. Catálogo e capabilities, não nomes comerciais codificados na UI,
definem esforços, tiers, modalidades, detalhe de imagem e janela de contexto.

Antes de cada amostragem, o engine mede o request real e aplica margem de 12%.
Quando o limite do catálogo é alcançado, Remote Compaction V2 instala um único
checkpoint válido em transação. `context_length_exceeded` permite uma recuperação
por compactação antes de se tornar terminal.

## Loop do agente

1. O engine normaliza histórico e garante um output para cada tool call.
2. Monta instruções, itens, capabilities e catálogo permitido.
3. Consome Responses Standard ou Lite por SSE.
4. Persiste itens completos; deltas permanecem projeções transitórias.
5. Executa ferramentas, persiste outputs na ordem original e continua a rodada.
6. Conclui, interrompe ou falha o turno em transação.

Heartbeats não renovam o deadline de evento semântico. Falhas transitórias de
transporte, timeout, HTTP 5xx e SSE podem retomar com backoff e cancelamento
imediato; protocolo inválido é terminal. Rate limit respeita o prazo do provider
sem criar um contador local arbitrário de tentativas.

Chamadas consecutivas somente leitura podem executar em paralelo. Qualquer
mutação, aprovação ou comando exclusivo cria uma barreira. O lote local é
limitado a oito e os resultados voltam ao provider na ordem das chamadas.

## Ferramentas

O catálogo completo atual possui 20 definições:

| Grupo | Ferramentas |
| --- | --- |
| arquivos e estado | `read_file`, `list_files`, `search_text`, `view_image`, `edit_file`, `write_file`, `read_output`, `update_plan` |
| execução | `exec_command`, `poll_command` |
| patch freeform | `apply_patch` |
| browser | `browser_manage`, `browser_snapshot`, `browser_screenshot`, `browser_viewport`, `browser_pointer`, `browser_type`, `browser_key`, `browser_wait`, `browser_metrics` |

| Ferramenta | Somente leitura | Projeto | Acesso total |
| --- | ---: | ---: | ---: |
| leitura, busca, imagem, output e plano | sim | sim | sim |
| ferramentas de browser | sim | sim | sim |
| `edit_file`, `write_file`, `apply_patch` | não | sim | sim |
| `exec_command` | não | aprovação | sem aprovação |
| `poll_command` | sim | sim | sim |

O perfil somente leitura nem anuncia ferramentas proibidas. Chamadas puras
idênticas no mesmo trecho podem ser coalescidas; efeitos nunca são deduplicados.
Schemas são estritos e qualquer restrição não representável no JSON Schema é
validada novamente pelo decoder Rust.

### Arquivos e patches

Paths são normalizados dentro do workspace. Escritas são UTF-8 e atômicas.
`apply_patch` usa gramática Lark própria, sem shell ou `git apply`: planeja todos
os arquivos em memória, rejeita escapes, symlinks e sobreposição, revalida
snapshots e aplica ou reverte a transação completa.

`search_text` executa o ripgrep embarcado por caminho absoluto, sem shell nem
dependência do `PATH`. O engine aplica `.gitignore`, limites, timeout,
cancelamento e leitura incremental.

### Comandos

`exec_command` usa PowerShell 7 em UTF-8, sem cor e sem janela. No Windows, cada
árvore entra em um Job Object com `KILL_ON_JOB_CLOSE`; falhar ao assumir ownership
impede o launch.

| Limite | Valor |
| --- | ---: |
| sessões simultâneas | 32 |
| espera inicial padrão | 10 s |
| `yield_time_ms` | 250 ms a 30 s |
| espera de `poll_command` | 0 a 30 s |
| prévia viva | 256 KiB por stream |

Após o yield, a sessão continua vinculada à tarefa e retorna deltas por cursor.
O transcript integral é persistido em chunks e consultado por `read_output` ou
`engine_output_read`. Conclusão do turno, exclusão e shutdown cancelam e drenam
todas as sessões antes do evento terminal.

### Imagens

`view_image` é a única ferramenta de inspeção visual de arquivo local. Ela
valida sandbox e cancelamento, decodifica PNG, JPEG, GIF ou WebP, limita arquivo
a 10 MiB, dimensão a 16.384 px e alocação decodificada a 256 MiB. O provider
recebe data URL; a timeline persiste apenas o path canônico e apresenta a
atividade de imagem. O browser não participa desse fluxo.

### Browser Use

O browser mantém até 16 child WebViews no runtime, cada uma vinculada à conversa
proprietária. URLs aceitam apenas HTTP, HTTPS ou `about:blank`, sem credenciais
embutidas. Webviews remotos não recebem IPC, filesystem ou opener.

Automação expõe apenas ações fechadas de aba, viewport, snapshot, screenshot,
ponteiro, texto, teclado, espera e métricas. Não existe comando CDP arbitrário.
Screenshot entra como conteúdo multimodal do tool output. Nova origem exige
`approval.browserOrigin` para a conversa atual.

## Persistência e recuperação

SQLite usa WAL e transações para alterações compostas. Calls sem output deixadas
por interrupção recebem `aborted`; outputs órfãos são removidos. Turnos ativos no
boot são recuperados para estado terminal explícito e comandos antigos nunca são
reativados.

`engine_turn_steer` persiste mensagem e entrada causal na mesma transação. A fila
é promovida apenas depois da resposta que não a observou, preservando ordem mesmo
após queda do processo. Exclusão de tarefa ativa cancela, impede nova aquisição
e só responde após a transação de remoção.

Saídas volumosas ficam em recursos paginados, não no item da timeline. Eventos
ao vivo possuem limites próprios; o item concluído é a barreira autoritativa.

## Automações

Automações possuem versão, timezone, intervalo, próximo disparo e estado. Updates
exigem `expectedVersion`. O scheduler permite no máximo duas execuções globais e
uma por automação; claim, avanço e criação do run são atômicos. Cada run usa uma
tarefa e um turno normais, sem caminho especial no agente.

## Configuração

`AppConfig` é um schema fechado com concorrência otimista. Modelo, esforço e tier
são atualizados juntos; overrides de um turno não alteram o padrão persistido.

Combinações válidas:

- `read-only` + `untrusted`;
- `workspace-write` + `on-request`;
- `danger-full-access` + `never`.

Qualquer outra combinação é rejeitada no Rust e no TypeScript.
