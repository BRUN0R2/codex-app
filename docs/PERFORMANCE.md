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
  referência. Steers continuam entrando na ordem transacional do banco.

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
| scanner sequencial anterior | 488,321 ms |
| `ripgrep` empacotado | 226,521 ms |
| aceleração | 2,156× |

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
prévia final enviada ao provider mediu 6.494 bytes e levou 12,6204 ms para ser
produzida:

| Dimensão | Original | Prévia atual | Redução |
| --- | ---: | ---: | ---: |
| bytes UTF-8 | 2.439.995 | 6.494 | 99,7339% |
| linhas originais | 40.000 | — | — |

O teste também exige que a linha de falha e o identificador do recurso integral
permaneçam presentes. A porcentagem acima mede bytes, não tokens: a economia
exata de tokens depende do tokenizer e do conteúdo. Também não representa
latência de rede ou do modelo.

#### Benchmark da conversa de referência — 16 de agosto de 2026

`pnpm measure:history` reproduz 741 turnos, 15.529 itens de transcript e 231 MiB
de texto. O contrato JSON completo mede 232,169 MiB. A consulta real pagina
linhas de itens antes de agrupá-las em turnos; portanto o lote inicial de 64 é
comparável ao alvo exibido na referência, e não significa 64 turnos.

| Dimensão | Contrato completo | Página inicial atual | Redução |
| --- | ---: | ---: | ---: |
| itens materializados | 15.529 | 64 | 99,588% |
| contrato codificado | 232,169 MiB | 0,957 MiB | 99,588% |
| crescimento incremental de heap Node | 243,716–243,738 MiB | 1,148 MiB | 99,529% |
| requisições para abrir | — | 1 | — |

No corpus sintético, os 64 itens representam os quatro turnos mais recentes. Em
três execuções isoladas, com três amostras completas e sete amostras da página
por execução:

| Caminho local | Completo | Página inicial | Aceleração |
| --- | ---: | ---: | ---: |
| validação do contrato | 32,284–34,210 ms | 0,198–0,222 ms | 148,2–163,1× |
| `JSON.parse` + validação | 302,631–307,001 ms | 0,939–0,952 ms | 322,1–326,6× |

Antes da última otimização, a validação criava um `TextEncoder` e um buffer
proporcional para cada campo. No mesmo benchmark ela consumiu 145,866 ms no
contrato completo e 0,678 ms na página. A medição UTF-8 atual reutiliza um buffer
de 64 KiB com `encodeInto`, interrompe cedo quando ultrapassa o limite e reduziu
esse custo em aproximadamente 4,3 vezes no contrato completo e 3 vezes na
página. O caminho `JSON.parse` + validação completo caiu de 438,127 ms para
302,631–307,001 ms.

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
| 1.200 atualizações sequenciais | 19,063–19,342 ms |
| um lote coalescido | 0,116–0,125 ms |

O lote ficou entre 154,7 e 164,3 vezes mais rápido que as atualizações sequenciais
já otimizadas nesse cenário. Este benchmark mede somente custo local de redução
de estado; não representa TTFT de rede, tempo do modelo ou tempo de ferramentas.

O comando `pnpm measure:soak` cobre estruturas destinadas a sessões longas sem
simular rede ou provider. Nas coletas de 16 de agosto de 2026, 100.000 turnos,
10.000 medições de altura, 50.000 consultas de viewport e 5.000 blocos Markdown
produziram; as três coletas incluíram também 50.000 trocas entre 12 sessões de
timeline com 1.000 turnos cada e 20.000 atualizações de projeções estáveis:

| Operação sintética | Resultado |
| --- | ---: |
| construção do índice de 100.000 turnos | 59,552–62,693 ms |
| 10.000 atualizações de altura | 4,807–5,210 ms |
| 50.000 consultas de viewport | 37,022–38,350 ms |
| maior conjunto montado por viewport | 8 turnos |
| 50.000 trocas de sessão da timeline | 306,501–655,780 ms |
| 50.000 projeções do overlay sobre 100.000 turnos | 14,262–15,507 ms |
| 5.000 atualizações incrementais Markdown | 1.095,358–1.115,506 ms |
| 20.000 projeções de atividade | 133,830–137,081 ms |
| 20.000 projeções de turno em streaming | 157,037–163,420 ms |

