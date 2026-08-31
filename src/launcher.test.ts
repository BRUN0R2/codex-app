import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];
const windowsTest = process.platform === "win32" ? it : it.skip;

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Windows development launcher", () => {
  windowsTest(
    "presents the interactive menu in English by default",
    () => {
      const project = createLauncherProject("ready");
      const result = runLauncher(project, { arguments: [], input: "0\r\n" });

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("1. Start in debug mode");
      expect(result.stdout).toContain("2. Build and start release");
      expect(result.stdout).toContain("0. Exit");
      expect(result.stdout).toContain("Select an option: 0");
      expect(result.stdout).not.toMatch(/Iniciar|Compilar|Sair|Selecione/u);
    },
    15_000,
  );

  windowsTest(
    "uses a valid dependency installation without changing it",
    () => {
      const project = createLauncherProject("ready");
      const result = runLauncher(project);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readInvocations(project.invocationPath)).toEqual(["list --depth=0", "release"]);
      expect(result.stdout).toContain("Building and starting Codex App release");
      expect(result.stdout).not.toContain("Installing the exact versions");
      expect(result.stdout).not.toContain("Recreating local dependency commands");
    },
    15_000,
  );

  windowsTest(
    "installs the frozen dependency graph when node_modules is missing",
    () => {
      const project = createLauncherProject("missing");
      const result = runLauncher(project);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readInvocations(project.invocationPath)).toEqual([
        "install --frozen-lockfile",
        "list --depth=0",
        "release",
      ]);
      expect(result.stdout).toContain("Installing the exact versions defined in pnpm-lock.yaml");
    },
    15_000,
  );

  windowsTest(
    "rebuilds missing local command shims",
    () => {
      const project = createLauncherProject("missing-shim");
      const result = runLauncher(project);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(readInvocations(project.invocationPath)).toEqual([
        "list --depth=0",
        "rebuild",
        "release",
      ]);
      expect(result.stdout).toContain("Recreating local dependency commands");
    },
    15_000,
  );

  windowsTest(
    "fails clearly when pnpm is unavailable from PATH",
    () => {
      const project = createLauncherProject("ready");
      const result = runLauncher(project, { includePnpm: false });

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("pnpm was not found on PATH");
    },
    15_000,
  );
});

type DependencyState = "missing" | "missing-shim" | "ready";

interface LauncherProject {
  readonly invocationPath: string;
  readonly projectRoot: string;
  readonly toolsDirectory: string;
}

function createLauncherProject(dependencyState: DependencyState): LauncherProject {
  const projectRoot = mkdtempSync(path.join(tmpdir(), "codex-launcher-"));
  const invocationPath = path.join(projectRoot, "pnpm-invocations.txt");
  const toolsDirectory = path.join(projectRoot, "tools");
  temporaryDirectories.push(projectRoot);

  copyFileSync(path.resolve("codex-app.bat"), path.join(projectRoot, "codex-app.bat"));
  mkdirSync(toolsDirectory);
  writeFileSync(path.join(projectRoot, "package.json"), "{}\n", "utf8");
  writeFileSync(path.join(projectRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writePnpmCommand(path.join(toolsDirectory, "pnpm.cmd"));

  if (dependencyState !== "missing") {
    mkdirSync(path.join(projectRoot, "node_modules"));
  }
  if (dependencyState === "ready") {
    createLocalTauriShim(projectRoot);
  }

  return { invocationPath, projectRoot, toolsDirectory };
}

interface LauncherRunOptions {
  readonly arguments?: readonly string[];
  readonly includePnpm?: boolean;
  readonly input?: string;
}

function runLauncher(project: LauncherProject, options: LauncherRunOptions = {}) {
  const environment = createIsolatedEnvironment(project, options.includePnpm ?? true);
  const launcherArguments = options.arguments ?? ["release"];
  return spawnSync(
    environmentValue("ComSpec") ?? "cmd.exe",
    ["/d", "/c", "codex-app.bat", ...launcherArguments],
    {
      cwd: project.projectRoot,
      encoding: "utf8",
      env: environment,
      input: options.input,
      windowsHide: true,
    },
  );
}

function createIsolatedEnvironment(
  project: LauncherProject,
  includePnpm: boolean,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === "path") {
      delete environment[key];
    }
  }

  const systemRoot = environmentValue("SystemRoot") ?? "C:\\Windows";
  const pathDirectories = includePnpm
    ? [project.toolsDirectory, path.join(systemRoot, "System32")]
    : [path.join(systemRoot, "System32")];
  return {
    ...environment,
    LAUNCHER_TEST_INVOCATION: project.invocationPath,
    PATH: pathDirectories.join(path.delimiter),
  };
}

function writePnpmCommand(filePath: string): void {
  writeCommand(
    filePath,
    [
      '>>"%LAUNCHER_TEST_INVOCATION%" echo %*',
      'if /i "%~1"=="install" goto create_shim',
      'if /i "%~1"=="rebuild" goto create_shim',
      "exit /b 0",
      ":create_shim",
      'if not exist "node_modules\\.bin" mkdir "node_modules\\.bin"',
      'type nul > "node_modules\\.bin\\tauri.cmd"',
      "exit /b 0",
    ].join("\r\n"),
  );
}

function createLocalTauriShim(projectRoot: string): void {
  const binaryDirectory = path.join(projectRoot, "node_modules", ".bin");
  mkdirSync(binaryDirectory, { recursive: true });
  writeCommand(path.join(binaryDirectory, "tauri.cmd"), "exit /b 0");
}

function writeCommand(filePath: string, body: string): void {
  writeFileSync(filePath, `@echo off\r\n${body}\r\n`, "utf8");
}

function readInvocations(filePath: string): string[] {
  return readFileSync(filePath, "utf8").trim().split(/\r?\n/u);
}

function environmentValue(name: string): string | undefined {
  return process.env[name];
}
