# Baseline de desempenho

O baseline deve ser coletado no executável `release`, com a conta já autenticada
e o projeto deste repositório selecionado. Ele é evidência para decisões de
otimização, não um benchmark sintético de CI.

## Inicialização e memória

Após `pnpm tauri build --no-bundle`, execute:

```powershell
pwsh -File scripts/measure-release.ps1
```

O script abre exatamente o executável informado, mede o tempo até uma janela
responsiva, aguarda três segundos, registra `WorkingSet` e memória privada e
fecha a mesma instância pela mensagem normal da janela. Nenhum processo é
encerrado à força.

## Latência de stream

A latência é medida ao vivo entre a ação de enviar uma mensagem curta e o
primeiro delta visível do mesmo turno. Use um projeto já materializado, sem
anexos, registre modelo, esforço, tier, rede e três amostras. Não compare
modelos ou condições de rede diferentes como se fossem a mesma série.

## Resultado atual

Coleta local de 2 de agosto de 2026, Windows `10.0.26200.0`, 28 processadores
lógicos, conta autenticada e este repositório selecionado:

| Amostra | Janela responsiva | Working set | Memória privada |
| ---: | ---: | ---: | ---: |
| 1, processo frio | 955,9 ms | 42,0 MiB | 8,9 MiB |
| 2 | 87,1 ms | 36,3 MiB | 8,9 MiB |
| 3 | 77,2 ms | 36,3 MiB | 9,0 MiB |

O executável mede 10,7 MiB. A mediana de inicialização foi 87,1 ms, o working
set médio 38,2 MiB e a memória privada média 8,9 MiB. A primeira amostra inclui
o carregamento frio do WebView e deve permanecer visível, sem ser descartada
para melhorar artificialmente o resultado.

A latência do primeiro delta continua exigindo um turno real controlado. A
tentativa autorizada de 2 de agosto de 2026 atravessou a normalização local do
histórico, mas o provider recusou o início do stream com `HTTP 429` e
`usage_limit_reached`. A medição e a aprovação ao vivo devem ser retomadas
somente após a renovação da cota; a duração total e uma resposta de erro não são
substitutos válidos para essa amostra.

### Revalidação release após as otimizações — 14 de agosto de 2026

Build gerado por `pnpm release:build` e medido por `pnpm measure:release` na
mesma versão do Windows e com 28 processadores lógicos:

| Amostra | Janela responsiva | Working set | Memória privada |
| ---: | ---: | ---: | ---: |
| 1, processo frio | 1.152,9 ms | 35,3 MiB | 9,7 MiB |
| 2 | 109,1 ms | 35,4 MiB | 9,1 MiB |
| 3 | 95,9 ms | 35,2 MiB | 8,8 MiB |

O executável mede 11,4 MiB. A mediana de inicialização foi 109,1 ms, o working
set médio 35,3 MiB e a memória privada média 9,2 MiB. Contra a coleta de 2 de
agosto, isso representa `+22,0 ms` na mediana, `-2,9 MiB` no working set médio,
`+0,3 MiB` na memória privada média e `+0,7 MiB` no executável. As coletas
refletem estados diferentes do projeto e não isolam uma única alteração; os
números são mantidos como regressão/ganho observado, não como causalidade.

## Investigação de latência entre turnos — 14 de agosto de 2026

Uma conversa real que reproduziu a impressão de demora aleatória foi auditada
diretamente no SQLite, separando fila local, primeira resposta do provider,
rodadas do agente e ferramentas:

| Medida | Primeiro turno | Segundo turno |
| --- | ---: | ---: |
| duração total | 130 s | 966 s |
| rodadas de modelo | 15 | 40 |
| ações/ferramentas | 39 | 163 |
| tempo até concluir a primeira rodada | — | 17,625 s |

No segundo turno, 121 ações eram execuções de ferramentas e 42 eram comandos.
Os comandos somaram 72,499 s, com uma chamada de 52,805 s. O contexto de entrada
cresceu de 53.321 para 214.732 tokens; a rodada mais lenta ficou 91,7 s sem um
novo evento semântico. A conclusão é objetiva: esse caso não ficou parado numa
fila depois do primeiro turno. Ele iniciou, mas acumulou 40 ciclos de
raciocínio/ferramentas em esforço máximo e contexto crescente.

Também existia uma segunda classe de problema, independente do modelo: dev e
release podiam compartilhar identidade Tauri, WebView, cofre e SQLite enquanto
o dono do turno ativo existia apenas na memória de cada processo. Isso tornava
retomadas e novos turnos dependentes de qual instância tocasse o mesmo estado.

As proteções permanentes são:

- perfis Tauri separados para dev e release e instância única dentro de cada
  perfil;
- banco `native-state-profile-v2.sqlite3`, `owner_id` por processo e índice
  SQLite que admite somente um turno ativo por tarefa;
- leituras independentes (`read_file`, `list_files`, `search_text`) executadas em
  lotes concorrentes de até oito quando o modelo anuncia suporte; comandos e
  qualquer mutação continuam serializados;
