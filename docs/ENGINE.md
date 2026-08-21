# Contrato do engine

## Identidade

O único backend é `NativeEngine`:

- transporte: `httpsSse`;
- provider: `ChatGPT Codex`;
- autenticação: `ChatGPT OAuth`;
- armazenamento: `sqlite`;
- schema IPC: versão `13`.

Não existe variável de ambiente para trocar backend nem execução de binário
genérico. O único sidecar é o `rg.exe` 15.2.0 fixado por manifesto e hash para a
ferramenta `search_text`; ele é chamado por caminho absoluto, sem shell e sem
dependência do `PATH`. A CLI aberta é uma referência de estudo, não uma
integração.

## Comandos Tauri

| Área | Comandos |
| --- | --- |
| lifecycle | `engine_start` |
| diagnóstico | `engine_runtime_diagnostic_report` |
| conta | `engine_account_read`, `engine_account_profile_read`, `engine_account_rate_limits_read`, `engine_login_chatgpt`, `engine_login_cancel`, `engine_logout` |
| tarefas | `engine_thread_start`, `engine_thread_list`, `engine_thread_resume`, `engine_thread_read`, `engine_thread_set_name`, `engine_thread_archive`, `engine_thread_unarchive`, `engine_thread_delete`, `engine_thread_fork` |
| saídas | `engine_output_read` |
| turnos | `engine_turn_start`, `engine_turn_steer`, `engine_turn_interrupt` |
| automações | `engine_automation_list`, `engine_automation_create`, `engine_automation_update`, `engine_automation_delete`, `engine_automation_run_now`, `engine_automation_run_mark_reviewed` |
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
- `model.rerouted`, `model.verification` e `model.safetyBufferingUpdated`;
- `automation.changed`, `automation.deleted` e `automation.runUpdated`.

Qualquer método diferente falha na fronteira TypeScript e gera diagnóstico
visível.

A sincronização Rust↔TypeScript é travada por fixtures golden em
`src/contracts/fixtures/`: `cargo test` falha se o contrato Rust mudar sem
regenerá-los e os testes do Vitest decodificam os mesmos arquivos com os
decoders estritos da interface. Regenere intencionalmente com
`cargo test -p codex-desktop-next regenerate_golden_contract_fixtures -- --ignored`.

`turn.completed` carrega a projeção terminal persistida do turno: `id`,
`status`, `error` e `updatedAt`. O storage produz esses valores na mesma
transação que encerra o turno e atualiza a thread. O frontend aplica a projeção
ao cache visível e limpa o runtime em um único batch, portanto interrupção,
falha e duração não dependem da chegada posterior de `thread.updated`. Essa
notificação posterior apenas reconcilia o snapshot completo de forma
idempotente; uma segunda conclusão conflitante é erro de contrato.

`engine_turn_steer` confirma a entrada somente depois de gravar, na mesma
transação, a mensagem visual em `thread_items` e o payload causal em
`pending_turn_inputs`. O payload não entra em `provider_items` enquanto uma
resposta que não o amostrou ainda está sendo produzida. Antes da rodada seguinte,
o engine promove a fila em ordem para depois da resposta e dos resultados de
ferramenta já persistidos. A decisão de continuar carrega o `sequence` pendente
exato; iniciar a rodada sem promovê-lo é erro de estado, não fallback.

Ao concluir ou interromper um turno, a mesma transação promove qualquer steer
restante antes de gravar o estado terminal. No boot, a recuperação faz essa
promoção antes de marcar turnos abandonados como interrompidos. Portanto uma
queda do processo não perde a entrada nem a reposiciona antes de uma resposta que
foi gerada sem vê-la.

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

O catálogo Codex da sessão é a fonte autoritativa para `context_window`,
`max_context_window`, percentual útil e limite de compactação automática. A
configuração persiste somente a preferência semântica `maximum` por ID de modelo;
`default` é representado pela ausência de override. Ao selecionar o modelo, o
Rust resolve os números atuais do catálogo e recalcula proporcionalmente a janela
útil e o ponto de compactação. Nenhum tamanho ou nome comercial de modelo é
fixado na interface.

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
respostas brutas não são expostos ao frontend. Cookies de infraestrutura
Cloudflare passam por allowlist e por um cookie jar que respeita host, path,
expiração e remoção. Uma página HTML de bloqueio nunca é persistida como mensagem
pública: no transporte Codex ela invalida o estado de borda e recebe tentativas
locais limitadas; se persistir, torna-se uma falha tipada e acionável. O parser
consumer negocia e aplica patches `v1`; o parser Codex aceita apenas os eventos
Responses implementados. Novidades em qualquer protocolo exigem mudança
explícita do contrato.

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
timeouts, HTTP 5xx e rejeições SSE transitórias como `server_error`, com espera
limitada a 60 segundos entre ciclos. Um rate limit preserva `Retry-After` ou
`resets_in_seconds`, aguarda até sete dias por ciclo e consulta novamente; a
ausência de delay usa 60 segundos. Não existe contador local que encerre um turno
apenas por repetição. `server_is_overloaded` permanece uma condição distinta de
alta demanda e é apresentado como aviso recuperável, não como falha grave.
Cancelamento continua imediato, e erro de protocolo/SSE malformado continua
terminal.

