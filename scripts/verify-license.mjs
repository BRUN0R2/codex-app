import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const expectedLicense = "MIT";
const expectedCopyright = "Copyright (c) 2026 BRUN0R2";
const requiredMitCondition =
  "The above copyright notice and this permission notice shall be included in all";

const [licenseText, licensingPolicy, readme, packageText, cargoManifest] = await Promise.all([
  readFile(new URL("LICENSE", root), "utf8"),
  readFile(new URL("LICENSING.md", root), "utf8"),
  readFile(new URL("README.md", root), "utf8"),
  readFile(new URL("package.json", root), "utf8"),
  readFile(new URL("src-tauri/Cargo.toml", root), "utf8"),
]);

const packageManifest = JSON.parse(packageText);
const cargoLicense = /^license\s*=\s*"([^"]+)"\s*$/mu.exec(cargoManifest)?.[1];

assert(packageManifest.license === expectedLicense, "package.json does not declare MIT");
assert(cargoLicense === expectedLicense, "src-tauri/Cargo.toml does not declare MIT");
assert(licenseText.startsWith("MIT License\n"), "LICENSE is not the MIT license text");
assert(licenseText.includes(expectedCopyright), "LICENSE has an unexpected copyright holder");
assert(licenseText.includes(requiredMitCondition), "LICENSE omits the MIT notice condition");
assert(
  licensingPolicy.includes("[MIT License](LICENSE)") &&
    licensingPolicy.includes("https://github.com/BRUN0R2") &&
    licensingPolicy.includes("written agreement"),
  "LICENSING.md does not describe the standard and alternative terms",
);
assert(
  readme.includes("[MIT License](LICENSE)") && readme.includes("[LICENSING.md](LICENSING.md)"),
  "README.md does not expose the licensing terms",
);

console.log(`Validated ${expectedLicense} licensing across repository manifests and documentation.`);

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
