# Contrato do engine

## Identidade

O único backend é `NativeEngine`:

- transporte: `httpsSse`;
- provider: `ChatGPT Codex`;
- autenticação: `ChatGPT OAuth`;
- armazenamento: `sqlite`;
- schema IPC: versão `9`.

Não existe variável de ambiente para trocar backend nem execução de binário
externo. A CLI aberta é uma referência de estudo, não uma integração.

## Comandos Tauri

| Área | Comandos |
| --- | --- |
| lifecycle | `engine_start` |
| diagnóstico | `engine_runtime_diagnostic_report` |
| conta | `engine_account_read`, `engine_account_profile_read`, `engine_account_rate_limits_read`, `engine_login_chatgpt`, `engine_login_cancel`, `engine_logout` |
| tarefas | `engine_thread_start`, `engine_thread_list`, `engine_thread_resume`, `engine_thread_read`, `engine_thread_set_name`, `engine_thread_archive`, `engine_thread_unarchive`, `engine_thread_delete`, `engine_thread_fork`, `engine_thread_compact_start` |
| saídas | `engine_output_read` |
| turnos | `engine_turn_start`, `engine_turn_steer`, `engine_turn_interrupt` |
| preferências | `application_preferences_read`, `application_preferences_update` |
| configuração | `engine_config_update`, `engine_model_list`, `engine_chat_model_list` |
| aprovação | `engine_server_request_respond` |
| anexos | `attachment_inspect`, `attachment_read_image`, `attachment_save_pasted_image` |

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
- `item.started`, `item.completed`, `item.streamDeltas`;
- `model.rerouted`, `model.verification` e `model.safetyBufferingUpdated`.

Qualquer método diferente falha na fronteira TypeScript e gera diagnóstico
visível.

`turn.completed` carrega a projeção terminal persistida do turno: `id`,
`status`, `error` e `updatedAt`. O storage produz esses valores na mesma
transação que encerra o turno e atualiza a thread. O frontend aplica a projeção
ao cache visível e limpa o runtime em um único batch, portanto interrupção,
falha e duração não dependem da chegada posterior de `thread.updated`. Essa
notificação posterior apenas reconcilia o snapshot completo de forma
idempotente; uma segunda conclusão conflitante é erro de contrato.

`engine_thread_delete` também é a operação completa para tarefas ativas. O motor
registra um único solicitante, cancela o turno, impede nova aquisição do mesmo
`thread_id` e responde somente depois da exclusão transacional. Se a persistência
da conclusão falhar, a exclusão exige a identidade exata do turno que ainda está
ativo; nenhum estado informado pela interface autoriza esse caminho.

## Boot resiliente

No Rust, cada operação do cofre de
credenciais (Credential Manager do Windows e decrypt scrypt/age) tem limite de
10 segundos no `spawn_blocking`; estouro vira erro tratável de storage, sem
apagar credenciais. No frontend, o registro de eventos tem limite de 15 segundos,
`engine_start` tem 120 segundos e `engine_account_read` tem 45 segundos. Falhas
transitórias são repetidas indefinidamente com backoff de 1 a 60 segundos,
inclusive sem intervenção do usuário; a tela continua oferecendo uma tentativa
manual imediata. Erros permanentes de contrato e storage param com causa
explícita. Eventos e respostas atrasados usam uma revisão de inicialização e não
podem trocar o estado de uma tentativa mais nova.

Uma resposta bem-sucedida de `engine_start` é a confirmação autoritativa de
`ready` e inclui `diagnosticLogPath` e a configuração versionada. O frontend não
depende de uma segunda entrega assíncrona nem de um comando de leitura separado
para concluir o boot. Erros de interface posteriores usam
`engine_runtime_diagnostic_report`, cujo payload é fechado e limitado, para
persistir a mesma causa no log nativo.

## Providers

O backend usa a mesma sessão OAuth da conta ChatGPT diretamente, sem solicitar
uma chave da API Platform. Os dois protocolos são separados antes de qualquer
seleção de modelo ou amostragem.

Para Chat consumidor:

- catálogo em `https://chatgpt.com/backend-api/models?iim=false&include_icons=false`;
- requisitos de integridade em `/backend-api/sentinel/chat-requirements/prepare`;
- preparação opcional e conduit em `/backend-api/f/conversation/prepare`;
- conversa e deltas `v1` em `/backend-api/f/conversation`;
- seleção por preset do catálogo, resolvido em `model` e `thinking_effort`.