- deadline de inatividade associado ao próximo evento Responses decodificado;
  heartbeat de transporte não renova indefinidamente a espera por progresso;
- atividades e diffs fechados e desmontados quando recolhidos, reduzindo DOM e
  memória sem perder a ordem dos resultados enviados ao provider.

### Pipeline de conversas longas

O caminho crítico local agora possui limites proporcionais ao trabalho novo,
não ao tamanho integral da conversa:

- o contrato 8 envia lotes heterogêneos de deltas: o primeiro delta de cada
  fluxo é imediato, os seguintes usam uma janela nativa de 8 ms e todo evento
  semântico força `flush`, preservando ordem e baixa TTFT;
- o decoder ChatGPT aplica `append` diretamente, sem clonar a árvore JSON nem
  reconstruir a mensagem acumulada a cada fragmento;
- o runtime mantém somente overlays transitórios do turno ativo e os projeta por
  uma sequência indexada, sem copiar todo o vetor de turnos a cada lote; listas
  laterais recebem `ThreadSummary` e nunca retêm snapshots completos;
- Markdown em streaming consolida blocos terminados e substitui somente o bloco
  instável; ao concluir, executa uma renderização integral autoritativa;
- Markdown final com pelo menos 32.000 caracteres delega parsing e syntax
  highlighting a um Web Worker compartilhado e cancelável. Sanitização e DOM
  permanecem na UI; o limiar decide escalonamento, não limita conteúdo;
- a timeline não possui janela máxima de turnos. Um índice de alturas variáveis
  constrói a árvore Fenwick em `O(n)`, mede em `O(log n)` e monta somente
  viewport mais overscan;
- o histórico usa cursor opaco, versionado e vinculado à tarefa. Limites de
  linhas/bytes pertencem à página de transporte, não ao total persistido;
- saídas de ferramentas e comandos usam referência + prévia no turno; o texto
  integral fica em blocos SQLite de 64 KiB e só cruza o IPC por demanda. Captura
  de processos usa spool em disco e normalização incremental, sem acumular todo
  o stream na memória;
- ao chegar ao topo por uma ação do usuário, a página anterior é carregada e a
  âncora visual é mantida sem remover histórico já carregado;
- o SQLite usa WAL e pool persistente dimensionado pela máquina; leituras podem
  avançar em paralelo e pares provider/timeline são gravados numa transação;
- durante uma execução, o agente conserva o histórico decodificado em memória,
  lê do SQLite apenas itens posteriores ao cursor e serializa requests por
  referência. Steers usam uma fila SQLite separada e são promovidos em lote
  antes da próxima amostragem, preservando ordem causal sem reserializar o
  histórico completo.

#### Busca nativa de código — 18 de agosto de 2026

`search_text` deixou de enumerar, ordenar, abrir e decodificar arquivos
sequencialmente no processo principal. O runtime agora chama diretamente o
`ripgrep 15.2.0` empacotado e validado, limita a busca a duas threads, consome
stdout incrementalmente, encerra ao atingir 200 resultados e preserva timeout e
cancelamento do turno.

`pnpm measure:search` executa em perfil release um corpus UTF-8 de 75 MiB,
distribuído em 2.400 arquivos e 48 diretórios. Sete amostras, com a ordem dos
caminhos alternada para reduzir viés de cache, produziram:

| Caminho | Mediana |
| --- | ---: |
| scanner sequencial anterior | 545,800 ms |
| `ripgrep` empacotado | 260,168 ms |
| aceleração | 2,098× |

O benchmark exige pelo menos `2×` nesse corpus e também valida que ambos os
caminhos retornam o mesmo resultado vazio. Ele mede varredura local aquecida e
inclui a criação do processo `rg`; não representa busca fria em disco, indexação
semântica, latência do provider ou tempo até o primeiro token.

#### Compactação de saídas de ferramentas — 18 de agosto de 2026

Saídas extensas de `read_file`, `list_files`, `search_text` e comandos agora são
compactadas antes de entrar no próximo request do provider. O algoritmo mantém o
início, o fim e linhas prioritárias da região omitida; em comandos com falha,
reserva mais espaço para `stderr`. O conteúdo integral continua persistido em
blocos SQLite de 64 KiB e pode ser percorrido sem compactação por `read_output`.

`pnpm measure:tool-output` gera deterministicamente 40.000 linhas e 2.439.995
bytes, incluindo uma falha representativa no centro. Em perfil release, a
prévia final enviada ao provider mediu 6.494 bytes e levou 14,8406 ms para ser
produzida:

| Dimensão | Original | Prévia atual | Redução |
| --- | ---: | ---: | ---: |
| bytes UTF-8 | 2.439.995 | 6.494 | 99,7339% |
| linhas originais | 40.000 | — | — |

O teste também exige que a linha de falha e o identificador do recurso integral
permaneçam presentes. A porcentagem acima mede bytes, não tokens: a economia
exata de tokens depende do tokenizer e do conteúdo. Também não representa
latência de rede ou do modelo.

