# Dependências

## Dependências diretas

Toda dependência direta tem escopo isolado e substituição custosa; nenhuma fica
ociosa. As versões exatas estão travadas em `package.json` e `src-tauri/Cargo.toml`.

### Interface (`package.json`)

| Dependência | Papel |
| --- | --- |
| `solid-js` | Reactivity e renderização da UI |
| `@tauri-apps/api` | Ponte `invoke`/eventos com o backend nativo |
| `@tauri-apps/plugin-dialog` | Diálogos nativos de arquivo para anexos e workspace |
| `@tauri-apps/plugin-opener` | Links externos no WebView e abertura nativa de diretórios já validados |
| `marked` | Parse de Markdown das mensagens |
| `dompurify` | Sanitização do HTML renderizado antes do DOM |

Ferramentas de desenvolvimento: `vite` + `vite-plugin-solid` (build),
`typescript` (tipagem estrita), `@biomejs/biome` (lint e formato), `vitest`
(testes), `@tauri-apps/cli` (empacotamento) e `@types/node` (tipos de script).

### Backend (`src-tauri/Cargo.toml`)

| Grupo | Crates | Papel |
| --- | --- | --- |
| Shell | `tauri`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-autostart`, `tauri-plugin-single-instance`, `tauri-build` | Janela nativa, integrações do SO e build |
| Async | `tokio`, `futures-util` | Runtime de tarefas e streaming SSE incremental |
| HTTP | `reqwest` (rustls, cookies, stream), `url` | HTTPS do provider sem OpenSSL e validação de URLs |
| Persistência | `rusqlite` (bundled), `r2d2`, `r2d2_sqlite` | SQLite WAL transacional com pool dimensionado |
| Credenciais | `age`, `keyring-core`, `windows-native-keyring-store`, `zeroize`, `rand`, `sha2` | Envelope cifrado, chave no Credential Manager, PKCE e hashing |
| Serialização | `serde`, `serde_json`, `base64` | Contratos IPC fechados e codificações de envelope |
| Domínio | `chrono`, `uuid` (v7), `thiserror`, `tempfile`, `parking_lot` | Carimbos de tempo ordenáveis, ids, taxonomia de erros, spool de saídas em disco e locks |

A política de atualização é contínua: versões modernas e estáveis, mudanças
revisadas pelo Dependabot e gates de lockfile em `pnpm verify`.

## Referências de estudo

`.references/` é ignorado pelo Git e nunca participa de build, runtime, bundle,
configuração ou armazenamento do aplicativo. Em 23 de agosto de 2026 ele contém:

- `shiki`, revisão `48cd2cc695ed2e3357c3f9c370578ea843d6d9a3`
  (`v4.4.3`);
- `openai-codex`, revisão
  `1e6185e52214a879a8b94f3743f47f57135dc64b`;
- módulos selecionados de perfil, uso e execução de comandos extraídos do
  `app.asar` do Codex Desktop `26.818.5229.0` em
  `codex-desktop-26.818.5229.0/`.

Nenhum pacote Shiki, Syntect, Tree-sitter ou Codex foi adicionado ao grafo. O
motor de realce é código próprio e usa apenas princípios arquiteturais observados
nas referências. Remover `.references/` não altera nenhuma funcionalidade.

O suporte a sessões longas, polling incremental e Common Controls v6 não
adicionou crates. O manager usa apenas `tokio`, `uuid`, tipos do domínio e o
spool já existente. No Windows, `build.rs` usa a API oficial
`WindowsAttributes::new_without_app_manifest` do `tauri-build` e fornece um único
manifesto ao linker, evitando tanto import ausente de `TaskDialogIndirect` quanto
recurso `MANIFEST` duplicado.

## Dependências transitivas

### `unic-*` via Tauri

O grafo travado atual contém somente este caminho não mantido:

```text
tauri-utils 2.9.3 -> urlpattern 0.3.0 -> unic-ucd-ident 0.9.0
```

Ele não é uma dependência direta e não pode ser removido sem substituir uma
versão estável do Tauri por código de desenvolvimento. O `urlpattern` 0.6 já usa
ICU e o branch de desenvolvimento do Tauri já aponta para essa versão, mas o
Tauri 2.11.5 estável ainda fixa `urlpattern` 0.3.

`pnpm verify:transitive` admite somente o caminho exato acima. Qualquer mudança
de versão mantendo `unic-*` falha e exige nova revisão. Quando uma versão
estável do Tauri remover o caminho, o mesmo gate passa sem exceção e este bloco
deve ser apagado junto com o próximo lockfile.

Fontes primárias:

- [releases estáveis do Tauri](https://github.com/tauri-apps/tauri/releases);
- [tauri-utils 2.9.3](https://raw.githubusercontent.com/tauri-apps/tauri/tauri-v2.11.5/crates/tauri-utils/Cargo.toml);
- [rust-urlpattern atual](https://github.com/denoland/rust-urlpattern/releases);
- [tauri-utils em desenvolvimento](https://raw.githubusercontent.com/tauri-apps/tauri/dev/crates/tauri-utils/Cargo.toml).

## Ripgrep nativo e reproduzível

O `ripgrep` é uma dependência nativa explícita do aplicativo. A busca de código
não depende de uma instalação global, do Codex CLI nem do `PATH` do usuário.
Execute manualmente quando quiser antecipar o bootstrap:

```powershell
pnpm tools:bootstrap
pnpm rg -- -n "texto" src src-tauri/src
```

O manifesto único em `scripts/ripgrep-manifest.json` fixa `ripgrep 15.2.0`,
revisão, assets x64/ARM64 e os hashes SHA-256 do ZIP e do executável. Dev, build,
verificação nativa e CI executam o bootstrap automaticamente. Ele detecta a
arquitetura Windows, baixa apenas o asset MSVC oficial, valida os dois hashes e
instala em `.tools/ripgrep/`, que permanece ignorado pelo Git.

No build, `src-tauri/build.rs` valida novamente o executável e materializa o
sidecar nomeado pelo target que o Tauri inclui por `externalBin`. No início do
runtime, o app exige o `rg.exe` ao lado do executável principal, rejeita symlink,
confere o hash compilado e a versão exata. A ferramenta `search_text` chama esse
binário por caminho absoluto, sem shell; comandos autorizados recebem o diretório
validado somente no `PATH` do processo filho. O `PATH` global nunca é alterado.
