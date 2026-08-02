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
