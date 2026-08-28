# Dependências

`package.json` e `src-tauri/Cargo.toml` são as fontes das dependências diretas;
`pnpm-lock.yaml` e `src-tauri/Cargo.lock` travam as resoluções. Este documento
registra somente o propósito e as exceções que exigem manutenção.

## Frontend

| Dependência | Papel |
| --- | --- |
| `solid-js` | reatividade e renderização |
| `@tauri-apps/api` | commands e events do shell nativo |
| `@tauri-apps/plugin-dialog` | seleção nativa de arquivos |
| `@tauri-apps/plugin-opener` | links externos e diretórios já validados |
| `marked` | parser de Markdown |
| `dompurify` | sanitização antes do DOM |

Vite, TypeScript, Biome, Vitest e Tauri CLI existem apenas no ambiente de
desenvolvimento e build.

## Backend

| Grupo | Dependências | Papel |
| --- | --- | --- |
| shell | `tauri`, plugins e `tauri-build` | janela, integração Windows e bundle |
| Windows | `webview2-com`, `windows` | child WebView2, COM e Job Objects |
| async | `tokio`, `futures-util` | tarefas, concorrência e SSE |
| HTTP | `reqwest`, `url` | HTTPS rustls, cookies e URLs validadas |
| storage | `rusqlite`, `r2d2`, `r2d2_sqlite` | SQLite WAL e pool |
| secrets | `age`, `keyring-core`, `windows-native-keyring-store`, `zeroize`, `rand`, `sha2` | cofre, PKCE e hashes |
| contratos | `serde`, `serde_json`, `base64`, `image` | IPC, envelopes e imagens |
| domínio | `chrono`, `uuid`, `thiserror`, `tempfile`, `parking_lot` | tempo, IDs, erros, spool e locks |

`webview2-com` e `windows` são diretas porque o código nomeia e testa APIs
específicas; nenhum objeto COM ou comando CDP genérico atravessa o contrato do
agente.

## Rust

Toolchain, MSRV e CI usam Rust 1.98.0. O projeto mantém `edition = "2024"` e
`build.warnings = "deny"`; Clippy também trata warnings locais como erro.

Fontes:

- [Rust 1.98.0](https://blog.rust-lang.org/2026/08/20/Rust-1.98.0/);
- [notas de release](https://doc.rust-lang.org/releases.html#version-1980-2026-08-20);
- [`build.warnings`](https://doc.rust-lang.org/cargo/reference/config.html#buildwarnings).

Novas APIs ou lints só devem ser adotados quando reduzirem complexidade ou
melhorarem correção no código real. Não use `allow` para esconder regressões.

## Exceção transitiva

O lockfile possui um único caminho conhecido para crates `unic-*` sem
manutenção:

```text
tauri-utils 2.9.3 -> urlpattern 0.3.0 -> unic-ucd-ident 0.9.0
```

Ele é transitivo do Tauri estável. `pnpm verify:transitive` permite somente esse
caminho e essas versões; qualquer desvio falha. Remova a exceção quando uma
release estável do Tauri atualizar `urlpattern`.

## Ripgrep embarcado

`search_text` usa ripgrep 15.2.0 próprio, nunca uma instalação global ou o
Codex CLI. `scripts/ripgrep-manifest.json` fixa arquitetura, assets e hashes.

```powershell
pnpm tools:bootstrap
pnpm rg -- -n "texto" src src-tauri/src
```

Bootstrap, build e runtime validam versão e SHA-256. O executável fica em
`.tools/ripgrep`, entra no bundle como sidecar e é chamado por caminho absoluto,
sem shell. O `PATH` global não é alterado.

## Política de atualização

1. Atualize apenas dependências com uso confirmado.
2. Revise release notes, features, MSRV, licenças e grafo transitivo.
3. Preserve versões exatas e ambos os lockfiles.
4. Remova features e dependências que deixaram de ser necessárias.
5. Execute `pnpm verify:transitive` e `pnpm verify`.

`.references` contém somente fontes de estudo ignoradas. Apagar esse diretório
não pode alterar build, runtime ou testes.
