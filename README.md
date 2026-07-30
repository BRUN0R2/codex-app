# Codex App

Base desktop nativa, modular e enxuta para experimentar um agente com a
ergonomia do Codex Desktop. O shell usa Tauri e Rust, a interface usa SolidJS e
TypeScript e a composição do agente pertence ao `NativeEngine` deste projeto.

O login é feito com a conta ChatGPT pelo fluxo oficial do Codex. Nesta etapa de
migração, autenticação, inferência e eventos ainda atravessam uma ponte de
compatibilidade isolada para o `codex app-server`. A UI não recebe tokens e o
SQLite nativo não armazena credenciais.

## O que já funciona

- `NativeEngine` como backend padrão, selecionado por um contrato `AgentEngine`;
- módulos independentes para autenticação, provider, ferramentas, permissões e
  armazenamento;
- SQLite nativo versionado para metadados de tarefas e operações, com WAL;
- login e logout oficiais pelo ChatGPT, reutilizando uma sessão existente;
- seleção de workspace, criação de tarefa e envio/interrupção de turnos;
- streaming de texto e atividades;
- anexos de arquivos e imagens, incluindo colar imagens no compositor;
- validação nativa de caminho, limite, tamanho e assinatura real das imagens;
- aprovações explícitas para comandos e alterações de arquivos;
- presets semânticos de permissão e edição atômica da configuração;
- configurações em tela inteira, modelos, esforço, velocidade e diagnósticos;
- shell visual inspirado no Codex Desktop, sem alterar DPI ou zoom do sistema.

## Fronteira atual do engine

O projeto já possui sua própria fronteira de domínio e seu próprio dono de
composição. A ponte oficial fica restrita a
`src-tauri/src/engine/compatibility.rs` e `src-tauri/src/codex`.

Ela ainda é necessária porque não implementamos OAuth privado nem consumimos
endpoints internos do ChatGPT. Enquanto não houver um contrato público direto
equivalente, o `ChatGptAuth` e o `ChatGptCodexProvider` delegam a execução à
ponte. Isso mantém o login correto e cria um caminho de substituição módulo por
módulo, sem acoplar a interface ao CLI.

## Stack fixada

| Camada | Tecnologia |
| --- | --- |
| Shell nativo | Tauri 2.11 |
| Backend | Rust 1.97.1, edition 2024, Tokio |
| Persistência local | SQLite via rusqlite 0.40 |
| Interface | SolidJS 1.9.14, TypeScript 7.0 |
| Build web | Vite 8.1 |
| Ponte ChatGPT temporária | Codex CLI `app-server` |

As versões exatas ficam travadas em `package.json`, `pnpm-lock.yaml`,
`Cargo.lock` e `rust-toolchain.toml`. O perfil Rust de release usa uma única
unidade de geração, ThinLTO, otimização nível 3, remoção de símbolos e abort em
panic.

## Pré-requisitos

- Windows 10 ou 11 com WebView2;
- Codex CLI instalado e disponível no `PATH` enquanto a ponte estiver ativa;
- uma conta ChatGPT com acesso ao Codex;
- Node.js 26 ou superior e pnpm 11.17 ou superior;
- toolchain MSVC para compilar Tauri no Windows.

Para usar um executável específico do Codex, defina `CODEX_APP_BINARY` com um
caminho absoluto.

## Executar

```powershell
pnpm install
pnpm tauri dev
```

O `NativeEngine` é o padrão. Para diagnosticar somente a integração antiga:

```powershell
$env:CODEX_APP_ENGINE = "compatibility"
pnpm tauri dev
```

Se não houver sessão, **Continuar com ChatGPT** abre o navegador no fluxo
oficial. O app recebe apenas URL, conclusão e estado da conta; tokens nunca
atravessam o IPC da interface.

## Verificar

```powershell
pnpm verify
```

O comando compila o frontend, checa o crate Rust, valida formatação, executa
Clippy com warnings como erro e roda os testes nativos.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Contrato do engine](docs/ENGINE.md)
- [Estudo do Codex oficial](docs/REFERENCE.md)
- [Regras do projeto](docs/RULES.md)
- [Próximos passos](docs/TODO.md)

A referência foi fixada no commit `6219b7c40fc9c702c0aef9964e72b492558f60e4`
do repositório [openai/codex](https://github.com/openai/codex). A cópia de estudo
fica em `.reference/` e não é versionada.

## Limite de segurança

Este projeto não implementa OAuth próprio, não lê arquivos de credenciais, não
captura tokens e não chama endpoints privados do ChatGPT. Incompatibilidades da
ponte falham de forma visível. O objetivo é removê-la quando cada responsabilidade
tiver uma alternativa pública, testada e compatível.