A preparação consumer continua opcional conforme o protocolo, mas sua falha não
é silenciosa: o cliente produz um `Result`, grava um diagnóstico persistente do
subsistema provider e só então continua com `client_prepare_state: "failure"` e
sem conduit token.

Para Work local e Codex:

- catálogo em `https://chatgpt.com/backend-api/codex/models`;
- respostas em `https://chatgpt.com/backend-api/codex/responses`;
- perfil em `https://chatgpt.com/backend-api/wham/profiles/me`;
- uso em `https://chatgpt.com/backend-api/wham/usage`.

O perfil segue o fluxo do Desktop oficial: `display_name` e
`profile_picture_url` são buscados depois que a conta local já foi apresentada.
A chamada tem deadline próprio de cinco segundos, não participa do caminho de
boot e fica válida por seis horas. Respostas de uma sessão substituída são
descartadas; URL ausente ou imagem que falha mantém as iniciais. A ausência de
foto no token OIDC não aciona `userinfo` nem atrasa a inicialização.

O uso segue uma política separada e não possui polling permanente: o valor fica
válido por cinco minutos e é revalidado, quando obsoleto, ao recuperar foco ou
visibilidade, ao abrir a tela e depois da conclusão de um turno. Há uma única
chamada em voo por revisão de sessão, e respostas de conta antiga nunca
atualizam a interface.

Headers de conta e sessão são montados somente no Rust. Tokens, cookies e
respostas brutas não são expostos ao frontend. O parser consumer negocia e
aplica patches `v1`; o parser Codex aceita apenas os eventos Responses
implementados. Novidades em qualquer protocolo exigem mudança explícita do
contrato.

Antes de cada requisição, o histórico garante a mesma invariável do Desktop
oficial: toda chamada de ferramenta possui exatamente uma saída compatível e
toda saída possui uma chamada. Uma interrupção que deixou uma chamada pendente
recebe a saída explícita `aborted`; saídas órfãs são removidas. Qualquer correção
é regravada em uma única transação e publicada nos diagnósticos de runtime.

Chunks SSE sem evento decodificado são apenas atividade de transporte. O
deadline de stream é calculado para o próximo evento semântico e não é reiniciado
por heartbeats. Quando uma rodada devolve chamadas consecutivas de ferramentas
somente leitura, o agente pode executar até oito em paralelo e persiste os
resultados na ordem original; qualquer ferramenta mutável cria uma barreira.

Uma requisição HTTP transitória possui tentativas rápidas locais com backoff
exponencial; se ainda falhar, o loop do turno continua retomando transporte,
timeouts e HTTP 5xx com espera limitada a 60 segundos entre ciclos. Um rate limit
preserva `Retry-After` ou `resets_in_seconds`, aguarda até sete dias por ciclo e
consulta novamente; a ausência de delay usa 60 segundos. Não existe contador
local que encerre um turno apenas por repetição. Cancelamento continua imediato,
e erro de protocolo/SSE malformado continua terminal.

Envelopes privados de referência de conteúdo (`U+E200 … U+E201`) pertencem ao
protocolo do provider e nunca ao texto apresentado. A projeção persistida da
timeline remove envelopes completos; durante o streaming, uma cauda ainda sem
delimitador final também fica oculta. Renderização, prévias e cópia aplicam a
mesma fronteira, impedindo que identificadores como `turn0search0` apareçam ao
usuário mesmo ao abrir uma conversa antiga.

## Compactação dinâmica de contexto

Antes da primeira amostragem e de toda continuação no mesmo turno, o
`NativeEngine` avalia a requisição que realmente será enviada. O contexto ativo
é o maior entre:

- a estimativa atual de instruções, histórico normalizado e ferramentas; e
- o último uso informado pelo servidor para o mesmo modelo, somado aos itens
  locais posteriores à última saída gerada pelo modelo.

A contagem é saturante e mede JSON com um writer de contagem, sem criar buffers
serializados temporários para cada item. A compactação começa quando o orçamento
automático do catálogo ou a janela útil do modelo é atingido. Não há um limite
de rodadas adicional nem uma cota local arbitrária de tamanho de projeto.