#### Coalescência de leituras — 18 de agosto de 2026

Chamadas idênticas de `read_file`, `list_files`, `search_text` e `read_output`
no mesmo lote paralelo compartilham uma única operação em voo. A chave inclui
tipo, workspace canônico, tarefa e todos os argumentos. Cada chamada ainda
materializa seu próprio item e recurso de saída. O cache termina junto com o
lote: a rodada seguinte volta a ler a fonte, evitando servir resultados
obsoletos após edições, comandos ou mudanças externas.

`pnpm measure:tool-cache` compara oito buscas `ripgrep` idênticas e concorrentes
com uma busca compartilhada em um corpus de 40 MiB. A coleta release final usou
sete amostras válidas em ordem alternada:

| Dimensão | Oito execuções independentes | Uma execução coalescida |
| --- | ---: | ---: |
| processos de busca por lote | 8 | 1 |
| redução de execuções | — | 87,5% |
| mediana de parede | 241,556 ms | 157,230 ms |
| aceleração observada | — | 1,536× |

O teste funcional exige exatamente uma execução para oito chamadas, preserva o
tipo dos erros compartilhados, diferencia workspace/tarefa/argumentos e prova
que um novo lote não reutiliza o anterior. A aceleração mede somente chamadas
duplicadas no mesmo lote; chamadas distintas continuam paralelas e não recebem
um ganho artificial atribuído ao cache.

#### Compactação semântica e busca em saídas — 22 de agosto de 2026

O caminho genérico de cabeça/cauda permanece como fallback lossless. Acima dele,
comandos concluídos com sucesso reconhecem apenas classes fechadas de ruído:
progresso de build, progresso de gerenciador de pacotes e linhas de sucesso de
testes Rust ou JavaScript. Diagnósticos, summaries e linhas representativas
continuam presentes; formatos desconhecidos abaixo de 10 KiB permanecem
byte-a-byte e comandos com exit code diferente de zero nunca usam o filtro de
sucesso.

`pnpm measure:command-output` compara o algoritmo anterior e o semântico em
perfil release:

| Corpus | Original | Prévia anterior | Prévia semântica | Redução adicional | Mediana |
| --- | ---: | ---: | ---: | ---: | ---: |
| logs moderados de testes | 3.186 B | 3.216 B | 414 B | 87,127% | 0,137 ms |
| build + 465 arquivos/testes | 29.086 B | 6.121 B | 633 B | 89,659% | 0,537 ms |

Usando a mesma aproximação conservadora do runtime de quatro bytes por token,
as prévias representam aproximadamente `804 -> 104` tokens e `1.531 -> 159`
tokens. Esses números são estimativas; a contagem exata continua dependendo do
tokenizer e do conteúdo.

`read_output` também aceita uma busca exata que varre os chunks sem materializar
o recurso inteiro no provider. `pnpm measure:output-search` posiciona um match no
fim de 64 MiB e compara a resposta com uma página bruta:

| Dimensão | Página bruta | Busca direcionada |
| --- | ---: | ---: |
| bytes enviados ao contexto | 65.536 | 110 |
| tokens estimados | 16.384 | 28 |
| redução | — | 99,832% |
| latência mediana da busca em 64 MiB | — | 61,080 ms |

O benchmark inclui duas amostras de aquecimento e sete amostras válidas da
varredura completa em memória dos chunks sintéticos, sempre com o match no fim.
Testes funcionais adicionais cobrem query atravessando fronteira de chunk, UTF-8
multibyte, uma ocorrência por linha, truncamento explícito e isolamento por
tarefa.

#### Benchmark da conversa de referência — 16 de agosto de 2026

`pnpm measure:history` reproduz 741 turnos, 15.529 itens de transcript e 231 MiB
de texto. O contrato JSON completo mede 232,169 MiB. A consulta real pagina
linhas de itens antes de agrupá-las em turnos; portanto o lote inicial de 64 é
comparável ao alvo exibido na referência, e não significa 64 turnos.

| Dimensão | Contrato completo | Página inicial atual | Redução |
| --- | ---: | ---: | ---: |
| itens materializados | 15.529 | 64 | 99,588% |
| contrato codificado | 232,169 MiB | 0,957 MiB | 99,588% |
| crescimento incremental de heap Node | 243,717 MiB | 1,148 MiB | 99,529% |
| requisições para abrir | — | 1 | — |

No corpus sintético, os 64 itens representam os quatro turnos mais recentes. Na
coleta isolada final, com três amostras completas e sete amostras da página:

| Caminho local | Completo | Página inicial | Aceleração |
| --- | ---: | ---: | ---: |
| validação do contrato | 31,660 ms | 0,212 ms | 149,340× |
| `JSON.parse` + validação | 293,283 ms | 0,989 ms | 296,545× |

