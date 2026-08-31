import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const manifestPath = fileURLToPath(new URL("../src-tauri/Cargo.toml", import.meta.url));
const result = spawnSync(
  "cargo",
  ["metadata", "--locked", "--format-version", "1", "--manifest-path", manifestPath],
  { encoding: "utf8", maxBuffer: 16 * 1_024 * 1_024, windowsHide: true },
);

if (result.error !== undefined) {
  throw result.error;
}
if (result.status !== 0) {
  throw new Error(result.stderr.trim() || "Could not inspect the Cargo dependency graph.");
}

const metadata = JSON.parse(result.stdout);
const packages = new Map(metadata.packages.map((entry) => [entry.id, entry]));
const nodes = metadata.resolve?.nodes ?? [];
const expectedParents = new Map([
  ["unic-char-property@0.9.0", ["unic-ucd-ident@0.9.0"]],
  ["unic-char-range@0.9.0", ["unic-char-property@0.9.0", "unic-ucd-ident@0.9.0"]],
  ["unic-common@0.9.0", ["unic-ucd-version@0.9.0"]],
  ["unic-ucd-ident@0.9.0", ["urlpattern@0.3.0"]],
  ["unic-ucd-version@0.9.0", ["unic-ucd-ident@0.9.0"]],
  ["urlpattern@0.3.0", ["tauri-utils@2.9.3"]],
]);
const expectedUnic = [...expectedParents.keys()].filter((entry) => entry.startsWith("unic-"));
const packageLabels = [...packages.values()].map(packageLabel);
const presentUnic = packageLabels.filter((entry) => expectedUnic.includes(entry));
const unexpectedUnic09 = packageLabels.filter(
  (entry) => entry.startsWith("unic-") && entry.endsWith("@0.9.0") && !expectedUnic.includes(entry),
);

if (presentUnic.length === 0 && unexpectedUnic09.length === 0) {
  process.stdout.write("The Cargo graph no longer contains the unmaintained UNIC 0.9 crates.\n");
  process.exit(0);
}
if (
  presentUnic.length !== expectedUnic.length ||
  expectedUnic.some((entry) => !presentUnic.includes(entry)) ||
  unexpectedUnic09.length > 0
) {
  throw new Error(
    "The transitive UNIC 0.9 set changed. Review it and remove the documented exception before updating the lockfile.",
  );
}

const directParents = new Map();
for (const node of nodes) {
  const parent = packages.get(node.id);
  if (parent === undefined) {
    continue;
  }
  for (const dependency of node.deps) {
    const current = directParents.get(dependency.pkg) ?? new Set();
    current.add(packageLabel(parent));
    directParents.set(dependency.pkg, current);
  }
}

for (const [dependencyLabel, expected] of expectedParents) {
  const dependency = [...packages.values()].find(
    (entry) => packageLabel(entry) === dependencyLabel,
  );
  if (dependency === undefined) {
    throw new Error(`Expected dependency is missing: ${dependencyLabel}.`);
  }
  const actual = [...(directParents.get(dependency.id) ?? [])].sort();
  const sortedExpected = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(sortedExpected)) {
    throw new Error(
      `The ${dependencyLabel} path changed: ${actual.join(", ") || "no dependents"}.`,
    );
  }
}

process.stdout.write(
  "Known transitive exception: tauri-utils 2.9.3 -> urlpattern 0.3.0 -> UNIC 0.9.0.\n",
);

function packageLabel(entry) {
  return `${entry.name}@${entry.version}`;
}
