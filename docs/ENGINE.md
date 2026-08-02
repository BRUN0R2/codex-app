# Contrato do engine

## Identidade

O único backend é `NativeEngine`:

- transporte: `httpsSse`;
- provider: `ChatGPT Codex`;
- autenticação: `ChatGPT OAuth`;
- armazenamento: `sqlite`;
- schema IPC: versão `1`.

Não existe variável de ambiente para trocar backend nem execução de binário
externo. A CLI aberta é uma referência de estudo, não uma integração.

## Comandos Tauri

| Área | Comandos |
| --- | --- |
| lifecycle | `engine_start` |
| conta | `engine_account_read`, `engine_account_rate_limits_read`, `engine_login_chatgpt`, `engine_login_cancel`, `engine_logout` |
| tarefas | `engine_thread_start`, `engine_thread_list`, `engine_thread_resume`, `engine_thread_read`, `engine_thread_set_name`, `engine_thread_archive`, `engine_thread_unarchive`, `engine_thread_delete`, `engine_thread_fork`, `engine_thread_compact_start` |
| turnos | `engine_turn_start`, `engine_turn_steer`, `engine_turn_interrupt` |
| projeto | `workspace_repository_read` |
| configuração | `engine_config_read`, `engine_config_update`, `engine_model_list` |
| aprovação | `engine_server_request_respond` |
| anexos | `attachment_inspect`, `attachment_save_pasted_image` |

Cada comando tem request e response próprios. Não há método genérico que aceite
nome de RPC ou JSON arbitrário.

## Eventos

Quatro canais Tauri possuem payloads fechados:

- `engine://runtime-status`: `starting`, `ready`, `failed` ou `stopped`;
- `engine://runtime-diagnostic`: falhas operacionais não ocultáveis;
- `engine://notification`: autenticação, tarefas, turnos, itens e deltas;
- `engine://server-request`: somente `approval.command`.

Notificações suportadas:

- `auth.loginCompleted`, `auth.sessionChanged`;
- `thread.created`, `thread.updated`, `thread.archived`, `thread.unarchived`,
  `thread.deleted`;
- `turn.started`, `turn.completed`;
- `item.started`, `item.completed`, `item.agentTextDelta`;
- `item.reasoningSummaryDelta`, `item.reasoningTextDelta`;
- `model.rerouted`, `model.verification`, `model.safetyBufferingUpdated` e
  `turn.moderationMetadata`.

Qualquer método diferente falha na fronteira TypeScript e gera diagnóstico
visível.

## Provider

O backend usa a sessão OAuth diretamente para:

- catálogo em `https://chatgpt.com/backend-api/codex/models`;
- respostas em `https://chatgpt.com/backend-api/codex/responses`;
- uso em `https://chatgpt.com/backend-api/wham/usage`.

Headers de conta e sessão são montados somente no Rust. Tokens, cookies e
respostas brutas não são expostos ao frontend. O parser aceita apenas a forma de
catálogo e os eventos SSE implementados; novidades de protocolo exigem mudança
explícita do contrato.

Antes de cada requisição, o histórico garante a mesma invariável do Desktop
oficial: toda chamada de ferramenta possui exatamente uma saída compatível e
toda saída possui uma chamada. Uma interrupção que deixou uma chamada pendente
recebe a saída explícita `aborted`; saídas órfãs são removidas. Qualquer correção
é regravada em uma única transação e publicada nos diagnósticos de runtime.

## Ferramentas e permissão

| Ferramenta | Somente leitura | Projeto | Acesso total |
| --- | ---: | ---: | ---: |
| `read_file`, `list_files`, `search_text` | sim | sim | sim |
| `edit_file`, `write_file` | não | sim | sim |
| `exec_command` | não | aprovação | sem aprovação |

Todos os paths de ferramenta são relativos ao workspace. Escritas são atômicas,
arquivos são UTF-8 e comandos são não interativos, limitados a 120 segundos e a
1 MiB de saída agregada. Recusa de comando retorna um resultado tipado ao modelo;
cancelamento interrompe o turno.

## Configuração

`AppConfig` é um schema fechado armazenado no SQLite. Toda escrita envia a
versão lida; conflito retorna erro em vez de sobrescrever uma alteração
concorrente. Modelo, esforço e tier pertencem a uma única mutação
`modelDefaults`, evitando configurações intermediárias incoerentes.
O compositor pode selecionar esses três valores para um único turno sem alterar
a configuração. O tier enviado é sempre uma escolha fechada entre o padrão do
modelo e um identificador anunciado pelo catálogo.

Os três perfis válidos são:

- `read-only` + `untrusted`;
- `workspace-write` + `on-request`;
- `danger-full-access` + `never`.

Nenhuma outra combinação é aceita no Rust ou no TypeScript.