Antes da última otimização, a validação criava um `TextEncoder` e um buffer
proporcional para cada campo. No mesmo benchmark ela consumiu 145,866 ms no
contrato completo e 0,678 ms na página. A medição UTF-8 atual reutiliza um buffer
de 64 KiB com `encodeInto`, interrompe cedo quando ultrapassa o limite e reduziu
esse custo em aproximadamente 4,6 vezes no contrato completo e 3,2 vezes na
página. Na coleta final, a validação ficou em 31,660 ms no contrato completo e
0,212 ms na página, enquanto o caminho `JSON.parse` + validação completo caiu de
438,127 ms para 293,283 ms.

Manter 64 itens é deliberado: o caminho local já fica abaixo de 1 ms e reduzir
para 32 economizaria frações de milissegundo, mas dobraria a chance de abrir uma
resposta recente sem seu prompt ou atividades associadas. Esse benchmark mede
parse, contrato e heap incremental no Node; não substitui trace de renderer,
paint, INP, rede, modelo ou ferramentas no WebView de produção.

O cenário sintético reproduzível usa 20.000 itens e 1.200 deltas destinados à
última mensagem. Antes da alteração, a projeção integral anterior levou
994,21 ms em uma amostra local. Em três execuções de 16 de agosto de 2026,
`pnpm measure:streaming` coletou sete amostras após duas de aquecimento por
execução:

| Caminho atual | Mediana |
| --- | ---: |
| 1.200 atualizações sequenciais | 18,872 ms |
| um lote coalescido | 0,097 ms |

O lote ficou 194,557 vezes mais rápido que as atualizações sequenciais já
otimizadas nesse cenário. Este benchmark mede somente custo local de redução
de estado; não representa TTFT de rede, tempo do modelo ou tempo de ferramentas.

#### Saída de comando ao vivo e âncoras dinâmicas — 22 de agosto de 2026

`exec_command` agora normaliza `stdout` e `stderr` enquanto drena os pipes. A UI
recebe frames append de até 8 KiB, operações semânticas de carriage return e
backspace e no máximo 256 KiB combinados por comando ativo. A saída integral
continua no spool e no recurso persistido; a prévia transitória não entra no
provider nem no histórico.

Em três execuções de `pnpm measure:streaming`, cada uma com duas amostras de
aquecimento e sete válidas, as medianas entre execuções foram:

| Carga sobre 20.000 itens | Sequencial | Caminho agrupado | Aceleração |
| --- | ---: | ---: | ---: |
| 1.200 deltas de texto | 22,650 ms | 0,100 ms | 226,5× |
| 128 deltas / 256 KiB de comando | 2,709 ms | 0,038 ms | 71,3× |

O caminho de comando reproduz o primeiro frame imediato seguido do frame
coalescido. Um benchmark Rust release separado processa 64 MiB com ANSI,
carriage return e leituras de 8 KiB. Em três execuções, a mediana foi
`1.787,762 ms`, equivalente a `35,8 MiB/s`; todas produziram exatamente as
mesmas operações e checksum.

O navegador de mensagens deixou de usar `turnIndex` como destino final. Ele usa
a âncora real por `message.id`, aguarda a revisão de layout dos disclosures e só
conclui depois de duas geometrias quietas. A auditoria reproduz uma mensagem
`708,781 px` abaixo do início do mesmo turno expandido. Ela chega a `32 px` do
topo nos viewports menores e ao scroll máximo matematicamente possível no
viewport de 1920 × 1080.

O gate visual corrente cobre 21 cenários em três viewports, totalizando
63 capturas. Além das regressões anteriores, valida saída ao vivo com auto-follow
de `0 px`, exclusão com `−288`, ausência do cabeçalho agrupado redundante,
navegação por âncora após expansão, ownership manual de scroll com drift `0` e
handoff de wheel entre comando, diff e leitura. As três transferências levam
`0,6–0,7 ms` juntas, não executam `getComputedStyle` e entregam exatamente
`−60`, `−120` e `−80 px` à timeline. O gate também cobre arquivo criado de 338
linhas colorido, `read_file`/`search_text` tipados, gutters compactos, três ondas
de atividade não sobrepostas em 4,2 s e o perfil com largura de `732 px`, avatar
de `80 px`, imagem efetivamente montada na página e na sidebar, 364 células,
cinco métricas, cinco insights e zero overflow. O gate pausa a animação em seis
pontos do ciclo e exige a sequência visível/oculta/visível/oculta/visível/oculta.

O build corrente produz app principal de `466,29 KiB` (`138,68 KiB` gzip),
chunk auxiliar de `20,47 KiB` (`8,14 KiB` gzip), CSS de `129,32 KiB`
(`23,81 KiB` gzip) e worker Markdown lazy de `63,48 KiB`. Contra o gate integral
de 21 de agosto, o payload inicial agregado passou de `151,10 KiB` para
`170,63 KiB` gzip, acréscimo de `19,53 KiB` (`12,93%`) para syntax, streaming,
navegação, perfil e demais superfícies novas. Nenhuma dependência, WASM ou worker
de runtime adicional foi introduzido; o worker Markdown continua lazy.

#### Comandos independentes em paralelo — 23 de agosto de 2026

