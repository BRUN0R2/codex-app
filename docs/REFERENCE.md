# Estudo da referência oficial

## Snapshot analisado

O repositório [openai/codex](https://github.com/openai/codex) foi baixado em
`.reference/openai-codex` e fixado no commit
`6219b7c40fc9c702c0aef9964e72b492558f60e4`, de 30 de julho de 2026. A cópia é
somente material de estudo e permanece fora do Git deste projeto.

As áreas relevantes foram lidas diretamente no snapshot:

- `codex-rs/app-server`: transporte, handshake, requisições e notificações;
- `codex-rs/app-server-protocol`: contratos gerados e tipos de entrada;
- `codex-rs/core`: configuração, autenticação e catálogo de modelos;
- `codex-rs/login`: fluxo ChatGPT administrado pelo runtime;
- `codex-rs/secrets` e `codex-rs/keyring-store`: cofre criptografado e chave do
  sistema operacional;
- testes do `app-server`: sequência de inicialização e formato das respostas.

## Contratos adotados

- O transporte local é JSONL por `stdio`, sem framing `Content-Length`.
- O cliente envia `initialize`, aguarda a resposta e então envia `initialized`.
- O login OAuth usa o cliente, os escopos, flags, portas e callback observados em
  `codex-rs/login`; tokens nunca atravessam a interface deste aplicativo.
- Conversas usam `thread/list`, `thread/start`, `thread/resume`,
  `thread/name/set`, `thread/archive`, `turn/start` e `turn/interrupt`.
- O envio atual usa `text`, `localImage` ou `mention`; a leitura histórica cobre
  também `image`, `audio`, `localAudio` e `skill`.
- Configuração usa `config/read`, `config/value/write`, `config/batchWrite` e
  `configRequirements/read`.
- Prontidão do sandbox usa o RPC sem parâmetros `windowsSandbox/readiness`.
- Preparação do sandbox usa `windowsSandbox/setupStart` e só termina com
  `windowsSandbox/setupCompleted`; os modos permitidos vêm de
  `allowedWindowsSandboxImplementations`.
- Diretórios graváveis por `Everyone` chegam em
  `windows/worldWritableWarning` como até três `samplePaths`, `extraCount` e
  `failedScan`; a lembrança oficial é
  `notice.hide_world_writable_warning = true`.
- Avisos de configuração chegam em `configWarning` logo após `initialize` e
  também podem surgir em `thread/start`; o contrato preserva `summary`,
  `details`, `path` e `range` com posições de base um.
- `deprecationNotice` é global e preserva `summary` e `details`; `warning` usa
  `threadId` opcional e `guardianWarning` exige um `threadId`, ambos com
  `message` autoritativa.
- Uso da conta usa `account/rateLimits/read`; atualizações incrementais chegam em
  `account/rateLimits/updated` e preservam metadados do snapshot completo.
- Modelo, esforços e tiers de serviço vêm de `model/list`.
- A timeline consome a união oficial `ThreadItem` e as notificações incrementais
  `item/*`, inclusive `item/mcpToolCall/progress`, `turn/plan/updated` e
  `turn/diff/updated`.
- Solicitações do servidor são respondidas pelo mesmo `id`; métodos desconhecidos
  não recebem aprovação automática.
- O roteador oficial classifica notificações como globais, do aplicativo ou de
  uma tarefa. `turn/*`, `item/*`, `error`, `warning`, `guardianWarning` e
  `serverRequest/resolved` preservam o `threadId` de destino; avisos de
  configuração e depreciação são do aplicativo.
- O catálogo interativo atual contém
  `item/commandExecution/requestApproval`, `item/fileChange/requestApproval`,
  `item/tool/requestUserInput`, `item/permissions/requestApproval` e
  `mcpServer/elicitation/request`; `serverRequest/resolved` encerra cada entrada.
- O cliente negocia as capacidades de inicialização explicitamente e só marca
  como verdade uma extensão cujo fluxo completo consegue atender.

## Decisões de implementação

O projeto usa a referência para entender responsabilidades e semântica, sem
copiar componentes privados nem incorporar o workspace Rust inteiro. O snapshot
contém dezenas de crates internos fortemente conectados; tratá-lo como uma
biblioteca pequena apenas deslocaria o acoplamento para dentro deste app.

Foi criada uma base própria em `src-tauri/src/engine`: contrato `AgentEngine`,
operações de domínio, `NativeEngine`, SQLite, registro de ferramentas e política
de permissões. O protocolo oficial agora fica atrás de
`CodexCompatibilityEngine`, em vez de ser a arquitetura do aplicativo.

O login do produto agora pertence ao backend Rust. A implementação reproduz o
contrato observado e mantém tokens em tipos redigidos. No snapshot atual,
`SecretAuthStorage` é estável e habilitado por padrão no Windows: o registro fica
em `secrets/codex_auth.age`, enquanto o Credential Manager guarda somente a
chave curta associada ao `CODEX_HOME`. O app implementa esse backend em módulos
próprios e preserva o formato consumido pelo `app-server`.

O processo da ponte é supervisionado por um único dono Rust, com I/O assíncrono,
timeout limitado e correlação de respostas. Ele não participa da autenticação e
só nasce quando provider, modelos ou configuração são solicitados.

## Estudo visual ao vivo

O Codex Desktop instalado foi inspecionado sem enviar mensagens nem alterar
preferências. Foram verificados shell, compositor, painel de ambiente, seletor e
os três submenus, menu da conta e página de configurações.

Padrões reproduzidos:

- sidebar de 273 px em janela ampla e conteúdo de chat centralizado;
- projetos com raiz selecionável, ações no hover, tarefas indentadas e seção de
  recentes;
- compositor compacto, expansível e com ações agrupadas nas extremidades;
- permissão resumida como intenção (`Aprovar por mim`, `Acesso completo` ou
  `Personalizado`) e detalhes técnicos concentrados nas configurações;
- popover de permissões com contexto, descrição por opção, seleção visível e
  acesso direto à configuração avançada;
- menu raiz de 226 px e submenus em cascata alinhados pela base;
- listas compactas com check, descrições apenas quando agregam contexto e reset
  separado por divisor;
- raciocínio como um único cabeçalho contextual, sem repetir deltas intermediários;
- comandos e edições ativos como linhas compactas sem expansão prematura;
- grupos concluídos expansíveis, com ícone semântico e seta apenas no hover/foco;
- nome, estatísticas de diff, estado e seta no mesmo fluxo inline;
- comandos com saída agregada, arquivos com diff e imagens visualizadas com
  miniaturas reais;
- progresso do turno em uma pílula compacta acima do compositor;
- configurações em página inteira, busca lateral e conteúdo central de 768 px;
- categorias separadas para geral, aparência, personalização, conta,
  configuração e edição avançada;
- canvas `#181818`, sidebar `#202020`, superfícies `#2D2D2D`, seleção
  `#313131` e destaque de permissão próximo de `#FF8549`.

A escala foi implementada no CSS do aplicativo. Não existe código que altere DPI,
zoom do WebView ou escala do sistema operacional.

Os contratos de configuração foram conferidos em `app-server-protocol`, no
carregamento de camadas do core e em `managed_new_thread_defaults.rs`. A UI usa
as listas permitidas de `ConfigRequirements` para aprovação, sandbox e busca, e
usa `ConfigLayerSource` para reconhecer valores administrados. Os defaults
gerenciados de modelo para novas tarefas não são uma lista de bloqueio: a própria
referência preserva a precedência de uma escolha explícita. Preferências locais
da interface ficam no campo opaco `desktop`, sob um namespace próprio, sem criar
um armazenamento paralelo. Escritas preservam `expectedVersion` da camada ativa
de usuário para manter a detecção de concorrência do app-server.

A configuração efetiva não é despejada na interface avançada. Camadas do Codex
podem conter cabeçalhos MCP e outros segredos; por isso o diagnóstico mostra
somente contagens e a edição exige caminho e JSON explícitos.

A escrita versionada foi exercitada na janela Tauri real alterando a escala da
interface em sequência e restaurando 15 px. Cada alteração recarregou a camada
ativa sem conflito, erro visível ou mudança de DPI do sistema.

O diagnóstico de sandbox também foi exercitado sem iniciar setup. Neste Windows,
o app-server retornou `ready`; a UI exibiu **Pronto** e permaneceu somente leitura.
Esse estado indica capacidade do executor e não substitui a política ativa da
tarefa, que pode continuar em acesso completo.

O fluxo de preparação foi conferido no processor e nos testes do app-server. O
modo `elevated` é o padrão recomendado e pode abrir UAC; `unelevated` usa token
restrito sem Administrador, mas a própria referência o classifica como de maior
risco em caso de prompt injection. A implementação expõe ambos somente quando
permitidos e nunca escolhe fallback automaticamente. Como a máquina já retornou
`ready`, nenhum setup ou prompt de elevação foi executado durante a validação.

O aviso de diretórios graváveis por todos foi conferido no tipo gerado do
`app-server-protocol`, em `windows_sandbox_prompts.rs`, no editor oficial de
configuração e no auditor de ACLs. A semântica oficial oferece continuar somente
na sessão ou continuar e não avisar novamente; falha de varredura declara que a
proteção não pôde ser verificada e não inventa caminhos.

Os dois estados visuais foram exercitados na janela Tauri com fixtures efêmeras:
três caminhos mais uma contagem e `failedScan` sem amostras. A acessibilidade
expôs um `alertdialog`, ambas as ações e o compositor desabilitado. As fixtures
foram removidas depois da captura; não houve clique nas ações, escrita de
configuração ou alteração de ACL durante essa validação.

O fluxo de `configWarning` foi conferido no processor de inicialização, no
carregamento por tarefa e no cliente TUI. A referência entrega primeiro a
resposta de `initialize` e então publica cada aviso global; ao carregar uma
tarefa, evita repetir apenas o aviso de política que já estava na lista inicial.
O cliente oficial apresenta `summary` e acrescenta `details` quando existe, sem
executar uma correção automática.

Na janela Tauri, fixtures efêmeras exercitaram duas ocorrências distintas e uma
duplicata estrutural, incluindo caminho e intervalo. A árvore de acessibilidade
confirmou somente uma entrada ativa, contador `+1`, detalhes, localização e
compositor disponível. As fixtures foram removidas sem escrever no
`config.toml`; a captura visual foi interrompida quando houve entrada do usuário,
preservando o foco da janela em uso.

Os tipos TypeScript gerados `DeprecationNoticeNotification`,
`WarningNotification` e `GuardianWarningNotification` confirmaram a separação
de escopo. Na TUI, avisos comuns e Guardian seguem a mesma célula de histórico;
o estado especial elimina somente repetições da mensagem exata de fallback de
metadados para o mesmo slug de modelo. A implementação local preserva essa
exceção sem deduplicar genericamente mensagens iguais.

Uma prova isolada pelo pipeline Vite validou parsing estrito, rejeição de
destino excessivo, ocorrências globais distintas, limite de vinte avisos do app,
limite de quarenta avisos por tarefa, descarte de tarefas antigas, reconciliação
da timeline e a exceção de metadados. Essa prova detectou a diferença semântica
entre `HashSet::insert` do Rust e `Set.add` do JavaScript antes do runtime final;
o runner efêmero foi removido após a correção.

Na janela Tauri real, fixtures efêmeras mostraram um aviso comum, um Guardian
com contagem de omissões e uma depreciação não bloqueante junto ao compositor.
Ícones, cores, quebra de linha e posição foram conferidos visualmente; não houve
envio de mensagem, alteração de configuração ou clique em ação. Depois da
captura, as fixtures foram removidas e uma nova leitura confirmou a interface
normal sem resíduos.

Os tipos `GetAccountRateLimitsResponse`, `RateLimitSnapshot` e
`RateLimitWindow` confirmam que `usedPercent` representa consumo, enquanto
`resetsAt` é um timestamp Unix em segundos. A seleção da janela semanal segue a
tolerância de 5% usada pela TUI oficial; quando ela não existe, a interface usa a
janela de maior duração disponível sem inventar uma periodicidade.

Na comparação ao vivo, a conta atingiu 100% de consumo. O Codex Desktop retirou
o cartão de uso da sidebar e mostrou um aviso de esgotamento acima do compositor,
com o mesmo horário de reset. O app reproduz essa transição e oferece releitura
do snapshot; ações comerciais não foram inventadas porque seus destinos não
fazem parte do contrato público estudado.

Os contratos `commandExecution`, `fileChange`, `imageView`, `reasoning` e suas
notificações foram conferidos nos tipos TypeScript gerados e no README do
`app-server`. A interface preserva o item final como autoridade e usa deltas
somente para o estado ativo, como orienta a referência.

Também foram conferidos diretamente os tipos atuais de `hookPrompt`,
`mcpToolCall`, `dynamicToolCall`, `collabAgentToolCall`, `subAgentActivity`,
`webSearch`, `sleep`, `imageGeneration`, modos de revisão e `contextCompaction`.
O resultado de ferramenta dinâmica pertence a `contentItems`; a geração de
imagem pode carregar base64 em `result` e caminho seguro em `savedPath`. A UI
mantém o segundo e descarta o primeiro depois da leitura, evitando duplicar um
payload grande no estado reativo.

O decoder local usa um catálogo fechado dos discriminadores atuais. Uma versão
futura que introduza outro item falha visivelmente até que domínio e renderer
sejam atualizados; não existe fallback genérico que aparente suporte inexistente.

O mapa de `app_server_event_targets.rs` foi reproduzido na fronteira da sessão
para os eventos já suportados. Uma prova isolada carregada pelo pipeline Vite
confirmou que um destino ausente falha, uma tarefa estrangeira não altera o
estado ativo, solicitações globais continuam visíveis e a limpeza de uma tarefa
não remove filas alheias. O fixture e o runner efêmeros foram removidos depois da
validação.

As solicitações interativas também foram conferidas nos tipos gerados, no README
do app-server e nos fluxos da TUI. O contrato preservado é:

- aprovações usam somente decisões oferecidas por `availableDecisions`, quando
  presente, e recorrem às heurísticas estáveis quando o campo experimental foi
  omitido;
- respostas selecionadas de `request_user_input` usam o rótulo da opção e texto
  livre usa o prefixo `user_note: ` esperado pelo runtime;
- `request_permissions` devolve somente o subconjunto solicitado e nunca
  combina `strictAutoReview` com escopo de sessão;
- formulários MCP estáveis aceitam apenas os tipos primitivos do esquema oficial;
  aprovações MCP vazias preservam `_meta.persist` como `session` ou `always`;
- URL MCP aceita somente HTTP(S), e `openai/form` inesperado é cancelado sem
  materializar o payload opaco na árvore reativa.

Como o cliente ainda não implementa ferramentas dinâmicas, geração externa de
atestados nem formulários OpenAI estendidos, o `initialize` anuncia
`experimentalApi: false`, `requestAttestation: false` e
`mcpServerOpenaiFormElicitation: false`. O parser defensivo continua tornando
qualquer desvio visível em vez de aceitar silenciosamente.

## Validação do login nativo

Em 30 de julho de 2026, uma prova efêmera escrita em Rust reproduziu diretamente
o fluxo observado em `codex-rs/login`, sem iniciar nem vincular o Codex CLI. O
teste executou, em sequência:

- PKCE S256 e estado aleatório;
- autorização no navegador com callback em `localhost:1455`;
- troca do código em `https://auth.openai.com/oauth/token`;
- leitura estrutural das claims de identidade, conta e plano;
- renovação pelo `refresh_token`;
- revogação em `https://auth.openai.com/oauth/revoke`.

O servidor aceitou também o `originator` próprio `codex_desktop_next`. O resultado
observado foi `login=true`, `refresh=true` e `revoke=true`. Nenhuma credencial foi
persistida, exibida ou enviada ao frontend; o processo descartou os valores
sensíveis ao terminar. A página de conclusão no navegador foi verificada ao vivo.

Essa evidência confirmou o protocolo antes da integração. A implementação do
produto adicionou armazenamento durável, detecção de alterações concorrentes,
cancelamento e ownership serializado.

Após a integração, o fluxo real foi repetido pela interface. Uma sessão maior
que o limite do Credential Manager foi gravada em um envelope de 4.797 bytes,
sem arquivos temporários residuais. O app foi encerrado e iniciado novamente,
reconheceu a conta sem novo login e o `app-server` iniciado com
`secret_auth_storage=true` leu o mesmo cofre e retornou 7 modelos.

Depois do aquecimento assíncrono, uma nova inicialização foi observada sem abrir
o seletor nem acionar outro controle. Em duas execuções limpas, a ponte filha
surgiu de três a quatro segundos após o processo da UI e o painel de ambiente
passou para `7 modelos disponíveis` automaticamente. O logout remoto permanece
no checklist para não invalidar a sessão validada.

## Atualização da referência

Antes de ampliar uma capacidade, compare o contrato com a versão oficial atual,
registre o novo commit estudado e valide a fronteira alterada ao vivo. Mudanças do
snapshot nunca devem ser copiadas mecanicamente para este repositório.
