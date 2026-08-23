# Contrato do engine

## Identidade

O único backend é `NativeEngine`:

- transporte: `httpsSse`;
- provider: `ChatGPT Codex`;
- autenticação: `ChatGPT OAuth`;
- armazenamento: `sqlite`;
- schema IPC: versão `18`.

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
| conta | `engine_account_read`, `engine_account_profile_read`, `engine_account_rate_limits_read`, `engine_account_usage_resets_read`, `engine_account_usage_reset_redeem`, `engine_account_auto_top_up_read`, `engine_account_auto_top_up_enable`, `engine_account_auto_top_up_update`, `engine_account_auto_top_up_disable`, `engine_login_chatgpt`, `engine_login_cancel`, `engine_logout` |
| tarefas | `engine_thread_start`, `engine_thread_list`, `engine_thread_resume`, `engine_thread_read`, `engine_thread_set_name`, `engine_thread_archive`, `engine_thread_unarchive`, `engine_thread_delete`, `engine_thread_fork` |
| saídas | `engine_output_read` |
| turnos | `engine_turn_start`, `engine_turn_steer`, `engine_turn_interrupt` |
| automações | `engine_automation_list`, `engine_automation_create`, `engine_automation_update`, `engine_automation_delete`, `engine_automation_run_now`, `engine_automation_run_mark_reviewed` |
| preferências | `application_preferences_read`, `application_preferences_update` |
| integração desktop | `application_workspace_open` |
| navegador interno | `browser_tab_create`, `browser_tab_navigate`, `browser_tab_back`, `browser_tab_forward`, `browser_tab_reload`, `browser_tab_close`, `browser_surface_sync` |
| configuração | `engine_config_update`, `engine_model_list`, `engine_chat_model_list` |
| aprovação | `engine_server_request_respond` |
| anexos | `attachment_inspect`, `attachment_read_image`, `attachment_save_pasted_image` |

Cada comando tem request e response próprios. Não há método genérico que aceite
nome de RPC ou JSON arbitrário.

`application_workspace_open` canonicaliza o path, exige que seja absoluto,
existente e diretório, e somente então usa a API Rust do opener. O WebView não
possui `opener:allow-open-path`, portanto não pode abrir arquivos ou caminhos
arbitrários diretamente.

## Eventos

Seis canais Tauri possuem payloads fechados:

- `engine://runtime-status`: `starting`, `ready`, `failed` ou `stopped`;
- `engine://runtime-diagnostic`: falhas operacionais não ocultáveis;
- `engine://notification`: autenticação, tarefas, turnos, itens e deltas;
- `engine://server-request`: somente `approval.command`.
- `browser://state`: snapshot estrito da aba após navegação, carregamento ou
  mudança de título;
- `browser://new-window`: URL HTTP(S) validada que deve virar uma nova aba
  controlada, nunca uma janela remota autônoma.

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

O navegador usa child webviews nativos, limitados a dezesseis abas e vinculados
à conversa proprietária. URLs aceitam somente `http`, `https` ou `about:blank`,
sem credenciais embutidas; bounds devem ser finitos e respeitar a superfície
mínima/máxima. A capability Tauri autoriza somente o webview local `main`.
Webviews remotos não recebem comandos IPC, permissões de arquivo ou opener. A
sincronização de bounds oculta todas as abas inativas antes de mostrar a aba
selecionada. Os sete comandos são assíncronos: `add_child`, navegação, bounds,
visibilidade e fechamento são despachados fora do handler principal, e eventos
de página/título são emitidos somente depois que o callback WebView2 retorna.

A versão IPC 15 adiciona saída transitória de comandos ao
`item.streamDeltas`. Cada delta identifica `stdout` ou `stderr` e carrega uma
operação fechada: `append`, `backspace`, `clearCurrentLine` ou `truncated`.
`CommandExecution.liveOutput` existe somente enquanto o item está ativo e volta
a `null` na projeção terminal. Frames append são limitados a 8 KiB e a soma
visível dos dois streams a 256 KiB; o recurso persistido continua integral.