O provider continua recebendo `parallel_tool_calls` apenas quando o modelo
declara suporte. O scheduler nativo forma lotes contíguos de até oito operações,
mantém mutações e aprovações como barreiras e persiste resultados na ordem das
chamadas. Leituras são intrinsecamente seguras; `exec_command` exige
`parallel_safe: true` e o perfil `danger-full-access/never`.

`pnpm measure:parallel-commands` inicia quatro processos PowerShell independentes
com a mesma espera útil de 180 ms. Após uma rodada de aquecimento, cinco amostras
alternam a ordem dos caminhos e validam conteúdo e ordenação:

| Caminho | Mediana |
| --- | ---: |
| quatro comandos sequenciais | `2.903,025 ms` |
| quatro comandos paralelos | `741,562 ms` |
| aceleração de tempo de parede | `3,915×` |

As cinco amostras paralelas ficaram entre `714,693 ms` e `795,816 ms`; as
sequenciais, entre `2.891,948 ms` e `2.918,971 ms`. O benchmark inclui startup
real de `pwsh`, não apenas timers no mesmo processo. Ele não autoriza concorrência
por inferência: um comando sem a declaração explícita ou fora do perfil seguro
continua exclusivo.

#### Comandos longos, yield e polling incremental — 23 de agosto de 2026

`pnpm measure:background-command` executa uma rodada de aquecimento e cinco
amostras de um processo PowerShell real que produz 16 KiB, permanece ativo,
permite um segundo comando independente e conclui com uma nova linha. O
benchmark release usa o piso local de 250 ms e compara o snapshot inicial com a
resposta posterior ao cursor:

| Medição | Resultado |
| --- | ---: |
| retorno mediano após `exec_command` | `261 ms` (`250–266 ms`) |
| comando independente mediano durante a sessão | `481 ms` (`470–510 ms`) |
| duração total mediana | `2.466 ms` (`2.461–2.474 ms`) |
| ganho mediano entre yield e conclusão | `9,43×` (`9,27–9,82×`) |
| payload do snapshot inicial | `16.513 bytes` |
| payload incremental posterior | `146 bytes` |
| redução mediana do payload repetido | `113,10×` |
| 2.000 snapshots completos de 256 KiB | `200.346 µs` |
| 2.000 polls incrementais sem cópia integral | `176 µs` |
| ganho por eliminação da cópia | `1.133,82×` |

Bytes são usados como proxy determinístico de tokens; a tokenização exata varia
por modelo. O gate exige pelo menos `4×` de ganho de responsividade e `20×` de
redução de payload. A implementação comum não repete o histórico append-only:
checkpoints recuperam apenas o sufixo posterior ao cursor. Reescritas de terminal
invalidam o checkpoint de forma explícita e usam snapshot, preservando correção
em vez de fingir um delta seguro.

O tipo de polling é separado do snapshot visual. Quando um checkpoint
append-only é válido, o backend clona somente o delta; não materializa primeiro
os até 512 KiB de `stdout` e `stderr` para descartá-los em seguida. A medição de
2.000 consultas usa `black_box`, o transcript no limite de 256 KiB e o mesmo
mutex assíncrono dos dois caminhos.

O teste também valida que o segundo comando termina antes do primeiro e que a
linha final não carrega novamente o marcador do histórico. O processo continua
com spool integral, cancelamento da árvore, limite de sessão e finalização
transacional; a redução afeta somente a resposta enviada ao agente.

O comando `pnpm measure:soak` cobre estruturas destinadas a sessões longas sem
simular rede ou provider. Na revalidação de 18 de agosto de 2026, 100.000 turnos,
10.000 medições de altura, 50.000 consultas de viewport e 5.000 blocos Markdown
produziram:

| Operação sintética | Resultado |
| --- | ---: |
| construção do índice de 100.000 turnos | 58,366 ms |
| 10.000 atualizações de altura | 5,113 ms |
| 50.000 consultas de viewport | 37,513 ms |
| maior conjunto montado por viewport | 8 turnos |
| 50.000 trocas de sessão da timeline | 13,843 ms, mediana de cinco coletas |
| 50.000 projeções do overlay sobre 100.000 turnos | 16,711 ms |
| 5.000 atualizações incrementais Markdown | 84,905 ms, mediana de cinco coletas |
| 20.000 projeções de atividade | 133,587 ms |
| 20.000 projeções de turno em streaming | 158,085 ms |

A linha de base registrada antes destas duas otimizações era 644,2 ms para as
trocas de sessão e 1.037,254 ms para Markdown. O resultado final representa cerca
de 46,5× e 12,2× de aceleração, respectivamente, ou reduções de aproximadamente
97,9% e 91,8%. A timeline reutiliza projeções imutáveis e o Markdown não compara
mais todo o prefixo acumulado a cada bloco. Não foi introduzido hash
probabilístico: a origem append-only é controlada pelo lifecycle de overlays e a
conclusão continua integral e autoritativa.