A dispersão nas trocas de sessão vem de uma única janela cronometrada sujeita a
coleta de lixo; mesmo o extremo corresponde a aproximadamente 13 microssegundos
por troca. Não foi adicionado hash ou estado duplicado para otimizar esse
microbenchmark e criar risco de invalidação incorreta.

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
| estatísticas sem materializar linhas | 30,021–30,436 ms |
| documento unificado completo | 90,052–92,955 ms |
| projeção split completa e lazy | 63,913–67,954 ms |
| highlight de todo o documento | 639,852–654,429 ms |
| highlight da janela visível | 0,379–0,462 ms |
| linhas montadas no maior viewport | 73 |
| 100.000 consultas de viewport | 12,083–12,499 ms |
| redução de linhas montadas | 2.054,808 vezes |

A sequência inteira continua acessível do início ao fim; a redução ocorre apenas
na quantidade de linhas simultaneamente montadas. O canvas físico é limitado
para evitar limites de layout do WebView, mas preserva a altura lógica e o
mapeamento de todas as linhas. Esse benchmark roda em Node e não substitui
medidas de paint, heap ou INP no WebView de produção.

### Moldura e configurações — 18 de agosto de 2026

A moldura customizada agora pertence à raiz do aplicativo, acima da área de
conteúdo. Boot, login, conversa e configurações compartilham o mesmo titlebar;
overlays não disputam mais a sua área por `z-index`. O estado maximizado é lido
da janela nativa, o ícone alterna entre maximizar e restaurar e qualquer falha de
controle entra no diagnóstico normal do app.

As configurações usam uma largura de navegação independente da sidebar,
tipografia e espaçamento consistentes, superfícies semânticas e switches
acessíveis. `pnpm verify:visual` abre a preview por CDP em um perfil temporário,
captura PNGs e valida geometria nos viewports `920 × 640`, `1280 × 820` e
`1920 × 1080`. Nas três medições:

- o titlebar ocupou exatamente `0–34 px`;
- os controles permaneceram nos `138 px` finais da janela;
- o conteúdo e o overlay começaram em `34 px`, sem interseção com o titlebar;
- não houve overflow horizontal;
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

### Validação integral — 16 de agosto de 2026

`pnpm verify` concluiu sem falhas:

- 41 arquivos e 192 testes frontend;
- TypeScript estrito e build Vite de produção;
- verificação de dependências transitivas, `cargo check`, `rustfmt` e Clippy com
  warnings tratados como erro;
- 165 de 165 testes Rust.

O build produziu o chunk principal do app com 366,23 KiB, ou 109,39 KiB gzip; o
chunk auxiliar ficou em 20,25 KiB, o CSS em 95,87 KiB e o worker Markdown em
45,49 KiB.

A linkedição nativa release atual não pôde ser concluída dentro desta sessão:
quatro execuções/retomadas chegaram a 2.315 artefatos em
`src-tauri/target/release/deps`, mas cada processo foi encerrado pelo teto externo
de 120 segundos antes de gerar `codex-desktop-next.exe`. O perfil continua com
`opt-level = 3`, ThinLTO e uma codegen unit; ele não foi enfraquecido para
fabricar uma medição. Portanto as métricas de executável, startup e working set
de 14 de agosto continuam sendo a última coleta release válida, e uma nova
medição permanece pendente em um terminal sem esse teto.

Em novas medições, “demora para responder” deve ser decomposta em pelo menos
quatro intervalos: aceitação de `turn_start`, primeira rodada, espera de
ferramentas e rodadas subsequentes. Somar tudo em um único cronômetro esconde a
causa e não distingue rede, modelo, ferramenta e disputa de estado.
