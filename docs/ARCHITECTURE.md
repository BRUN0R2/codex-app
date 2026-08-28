# Arquitetura

O aplicativo separa apresentação, estado, IPC e domínio nativo. O backend Rust
é a autoridade sobre autenticação, agente, ferramentas, browser, processos e
persistência; o frontend apresenta contratos já validados.

```text
SolidJS UI
    ↓ ações / ↑ estado
State controllers
    ↓ contratos tipados
Tauri infrastructure
    ↓ commands / ↑ events
Rust NativeEngine
    ├─ auth e providers
    ├─ loop do agente, Code Mode e multiagente
    ├─ ferramentas e runtime V8 isolado
    ├─ browser WebView2 e processos
    └─ SQLite e cofre de credenciais
```

## Fronteiras

| Camada | Responsabilidade | Não deve fazer |
| --- | --- | --- |
| `src/ui` | renderização e interação | acessar IPC ou decidir regras do domínio |
| `src/state` | ownership reativo e transições | aceitar payload externo sem decoder |
| `src/infrastructure` | commands, events e adaptação Tauri | manter regra de negócio |
| `src/contracts` | tipos e decoders de fronteira | inferir ou reparar payload inválido |
| `src-tauri/src/engine/native` | agente, auth, provider, storage e ferramentas | depender do frontend ou da CLI |
| `src-tauri/src/browser` | lifecycle e automação do child WebView2 | expor acesso irrestrito à webview |
| `src-tauri/src/process` | ownership dos processos filhos | deixar árvores órfãs |

Contratos inválidos falham na fronteira. Não existe fallback para um formato
aproximado nem acesso direto do componente ao comando nativo.

## Fluxo de inicialização

1. O shell cria o estado nativo e registra commands e events.
2. O frontend solicita o snapshot do engine.
3. Rust valida configuração, banco e credenciais antes de responder.
4. `src/contracts` decodifica a resposta.
5. O controller publica um estado pronto ou um erro explícito e repetível.

Uma falha não produz estado parcialmente inicializado. Tentativas posteriores
reexecutam a fronteira responsável.

## Fluxo de uma tarefa Codex

1. A UI envia um turno validado ao controller.
2. O engine persiste a intenção e monta contexto, modelo, instruções e catálogo
   compatível com as capacidades ativas.
3. O provider transmite itens Responses por SSE.
4. O loop converte deltas em eventos, persiste itens completos e executa chamadas
   de ferramenta autorizadas.
5. Saídas são limitadas e compactadas antes de voltar ao contexto do modelo.
6. Conclusão, falha, interrupção e recuperação fecham o turno de modo explícito.

Tarefas distintas podem progredir em paralelo. Cada recurso compartilhado tem
um dono e limites próprios; cancelamento não depende de desmontar a interface.

## Code Mode e colaboração

Code Mode executa JavaScript em um isolate V8 dedicado. O modelo recebe apenas
um manifesto tipado das ferramentas permitidas; callbacks atravessam uma ponte
Rust limitada, cancelável e sem acesso implícito a Node.js, filesystem, rede ou
processo. Leituras podem coexistir, enquanto mutações criam uma barreira e
invalidam o cache da célula.

Multiagente v2 mantém identidade, árvore, mailbox e estado no SQLite. Spawn,
mensagens, follow-up, interrupção, listagem e espera são operações diretas do
agente e nunca entram recursivamente no Code Mode. O limite é de quatro agentes
ativos, incluindo a raiz, e 64 tarefas por árvore durante sua vida útil.

## Ferramentas e comandos

O catálogo é construído no backend conforme perfil de permissão, plataforma e
capacidades do modelo. Ferramentas nunca escolhem permissões por conta própria.

- leitura, listagem e busca validam o workspace e possuem limites;
- escrita e patch usam alvos normalizados e operações transacionais quando há
  múltiplos arquivos;
- comandos usam sessões limitadas, saída incremental e Job Object no Windows;
- processos longos cedem o turno de execução e são consultados por cursor;
- resultados extensos são compactados ou armazenados para leitura direcionada.

O contrato completo está em [ENGINE.md](ENGINE.md).

## Imagens

Anexos são inspecionados no backend. `view_image` lê e valida a imagem local,
persiste uma cópia gerenciada dos mesmos bytes enviados ao provider e publica
uma atividade própria na timeline. A interface exibe a miniatura e o visualizador
nativo; abrir um navegador não faz parte desse fluxo.

## Browser Use

O browser usa child WebView2 visível e separado da interface principal. O
backend controla abas, navegação, viewport, snapshot, screenshot, ponteiro,
teclado, espera e métricas. A UI apenas sincroniza a superfície e apresenta o
estado.

Navegação e ações sensíveis respeitam a origem e o perfil de aprovação. O agente
recebe resultados estruturados ou imagens, nunca acesso arbitrário ao DOM da
aplicação.

## Persistência e secrets

- SQLite em WAL guarda tarefas, eventos, agentes, mailboxes, configuração e
  metadados;
- mudanças compostas usam transações e concorrência otimista quando aplicável;
- pares incompletos de chamada e saída são reparados por regras explícitas;
- credenciais são cifradas em envelope privado do aplicativo;
- a chave do envelope fica no Windows Credential Manager;
- tokens não atravessam IPC e não são armazenados no SQLite.

Schemas possuem versão e migrações internas testadas. Banco ou cofre com
identidade incompatível são rejeitados em vez de reinterpretados.

## Estado e renderização

Controllers mantêm ownership por domínio: conta, projetos, tarefas, browser,
automações e preferências. Projeções pesadas são memoizadas e listas extensas
são virtualizadas. Markdown, syntax highlighting, diffs e saídas grandes usam
trabalho incremental para não bloquear a interface.

Eventos podem chegar enquanto outra tarefa está visível; identidade de tarefa e
turno acompanha cada redução para impedir vazamento de estado entre sessões.

## Invariantes

- Rust é a autoridade do domínio nativo; UI é a autoridade de apresentação.
- Toda fronteira externa valida schema, tamanho e identidade.
- Tokens e secrets nunca entram no contrato Tauri.
- Nenhuma ferramenta amplia a permissão configurada.
- Nenhum processo filho sobrevive ao owner.
- Nenhuma saída ilimitada entra na memória, no IPC ou no contexto do modelo.
- Persistência composta é atômica ou falha visivelmente.
- Preview, mocks e fixtures não entram no comportamento de produção.
- O aplicativo não lê configuração, dados ou credenciais do Codex CLI.

Essas invariantes devem ser cobertas no ponto mais próximo do contrato e pelo
gate `pnpm verify`.