O teste nativo também persiste e percorre 1.200 turnos — acima do antigo teto
de 1.000 — por todas as páginas, validando cardinalidade e ordem sem um limite
total de histórico. Uma regressão frontend adicional projeta um overlay ativo
sobre 10.000 turnos sem materializar uma nova matriz. Esses cenários são
regressões locais reproduzíveis; o trace
de produção com heap, nós DOM e INP continua sendo a evidência necessária para
caracterizar uma sessão real de muitas horas.

O comando `pnpm measure:diff` mede separadamente parsing, projeção split,
highlight e consultas de viewport sem limitar o conteúdo. Em três execuções de
16 de agosto de 2026, cada uma com cinco amostras de um diff sintético com
150.001 linhas e 3.744.479 caracteres, os resultados foram:

| Operação sintética | Resultado |
| --- | ---: |
| estatísticas sem materializar linhas | 30,312 ms |
| documento unificado completo | 89,630 ms |
| projeção split completa e lazy | 64,516 ms |
| highlight de todo o documento | 623,162 ms |
| highlight da janela visível | 0,440 ms |
| linhas montadas no maior viewport | 73 |
| 100.000 consultas de viewport | 11,959 ms |
| redução de linhas montadas | 2.054,808 vezes |

A sequência inteira continua acessível do início ao fim; a redução ocorre apenas
na quantidade de linhas simultaneamente montadas. O canvas físico é limitado
para evitar limites de layout do WebView, mas preserva a altura lógica e o
mapeamento de todas as linhas. Esse benchmark roda em Node e não substitui
medidas de paint, heap ou INP no WebView de produção.

#### Motor próprio de syntax highlighting — 22 de agosto de 2026

Antes da mudança, `syntaxHighlight.ts` combinava palavras-chave de linguagens
distintas, ignorava o parâmetro de linguagem e gerava HTML diretamente. Em Rust,
`#[test]` podia ser classificado como comentário; somente linhas adicionadas ou
removidas recebiam decoração. O baseline imediatamente anterior mediu:

| Dimensão | Baseline |
| --- | ---: |
| parse de 150.001 linhas | 92,163 ms |
| projeção split de 100.001 rows | 63,592 ms |
| highlight stateless do documento completo | 638,955 ms |
| highlight stateless de 73 linhas | 0,394 ms |
| app principal | 420,38 KiB / 124,90 KiB gzip |
| worker Markdown | 45,58 KiB |

O motor novo possui registro explícito de linguagens, estado multiline, tokens
tipados, CSS semântico, renderização Solid no diff, escaping no Markdown e
fallback por limites. `pnpm measure:syntax` executa duas amostras de aquecimento
e sete válidas:

| Operação | Mediana |
| --- | ---: |
| 18 linguagens × 500 iterações | 52,567 ms |
| bloco Rust de 4.000 linhas | 16,407 ms |
| 1.000 serializações HTML seguras | 13,736 ms |
| cold path de 73 linhas de diff | 0,757 ms |
| warm path das mesmas 73 linhas | 0,044 ms |
| arquivo Rust criado com 338 linhas | 1,431 ms |
| fallback de hunk acima do limite | 0,002 ms |

A revalidação de 23 de agosto de 2026 alinhou o limite do diff ao preview nativo
de 128 KiB e 4.096 linhas. O caso que antes perdia todas as cores ficou abaixo
de 1,5 ms sem alterar o fallback patológico.

No corpus de diff completo, a série final permaneceu próxima do baseline no
parse (`92,754 ms`), reduziu o highlight integral para `506,087 ms`, manteve o
cold path abaixo de `1,3 ms` e o warm path abaixo de `0,2 ms`. A projeção split
subiu para `67,571 ms` porque conserva índices compactos de origem em dois
`Uint32Array`; o custo adicional de `3,98 ms` ocorre uma única vez em 100 mil
rows e evita ampliar cada objeto visual ou perder estado sintático no modo split.

O checkpoint isolado do motor produziu:

- app principal: `439,47 KiB`, `130,81 KiB` gzip;
- chunk auxiliar: `20,47 KiB`, `8,14 KiB` gzip;
- CSS: `119,65 KiB`, `22,09 KiB` gzip;
- worker Markdown: `62,50 KiB`.

Contra o baseline, o custo inicial adicional é `5,91 KiB` gzip, sem WASM,
worker novo, inicialização assíncrona ou dependência. O worker maior continua
lazy e só nasce para Markdown final acima de 32 KiB. A auditoria visual valida
quatorze cenários em três viewports, incluindo nove cores distintas, linhas de
contexto coloridas, fundos de adição/remoção preservados e ausência de overflow.

### Moldura e configurações — 18 de agosto de 2026

A moldura customizada agora pertence à raiz do aplicativo, acima da área de
conteúdo. Boot, login, conversa e configurações compartilham o mesmo titlebar;
overlays não disputam mais a sua área por `z-index`. O estado maximizado é lido
da janela nativa, o ícone alterna entre maximizar e restaurar e qualquer falha de
controle entra no diagnóstico normal do app.