A versão IPC 16 adiciona `ToolExecution.outputPresentation`. O backend define
explicitamente `sourceFile { path }`, `searchResults`, `fileList` ou `plainText`;
a UI nunca extrai path da descrição nem tenta adivinhar linguagem pelo conteúdo.
Dados internos anteriores recebem `plainText` durante a desserialização e voltam
ao frontend com o campo explícito.

A versão IPC 17 adiciona estatísticas explícitas de diff, o perfil analítico da
conta, preço do plano, créditos de redefinição e configuração de recarga
automática. Todos os campos atravessam decoders fechados, com limites e nulidade
declarados; indisponibilidade parcial de estatísticas permanece um estado do
contrato, não um payload alternativo inferido pela interface.

A versão IPC 18 adiciona a apresentação `image` para resultados de ferramenta.
O payload continua armazenado como recurso paginado, mas a interface valida o
envelope `{ image_url }` e renderiza uma prévia segura em vez de expor a data URL
como texto. Registros anteriores de `view_image` com `plainText` recebem a mesma
apresentação por uma migração determinística baseada no nome fechado da
ferramenta, nunca por heurística sobre a descrição ou o conteúdo.

A sincronização Rust↔TypeScript é travada por fixtures golden em
`src/contracts/fixtures/`: `cargo test` falha se o contrato Rust mudar sem
regenerá-los e os testes do Vitest decodificam os mesmos arquivos com os
decoders estritos da interface. Regenere intencionalmente com
`cargo test --locked --manifest-path src-tauri/Cargo.toml
engine::contracts_fixtures::tests::regenerate_golden_contract_fixtures --
--ignored`.

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
- uso em `https://chatgpt.com/backend-api/wham/usage`;
- redefinições em `/backend-api/wham/rate-limit-reset-credits` e
  `/backend-api/wham/rate-limit-reset-credits/consume`;
- recarga automática em `/backend-api/subscriptions/auto_top_up/*`;
- moeda e preço localizado em `/backend-api/accounts/check/v4-2023-04-27` e
  `/backend-api/checkout_pricing_config/configs/{country_code}`.

O catálogo Codex da sessão é a fonte autoritativa para `context_window`,
`max_context_window`, percentual útil e limite de compactação automática. A
configuração persiste somente a preferência semântica `maximum` por ID de modelo;
`default` é representado pela ausência de override. Ao selecionar o modelo, o
Rust resolve os números atuais do catálogo e recalcula proporcionalmente a janela
útil e o ponto de compactação. Nenhum tamanho ou nome comercial de modelo é
fixado na interface.

O perfil segue o fluxo do Desktop oficial. `GET /wham/profiles/me` fornece
`display_name`, `username`, `profile_picture_url`, resumo vitalício, buckets
diários, insights e invocações de plugins/skills. O wire remoto é privado ao
módulo `auth/profile.rs`; antes do IPC, o Rust valida limites, percentuais,
datas ISO, cardinalidade e overflow, agrega buckets duplicados pela data e
produz uniões discriminadas próprias. Variantes de plugin/skill usam
`rename_all_fields = "camelCase"` na fronteira IPC, garantindo `usageCount` e
`pluginName` em vez dos nomes internos Rust. `metadata.stats_error` vira o
estado explícito `unavailable`, preservando a identidade sem inventar
estatísticas.

A chamada tem deadline próprio de cinco segundos, não participa do caminho de
boot e fica válida por seis horas por identidade de sessão. Respostas de uma
sessão substituída são descartadas; URL ausente ou imagem que falha mantém as
iniciais. Uma nova revisão da conta limpa a falha visual anterior e permite
tentar novamente a mesma URL; a foto oficial aplicada pelo perfil atualiza
página, menu e sidebar pelo mesmo estado. A ausência de foto no token OIDC não
aciona `userinfo` nem atrasa a inicialização. A UI deriva localmente somente as
projeções diária, semanal e acumulada da janela fixa de 52 semanas; totais e
insights continuam autoritativos da conta e nunca são estimados pelo histórico
SQLite local.

