# Codex Desktop Next

Cliente Windows nativo e independente para ChatGPT Chat, ChatGPT Work local e
um agente Codex. O aplicativo usa a conta ChatGPT, mas não inicia, empacota nem
depende do Codex CLI. O repositório público `openai/codex` serve apenas como
referência de protocolo e comportamento.

## O que o aplicativo oferece

- OAuth ChatGPT com PKCE, renovação, revogação e cancelamento;
- Chat e Codex com catálogos próprios, streaming HTTPS/SSE e histórico isolado;
- tarefas simultâneas, direcionamento, interrupção, compactação, fork e arquivo;
- agente nativo com ferramentas de arquivos, comandos, planos, imagens e browser;
- três perfis explícitos: somente leitura, escrita no projeto e acesso total;
- processos longos em segundo plano, saída incremental e encerramento da árvore;
- SQLite local com WAL e credenciais protegidas pelo Windows Credential Manager;
- limites, aprovações e contratos Tauri validados nas duas fronteiras;
- interface SolidJS para tarefas, modelos, uso, automações e configurações.

## Arquitetura

| Camada | Responsabilidade |
| --- | --- |
| Rust/Tauri | autenticação, provider, agente, ferramentas, browser e persistência |
| TypeScript/SolidJS | contratos decodificados, estado da interface e apresentação |
| SQLite | tarefas, eventos, configurações e metadados não secretos |
| Windows Credential Manager | chave usada para proteger credenciais locais |

As versões e o grafo de dependências são definidos pelos manifestos e lockfiles.
Consulte [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) para os limites entre
módulos e [docs/ENGINE.md](docs/ENGINE.md) para o contrato do agente.

## Requisitos

- Windows 10 ou 11 com WebView2;
- conta ChatGPT com acesso aos recursos usados;
- PowerShell 7 (`pwsh`);
- Node.js 26 ou superior e pnpm 11.22 ou superior;
- Rust 1.98.0 com toolchain MSVC.

O Codex CLI não é necessário.

## Desenvolvimento

```powershell
pnpm install --frozen-lockfile
pnpm dev:launch
```

O primeiro comando instala exatamente o lockfile. O segundo inicia Vite e o
shell Tauri em um perfil de desenvolvimento separado.

Para trabalhar apenas na interface:

```powershell
pnpm dev
```

Abra `http://127.0.0.1:1420/?preview=1`. O preview usa contratos determinísticos,
rejeita operações nativas e não entra no bundle de produção.

## Verificação

```powershell
pnpm verify
```

Esse é o gate completo: encoding, lint, tipagem, testes, benchmarks de regressão,
QA visual, build de produção, dependências transitivas, `cargo check`, formato,
Clippy e testes Rust.

Comandos úteis:

```powershell
pnpm smoke:browser   # fluxo real do child WebView2 sem conta
pnpm measure:tokens  # orçamento de contexto e compactação
pnpm tauri build     # bundle NSIS local
```

Releases oficiais seguem [docs/RELEASE.md](docs/RELEASE.md).

## Estrutura

- `src/contracts`: tipos e decoders de fronteira;
- `src/infrastructure`: comandos e eventos Tauri;
- `src/state`: estado reativo e reduções determinísticas;
- `src/ui`: apresentação sem acesso direto ao IPC;
- `src-tauri/src/engine/native`: agente, auth, provider, storage e ferramentas;
- `scripts`: gates, medições e automação local;
- `docs`: contrato, arquitetura, referência, desempenho e release.

Antes de alterar o projeto, leia [docs/RULES.md](docs/RULES.md). O backlog ativo
fica em [docs/TODO.md](docs/TODO.md).
