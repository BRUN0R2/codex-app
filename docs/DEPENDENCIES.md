# Dependências transitivas

## `unic-*` via Tauri

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

## Ferramentas locais de desenvolvimento

O `ripgrep` é uma ferramenta de desenvolvimento opcional e reproduzível; ele não
participa do build, do bundle nem do runtime release. Execute:

```powershell
pnpm tools:bootstrap
pnpm rg -- -n "texto" src src-tauri/src
```

O bootstrap fixa `ripgrep 15.2.0`, detecta Windows x64 ou ARM64, baixa somente o
asset MSVC do release oficial, valida SHA-256 do ZIP e do `rg.exe` e instala em
`.tools/ripgrep/`, que permanece ignorado pelo Git. Nenhum PATH global é alterado.
Os scripts dev adicionam o diretório validado apenas ao ambiente do processo,
permitindo que comandos filhos usem `rg`; se a ferramenta estiver ausente, eles
mostram a ação explícita de bootstrap sem baixar nada silenciosamente.
