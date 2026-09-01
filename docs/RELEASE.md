# Windows release

`.github/workflows/release.yml` is the only official release path. It validates
the repository, builds the NSIS installer, and publishes the tagged release.
Local builds are not official publications.

The version determines one explicit release channel:

| Version and tag | GitHub channel | Windows identity |
| --- | --- | --- |
| `MAJOR.MINOR.PATCH-alpha.NUMBER` and matching `v` tag | Alpha prerelease | Unsigned |
| `MAJOR.MINOR.PATCH` and matching `v` tag | Stable release | Authenticode |

Alpha assets start with `Alpha-Codex-App_` and the release title starts with
`Alpha Codex App`. The release body states that the installer is unsigned and
Windows may display a SmartScreen warning. This is an explicit channel contract,
not a fallback when signing fails. Stable publishing never proceeds unsigned.

## Stable release secrets

- `WINDOWS_CERTIFICATE_BASE64`: Base64-encoded PFX certificate;
- `WINDOWS_CERTIFICATE_PASSWORD`: PFX password;
- `WINDOWS_CERTIFICATE_THUMBPRINT`: certificate thumbprint;
- `WINDOWS_PUBLISHER`: legal publisher identity in the certificate.

For stable versions, the job stops before bundling if a value is missing or the
imported identity does not match the configured secrets. Alpha versions never
read or simulate an Authenticode identity.

## Publishing

1. Use the same stable or `alpha.NUMBER` SemVer version in `package.json`,
   `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Run `pnpm verify:version` and `pnpm verify`.
3. Create the exact matching `v` tag on the verified commit and push it.

The pipeline requires the tagged commit to belong to `main`, then verifies the
tag, all three manifests, the `rg.exe` sidecar, and the complete source before
publishing. Stable releases additionally verify the Authenticode identity and
apply a timestamped signature.

## Local builds

```powershell
pnpm release:check  # detect conflicts with another release instance
pnpm release:build  # rebuild without opening the application
pnpm release        # rebuild and start the resulting executable
```

Never terminate a canonical instance to replace its executable. For disposable
validation, use a temporary ignored `CARGO_TARGET_DIR`. Official releases
always use the workflow and canonical target.