O protocolo é Responses Remote Compaction V2. O motor envia
`compaction_trigger`, exige exatamente um checkpoint `compaction` criptografado
e só então instala, em uma transação SQLite, as mensagens recentes retidas, o
checkpoint e o item concluído da timeline. A cópia enviada ao provider pode
reduzir apenas o sufixo contíguo de saídas de ferramenta quando ele sozinho
impede a requisição de caber; o histórico durável não é alterado antes do
checkpoint válido.

Um `context_length_exceeded` inesperado em uma amostragem comum é preservado
como `ContextWindowExceeded`. O turno atual falha de forma visível e uma medição
de janela cheia é persistida. Na próxima submissão, o preflight compacta antes
de chamar o modelo. A ação recusada nunca é repetida silenciosamente no mesmo
turno. O frontend somente apresenta os eventos e o estado persistido; política,
recuperação e atomicidade pertencem integralmente ao Rust.

## Ferramentas e permissão

| Ferramenta | Somente leitura | Projeto | Acesso total |
| --- | ---: | ---: | ---: |
| `read_file`, `list_files`, `search_text` | sim | sim | sim |
| `read_output` | sim | sim | sim |
| `edit_file`, `write_file` | não | sim | sim |
| `apply_patch` | não | sim | sim |
| `exec_command` | não | aprovação | sem aprovação |

Todos os paths de ferramenta são relativos ao workspace. Escritas são atômicas,
arquivos são UTF-8 e comandos são não interativos. Cada chamada pode declarar
`timeout_seconds`; o padrão é uma hora e o máximo é sete dias, sempre
cancelável.
`stdout` e `stderr` são drenados concorrentemente para arquivos temporários,
normalizados em streaming e persistidos em blocos UTF-8 de 64 KiB, sem corte de
tamanho agregado imposto pelo aplicativo. O item do turno contém somente ID,
prévia, tamanho total e cursor; UI e agente continuam por `engine_output_read` e
`read_output`. Recusa de comando retorna um resultado tipado ao modelo;
cancelamento interrompe o turno.

Erros de validação ou execução de uma ferramenta pertencem à chamada, não ao
turno inteiro. Um plano com mais de uma etapa `in_progress`, um patch malformado
ou um comando com exit code diferente de zero gera item `failed`, saída tipada
para o provider e diagnóstico operacional; o agente pode corrigir a entrada na
rodada seguinte. Cancelamento explícito continua sendo terminal.

Processos recebem `NO_COLOR=1`, `CLICOLOR=0`, `FORCE_COLOR=0` e `TERM=dumb`. No
Windows, todo processo iniciado pelo engine usa `CREATE_NO_WINDOW`; o PowerShell
também configura entrada, saída e `$OutputEncoding` como UTF-8 sem BOM. A sessão
define `Start-Process` como oculta e bloqueante por padrão, portanto validações
que criam um processo filho não abrem um console separado nem escapam do
lifetime limitado do comando. Processos destacados e janelas externas não fazem
parte do contrato de `exec_command`. Mesmo quando uma ferramenta ignora o modo
sem cor, o engine remove sequências ANSI e normaliza controles de terminal antes
de persistir ou publicar a saída.

A fila de mensagens posteriores não possui limite local de quantidade. Ela é
persistida por conversa em schema versionado antes de aceitar o enqueue,
restaurada após reinício e despachada automaticamente quando o turno fica ocioso.
Uma entrada corrompida não impede a recuperação das demais filas. O limite de
quota do armazenamento do WebView permanece uma restrição externa e produz erro
visível; não causa descarte silencioso.

`apply_patch` é uma ferramenta freeform do Responses, anunciada com gramática
Lark fechada e respondida por `custom_tool_call_output`; ela não passa por shell,
PowerShell, `git apply` ou executável auxiliar. O parser aceita somente o envelope
canônico e hunks add/delete/update/move. Antes do primeiro write, o planejador
resolve todos os paths, rejeita escapes, symlinks, duplicidades e sobreposições,
aplica todos os chunks em memória e fotografa conteúdo, permissões e SHA-256.

O commit prepara e sincroniza todos os temporários, revalida cada fotografia e
só então troca os arquivos. Cancelamento, concorrência ou falha intermediária
acionam o journal inverso; qualquer falha de restauração vira erro explícito de
integridade com os paths afetados. A timeline recebe um único `FileChange` com
as alterações canônicas somente após o commit completo.

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
