import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const candidateFilesResult = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  {
    cwd: projectRoot,
    encoding: "buffer",
    maxBuffer: 16 * 1_024 * 1_024,
    windowsHide: true,
  },
);
assertCommandSucceeded(candidateFilesResult, "Could not list repository files.");
const deletedFilesResult = spawnSync("git", ["ls-files", "--deleted", "-z"], {
  cwd: projectRoot,
  encoding: "buffer",
  maxBuffer: 16 * 1_024 * 1_024,
  windowsHide: true,
});
assertCommandSucceeded(deletedFilesResult, "Could not list deleted files.");

const deletedFiles = new Set(parseNullSeparated(deletedFilesResult.stdout));
const existingFiles = parseNullSeparated(candidateFilesResult.stdout).filter(
  (file) => !deletedFiles.has(file),
);
const existingFilesInput = Buffer.from(
  existingFiles.length === 0 ? "" : `${existingFiles.join("\0")}\0`,
  "utf8",
);

const attributesResult = spawnSync("git", ["check-attr", "-z", "--stdin", "text"], {
  cwd: projectRoot,
  encoding: "buffer",
  input: existingFilesInput,
  maxBuffer: 16 * 1_024 * 1_024,
  windowsHide: true,
});
assertCommandSucceeded(attributesResult, "Could not inspect text attributes.");

const textAttributes = parseTextAttributes(attributesResult.stdout);
const decoder = new TextDecoder("utf-8", { fatal: true });
const failures = [];
let validatedFiles = 0;

for (const [file, textAttribute] of textAttributes) {
  if (textAttribute === "unset") {
    continue;
  }
  const bytes = await readFile(path.join(projectRoot, file));
  if (bytes.length === 0) {
    validatedFiles += 1;
    continue;
  }
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    failures.push(`${file}: contains a UTF-8 BOM; save it as UTF-8 without a BOM.`);
    continue;
  }
  if (
    startsWith(bytes, [0xff, 0xfe]) ||
    startsWith(bytes, [0xfe, 0xff]) ||
    startsWith(bytes, [0xff, 0xfe, 0x00, 0x00]) ||
    startsWith(bytes, [0x00, 0x00, 0xfe, 0xff])
  ) {
    failures.push(`${file}: uses UTF-16/UTF-32; convert it to UTF-8 without a BOM.`);
    continue;
  }
  if (bytes.includes(0)) {
    continue;
  }
  try {
    decoder.decode(bytes);
    validatedFiles += 1;
  } catch {
    failures.push(`${file}: does not contain valid UTF-8.`);
  }
}

if (failures.length > 0) {
  throw new Error(`Encoding policy violation:\n${failures.join("\n")}`);
}

process.stdout.write(
  `Validated UTF-8 without BOM in ${validatedFiles} repository text files.\n`,
);

function parseTextAttributes(output) {
  const fields = parseNullSeparated(output);
  if (fields.length % 3 !== 0) {
    throw new Error("The git check-attr result is malformed.");
  }
  const attributes = new Map();
  for (let index = 0; index < fields.length; index += 3) {
    const file = fields[index];
    const attribute = fields[index + 1];
    const value = fields[index + 2];
    if (attribute !== "text" || file === undefined || value === undefined) {
      throw new Error("The git check-attr result contains unexpected fields.");
    }
    attributes.set(file, value);
  }
  return attributes;
}

function parseNullSeparated(output) {
  return output
    .toString("utf8")
    .split("\0")
    .filter((value) => value.length > 0);
}

function startsWith(bytes, prefix) {
  return prefix.every((byte, index) => bytes[index] === byte);
}

function assertCommandSucceeded(result, fallbackMessage) {
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(result.stderr.toString("utf8").trim() || fallbackMessage);
  }
}