O uso segue uma política separada e não possui polling permanente: o valor fica
válido por cinco minutos e é revalidado, quando obsoleto, ao recuperar foco ou
visibilidade, ao abrir a tela e depois da conclusão de um turno. Há uma única
chamada em voo por revisão de sessão, e respostas de conta antiga nunca
atualizam a interface.

Redefinições e recarga automática são consultadas separadamente para que uma
indisponibilidade de cobrança não esconda os limites já carregados. O consumo de
reset exige confirmação na UI e um `redeem_request_id` estável; `reset` e
`already_redeemed` são resultados idempotentes e provocam nova leitura dos
limites. A recarga valida inteiros, mínimo de 125 créditos, diferença mínima de
125 entre gatilho e alvo, alvo máximo de 250.000 e limite mensal não inferior ao
alvo. Respostas `failed` ou `payment_declined` permanecem falhas visíveis.

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
| `poll_command` | sim | sim | sim |

As definições são construídas uma vez em `OnceLock` e codificadas por perfil,
sem remontar ou clonar o catálogo a cada rodada. O perfil somente leitura não
anuncia `edit_file`, `write_file`, `apply_patch` nem `exec_command`, capacidades
que seriam rejeitadas de qualquer forma. Chamadas puras idênticas dentro do
mesmo trecho consecutivo de leitura possuem uma líder canônica: a execução, a
saída persistida e o payload volumoso ocorrem uma vez; duplicatas recebem apenas
uma referência curta ao `call_id` líder. Qualquer comando ou mutação encerra o
domínio de deduplicação, e operações com efeito nunca são coalescidas.

Todos os paths de ferramenta são relativos ao workspace. Escritas são atômicas,
arquivos são UTF-8 e comandos são não interativos. O engine não possui uma
bifurcação funcional para token médio ou elevado: parser, busca, contratos e
renderização são idênticos. Quando iniciado como administrador, processos filhos
apenas herdam o token alto, ampliando o impacto permitido pelo Windows; isso não
muda a gramática nem o comportamento do ripgrep. Cada chamada pode declarar
`timeout_seconds`; o agente escolhe o orçamento pelo pior caso esperado do
comando, usa `null` para o padrão seguro de uma hora e pode solicitar até sete
dias, sempre com cancelamento. Cada comando também declara `parallel_safe`: o
valor só pode ser `true` quando não há dependência de saída nem mutação de
arquivos ou configuração compartilhados. O motor limita lotes a oito operações
consecutivas, sobrepõe sempre as leituras e só sobrepõe comandos em
`danger-full-access` com aprovação `never`; qualquer mutação, aprovação ou
comando exclusivo funciona como barreira. Itens começam juntos, mas resultados
e saídas para o provider são persistidos deterministicamente na ordem original
das chamadas. A timeline não mostra cronômetro para operações
curtas; após dez segundos, comandos ativos exibem duração atualizada a cada
segundo e preservam a duração terminal.

`yield_time_ms` controla por quanto tempo `exec_command` aguarda a conclusão em
primeiro plano. O padrão é dez segundos e o intervalo fechado permitido é de
250 ms a 30 s. Se o processo ultrapassa esse prazo, a chamada retorna
`session_id`, `cursor`, tempo decorrido e o snapshot disponível, enquanto o
processo continua sob ownership do `NativeEngine`. O item permanece
`inProgress`, continua recebendo `stdout`/`stderr` em tempo real e o agente pode
executar trabalho independente antes de consultar a sessão novamente.