Envelopes privados de referência de conteúdo (`U+E200 … U+E201`) pertencem ao
protocolo do provider e nunca ao texto apresentado. A projeção persistida da
timeline remove envelopes completos; durante o streaming, uma cauda ainda sem
delimitador final também fica oculta. Renderização, prévias e cópia aplicam a
mesma fronteira, impedindo que identificadores como `turn0search0` apareçam ao
usuário mesmo ao abrir uma conversa antiga.

`item.completed` é uma barreira autoritativa. Antes de instalar o item
persistido, o frontend descarta qualquer delta daquele item ainda aguardando o
próximo frame; em seguida remove o overlay transitório. Somente IDs presentes no
overlay entram no renderer append-only. A conclusão canônica executa uma
renderização final integral, portanto uma normalização do provider nunca é
tratada como continuação de texto.

## Automações

Automações são registros nativos versionados com nome, prompt, projeto opcional,
estado habilitado, intervalo de 5 minutos a 7 dias, timezone, próximo disparo e
última execução. Atualizações exigem `expectedVersion`; conflitos são visíveis.

O scheduler mantém no máximo duas execuções globais e uma por automação. Claim,
avanço de agenda e criação do run são uma única transação SQLite. Execução manual
é permitida mesmo quando a definição está pausada, mas obedece aos mesmos limites
de concorrência. Não há backfill de todos os intervalos perdidos.

Cada run inicia uma tarefa Codex normal e um turno ligado ao seu ID. Conclusão do
turno e conclusão do run são persistidas na mesma transação. Falha antes do
turno, interrupção, reinício e revisão possuem estados explícitos e eventos
monotônicos. A fila de revisão é apenas uma projeção de runs terminais ainda não
marcados como revisados.

## Compactação dinâmica de contexto

Antes da primeira amostragem e de toda continuação no mesmo turno, o
`NativeEngine` avalia a requisição que realmente será enviada. O contexto ativo
é o maior entre:

- a estimativa atual de instruções, histórico normalizado e ferramentas; e
- o último uso informado pelo servidor para o mesmo modelo, somado aos itens
  locais posteriores à última saída gerada pelo modelo.

A contagem é saturante e mede JSON com um writer de contagem, sem criar buffers
serializados temporários para cada item. A estimativa local reserva 12% de
headroom para diferenças de tokenização e envelopes do provider. A compactação
começa quando o orçamento automático do catálogo ou a janela útil do modelo é
atingido. Não há um limite de rodadas adicional nem uma cota local arbitrária de
tamanho de projeto.

A compactação é exclusivamente automática. Não existe comando IPC, ação de menu
ou turno vazio para iniciá-la manualmente; o mesmo caminho transacional é
acionado somente pela política de contexto ou pela recuperação de
`context_length_exceeded`.

O protocolo é Responses Remote Compaction V2. O motor envia
`compaction_trigger`, exige exatamente um checkpoint `compaction` criptografado
e só então instala, em uma transação SQLite, as mensagens recentes retidas, o
checkpoint e o item concluído da timeline. A cópia enviada ao provider pode
reduzir saídas de ferramenta da mais recente para a mais antiga, mesmo quando
existem itens de mensagem ou raciocínio entre elas, até a requisição caber no
menor limite aplicável. O histórico durável não é alterado antes do checkpoint
válido.

Um `context_length_exceeded` inesperado em uma amostragem comum é preservado
como `ContextWindowExceeded`, mas primeiro aciona uma recuperação única dentro
do mesmo turno: o motor compacta, recarrega o histórico instalado e repete a
amostragem ativa. Uma resposta concluída libera uma nova recuperação futura. Se
a própria compactação exceder a janela ou a amostragem falhar novamente sem
qualquer resposta concluída, o erro se torna terminal e uma medição de janela
cheia é persistida. O frontend somente apresenta os eventos e o estado
persistido; política, recuperação e atomicidade pertencem integralmente ao Rust.

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
`timeout_seconds`; o agente escolhe o orçamento pelo pior caso esperado do
comando, usa `null` para o padrão seguro de uma hora e pode solicitar até sete
dias, sempre com cancelamento. A timeline não mostra cronômetro para operações
curtas; após dez segundos, comandos ativos exibem duração atualizada a cada
segundo e preservam a duração terminal.
`stdout` e `stderr` são drenados concorrentemente para arquivos temporários,
normalizados em streaming e persistidos em blocos UTF-8 de 64 KiB, sem corte de
tamanho agregado imposto pelo aplicativo. O item do turno contém somente ID,
prévia, tamanho total e cursor; UI e agente continuam por `engine_output_read` e
`read_output`. Recusa de comando retorna um resultado tipado ao modelo;
cancelamento interrompe o turno.

`search_text` usa o `ripgrep` embarcado com correspondência literal,
sensibilidade de caixa explícita, regras `.gitignore`, leitura incremental,
limite global de resultados, timeout e cancelamento. O binário é validado no
bootstrap, no build e novamente no runtime.

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