As configurações usam uma largura de navegação independente da sidebar,
tipografia e espaçamento consistentes, superfícies semânticas e switches
acessíveis. `pnpm verify:visual` abre a preview por CDP em um perfil temporário,
captura PNGs e valida configurações, lista de Automações e editor nos viewports
`920 × 640`, `1280 × 820` e `1920 × 1080`. Nos nove cenários:

- o titlebar ocupou exatamente `0–34 px`;
- os controles permaneceram nos `138 px` finais da janela;
- o conteúdo e o overlay começaram em `34 px`, sem interseção com o titlebar;
- não houve overflow horizontal;
- a área de Automações manteve uma única navegação ativa, badge não lido, card,
  duas linhas de execução e ação primária;
- o editor manteve um único diálogo, seis campos nomeados, dois botões de rodapé
  e switch acessível;
- a navegação mediu `248–288 px` e o conteúdo útil permaneceu entre
  `533,219–820 px`.

As capturas ficam em `.freebuff/visual-audit/`. O teste geométrico evita
regressões objetivas de sobreposição e responsividade, mas não substitui revisão
humana de contraste, hierarquia e acabamento no WebView nativo.

### Autonomia prolongada — 16 de agosto de 2026

Os tetos internos que podiam encerrar ou perder trabalho prolongado foram
removidos ou convertidos em limites de segurança configuráveis:

- filas posteriores não possuem limite de quantidade, são persistidas por
  conversa e retomadas automaticamente após reinício;
- aprovações não expiram depois de um intervalo arbitrário;
- falhas transitórias de boot, transporte, timeout e HTTP 5xx usam backoff
  limitado e não possuem contador terminal enquanto o turno continuar ativo;
- rate limits preservam o reset informado, aguardam e consultam novamente;
- comandos usam uma hora por padrão, aceitam até sete dias por chamada e
  continuam canceláveis;
- streams possuem 30 minutos de inatividade semântica antes de reiniciar o ciclo
  transitório, em vez de cinco minutos;
- fechar a janela pelo `X` durante trabalho ativo a oculta para a bandeja; somente
  **Sair** encerra explicitamente o processo.

Isso não remove restrições externas. O aviso `usage_limit_reached` da tela de uso
é uma cota da conta/serviço, não um teto do aplicativo. Durante essa condição o
app pode permanecer ativo e aguardar o reset, mas não pode obrigar o provider a
gerar respostas. Também permanecem externos: desligamento ou reinício do
sistema, suspensão prolongada, falha permanente de autenticação/protocolo,
indisponibilidade de rede, espaço em disco, quota do armazenamento WebView e a
janela de contexto anunciada pelo modelo. A janela de contexto é tratada por
compactação transacional; as demais condições produzem espera ou erro explícito,
nunca descarte silencioso.

### Validação integral — 18 de agosto de 2026

`pnpm verify:frontend` e `pnpm verify:native` concluíram sem falhas:

- 47 arquivos e 221 testes frontend;
- TypeScript estrito e build Vite de produção;
- verificação de dependências transitivas, `cargo check`, `rustfmt` e Clippy com
  warnings tratados como erro;
- 194 testes Rust aprovados e 4 benchmarks ignorados no fluxo comum por design.

O build produziu o chunk principal do app com 399,24 KiB, ou 118,24 KiB gzip; o
chunk auxiliar ficou em 20,25 KiB, o CSS em 114,63 KiB, ou 21,53 KiB gzip, e o
worker Markdown em 45,51 KiB.

A linkedição Tauri release também concluiu com `opt-level = 3`, ThinLTO e uma
codegen unit, gerando
`.freebuff/release-validation-target/release/codex-desktop-next.exe`. O target
isolado foi necessário porque o executável canônico estava aberto; nenhum
processo foi encerrado ou substituído. Startup e memória do binário novo
continuam pendentes até que a instância atual possa ser fechada, pois o plugin de
instância única invalidaria uma segunda amostra.

Em novas medições, “demora para responder” deve ser decomposta em pelo menos
quatro intervalos: aceitação de `turn_start`, primeira rodada, espera de
ferramentas e rodadas subsequentes. Somar tudo em um único cronômetro esconde a
causa e não distingue rede, modelo, ferramenta e disputa de estado.

### Chat oficial, ferramentas e release isolada — 21 de agosto de 2026

O chat foi comparado com o build oficial `26.818.3698.0`. Naquele gate, a
auditoria visual executou onze cenários em `920 × 640`, `1280 × 820` e
`1920 × 1080`, produzindo trinta e três capturas. Três cenários são específicos
da conversa:

- reprodução do turno de referência, incluindo usuário, duração, três
  commentaries, comandos, leitura do terminal e resposta final, começando
  diretamente abaixo do titlebar sem título duplicado;
- atividade em andamento com as camadas `activity-title-base`,
  `activity-title-sweep` e `activity-title-highlight`, máscara luminosa e os
  keyframes sincronizados `activity-reflection-*`;