`poll_command` aceita somente uma sessão pertencente à própria tarefa, um cursor
opcional e espera de zero a 300 segundos. Consultas da mesma sessão são
serializadas; sessões diferentes continuam independentes. O manager mantém no
máximo 32 sessões, remove primeiro a terminal mais antiga e nunca abandona um
processo ativo para abrir espaço. Um cursor append-only recebe apenas o delta
posterior; se o terminal reescreveu conteúdo com backspace, carriage return ou
limpeza de linha, a resposta muda explicitamente para `output_mode: snapshot`.
Cursores futuros são rejeitados. Checkpoints são limitados, o transcript ao vivo
retém no máximo 256 KiB por stream e o spool integral em disco continua sendo a
fonte autoritativa após a conclusão.

Uma licença RAII acompanha cada sessão entregue ao agente. Persistir o item
consome a licença por `commit`; qualquer retorno antecipado, cancelamento ou
falha antes disso executa `discard`, cancela a árvore e libera o finalizador.
Depois do commit, conclusão, timeout e cancelamento atualizam o mesmo
`CommandExecution` e seu `ThreadOutput` em uma única transação SQLite. O evento
terminal só é publicado depois da drenagem dos dois pipes. Exclusão da tarefa e
encerramento cancelam e drenam suas sessões; fork é recusado enquanto existir
comando ativo. Na inicialização, qualquer item de atividade que um processo
anterior deixou `inProgress` é marcado como falha explícita.

`stdout` e `stderr` são drenados concorrentemente para arquivos temporários,
normalizados incrementalmente e persistidos em blocos UTF-8 de 64 KiB, sem corte
de tamanho agregado imposto pelo aplicativo. As mesmas operações normalizadas
alimentam a prévia ao vivo limitada; todos os lotes são emitidos antes do item
terminal, inclusive em falha, timeout ou cancelamento. O item concluído contém
somente ID, prévia, tamanho total e cursor; UI e agente continuam por
`engine_output_read` e `read_output`. Recusa de comando retorna um resultado
tipado ao modelo; cancelamento interrompe o turno.

`read_output` possui dois caminhos mutuamente exclusivos. `query: null` lê a
página bruta indicada por `cursor`; uma `query` textual exige `cursor: null` e
procura o fragmento exato diretamente nos chunks persistidos, retornando no
máximo doze linhas distintas com excertos UTF-8 limitados. A busca preserva
matches que atravessam a fronteira entre chunks, informa truncamento e continua
restrita à tarefa proprietária do recurso. Não existe fallback implícito entre
busca e paginação.

Comandos concluídos com sucesso passam por um classificador determinístico de
linhas antes do próximo request. Progresso repetitivo de build e linhas de
sucesso de testes Rust/JavaScript podem ser substituídos por contagens tipadas,
mantendo diagnósticos, summaries e amostras representativas. A transformação só
é aceita quando reconhece pelo menos oito linhas e reduz materialmente a saída.
Comandos com falha e formatos desconhecidos conservam o caminho lossless
anterior; o recurso integral permanece recuperável em todos os casos.

Arquivos escolhidos e imagens coladas são copiados atomicamente para
`app_local_data_dir/attachments/<uuid>/` antes de entrarem em rascunhos, filas ou
turnos. O histórico aponta para esse snapshot imutável, não para o arquivo
externo original. Históricos antigos cujo arquivo já desapareceu degradam apenas
a miniatura correspondente; o restante do turno continua renderizável.

`search_text` usa o `ripgrep` embarcado com correspondência literal,
sensibilidade de caixa explícita, regras `.gitignore`, leitura incremental,
limite global de resultados, timeout e cancelamento. Consultas com quebra de
linha ativam `--multiline` e são enviadas como duas variantes literais
normalizadas, LF e CRLF; portanto o mesmo fragmento funciona nos dois formatos
sem regex ou fallback heurístico. O binário é validado no bootstrap, no build e
novamente no runtime.

