# Dependências

## Dependências diretas

Toda dependência direta tem escopo isolado e substituição custosa; nenhuma fica
ociosa. Os requisitos diretos estão declarados em `package.json` e
`src-tauri/Cargo.toml`; as resoluções exatas de ambos os grafos ficam travadas
nos respectivos lockfiles.

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
| Windows nativo | `webview2-com`, `windows` | Callback assíncrono de `ExecuteScript`, métodos CDP fechados, tipos COM do child WebView2 e Job Objects que possuem árvores de comandos |
| Async | `tokio`, `futures-util` | Runtime de tarefas e streaming SSE incremental |
| HTTP | `reqwest` (rustls, cookies, stream), `url` | HTTPS do provider sem OpenSSL e validação de URLs |
| Persistência | `rusqlite` (bundled), `r2d2`, `r2d2_sqlite` | SQLite WAL transacional com pool dimensionado |
| Credenciais | `age`, `keyring-core`, `windows-native-keyring-store`, `zeroize`, `rand`, `sha2` | Envelope cifrado, chave no Credential Manager, PKCE e hashing |
| Serialização e imagem | `serde`, `serde_json`, `base64`, `image` | Contratos IPC fechados, codificações de envelope e decode limitado de PNG/JPEG/GIF/WebP |
| Domínio | `chrono`, `uuid` (v5/v7), `thiserror`, `tempfile`, `parking_lot` | Carimbos de tempo ordenáveis, ids persistentes, identidades estáveis do prefixo Lite, taxonomia de erros, spool de saídas em disco e locks |

A política de atualização é contínua: versões modernas e estáveis, mudanças
revisadas pelo Dependabot e gates de lockfile em `pnpm verify`.

## Rust estável

O toolchain, o MSRV do crate e o CI estão fixados em Rust 1.98.0, release estável
de 20 de agosto de 2026. `.cargo/config.toml` usa o `build.warnings = "deny"`
estabilizado no ciclo anterior para que todo comando Cargo falhe em warnings dos
crates locais, não apenas a etapa separada de Clippy.

As novidades de 1.98 foram avaliadas contra o código real. Os novos lints
encontraram APIs com argumentos demais, um cache com tipo excessivamente
aninhado, um `div_ceil` manual e uma normalização de enum redundante; todos foram
refatorados sem `allow`. `String::from_utf16le`, `NumBuffer` e os métodos de float
algebraicos não foram introduzidos porque não simplificam nenhum caminho atual;
os últimos ainda permitem reordenação não determinística, incompatível com a
política deste projeto.

Fontes primárias:

- [anúncio do Rust 1.98.0](https://blog.rust-lang.org/2026/08/20/Rust-1.98.0/);
- [notas completas do Rust 1.98.0](https://doc.rust-lang.org/releases.html#version-1980-2026-08-20);
- [configuração `build.warnings`](https://doc.rust-lang.org/cargo/reference/config.html#buildwarnings).

## Referências de estudo

`.references/` é ignorado pelo Git e nunca participa de build, runtime, bundle,
configuração ou armazenamento do aplicativo. Em 28 de agosto de 2026 ele contém:

- `shiki`, revisão `48cd2cc695ed2e3357c3f9c370578ea843d6d9a3`
  (`v4.4.3`);
- `openai-codex`, revisão
  `6be2a6ca952ac9f70676ce4dd07fda27175aa9dd` (release estável auditada
  `rust-v0.150.1`, revisão `90854393966b21e9ebfd21b122334eb09a20c93d`);
- módulos selecionados de perfil, uso, navegador e execução de comandos extraídos do
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

O navegador interno habilita a feature `unstable` do `tauri` para
`Window::add_child`, a API necessária aos child webviews nativos. O controle do
agente tornou diretas duas dependências que já estavam no grafo transitivo do
Tauri: `webview2-com 0.38.2` e `windows 0.61.3`. Isso permite nomear e testar o
contrato WebView2 usado por `ExecuteScript` e
`CallDevToolsProtocolMethod` e o contrato de Job Objects usado para encerrar
árvores de comandos sem `taskkill`; nenhuma versão adicional entrou no lockfile. O
modelo não recebe COM nem CDP genérico: somente operações fechadas do módulo
`browser/automation.rs`.

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
