# Windows release

`.github/workflows/release.yml` is the only official release path. It requires
a signed annotated tag verified by GitHub, validates the repository, builds the
NSIS installer, and publishes the tagged release.
Local builds are not official publications.

The version determines one explicit release channel:

| Version and tag | GitHub channel | Git tag signature | Windows identity |
| --- | --- | --- | --- |
| `MAJOR.MINOR.PATCH-alpha.NUMBER` and matching `v` tag | Alpha prerelease | GitHub verified | Unsigned |
| `MAJOR.MINOR.PATCH` and matching `v` tag | Stable release | GitHub verified | Authenticode |

Alpha assets start with `Alpha-Codex-App_` and the release title starts with
`Alpha Codex App`. The release body states that the installer is unsigned and
Windows may display a SmartScreen warning. This is an explicit channel contract,
not a fallback when signing fails. Stable publishing never proceeds unsigned.

## Git tag signing

GitHub's **Verified** badge identifies a cryptographically verified Git signature.
It does not certify the installer, its safety, or CI results. A lightweight tag
can display its commit's verification; an annotated tag has its own signature.
An unsigned annotated tag does not inherit a signed commit's verification.

Every official tag must be annotated, signed, and verified by GitHub, regardless
of release channel. The release gate checks the remote reference and tag object,
requires `verification.verified == true` and `verification.reason == "valid"`,
and binds the tag directly to the checked-out commit. Lightweight tags, unsigned
tags, unrecognized keys, mismatched objects, and API failures stop publication.

Configure a GPG or SSH signing key and register its public key with the releasing
maintainer's GitHub account. Keep the private key outside the repository. For
SSH, register it as a **signing** key, configure Git's `gpg.format` and
`user.signingkey`, and configure `gpg.ssh.allowedSignersFile` for local verification.
Then enable `git config --local tag.gpgsign true`. This setting is local to each
checkout; the workflow enforces the shared publication contract.

See GitHub's [signature verification guide](https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification)
and [tag signing instructions](https://docs.github.com/en/authentication/managing-commit-signature-verification/signing-tags).

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
2. Merge the release change into `main`, check out its exact commit, and run
   `pnpm verify:version` and `pnpm verify`.
3. Create the matching annotated tag with an explicit signature:
   `git tag --sign vVERSION COMMIT_SHA -m "Release VERSION"`.
4. Run `git verify-tag vVERSION`, then push that exact tag:
   `git push origin refs/tags/vVERSION`. Never substitute `git tag -a`, a
   lightweight tag, or the GitHub release form's automatic tag creation.

The pipeline requires the tagged commit to belong to `main`, then verifies the
tag's signature through GitHub, all three manifests, the `rg.exe` sidecar, and
the complete source before publishing. Stable releases additionally verify the
Authenticode identity and apply a timestamped signature.

## Existing tags

Signing creates a new Git object; it cannot add a signature to an existing object
while preserving its SHA. Published tags are not automatically rewritten.
Correcting an existing tag requires explicit approval to replace the remote tag
object while preserving its exact peeled commit and release assets. First check
release immutability and tag protection, record the remote object and peeled
commit SHAs (local tags may be stale), and coordinate any active release run.
Verify the replacement signature before updating the ref, guard the update with
the original SHA, and confirm GitHub verification and the unchanged commit
afterward. Never move a historical tag to a newer commit just to obtain a badge.

The signature gate runs after a tag push; it blocks publication, but cannot
prevent an unsigned tag from appearing on GitHub. Restrict release-tag creation
to maintainers with configured signing keys, and restrict tag updates/deletions
through a GitHub tag ruleset. GitHub's required commit-signature rule applies to
branches and does not enforce annotated tag signatures.

## Local builds

```powershell
pnpm release:check  # detect conflicts with another release instance
pnpm release:build  # rebuild without opening the application
pnpm release        # rebuild and start the resulting executable
```

Never terminate a canonical instance to replace its executable. For disposable
validation, use a temporary ignored `CARGO_TARGET_DIR`. Official releases
always use the workflow and canonical target.
