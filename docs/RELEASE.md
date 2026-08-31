# Windows release

`.github/workflows/release.yml` is the only official release path. It validates
the repository, builds the NSIS installer, applies Authenticode, and publishes
the tagged release. Local builds are not official publications.

## Required secrets

- `WINDOWS_CERTIFICATE_BASE64`: Base64-encoded PFX certificate;
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX password;
- `WINDOWS_CERTIFICATE_THUMBPRINT`: certificate thumbprint;
- `WINDOWS_PUBLISHER`: legal publisher identity in the certificate.

The job stops before bundling if a value is missing or the imported identity
does not match the configured secrets.

## Publishing

1. Use the same version in `package.json`, `src-tauri/Cargo.toml`, and
   `src-tauri/tauri.conf.json`.
2. Run `pnpm verify:version` and `pnpm verify`.
3. Create `vMAJOR.MINOR.PATCH` on the verified commit and push the tag.

The pipeline verifies the tag, all three manifests, the `rg.exe` sidecar,
signature, and timestamp before publishing.

## Local builds

```powershell
pnpm release:check  # detect conflicts with another release instance
pnpm release:build  # rebuild without opening the application
pnpm release        # rebuild and start the resulting executable
```

Never terminate a canonical instance to replace its executable. For disposable
validation, use a temporary ignored `CARGO_TARGET_DIR`. Official releases
always use the workflow and canonical target.
