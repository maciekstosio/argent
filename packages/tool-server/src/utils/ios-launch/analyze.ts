import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { parseCpuXml } from "../ios-profiler/pipeline/xml-parser";

export interface LaunchFinding {
  finding: string;
  comment: string;
  time: string;
  spot: string;
  confidence: "high" | "medium" | "low";
}

function decode(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function rows(xml: string): string[] {
  return [...xml.matchAll(/<row>(.*?)<\/row>/gs)].map((match) => match[1]!);
}

function field(row: string, tag: string, registry: Map<string, string>): string | null {
  const match = new RegExp(`<${tag}\\b([^>]*)(?:>([^<]*)<\\/${tag}>|\\/>)`).exec(row);
  if (!match) return null;
  const attrs = match[1]!;
  const ref = /\bref="([^"]+)"/.exec(attrs)?.[1];
  if (ref) return registry.get(`${tag}:${ref}`) ?? null;
  const value = /\bfmt="([^"]*)"/.exec(attrs)?.[1] ?? match[2] ?? "";
  const decoded = decode(value);
  const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
  if (id) registry.set(`${tag}:${id}`, decoded);
  return decoded;
}

function numericField(row: string, tag: string, registry: Map<string, string>): number | null {
  const match = new RegExp(`<${tag}\\b([^>]*)(?:>(\\d+)<\\/${tag}>|\\/>)`).exec(row);
  if (!match) return null;
  const attrs = match[1]!;
  const ref = /\bref="([^"]+)"/.exec(attrs)?.[1];
  if (ref) return Number(registry.get(`${tag}:${ref}`) ?? NaN);
  const value = match[2] ?? "";
  const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
  if (id) registry.set(`${tag}:${id}`, value);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function periodFindings(
  xml: string,
  tag: "app-period" | "dyld-activity",
  limit: number,
  launchEndNs?: number
): LaunchFinding[] {
  const registry = new Map<string, string>();
  const candidates: Array<{ label: string; ms: number }> = [];
  for (const row of rows(xml)) {
    const label = field(row, tag, registry);
    const durationNs = numericField(row, "duration", registry);
    const startNs = numericField(row, "start-time", registry);
    if (launchEndNs != null && (startNs == null || startNs >= launchEndNs)) continue;
    if (!label || durationNs == null || durationNs < 10_000_000) continue;
    if (tag === "app-period" && /^(Foreground|Background) - /.test(label)) continue;
    const image =
      tag === "dyld-activity" && label === "Map Image" ? field(row, "string", registry) : null;
    candidates.push({
      label: image ? `Map ${path.basename(image).replace(/\.framework$/, "")}` : label,
      ms: durationNs / 1_000_000,
    });
  }
  return candidates
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map(({ label, ms }) => ({
      finding: label,
      comment:
        tag === "app-period"
          ? "App lifecycle interval. Inspect work inside this phase; it is not a single function."
          : "Dynamic loader activity. This interval may contain nested loader tasks.",
      time: `${ms.toFixed(1)} ms wall interval`,
      spot: "unknown",
      confidence: "low" as const,
    }));
}

function firstFrameTime(xml: string): number | null {
  const registry = new Map<string, string>();
  for (const row of rows(xml)) {
    const label = field(row, "app-period", registry);
    const startNs = numericField(row, "start-time", registry);
    if (label === "Foreground - Active" && startNs != null) return startNs;
  }
  return null;
}

function firstTimeProfileNode(xml: string): string {
  const start = xml.indexOf("<node");
  const end = xml.indexOf("</node>", start);
  if (start < 0 || end < 0) return xml;
  return `<trace-query-result>${xml.slice(start, end + 7)}</trace-query-result>`;
}

function runningSampleTimes(xml: string): Set<number> {
  const ids = new Set(
    [...xml.matchAll(/<thread-state\s+id="(\d+)"\s+fmt="Running"/g)].map((match) => match[1]!)
  );
  const result = new Set<number>();
  for (const row of rows(xml)) {
    const state = /<thread-state\b([^>]*)\/?\s*>/.exec(row)?.[1] ?? "";
    const ref = /\bref="(\d+)"/.exec(state)?.[1];
    if (!state.includes('fmt="Running"') && (!ref || !ids.has(ref))) continue;
    const timestamp = /<sample-time\b[^>]*>(\d+)<\/sample-time>/.exec(row)?.[1];
    if (timestamp) result.add(Number(timestamp));
  }
  return result;
}

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const excluded = new Set([
    ".git",
    ".argent",
    "node_modules",
    "Pods",
    "build",
    "DerivedData",
    "dist",
  ]);
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 7 || files.length > 5000) return;
    const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full, depth + 1);
      else if (entry.isFile() && /\.(swift|m|mm|c|cc|cpp)$/.test(entry.name)) files.push(full);
    }
  }
  await walk(root, 0);
  return files;
}

