# Release para Windows

`.github/workflows/release.yml` é a única rota oficial. O workflow valida o
repositório, gera o instalador NSIS, aplica Authenticode e publica a release da
tag. Builds locais não são publicações oficiais.

## Secrets obrigatórios

- `WINDOWS_CERTIFICATE_BASE64`: certificado PFX em Base64;
- `WINDOWS_CERTIFICATE_PASSWORD`: senha do PFX;
- `WINDOWS_CERTIFICATE_THUMBPRINT`: impressão digital do certificado;
- `WINDOWS_PUBLISHER`: publicador legal presente no certificado.

O job encerra antes do bundle se algum valor estiver ausente ou se a identidade
importada não corresponder aos secrets.

## Publicação

1. Use a mesma versão em `package.json`, `src-tauri/Cargo.toml` e
   `src-tauri/tauri.conf.json`.
2. Execute `pnpm verify:version` e `pnpm verify`.
3. Crie a tag `vMAJOR.MINOR.PATCH` no commit validado e envie-a ao GitHub.

O pipeline confere a tag, os três manifestos, o sidecar `rg.exe`, a assinatura e
o timestamp antes de publicar.

## Build local

```powershell
pnpm release:check  # valida conflitos com outra instância release
pnpm release:build  # recompila sem abrir o aplicativo
pnpm release        # recompila e inicia o binário resultante
```

Não encerre uma instância canônica para substituir seu executável. Para uma
validação descartável, use um `CARGO_TARGET_DIR` temporário e ignorado; a release
oficial sempre usa o workflow e o target canônico.
