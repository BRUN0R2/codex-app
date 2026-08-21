# Referência aberta do Codex

## Snapshot estudado

O diretório local ignorado `.reference/openai-codex` aponta para o commit
`9894a14c81e50bbd845a337e4f77293f1cbc2633`, de 20 de agosto de 2026, do
repositório [openai/codex](https://github.com/openai/codex).

A referência serve para confirmar protocolos e semântica. Nenhum crate, pacote,
arquivo, banco, processo ou executável desse workspace participa do build ou do
runtime deste aplicativo.

## Elementos estudados

- `codex-rs/login`: parâmetros OAuth, PKCE, callback local, troca, renovação e
  revogação;
- autenticação do core: claims de conta e headers necessários para uma sessão
  ChatGPT;
- cliente de modelos: endpoint e forma autoritativa `{ "models": [...] }`;
- cliente Responses: request, eventos SSE e itens de mensagem, raciocínio,
  função e pesquisa web;
- cliente HTTP: allowlist de cookies de infraestrutura Cloudflare delegada ao
  `reqwest::cookie::Jar`, incluindo escopo, expiração e remoção;
- leitura de limites da conta: endpoint e semântica das janelas de uso;
- políticas e ferramentas: inspiração para limites, aprovações e cancelamento.

O login nativo foi validado em runtime antes desta reescrita. Essa validação
confirma o protocolo OAuth, não autoriza dependência da CLI nem compatibilidade
com o armazenamento dela.

O catálogo declara explicitamente `0.146.0` como versão de compatibilidade do
cliente no parâmetro `client_version`. Esse contrato acompanha a versão estável
do protocolo estudado e é independente da versão comercial do aplicativo.

## Desktop oficial e limites do agente

O aplicativo oficial para Windows foi revalidado em 21 de agosto de 2026 no
build `26.818.3698.0`. Seu processo Electron `ChatGPT.exe` inicia o executável
embarcado como `codex.exe -c features.code_mode_host=true app-server
--analytics-default-enabled` e também inicia `codex-code-mode-host.exe`.
Portanto, o Desktop usa o `app-server` e o core como engine; ele não executa o
fluxo interativo da CLI. O build anterior `26.727.6591.0` reportava
`codex-cli 0.146.0-alpha.9.2`; a versão interna atual não foi inferida porque o
binário protegido não publica esse metadado.

## Referência visual da conversa

O bundle `app.asar` do build `26.818.3698.0` foi analisado somente como
referência. Os módulos relevantes incluem `agent-activity-item`,
`command-execution-command`, `exec-shell-container` e `conversation-markdown`.
A janela oficial em execução foi capturada sem interação e medida por OCR
nativo do Windows.

O contrato visual observado no viewport nativo maximizado inclui:

- toolbar de conversa com `64 px`, título e ação **Abrir em**;
- coluna lógica de `48rem`, equivalente a `768 px` na raiz oficial;
- texto e Markdown de `14 px`, código de `13 px` e line-height de `1.6`;
- duração com precisão de segundos em todas as escalas, incluindo
  `1 h 29 min 25 s`;
- fundo da conversa `#181818`, bolha do usuário `#222222`, texto principal
  `#dfdfdf`, atividade/duração `#909090` e divisor `#2d2d2d`;
- commentary dentro da área recolhível de trabalho, entre o divisor de duração
  e a resposta final;
- comandos individuais no formato **Comando executado: ...**;
- `read_thread_terminal` apresentado como **Lendo terminal do chat**,
  **Terminal do chat lido** e, em resumo composto, **leu o terminal do chat**;
- grupos semânticos independentes, com apenas os detalhes escolhidos pelo
  usuário expandidos.

A implementação local adota deliberadamente uma superfície mais enxuta: não
repete o preview da primeira mensagem como título no topo e não mantém a toolbar
**Abrir em**. A conversa começa diretamente abaixo do titlebar com `32 px` de
respiro. A abertura do workspace fica na ação **Abrir no Explorador de
Arquivos** do menu do projeto, usando diretamente o caminho persistido.

O bundle oficial também contém `OpenAISans-Regular` e `OpenAISans-Medium`.
Esses arquivos são ativos de primeira parte e não possuem autorização de
redistribuição no `THIRD_PARTY_NOTICES.txt`; por isso não participam deste
repositório. A interface prioriza `OpenAI Sans` quando instalada e usa a pilha
de fontes do sistema como fallback. Incorporar os binários oficiais exige uma
licença ou arquivo autorizado fornecido separadamente.

Nem o snapshot da referência nem os binários oficiais contêm os limites fixos
`MAX_AGENT_ROUNDS = 128` ou `MAX_TOOL_CALLS_PER_TURN = 512`. O loop oficial
continua enquanto houver itens que exigem outra rodada e termina por resposta
final, cancelamento, erro/limite do provider ou compactação de contexto. O
contador de chamadas de ferramenta é telemetria, não um teto de execução. Esta
aplicação segue essa mesma semântica e não impõe aqueles dois limites.

O `ContextManager` oficial também normaliza o prompt antes da rede: insere uma
saída `aborted` para chamadas sem resultado e remove resultados órfãos. O engine
local segue essa invariável e ainda persiste a correção atomicamente, porque seu
SQLite próprio é a fonte autoritativa entre reinícios.

## Contexto ativo e compactação

A implementação de compactação foi comparada diretamente com estes arquivos do
snapshot fixado:

- `codex-rs/core/src/context_manager/history.rs`;
- `codex-rs/core/src/session/context_window.rs`;
- `codex-rs/core/src/session/turn.rs`;
- `codex-rs/core/src/compact_remote.rs`;
- `codex-rs/core/src/compact_remote_v2.rs`.

O core oficial combina o último uso medido pelo servidor com itens locais ainda
não medidos, consulta a política antes das amostragens e, no Remote Compaction
V2, conserva mensagens recentes junto de um único checkpoint criptografado. Um
estouro inesperado marca a janela como cheia, encerra o turno com erro visível e
faz a submissão seguinte compactar antes da rede; ele não repete silenciosamente
a mesma amostragem.

Neste aplicativo, instruções e ferramentas são campos recompostos em cada
request, e não world-state persistido no histórico. Por isso o cálculo local usa
o máximo entre a medição compatível acrescida do sufixo local e a estimativa da
requisição completa. Também não são inventados `comp_hash`, metadados de mundo,
um ledger duplicado ou um endpoint alternativo. A instalação do histórico e do
marcador visível é atômica no SQLite próprio.

## Edição freeform nativa

A semântica de `apply_patch` foi estudada somente nestes arquivos do snapshot:

- `codex-rs/apply-patch/src/parser.rs`;
- `codex-rs/apply-patch/src/seek_sequence.rs`;
- `codex-rs/core/src/tools/handlers/apply_patch.lark`;
- `codex-rs/core/src/tools/handlers/apply_patch_spec.rs`.

A gramática e o formato custom do Responses definem o contrato externo. Parser,
planejamento, confinamento de paths, snapshots, journal, rollback e itens da
timeline foram implementados sobre as abstrações próprias do `NativeEngine`.
Nenhum crate do snapshot, sidecar, comando de shell ou fallback de ferramenta
participa do build ou do runtime local.

## Decisões próprias

Este projeto implementa do zero:

- domínio IPC menor e fechado;
- banco SQLite e histórico próprios;
- envelope de credencial privado do aplicativo;
- cliente HTTPS/SSE com limites próprios;
- loop do agente e catálogo reduzido de ferramentas;
- perfis de permissão e aprovação;
- UI e reducers TypeScript.

Automações também foram implementadas no domínio próprio após estudar a
superfície pública do Codex Desktop: tarefas recorrentes em segundo plano e uma
fila de resultados para revisão. O projeto não copia scheduler, banco ou código
do produto oficial. O scheduler, transações, limites, tarefas Codex vinculadas e
UI foram construídos sobre o `NativeEngine`.

Deliberadamente não foram adotados `app-server`, JSONL por `stdio`, config da
CLI, `CODEX_HOME`, rollout files, MCP, colaboração, aliases antigos, migrações de
formatos externos ou fallbacks de protocolo.

## Política de atualização

Antes de alterar OAuth ou provider:

1. atualizar o clone ignorado da referência;
2. registrar o commit estudado neste arquivo;
3. comparar apenas o contrato relevante;
4. implementar a mudança no domínio próprio;
5. executar testes de fronteira e validação live limitada.

Mudanças da referência nunca são copiadas mecanicamente e nunca criam um caminho
de compatibilidade automática.

## Validação visual do desktop oficial

Em 1 de agosto de 2026, a interface foi comparada com os artefatos do aplicativo
Codex oficial para Windows, build `26.727.6591.0`. A inspeção cobriu o shell, o
estado vazio, uma tarefa ativa, a rolagem, projetos/pastas e os menus do
compositor, ambiente, permissões e modelo.

Os parâmetros usados como referência visual são:

- barra lateral responsiva com `275px` preferidos, mínimo de `240px`, máximo de
  `520px`, toolbar de `46px` e linhas de `30px`;
- coluna da conversa limitada a `768px`, com `16px` de respiro lateral, e
  compositor limitado a `784px` pelo overhang oficial;
- escala tipográfica de `11px`, `12px`, `14px` e `16px`, usando a pilha de fonte
  do sistema e peso base `445` no Windows;
- compositor sobreposto e medido em runtime; o inset inferior da timeline
  acompanha sua altura sem criar uma segunda área rolável;
- mensagem do usuário em balão discreto alinhado à direita, resposta do agente
  plana e renderizada como Markdown sanitizado à esquerda, com ação contextual
  de cópia em ambas;
- raciocínio, comandos, ferramentas e alterações organizados como uma trilha
  visual leve; apenas o conteúdo expandido recebe contorno próprio;
- scrollbar da conversa ocupando toda a viewport, botão circular de retorno ao
  fim e o último item sempre integralmente acima do compositor;
- donut de contexto oficial de `12px`, calculado sobre a janela declarada pelo
  modelo e oculto até existir uma medição;
- projetos expansíveis sem reordenação ao selecionar, no máximo cinco projetos
  e cinco tarefas por grupo antes de “Mostrar mais”, com ações secundárias
  reveladas por hover/foco.

A aplicação própria preserva essa hierarquia e semântica, mas só apresenta
ações ligadas a capacidades já implementadas. Itens oficiais sem contrato local
real não são simulados nem mantidos como controles inertes.

O teste funcional comparativo usou a mensagem `Responda apenas com: OK.` em um
chat novo do mesmo projeto. As duas aplicações criaram a tarefa no primeiro
envio e responderam `OK.`. O desktop próprio registrou `8,5k / 258k` tokens
(3%) e o oficial indicou 8%; a diferença é esperada porque cada aplicação monta
seu próprio contexto e conjunto de capacidades.

## Cobertura funcional

A comparação do aplicativo próprio com o Codex CLI `0.146.0`, o protocolo
`app-server` e o desktop oficial separa o núcleo do agente das superfícies de
produto. O estado atual é:

| Área | Cobertura local |
| --- | --- |
| Login ChatGPT, renovação, logout e uso da conta | implementada |
| Modelos, esforço, tier, permissões e janela de contexto | implementada |
| Criar, listar, abrir, renomear e arquivar tarefas | implementada |
| Turno incremental com raciocínio, ferramentas, aprovação e interrupção | implementada |
| Histórico persistido, anexos, pesquisa web e falhas visíveis | implementada |
| Troca de tarefa e múltiplos turnos simultâneos em background | implementada por runtime isolado por tarefa |
| Compactação automática e direcionamento de turno ativo | implementada |
| Fork, arquivamento, desarquivamento e exclusão de tarefa | implementada |
| Markdown sanitizado, scroll medido e janela de contexto | implementada |
| Automações recorrentes, execução manual, pausa, histórico e fila de revisão | implementada |
| Worktrees e fluxo Git completo de diff, revisão e commit | não implementada |
| Terminal e navegador integrados, plugins, skills e MCP | não implementada |

O aplicativo executa o fluxo essencial moderno de um agente Codex para PC sem
depender da CLI. As superfícies ainda ausentes não são representadas por botões
inertes; cada uma exige um contrato nativo próprio antes de aparecer na
interface.

## Fluxo unificado ChatGPT, Work e Codex

Em 12 de agosto de 2026, o fluxo foi revalidado no desktop oficial para Windows,
build `26.803.10989.0`, e na documentação oficial do ChatGPT. A inspeção cobriu
o seletor de produto, o seletor `Chat | Work`, a restauração de navegação e os
controladores de conversa.

As invariantes portadas são:

- a seleção superior é binária, `ChatGPT | Codex`; `Work` não é um terceiro
  produto;
- `Chat` é o padrão interno do ChatGPT e `Chat | Work` possui persistência
  própria;
- antes de trocar de produto, o desktop salva a localização atual e restaura o
  último destino do produto escolhido;
- Chat e Work pertencem ao histórico ChatGPT; tarefas Codex ficam no histórico
  Codex;
- Chat não recebe ferramentas do workspace; Work local e Codex recebem as
  capacidades locais anunciadas pelo runtime;
- os placeholders oficiais são “Message ChatGPT”, “Work with ChatGPT” e “Do
  anything”, localizados pela interface.

O seletor de inteligência do Chat também foi validado na sessão autenticada e
no bundle do mesmo build. O gatilho mostra a seleção efetiva (`Pro`, por
exemplo), nunca o plano da conta nem o texto `ChatGPT`. Cada opção visível é um
preset publicado pelo servidor, com faixa (`instant`, `thinking`, `pro`), slug
de modelo e `thinking_effort` próprios.

O catálogo consumer vem de `/backend-api/models?iim=false&include_icons=false`
e declara `default_model_slug`, esforço padrão por slug, versões e presets. O
estado oficial mantém uma preferência global anulável em
`chatgpt-last-selected-model-v1`: ausência de valor deriva modelo e esforço do
catálogo e não grava nada; somente uma ação explícita do usuário persiste outra
seleção. A implementação local conserva essa mesma invariante e descarta
qualquer preferência cujo contrato não corresponda ao catálogo atual.

Há três contratos diferentes que não podem ser misturados. O Responses público
da API Platform documenta `reasoning.mode` para modelos compatíveis; o Responses
do backend Codex usa `reasoning.effort`; o Chat consumidor usa o preset do
catálogo resolvido em `model` e `thinking_effort`. Portanto, Pro no Chat é uma
faixa/preset e pode selecionar outro `model_slug`; ele não é serializado como
`reasoning.mode` no endpoint consumer nem no endpoint Codex.

O transporte consumer do ChatGPT oficial é distinto do Responses do Codex. O
desktop prepara integridade e conduit token antes de transmitir em
`/backend-api/f/conversation`. A implementação local agora percorre esse mesmo
fluxo consumidor com a sessão OAuth da conta ChatGPT, sem chave da API Platform:

1. carrega `/backend-api/models?iim=false&include_icons=false`;
2. reutiliza um `oai-did` aleatório e persistente, prepara requisitos em
   `/backend-api/sentinel/chat-requirements/prepare` e resolve o proof-of-work
   quando solicitado;
3. tenta `/backend-api/f/conversation/prepare`; uma falha é diagnosticada e a
   continuidade explícita usa `client_prepare_state: "failure"` sem conduit token;
4. transmite em `/backend-api/f/conversation`, negocia `supported_encodings:
   ["v1"]` e aplica os patches incrementais;
5. persiste `conversation_id` e o último `parent_message_id` para continuar ou
   bifurcar a conversa.

O desafio interativo Turnstile não é contornado: se o servidor o exigir, o
turno falha com orientação explícita para restabelecer a sessão no cliente
oficial. Upload consumer de imagens também permanece ausente; anexos de imagem
são recusados antes da rede em vez de serem enviados no formato incorreto.

Fontes públicas usadas na comparação:

- [Authentication](https://learn.chatgpt.com/docs/auth);
- [Models](https://learn.chatgpt.com/docs/models);
- [Codex App Server](https://learn.chatgpt.com/docs/app-server);
- [GPT-5.6 model guidance](https://developers.openai.com/api/docs/guides/latest-model).

## Validação live do transporte

Em 1 de agosto de 2026, uma tarefa real autenticada percorreu 56 itens de
provider, com múltiplas rodadas de leitura, busca e comando, persistiu a resposta
final e concluiu um segundo turno após o reinício de desenvolvimento. O teste
encontrou o marcador válido
`response.reasoning_summary_part.done`, que passou a ser aceito explicitamente.
Eventos desconhecidos continuam falhando na fronteira.

Falhas de turno persistidas agora fazem parte do contrato de leitura e são
mostradas na timeline. Isso evita que reabrir uma tarefa transforme uma falha de
provider em silêncio visual.

No transporte Responses, um status HTTP de sucesso pode iniciar um stream SSE
sem o header `Content-Type`. O corpo, e não esse header opcional, é a fronteira
autoritativa: o parser local continua rejeitando eventos desconhecidos, linhas
excessivas, uso incoerente e streams malformados.
