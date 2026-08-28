# Referência do Codex oficial

Este documento registra apenas conclusões que afetam o produto. A implementação
local continua independente.

## Snapshot auditado

| Fonte | Versão |
| --- | --- |
| [`openai/codex`](https://github.com/openai/codex) | commit `6be2a6ca952ac9f70676ce4dd07fda27175aa9dd`, 28/08/2026 |
| release estável | `rust-v0.150.1`, commit `90854393966b21e9ebfd21b122334eb09a20c93d` |
| Codex Desktop para Windows | build `26.818.5229.0`, validado em 28/08/2026 |

O clone de estudo fica em `.references/openai-codex`, que é ignorado. Nenhum
crate, pacote, executável, banco, configuração ou credencial da referência entra
no build ou no runtime local.

O parâmetro `client_version` do catálogo local permanece `0.150.1`, a última
release estável cujo protocolo foi auditado.

## Topologia oficial

CLI, extensão e Desktop compartilham o core aberto e o protocolo `app-server`.
No Windows, o Desktop auditado iniciou:

```text
codex.exe -c features.code_mode_host=true app-server --analytics-default-enabled
└─ codex-code-mode-host.exe
```

O Desktop não usa o fluxo interativo da CLI, mas usa o mesmo harness para loop,
contexto, ferramentas, sandbox, aprovações, streaming e continuidade. Este
projeto reproduz os contratos necessários em `NativeEngine`, sem executar esses
binários.

Referências oficiais:

- [repositório e core](https://github.com/openai/codex);
- [app-server](https://learn.chatgpt.com/docs/app-server);
- [Codex como plataforma](https://learn.chatgpt.com/blog/codex-as-a-platform);
- [Browser Use](https://learn.chatgpt.com/docs/browser);
- [aplicativo para Windows](https://learn.chatgpt.com/docs/windows/windows-app).

## Conclusões portadas

| Área | Comportamento confirmado | Decisão local |
| --- | --- | --- |
| OAuth | PKCE, callback local, troca, renovação e revogação | implementação Rust própria e cofre isolado |
| modelos | catálogo autoritativo com capabilities | parser fechado; UI não fixa capacidades por nome |
| Responses | Standard, Lite, SSE e itens tipados | parsers e requests nativos separados |
| histórico | cada tool call possui exatamente um output | normalização e reparo transacional |
| instruções | template do catálogo mais contexto factual do runtime | camadas limitadas, sem prompt universal duplicado |
| cache | catálogo curto em memória e invalidação por ETag | TTL de 5 min, sem cache persistente |
| contexto | janela do catálogo e Remote Compaction V2 | orçamento dinâmico e checkpoint atômico |
| comandos | yield, sessão registrada, polling e output incremental | manager próprio com Job Object no Windows |
| paralelismo | ferramentas independentes podem sobrepor execução | lote local máximo de 8 e ordem determinística |
| patch | ferramenta freeform com parser dedicado | gramática Lark e commit transacional próprios |
| imagens | inspeção multimodal é uma tool activity nativa | `view_image`, miniatura e visualizador próprios |
| browser | superfície visível, ações fechadas e aprovação de origem | child WebView2 controlado pelo engine |

O core oficial não define um único “máximo de comandos paralelos” equivalente
ao limite local: o agendamento depende dos handlers e das barreiras. O manager
oficial admite até 64 processos Unified Exec; este projeto limita uma rodada a
8 ferramentas e o registry a 32 sessões. Esses limites são intencionais e
cobertos por testes.

## Instruções e prompts

O fluxo oficial é híbrido:

1. o servidor entrega `model_messages.instructions_template` e capabilities;
2. o cliente acrescenta instruções do usuário e do repositório, permissão,
   colaboração, workspace, shell, data e timezone;
3. o provider recebe cada camada com papel e tamanho próprios.

Portanto, instruções locais são necessárias para fatos que só o runtime conhece,
mas não devem repetir personalidade ou protocolo já fornecidos pelo catálogo. O
protocolo comportamental manual antigo e nudges específicos de browser foram
removidos porque competiam com templates mais atuais.

Responses Lite mantém a mesma semântica por wire diferente: tools entram em
`additional_tools`, funções ficam no namespace `functions` e instruções-base
viram mensagem developer com IDs estáveis. O contrato é escolhido pela capability
do modelo, nunca por fallback após uma requisição falhar.

## Cache e integridade

O catálogo não é salvo em disco. ETag igual renova o TTL; ETag diferente invalida
imediatamente; ausência do header não destrói uma entrada válida. A chave de
prompt é o ID estável da tarefa, evitando fragmentação entre rodadas e polls.

A auditoria local validou `PRAGMA integrity_check`, JSON persistido e referências
entre tabelas sem encontrar corrupção. O problema de eficiência observado não
era cache corrompido: as causas estavam em instruções redundantes, capabilities
não respeitadas e diferenças do loop, corrigidas nos respectivos módulos.

## Code Mode, multiagente e Ultra

No core oficial, Code Mode é um subsistema com protocolo, runtime V8 sandboxed,
host, negociação, backpressure, limites, yield e cancelamento. Expor apenas uma
tool JavaScript não seria equivalente nem seguro.

Modelos `code_mode_only` permanecem visíveis, porém bloqueados sem o host. Uma
preferência antiga incompatível volta ao modelo padrão utilizável. Ultra permanece
bloqueado sem multiagente v2, e seu requisito aparece somente na própria opção.
O engine não anuncia capabilities ausentes nem envia `ultra` ao provider. As
implementações completas estão no backlog; shims são proibidos.

## Imagens e Browser Use

O Desktop representa a inspeção de imagem como atividade da ferramenta, com
miniatura expansível. O fluxo local segue o mesmo contrato visual e semântico:
`view_image` decodifica o arquivo, envia conteúdo multimodal e publica a atividade
“Visualizou uma imagem”. Não há navegação para `file://` nem abertura do browser.

Browser Use é um subsistema diferente: controla página HTTP(S) visível por ações
fechadas, screenshot, snapshot e aprovação da primeira origem. Computer Use,
controle amplo do desktop e CDP irrestrito não fazem parte do escopo local.

## Decisões não portadas

- armazenamento, config e processo do Codex CLI;
- host Code Mode incompleto;
- multiagente ou Ultra simulados;
- Computer Use amplo;
- CDP arbitrário e perfil de navegação externo;
- Responses WebSocket sem equivalência comprovada com SSE;
- compatibilidade genérica com versões antigas do protocolo.

## Cobertura antirregressão

Fixtures e testes locais travam:

- schemas Rust ↔ TypeScript e métodos de evento;
- Standard ↔ Lite e instruções por capability;
- TTL/ETag e ausência de cache persistente;
- pareamento call/output, ordenação e retomada;
- paralelismo, barreiras, yield, cursor e cancelamento;
- compactação e recuperação de janela;
- atomicidade do patch;
- validação, apresentação e limites de imagem;
- origem, bounds e lifecycle do browser.

## Atualização da referência

Ao mudar o snapshot:

1. registre commit e release estável;
2. revise apenas áreas usadas pelo produto;
3. compare protocolo e comportamento antes de portar código;
4. implemente no domínio local com testes de regressão;
5. atualize `client_version` somente após validar o catálogo;
6. execute `pnpm verify`.
