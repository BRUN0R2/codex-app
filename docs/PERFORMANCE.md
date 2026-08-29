# Desempenho

Os scripts são a fonte dos cenários e limites. Este documento mantém apenas o
método e a última fotografia dos gates reproduzíveis; não acumula séries
históricas.

## Como medir

```powershell
pnpm verify:benchmarks  # regressões de UI, stream e comandos
pnpm measure:tokens     # catálogo, contexto e compactação
pnpm measure:release    # startup e memória do executável release
pnpm measure:browser    # métricas capturadas pelo Browser Use
```

Use release, máquina ociosa e o mesmo hardware. Registre sistema, modelo, esforço,
tier e rede quando houver provider. Não compare condições diferentes nem trate
um smoke funcional como benchmark.

`measure:release` abre o executável indicado, mede a primeira janela responsiva,
aguarda a estabilização, coleta working set e memória privada e fecha a mesma
instância normalmente. Nunca encerre outro processo para produzir a amostra.

Tempo até o primeiro delta exige uma tarefa autenticada e controlada. Erro,
rate limit ou duração total não substituem essa medida.

## Baseline atual

Coleta local de 28/08/2026 em Windows com 28 processadores lógicos. Os tempos são
evidência desta execução, não garantias universais.

### Contexto e ferramentas

| Cenário | Resultado |
| --- | ---: |
| catálogo base, 20 tools | 13.977 B; ~3.495 tokens |
| catálogo somente leitura, 16 tools | 9.598 B; ~2.400 tokens |
| redução do catálogo somente leitura | 31,33% |
| build + encode do catálogo | 0,0227 ms mediano |
| output de provider, 2.439.995 B → 6.372 B | 99,7389% menor |
| comando moderado, 3.216 B → 414 B | 87,1269% menor |
| comando grande, 6.018 B → 633 B | 89,4816% menor |
| histórico, 232,169 MiB → 0,957 MiB | 99,588% menor |
| parse + decode do histórico inicial | 311,694× mais rápido |
| heap inicial do histórico | 99,576% menor |
| busca em output de 64 MiB, 65.536 B → 110 B | 99,8322% menor; 57,28 ms |
| 8 leituras idênticas | 1 execução; 87,5% menos chamadas |

### Interface e execução

| Cenário | Resultado |
| --- | ---: |
| streaming de texto batched | 195,684× o caminho sequencial |
| streaming de comando framed | 63,229× o caminho sequencial |
| diff de 150.001 linhas | 45 linhas montadas; janela em 0,320 ms |
| terminal incremental de 64 MiB | 1.368,10 ms; 46,8 MiB/s |
| comando após yield | resposta em 262 ms; trabalho independente em 499 ms |
| polling incremental | 146 B contra snapshot de 16.513 B |
| 4 comandos independentes | 749,72 ms paralelo contra 2.900,67 ms sequencial |

O QA visual passou em 920×640, 1280×820 e 1920×1080 sem overflow horizontal.
Ultra foi apresentado em `rgb(167, 139, 250)` (`#a78bfa`); aparência não altera
o bloqueio de capability no engine.

### Gate completo

| Verificação | Resultado |
| --- | ---: |
| encoding | 388 arquivos UTF-8 válidos |
| frontend | 80 arquivos; 449 testes aprovados |
| bundle principal JS | 442,45 kB; 134,41 kB gzip |
| CSS | 144,20 kB; 25,82 kB gzip |
| Rust | 418 aprovados; 9 benchmarks ignorados; 0 falhas |
| Cargo, formato e Clippy | aprovados sem warnings |

## Proteções contra regressão

| Risco | Proteção |
| --- | --- |
| deltas bloquearem a UI | batching, worker e benchmarks de streaming |
| histórico crescer com a conversa | paginação, virtualização e soak de 100 mil turnos |
| output ocupar memória ou IPC | spool, cursor, compactação e cenário de 64 MiB |
| diff montar o documento inteiro | janela virtual e corpus de 150 mil linhas |
| comandos longos bloquearem o agente | yield, polling incremental e trabalho independente |
| concorrência quebrar ordem | lote com barreiras e benchmark de comandos paralelos |
| tools consumirem contexto sem controle | orçamento do catálogo e `measure:tokens` |
| browser degradar layout | matrizes de viewport, métricas e smoke WebView2 |
| taxa de atualização alterar o QA | sondagem de identidade controlada, separada do scroll rápido |
| processos escaparem do turno | testes Windows com Job Object e descendente real |

Os thresholds vivem nos scripts para que documentação e gate não divirjam.
Qualquer alteração de cenário deve atualizar o teste, justificar o novo limite e
substituir o baseline desta página após `pnpm verify` completo.
