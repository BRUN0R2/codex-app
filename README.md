# Codex Desktop Next

Aplicativo desktop nativo e independente para executar um agente de código com
uma conta ChatGPT. O produto não inicia, empacota, importa nem exige o Codex CLI.
O repositório aberto `openai/codex` é usado somente como referência de protocolo
e comportamento.

O backend Rust possui autenticação, provider HTTPS/SSE, composição do agente,
ferramentas, aprovações e persistência. A interface SolidJS recebe apenas
contratos Tauri fechados e valida toda resposta ou evento em runtime antes de
alterar estado.

## Capacidades

- OAuth ChatGPT oficial com PKCE, callback local, renovação, revogação e
  cancelamento;
- credenciais em envelope `age` privado do aplicativo; a chave fica no Windows
  Credential Manager e tokens nunca atravessam o IPC ou o SQLite;
- catálogo de modelos, tiers e esforços obtido diretamente da sessão ChatGPT;
- respostas incrementais por HTTPS/SSE, raciocínio e pesquisa web hospedada;
- tarefas e histórico locais em SQLite com WAL, transações e concorrência
  otimista de configuração;
- ferramentas nativas fechadas para leitura, listagem, busca, edição, escrita e
  comandos;
- três perfis de permissão sem combinações implícitas: somente leitura, projeto
  com aprovação de comando e acesso total;
- limites explícitos para entrada, anexos, arquivos, resultados, processos,
  streams, histórico, paginação e encerramento;
- UI enxuta para projetos, tarefas, timeline, aprovações, anexos, modelos,
  configurações, uso da conta e diagnósticos.

## Stack

| Camada | Tecnologia |
| --- | --- |
| Shell | Tauri 2.11 |
| Backend | Rust 1.97.1, edition 2024, Tokio |
| HTTP | reqwest 0.13, rustls e SSE incremental |
| Persistência | SQLite via rusqlite 0.40 |
| Credenciais | age+scrypt e Windows Credential Manager |
| Interface | SolidJS 1.9.14 e TypeScript 7.0.2 estrito |
| Build e qualidade | Vite 8.2, Biome 2.5, Vitest 4.1, pnpm 11.18 |

As versões diretas são fixadas em `package.json`, `Cargo.toml` e
`rust-toolchain.toml`; os grafos completos ficam travados nos lockfiles.

## Pré-requisitos

- Windows 10 ou 11 com WebView2;
- conta ChatGPT com acesso ao Codex;
- Node.js 26 ou superior e pnpm 11.18 ou superior;
- Rust 1.97.1 e toolchain MSVC para desenvolvimento nativo.

O Codex CLI não é pré-requisito.

## Desenvolvimento

```powershell
pnpm install --frozen-lockfile
pnpm tauri dev
```

Na primeira execução, **Continuar com ChatGPT** abre a autorização no navegador.
A sessão é criada no diretório de dados deste aplicativo; credenciais existentes
da CLI não são lidas ou migradas.

## Verificação

```powershell
pnpm verify
```

O gate executa lint, testes TypeScript, tipagem, build de produção, `cargo check`,
`rustfmt`, Clippy com warnings como erros e testes Rust.

Para gerar o instalador NSIS:

```powershell
pnpm tauri build
```

## Organização

- `src/contracts`: domínio TypeScript e decoders de fronteira;
- `src/infrastructure`: comandos e eventos Tauri;
- `src/state`: ownership reativo e reduções determinísticas;
- `src/ui`: componentes sem acesso direto ao IPC;
- `src-tauri/src/engine/native`: agente, auth, provider, storage, ferramentas e
  aprovações;
- `docs`: regras, arquitetura, contrato do engine e estudo da referência.

Consulte [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/ENGINE.md](docs/ENGINE.md), [docs/REFERENCE.md](docs/REFERENCE.md) e
[docs/RULES.md](docs/RULES.md).
