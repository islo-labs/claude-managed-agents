import type { IsloClient } from "../islo/client.js";

export interface RunnableTool {
  name: string;
  parse?: (input: unknown) => unknown;
  run: (
    input: unknown,
    ctx?: { signal?: AbortSignal },
  ) => Promise<string | unknown[]>;
}

const WORKDIR = "/workspace";
const BASH_DEFAULT_TIMEOUT_MS = 60_000;
const BASH_MAX_TIMEOUT_MS = 110_000;
const READ_MAX_BYTES = 5 * 1024 * 1024;
const COMMAND_OUTPUT_MAX_BYTES = 64 * 1024;

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null) {
    return input as Record<string, unknown>;
  }
  return {};
}

function resolvePath(p: unknown): string {
  if (typeof p !== "string" || p.length === 0) {
    throw new Error("file_path is required");
  }
  if (p.startsWith("/")) return p;
  return `${WORKDIR}/${p.replace(/^\.\//, "")}`;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…(truncated, ${s.length - max} bytes more)`;
}

function tool(
  name: string,
  run: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<string | unknown[]>,
): RunnableTool {
  return { name, parse: (input: unknown) => input, run };
}

export function buildStockTools(
  islo: IsloClient,
  sandboxName: string,
): RunnableTool[] {
  return [
    tool("bash", async (input) => {
      const args = asRecord(input);
      const command = args.command;
      if (typeof command !== "string" || command.length === 0) {
        throw new Error("bash: command is required");
      }
      const timeoutMs = Math.min(
        Math.max(typeof args.timeout_ms === "number" ? args.timeout_ms : BASH_DEFAULT_TIMEOUT_MS, 1),
        BASH_MAX_TIMEOUT_MS,
      );
      const result = await islo.exec(
        sandboxName,
        ["/bin/bash", "-lc", command],
        { workdir: WORKDIR, timeoutSecs: Math.ceil(timeoutMs / 1000) },
      );
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const merged = stderr ? `${stdout}\n[stderr]\n${stderr}` : stdout;
      const out = truncate(merged.trimEnd(), COMMAND_OUTPUT_MAX_BYTES);
      if ((result.exit_code ?? 0) !== 0) {
        throw new Error(`bash: exit ${result.exit_code}\n${out || "(no output)"}`);
      }
      return out || "(no output)";
    }),
    tool("read", async (input) => {
      const args = asRecord(input);
      const abs = resolvePath(args.file_path);
      let content = await islo.readFile(sandboxName, abs);
      const viewRange = Array.isArray(args.view_range) ? args.view_range : [];
      const start = viewRange[0];
      const end = viewRange[1];
      if (
        typeof start === "number" &&
        typeof end === "number" &&
        start >= 1 &&
        end >= start
      ) {
        content = content.split("\n").slice(start - 1, end).join("\n");
      }
      return truncate(content, READ_MAX_BYTES);
    }),
    tool("write", async (input) => {
      const args = asRecord(input);
      const abs = resolvePath(args.file_path);
      const body = typeof args.content === "string" ? args.content : "";
      const dir = abs.replace(/\/[^/]*$/, "");
      if (dir && dir !== abs) {
        await islo.mkdir(sandboxName, dir);
      }
      await islo.writeFile(sandboxName, abs, body);
      return `wrote ${new TextEncoder().encode(body).length} bytes to ${abs}`;
    }),
    tool("edit", async (input) => {
      const args = asRecord(input);
      const old_string = args.old_string;
      const new_string = args.new_string;
      const replace_all = args.replace_all === true;
      if (typeof old_string !== "string" || old_string.length === 0) {
        throw new Error("edit: old_string is required");
      }
      const abs = resolvePath(args.file_path);
      const replacement = typeof new_string === "string" ? new_string : "";
      const original = await islo.readFile(sandboxName, abs);
      const occurrences = original.split(old_string).length - 1;
      if (occurrences === 0) {
        throw new Error(`edit: old_string not found in ${abs}`);
      }
      if (occurrences > 1 && !replace_all) {
        throw new Error(
          `edit: old_string matches ${occurrences} times in ${abs}; pass replace_all=true to replace all`,
        );
      }
      const updated = replace_all
        ? original.replaceAll(old_string, replacement)
        : original.replace(old_string, replacement);
      await islo.writeFile(sandboxName, abs, updated);
      return `edited ${abs} (${occurrences} replacement${occurrences === 1 ? "" : "s"})`;
    }),
    tool("glob", async (input) => {
      const args = asRecord(input);
      const pattern = args.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error("glob: pattern is required");
      }
      const root = args.path ? resolvePath(args.path) : WORKDIR;
      const namePattern = pattern.replace(/^\*\*\//, "");
      const cmd = `find ${shellQuote(root)} -type f -name ${shellQuote(namePattern)} 2>/dev/null | head -1000`;
      const result = await islo.exec(
        sandboxName,
        ["/bin/bash", "-lc", cmd],
        { workdir: WORKDIR, timeoutSecs: 15 },
      );
      return truncate((result.stdout ?? "").trim() || "(no matches)", COMMAND_OUTPUT_MAX_BYTES);
    }),
    tool("grep", async (input) => {
      const args = asRecord(input);
      const pattern = args.pattern;
      if (typeof pattern !== "string" || pattern.length === 0) {
        throw new Error("grep: pattern is required");
      }
      const root = args.path ? resolvePath(args.path) : WORKDIR;
      const flags = ["-n", "--no-heading"];
      if (typeof args.type === "string") flags.push("-t", args.type);
      if (typeof args.glob === "string") flags.push("-g", args.glob);
      const rgCmd = `rg ${flags.join(" ")} ${shellQuote(pattern)} ${shellQuote(root)} 2>/dev/null | head -500`;
      let result = await islo.exec(
        sandboxName,
        ["/bin/bash", "-lc", rgCmd],
        { workdir: WORKDIR, timeoutSecs: 30 },
      );
      if ((result.exit_code ?? 0) === 127) {
        const grepCmd = `grep -rn ${shellQuote(pattern)} ${shellQuote(root)} 2>/dev/null | head -500`;
        result = await islo.exec(
          sandboxName,
          ["/bin/bash", "-lc", grepCmd],
          { workdir: WORKDIR, timeoutSecs: 30 },
        );
      }
      return truncate((result.stdout ?? "").trim() || "(no matches)", COMMAND_OUTPUT_MAX_BYTES);
    }),
  ];
}