Erros de validação ou execução de uma ferramenta pertencem à chamada, não ao
turno inteiro. Um plano com mais de uma etapa `in_progress`, um patch malformado
ou um comando com exit code diferente de zero gera item `failed`, saída tipada
para o provider e diagnóstico operacional; o agente pode corrigir a entrada na
rodada seguinte. Cancelamento explícito continua sendo terminal.

Processos recebem `NO_COLOR=1`, `CLICOLOR=0`, `FORCE_COLOR=0` e `TERM=dumb`. No
Windows, todo processo iniciado pelo engine usa `CREATE_NO_WINDOW`; o shell é
PowerShell 7 (`pwsh`) e configura entrada, saída, `$OutputEncoding` e parâmetros
de `Encoding` dos cmdlets como UTF-8 sem BOM. A sessão também ativa o modo UTF-8
do Python e define `Start-Process` como oculto e bloqueante por padrão, portanto
validações que criam um processo filho não abrem um console separado nem escapam
do lifetime limitado do comando. Processos destacados e janelas externas não
fazem parte do contrato de `exec_command`. Mesmo quando uma ferramenta ignora o
modo sem cor, o engine remove sequências ANSI e normaliza controles de terminal
antes de persistir ou publicar a saída. Bytes visíveis fora de UTF-8 são
rejeitados com erro explícito; nunca são convertidos silenciosamente em `�`.

O build Windows contém exatamente um manifesto de aplicação. `build.rs` pede ao
`tauri-build` que gere ícone e metadados sem seu manifesto embutido e fornece ao
linker um único manifesto com Common Controls v6. Assim, harnesses que passam a
alcançar APIs de diálogo carregam `TaskDialogIndirect`, enquanto o executável
Tauri não recebe dois recursos `MANIFEST`. O nível de execução continua
`asInvoker`: iniciar o aplicativo elevado apenas faz os filhos herdarem o token
alto; não altera parser, busca, streaming ou ciclo das ferramentas.

A fila de mensagens posteriores não possui limite local de quantidade. Ela é
persistida por conversa em schema versionado antes de aceitar o enqueue,
restaurada após reinício e despachada automaticamente quando o turno fica ocioso.
Uma entrada corrompida não impede a recuperação das demais filas. O limite de
quota do armazenamento do WebView permanece uma restrição externa e produz erro
visível; não causa descarte silencioso.

`apply_patch` é uma ferramenta freeform do Responses, anunciada com gramática
Lark fechada e respondida por `custom_tool_call_output`; ela não passa por shell,
PowerShell, `git apply` ou executável auxiliar. A gramática exige que cada bloco
`@@` contenha pelo menos uma linha `+` ou `-`, impedindo que o modelo gere
separadores de contexto vazios. A descrição da ferramenta explicita que `@@`
somente abre um bloco e nunca funciona como delimitador de fechamento; append
mantém contexto e adições no mesmo bloco. O parser aplica a mesma invariável em
runtime, distingue bloco vazio de bloco contendo apenas contexto e retorna linha
exata mais uma correção acionável, sem aceitar silenciosamente um patch
malformado. O envelope permitido continua restrito a hunks
add/delete/update/move. Antes do primeiro write, o planejador
resolve todos os paths, rejeita escapes, symlinks, duplicidades e sobreposições,
aplica todos os chunks em memória e fotografa conteúdo, permissões e SHA-256.

O commit prepara e sincroniza todos os temporários, revalida cada fotografia e
só então troca os arquivos. Cancelamento, concorrência ou falha intermediária
acionam o journal inverso; qualquer falha de restauração vira erro explícito de
integridade com os paths afetados. A timeline recebe um único `FileChange` com
as alterações canônicas somente após o commit completo. Add, update e delete
preservam a semântica de cada linha; exclusões textuais geram unified diff
canônico a partir do snapshot original. `lineStats` é calculado antes do limite
de 128 KiB do preview, portanto um arquivo removido continua exibindo seu total
exato mesmo quando o diff visual é truncado. Binários não inventam contagem de
linhas.

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
