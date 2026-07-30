# Codex App

Base desktop nativa, modular e enxuta para experimentar uma interface semelhante
ao Codex Desktop. O shell usa Tauri e Rust; a interface usa SolidJS e TypeScript;
e o agente continua sendo o `codex app-server` oficial.

Este repositório é uma fundação funcional, não uma tentativa de reimplementar o
motor do Codex. Autenticação, sessão, modelos, configuração e execução permanecem
sob responsabilidade do runtime oficial.

## O que já funciona

- inicialização e supervisão assíncrona do `codex app-server` por `stdio`;
- reutilização segura da conta ChatGPT já autenticada pelo Codex;
- login oficial pelo navegador, logout e atualização de estado da conta;
- seleção de workspace, criação de thread e envio/interrupção de turnos;
- streaming de texto e atividades do turno;
- anexos de arquivos e imagens, incluindo colar imagens no compositor;
- validação nativa de limites, caminho, tamanho e assinatura real das imagens;
- aprovações explícitas para comandos e alterações de arquivos;
- seletor semântico de permissões com presets atômicos e acesso ao `config.toml`;
- configurações em tela inteira, busca e editor para qualquer chave oficial;
- seletor em cascata de modelo, esforço e velocidade, com redefinição atômica;
- painel de ambiente, listagem de modelos e diagnósticos do runtime.

## Stack fixada

| Camada | Tecnologia |
| --- | --- |
| Shell nativo | Tauri 2.11 |
| Backend | Rust 1.97.1, edition 2024, Tokio |
| Interface | SolidJS 1.9.14, TypeScript 7.0 |
| Build web | Vite 8.1 com Rolldown |
| Runtime de agente | Codex CLI `app-server` oficial |

O SolidJS 1.9 é usado por ser a linha estável atual; versões beta não entram na
base somente por terem número maior. Versões exatas ficam travadas em
`package.json`, `pnpm-lock.yaml`, `Cargo.lock` e `rust-toolchain.toml`.
O perfil Rust de release usa uma única unidade de geração, ThinLTO, otimização
nível 3, remoção de símbolos e abort em panic.

## Pré-requisitos

- Windows 10 ou 11 com WebView2;
- Codex CLI instalado e disponível no `PATH`;
- Node.js 26 ou superior e pnpm 11.17 ou superior;
- toolchain MSVC necessária para compilar Tauri no Windows.

O Rust correto é instalado automaticamente pelo `rust-toolchain.toml`. Para usar
um executável específico do Codex, defina `CODEX_APP_BINARY` com o caminho absoluto.

## Executar

```powershell
pnpm install
pnpm tauri dev
```

Se não houver uma sessão existente, o botão de login inicia o fluxo ChatGPT no
navegador. O app recebe apenas o estado do fluxo; tokens nunca passam pela UI nem
são armazenados por este projeto.

## Verificar

```powershell
pnpm verify
```

O comando compila o frontend, checa o crate Rust, valida formatação, executa
Clippy com warnings como erro e roda os testes nativos.

## Direção visual

A interface adota a densidade e os padrões de interação do Codex Desktop sem
acoplar o projeto aos componentes privados do aplicativo. A escala tipográfica é
definida em CSS e não altera DPI nem zoom do sistema. Cores-base, superfícies,
seleções e estados são tokens centralizados em `src/styles/global.css`.

## Arquitetura e referência

- [Arquitetura](docs/ARCHITECTURE.md)
- [Estudo do Codex oficial](docs/REFERENCE.md)
- [Regras do projeto](docs/RULES.md)
- [Próximos passos](docs/TODO.md)

A referência foi fixada no commit `6219b7c40fc9c702c0aef9964e72b492558f60e4`
do repositório [openai/codex](https://github.com/openai/codex). A cópia de estudo
fica em `.reference/` e não é versionada.

## Limite de segurança

Este projeto não implementa OAuth próprio, não lê arquivos de credenciais, não
captura tokens e não chama endpoints privados do ChatGPT. A integração pública é
o protocolo do `codex app-server`; qualquer incompatibilidade deve falhar de forma
visível e ser corrigida nessa fronteira.
