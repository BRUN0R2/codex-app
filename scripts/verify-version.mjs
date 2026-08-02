import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const tauriConfig = JSON.parse(
  await readFile(new URL("src-tauri/tauri.conf.json", root), "utf8"),
);
const cargoManifest = await readFile(new URL("src-tauri/Cargo.toml", root), "utf8");
const cargoVersion = cargoManifest.match(/^version\s*=\s*"([^"]+)"/mu)?.[1];
const versions = new Map([
  ["package.json", packageJson.version],
  ["src-tauri/Cargo.toml", cargoVersion],
  ["src-tauri/tauri.conf.json", tauriConfig.version],
]);
const invalid = [...versions].filter(([, version]) => typeof version !== "string");
if (invalid.length > 0) {
  throw new Error(`Versão ausente em: ${invalid.map(([file]) => file).join(", ")}`);
}
const unique = new Set(versions.values());
if (unique.size !== 1) {
  throw new Error(
    `Versões divergentes: ${[...versions].map(([file, version]) => `${file}=${version}`).join(", ")}`,
  );
}
const version = [...unique][0];
const releaseTag = process.env.GITHUB_REF_TYPE === "tag" ? process.env.GITHUB_REF_NAME : undefined;
if (releaseTag !== undefined && releaseTag !== `v${version}`) {
  throw new Error(`A tag ${releaseTag} não corresponde à versão v${version}.`);
}
process.stdout.write(`Versão consistente: ${version}\n`);
