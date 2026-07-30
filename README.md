# Codex App

Base desktop nativa, modular e enxuta para experimentar um agente com a
ergonomia do Codex Desktop. O shell usa Tauri e Rust, a interface usa SolidJS e
TypeScript e a composição pertence ao `NativeEngine` deste projeto.

A autenticação usa diretamente o fluxo OAuth ChatGPT estudado no Codex oficial.
PKCE, callback local, troca, renovação, revogação e persistência segura pertencem
ao backend Rust. Tokens nunca atravessam o IPC nem entram no SQLite; a sessão
fica em um arquivo local criptografado cuja chave fica no Gerenciador de
Credenciais do Windows.

Inferência, modelos, configuração e execução de ferramentas ainda usam o
`codex app-server` como ponte de compatibilidade. A ponte é explícita, isolada e
iniciada somente quando uma dessas capacidades é solicitada; abrir o app,
consultar a conta, entrar, renovar ou sair não inicia a CLI.

## O que já funciona

- `NativeEngine` como backend padrão por um contrato `AgentEngine` fechado;
- login ChatGPT nativo com PKCE, cancelamento, renovação e logout com revogação;
- cofre `age` compatível com o backend seguro atual do Codex no Windows;
- SQLite versionado para metadados de tarefas e operações, com WAL;
- ponte Codex sob demanda para provider, modelos e configuração;
- seleção de workspace, criação de tarefa e envio/interrupção de turnos;
- streaming de texto e atividades;
- anexos e imagens coladas, validados no backend antes do envio;
- aprovações explícitas e presets semânticos de permissão;
- configurações, modelos, esforço, velocidade e diagnósticos;
- shell visual inspirado no Codex Desktop, sem alterar DPI ou zoom do sistema.

## Fronteira atual do engine

`src-tauri/src/engine/native` contém as responsabilidades próprias do produto.
A autenticação está em `native/auth`, dividida em callback, OAuth, PKCE,
armazenamento e tokens. O provider compatível permanece restrito a
`src-tauri/src/engine/compatibility.rs` e `src-tauri/src/codex`.

Quando a ponte é necessária, o app-server recebe configuração explícita para ler
o mesmo cofre criptografado administrado pelo backend nativo. O arquivo
`auth.json` do usuário não é copiado, alterado nem removido por este aplicativo.

## Stack fixada

| Camada | Tecnologia |
| --- | --- |
| Shell nativo | Tauri 2.11 |
| Backend | Rust 1.97.1, edition 2024, Tokio |
| Persistência local | SQLite via rusqlite 0.40 |
| Credenciais | age+scrypt; chave no Windows Credential Manager |
| HTTP OAuth | reqwest 0.13 com rustls |
| Interface | SolidJS 1.9.14, TypeScript 7.0 |
| Build web | Vite 8.1 |
| Provider temporário | Codex CLI `app-server` sob demanda |

As versões exatas ficam travadas em `package.json`, `pnpm-lock.yaml`,
`Cargo.lock` e `rust-toolchain.toml`.

## Pré-requisitos

- Windows 10 ou 11 com WebView2;
- uma conta ChatGPT com acesso ao Codex;
- Codex CLI para conversar, listar modelos e editar a configuração nesta fase;
- Node.js 26 ou superior e pnpm 11.17 ou superior;
- toolchain MSVC para compilar Tauri no Windows.

O login e o gerenciamento da sessão não exigem o Codex CLI. Para usar um
executável específico somente nas capacidades compatíveis, defina
`CODEX_APP_BINARY` com um caminho absoluto.

## Executar

```powershell
pnpm install
pnpm tauri dev
```

O `NativeEngine` é o padrão. Para diagnosticar diretamente a implementação
compatível:

```powershell
$env:CODEX_APP_ENGINE = "compatibility"
pnpm tauri dev
```

Se não houver sessão, **Continuar com ChatGPT** abre o navegador. A UI recebe
somente a URL, o identificador do fluxo, a conclusão e o estado público da conta.

## Verificar

```powershell
pnpm verify
```

O comando compila o frontend, checa e formata o crate Rust, executa Clippy com
warnings como erro e roda os testes nativos.

## Documentação

- [Arquitetura](docs/ARCHITECTURE.md)
- [Contrato do engine](docs/ENGINE.md)
- [Estudo do Codex oficial](docs/REFERENCE.md)
- [Regras do projeto](docs/RULES.md)
- [Próximos passos](docs/TODO.md)

A referência está fixada no commit
`6219b7c40fc9c702c0aef9964e72b492558f60e4` do repositório
[openai/codex](https://github.com/openai/codex). A cópia de estudo fica em
`.reference/` e não é versionada.

## Limite de segurança

O app implementa apenas o protocolo de autenticação observado e validado na
referência; não chama endpoints privados de inferência do ChatGPT. Credenciais
são tratadas como segredos, gravadas somente pelo backend e removidas localmente
mesmo quando uma revogação remota falha. Toda incompatibilidade permanece
visível, sem fallback silencioso.
