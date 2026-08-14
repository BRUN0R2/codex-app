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

- o contrato 5 envia lotes heterogêneos de deltas: o primeiro delta de cada
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
- ao chegar ao topo por uma ação do usuário, a página anterior é carregada e a
  âncora visual é mantida sem remover histórico já carregado;
- o SQLite usa WAL e pool persistente dimensionado pela máquina; leituras podem
  avançar em paralelo e pares provider/timeline são gravados numa transação;
- durante uma execução, o agente conserva o histórico decodificado em memória,
  lê do SQLite apenas itens posteriores ao cursor e serializa requests por
  referência. Steers continuam entrando na ordem transacional do banco.

O cenário sintético reproduzível usa 20.000 itens e 1.200 deltas destinados à
última mensagem. Antes da alteração, a projeção integral anterior levou
994,21 ms em uma amostra local. Em três execuções de 14 de agosto de 2026,
`pnpm measure:streaming` coletou sete amostras após duas de aquecimento por
execução:

| Caminho atual | Mediana |
| --- | ---: |
| 1.200 atualizações sequenciais | 18,887–19,287 ms |
| um lote coalescido | 0,100–0,126 ms |

O lote ficou entre 150 e 193 vezes mais rápido que as atualizações sequenciais
já otimizadas nesse cenário. Este benchmark mede somente custo local de redução
de estado; não representa TTFT de rede, tempo do modelo ou tempo de ferramentas.

O comando `pnpm measure:soak` cobre estruturas destinadas a sessões longas sem
simular rede ou provider. Em cinco coletas de 14 de agosto de 2026, 100.000
turnos, 10.000 medições de altura, 50.000 consultas de viewport e 5.000 blocos
Markdown produziram; a coleta final incluiu também 50.000 projeções do overlay
ativo:

| Operação sintética | Resultado |
| --- | ---: |
| construção do índice de 100.000 turnos | 62,818–75,018 ms |
| 10.000 atualizações de altura | 4,868–6,046 ms |
| 50.000 consultas de viewport | 31,615–32,858 ms |
| maior conjunto montado por viewport | 8 turnos |
| 50.000 projeções do overlay sobre 100.000 turnos | 21,679–23,804 ms |
| 5.000 atualizações incrementais Markdown | 1.088,267–1.116,955 ms |

O teste nativo também persiste e percorre 1.200 turnos — acima do antigo teto
de 1.000 — por todas as páginas, validando cardinalidade e ordem sem um limite
total de histórico. Uma regressão frontend adicional projeta um overlay ativo
sobre 10.000 turnos sem materializar uma nova matriz. Esses cenários são
regressões locais reproduzíveis; o trace
de produção com heap, nós DOM e INP continua sendo a evidência necessária para
caracterizar uma sessão real de muitas horas.

A interface preview também foi validada ao vivo em 14 de agosto de 2026 nos
viewports solicitados de `920 × 640`, `1280 × 820` e `1920 × 1080`. Nos três
casos não houve overflow horizontal, e timeline e compositor permaneceram
visíveis. Escritas de layout originadas por `ResizeObserver` são coalescidas no
próximo frame; a repetição do teste não produziu warnings ou erros no console.

Em novas medições, “demora para responder” deve ser decomposta em pelo menos
quatro intervalos: aceitação de `turn_start`, primeira rodada, espera de
ferramentas e rodadas subsequentes. Somar tudo em um único cronômetro esconde a
causa e não distingue rede, modelo, ferramenta e disputa de estado.