const GENERIC_SOURCE_NAMES = new Set([
  "AppDelegate",
  "ViewController",
  "Manager",
  "Module",
  "Factory",
  "Utils",
]);

function sourceIndex(files: string[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const file of files) {
    const name = path.basename(file, path.extname(file));
    if (name.length < 8 || GENERIC_SOURCE_NAMES.has(name)) continue;
    const paths = index.get(name) ?? [];
    paths.push(file);
    index.set(name, paths);
  }
  return index;
}

function matchSource(symbol: string, index: Map<string, string[]>): string {
  const objectiveCClass = /^[+-]\[([A-Za-z_][A-Za-z0-9_]*)\s/.exec(symbol)?.[1];
  const qualifiedTypes = [...symbol.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\./g)];
  const owner = objectiveCClass ?? qualifiedTypes.at(-1)?.[1];
  const matches = owner ? index.get(owner) : undefined;
  return matches?.length === 1 ? matches[0]! : "unknown";
}

export async function analyzeAppLaunchExports(
  workspacePath: string,
  paths: { lifecycle?: string; dyld?: string; cpu?: string }
): Promise<LaunchFinding[]> {
  const findings: LaunchFinding[] = [];
  const lifecycle = paths.lifecycle ? await fsp.readFile(paths.lifecycle, "utf8") : null;
  const launchEndNs = lifecycle ? firstFrameTime(lifecycle) : null;
  if (lifecycle) {
    findings.push(...periodFindings(lifecycle, "app-period", 3, launchEndNs ?? undefined));
  }
  if (launchEndNs == null) {
    findings.push({
      finding: "Launch boundary unavailable",
      comment:
        "Instruments did not identify the first frame. CPU and loader work cannot be isolated to launch.",
      time: "unknown",
      spot: "unknown",
      confidence: "low",
    });
  }
  if (paths.dyld && launchEndNs != null) {
    findings.push(
      ...periodFindings(await fsp.readFile(paths.dyld, "utf8"), "dyld-activity", 4, launchEndNs)
    );
  }
  if (paths.cpu && launchEndNs != null) {
    const xml = firstTimeProfileNode(await fsp.readFile(paths.cpu, "utf8"));
    const running = runningSampleTimes(xml);
    const samples = parseCpuXml(xml.replaceAll("tagged-backtrace", "backtrace")).filter(
      (sample) =>
        sample.threadFmt.includes("Main Thread") &&
        running.has(sample.timestampNs) &&
        sample.timestampNs < launchEndNs
    );
    const weights = new Map<string, { ns: number; first: number; last: number }>();
    for (const sample of samples) {
      const unique = new Set(
        sample.stack.filter((frame) => !frame.isSystemLibrary).map((frame) => frame.name)
      );
      for (const symbol of unique) {
        if (symbol === "main") continue;
        const prior = weights.get(symbol);
        if (prior) {
          prior.ns += sample.weightNs;
          prior.first = Math.min(prior.first, sample.timestampNs);
          prior.last = Math.max(prior.last, sample.timestampNs);
        } else {
          weights.set(symbol, {
            ns: sample.weightNs,
            first: sample.timestampNs,
            last: sample.timestampNs,
          });
        }
      }
    }
    const files = await sourceFiles(workspacePath);
    const index = sourceIndex(files);
    const ranked = [...weights.entries()].sort((a, b) => b[1].ns - a[1].ns);
    const app = ranked.filter(([name]) => matchSource(name, index) !== "unknown").slice(0, 5);
    const frameworks = ranked
      .filter(([name]) => matchSource(name, index) === "unknown")
      .slice(0, 4);
    for (const [symbol, weight] of [...app, ...frameworks]) {
      const spot = matchSource(symbol, index);
      findings.push({
        finding: symbol,
        comment:
          "Inclusive main-thread running samples; stacks overlap, so sampled weights cannot be summed.",
        time: `${(weight.ns / 1_000_000).toFixed(1)} ms sampled weight (${(weight.first / 1_000_000).toFixed(0)}–${(weight.last / 1_000_000).toFixed(0)} ms trace window)`,
        spot,
        confidence: spot === "unknown" ? "low" : "medium",
      });
    }
  }
  return findings;
}

export function renderLaunchFindings(findings: LaunchFinding[]): string {
  const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return [
    "# iOS App Launch findings",
    "",
    "Times in lifecycle and dyld rows are wall intervals. CPU rows are sampled weights and must not be summed with intervals.",
    "",
    "| Finding | Comment | Time | Spot | Confidence |",
    "|---|---|---:|---|---|",
    ...findings.map(
      (row) =>
        `| ${cell(row.finding)} | ${cell(row.comment)} | ${cell(row.time)} | ${cell(row.spot)} | ${row.confidence} |`
    ),
    "",
  ].join("\n");
}