- alteração de um único arquivo renderizada diretamente e já expandida, sem o
  contêiner agregado reservado a mudanças com múltiplos arquivos.

Em 22 de agosto de 2026, o bundle do build oficial `26.818.4152.0` mostrou a
evolução desse último contrato: um patch simples permanece no grupo enquanto é
a atividade atual e, ao concluir sozinho, vira uma linha direta compacta,
recolhida e sem contorno ou fundo de cartão. O cenário visual corrente segue
esse fluxo e valida também que o ícone interno do grupo não vaza para a linha
independente. O gate frontend completo aprovou 50 arquivos e 240 testes,
os três benchmarks sintéticos, as 33 capturas e o build de produção.

A auditoria também rejeita as páginas removidas **Aparência** e **Segurança e
permissões**. O perfil permanece somente dentro de Configurações, enquanto o
menu da conta conserva uso, configurações e saída. A ação do menu de projeto
abre diretamente seu caminho persistido no Explorer, sem reutilizar o seletor
de workspace.

O gate integral de 21 de agosto aprovou 50 arquivos e 238 testes frontend, além
de 210 testes Rust; quatro benchmarks nativos continuam ignorados no fluxo
comum e foram executados separadamente quando aplicável. O build Vite produziu:

- app principal: `408,97 KiB`, `121,65 KiB` gzip;
- chunk auxiliar: `20,46 KiB`, `8,14 KiB` gzip;
- CSS: `115,54 KiB`, `21,31 KiB` gzip;
- worker Markdown: `45,51 KiB`.

Medições sintéticas após o porte:

| Operação | Resultado |
| --- | ---: |
| batching de 1.200 deltas sobre 20.000 itens | `223,020×` mais rápido |
| turnos simultaneamente montados em histórico de 100.000 | `8` |
| 5.000 blocos Markdown incrementais | `91,931 ms` |
| 20.000 projeções de atividade | `146,101 ms` |
| 20.000 projeções de turno | `162,892 ms` |
| highlight da janela visível de diff | `0,391 ms` |
| redução de linhas de diff montadas | `2.054,808×` |
| decode da página inicial de histórico | `0,229 ms` |
| redução de heap da página inicial | `99,527%` |

As ferramentas nativas em release mediram:

| Ferramenta | Resultado |
| --- | ---: |
| ripgrep contra scanner anterior | `2,098×` mais rápido |
| oito buscas duplicadas coalescidas | `87,5%` menos execuções |
| ganho de latência na coalescência | `1,536×` |
| compactação de saída de `2,44 MB` | `99,734%` em `14,841 ms` |

Para não compartilhar SQLite, OAuth ou recovery com a instância aberta, o
startup foi medido em um build de código idêntico com identificador Tauri
temporário e diretório de dados isolado:

Em 22 de agosto de 2026 foram executadas três séries independentes de sete
processos cada:

| Série | Mediana da janela responsiva | Working set médio | Memória privada média |
| ---: | ---: | ---: | ---: |
| 1 | `188,9 ms` | `32,3 MiB` | `7,8 MiB` |
| 2 | `80,9 ms` | `31,3 MiB` | `7,7 MiB` |
| 3 | `154,1 ms` | `29,9 MiB` | `7,6 MiB` |

A mediana das 21 partidas foi `158,9 ms` e a mediana das três medianas
`154,1 ms`. As partidas aquecidas variaram de `71,9 ms` a `232,4 ms`; uma
primeira partida fria levou `1.400,1 ms`. A média entre séries foi `31,2 MiB` de
working set e `7,7 MiB` privados, com executável de `12,5 MiB`. A instância
canônica aberta permaneceu responsiva e não foi encerrada ou substituída.

### Validação integral final — 23 de agosto de 2026

`pnpm verify` concluiu sem falhas no Windows com token de administrador e nível
de integridade alto:

- 291 arquivos de texto validados como UTF-8 sem BOM;
- 56 arquivos e 282 testes frontend aprovados;
- 21 cenários visuais em três viewports, totalizando 63 capturas;
- TypeScript estrito, Biome e build Vite de produção;
- bootstrap/hash do ripgrep e auditoria de dependências transitivas;
- `cargo check`, `rustfmt` e Clippy com warnings como erro;
- 273 testes Rust aprovados e 8 benchmarks ignorados no fluxo comum por design;
- benchmarks release de streaming, sessões longas e comandos paralelos
  executados separadamente dentro do mesmo gate.

Timeout e cancelamento iniciam processos reais, encerram a árvore e preservam
saída já drenada. Yield e polling usam processo real, e as regressões de storage
validam finalização transacional e reparo de atividades interrompidas após
reinício abrupto.

Os executáveis de teste da biblioteca e do aplicativo foram inspecionados com
`mt.exe`: ambos possuem exatamente um recurso de manifesto, Common Controls v6
e `requestedExecutionLevel="asInvoker"`. O mesmo harness executou com sucesso
sob o token elevado; portanto o erro anterior de `TaskDialogIndirect` não
dependia de privilégio e foi removido na composição do build.
