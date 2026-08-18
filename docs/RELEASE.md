# Release oficial para Windows

O pipeline `.github/workflows/release.yml` é a única rota de publicação. Ele
valida toda a base, exige uma identidade Authenticode, gera o instalador NSIS,
assina e publica a release correspondente à tag.

## Identidade obrigatória

Configure estes secrets no repositório:

- `WINDOWS_CERTIFICATE_BASE64`: PFX de assinatura em Base64;
- `WINDOWS_CERTIFICATE_PASSWORD`: senha do PFX;
- `WINDOWS_CERTIFICATE_THUMBPRINT`: impressão digital exata do certificado;
- `WINDOWS_PUBLISHER`: nome legal do publicador presente no certificado.

O job falha antes do bundle quando qualquer valor estiver ausente ou quando a
impressão digital importada divergir. Nenhum instalador sem assinatura é
publicado pela rota oficial.

## Versionamento e publicação

1. Atualize a mesma versão em `package.json`, `src-tauri/Cargo.toml` e
   `src-tauri/tauri.conf.json`.
2. Execute `pnpm verify:version` e `pnpm verify`.
3. Crie e envie a tag `vMAJOR.MINOR.PATCH` apontando para o commit validado.

O pipeline compara a tag com os três manifestos, usa SHA-256 e timestamp
Authenticode e publica apenas se todos os testes, o bundle e a assinatura forem
concluídos.

## Fluxo de Release seguro (desenvolvimento local)

Para trabalhar com o app release localmente, execute:

- `pnpm release:check` para validar que não há outra instância release em execução.
- `pnpm release` para reconstruir release e executar imediatamente o binário novo.
- `pnpm release:build` para reconstruir release sem abrir janela.

Esses comandos têm responsabilidades separadas:

- `release:check` verifica se há processo antigo do `codex-desktop-next`.
- `release` só é interrompido quando outra instância release está aberta.
- Servidores Vite podem permanecer ativos durante o build e a execução da release; a porta
  de desenvolvimento não é usada pelo executável compilado.

O build valida e inclui o sidecar `rg.exe` correspondente ao target. O manifesto,
hash e versão são conferidos antes da linkedição; uma release sem o binário
esperado falha.

Quando o executável canônico estiver aberto, não o encerre para forçar uma
substituição. Para uma validação não publicável, pode-se definir
`CARGO_TARGET_DIR` para um diretório temporário/ignorado e executar
`pnpm tauri build --no-bundle`. A publicação oficial continua usando apenas o
pipeline e o target canônicos.
