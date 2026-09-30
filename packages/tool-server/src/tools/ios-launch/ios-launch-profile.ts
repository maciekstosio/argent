import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";
import type { FileInputSpec, ToolDefinition } from "@argent/registry";
import {
  ensureLaunchDeviceReady,
  prepareReleaseLaunch,
  runLogged,
  terminateForWarmLaunch,
} from "../../utils/ios-launch/workflow";
import { analyzeAppLaunchExports, renderLaunchFindings } from "../../utils/ios-launch/analyze";

const execFileAsync = promisify(execFile);

const schema = z.object({
  workspace_path: z.string().describe("Absolute path to the iOS app project root."),
  device_id: z
    .string()
    .optional()
    .describe("Connected iPhone UDID; required for a physical-device run."),
  scheme: z
    .string()
    .optional()
    .describe("App scheme; required when Xcode cannot select one unambiguously."),
  xcode_container: z
    .string()
    .optional()
    .describe("Workspace or project path, relative to workspace_path."),
  allow_simulator: z
    .boolean()
    .default(false)
    .describe("Explicitly allow a booted simulator when no iPhone is selected."),
  duration_seconds: z
    .number()
    .int()
    .min(5)
    .max(60)
    .default(8)
    .describe("App Launch trace recording length."),
});

const fileInputs: FileInputSpec[] = [
  { target: "workspace_path", path: "${workspace_path}", kind: "directory" },
];

const EXPORTS = {
  lifecycle: "life-cycle-period",
  dyld: "dyld-activity-interval",
  cpu: "time-profile",
} as const;

export const iosLaunchProfileTool: ToolDefinition<z.infer<typeof schema>, unknown> = {
  id: "ios-launch-profile",
  longRunning: true,
  searchHint: "iOS iPhone app launch Instruments xctrace trace startup weak spots Release",
  capability: { apple: { device: true, simulator: true } },
  interaction: {
    startedMsg: () => "Recording iOS App Launch in Release",
    completedMsg: () => "Recorded and analyzed iOS App Launch",
    failedMsg: ({ failureSignal }) =>
      `Failed to record iOS App Launch: ${failureSignal.error_code}`,
  },
  description:
    "Build an iOS app in Release, warm-launch it on a physical iPhone under Xcode Instruments' App Launch template, and report lifecycle, dyld, and main-thread sample hotspots. Saves the raw .trace and exports under <workspace>/.argent/traces/<datetime>. Source locations are shown only when uniquely inferred from repository source; otherwise spot is unknown. A simulator requires explicit allow_simulator=true.",
  zodSchema: schema,
  fileInputs,
  services: () => ({}),
  async execute(_services, params, ctx) {
    const context = await prepareReleaseLaunch(
      {
        workspacePath: params.workspace_path,
        deviceId: params.device_id,
        scheme: params.scheme,
        xcodeContainer: params.xcode_container,
        allowSimulator: params.allow_simulator,
      },
      (message) => ctx?.emitProgress?.({ type: "device-action", message }),
      ctx?.signal
    );
    await terminateForWarmLaunch(context, ctx?.signal);
    await ensureLaunchDeviceReady(
      context,
      (message) => ctx?.emitProgress?.({ type: "device-action", message }),
      ctx?.signal
    );
    const tracePath = path.join(context.runDir, "app-launch.trace");
    const recordLog = path.join(context.runDir, "xctrace-record.log");
    await runLogged(
      "xcrun",
      [
        "xctrace",
        "record",
        "--template",
        "App Launch",
        "--device",
        context.deviceId,
        "--output",
        tracePath,
        "--time-limit",
        `${params.duration_seconds}s`,
        "--no-prompt",
        "--launch",
        "--",
        context.bundleId,
      ],
      { cwd: params.workspace_path, logPath: recordLog, timeoutMs: 180_000, signal: ctx?.signal }
    );
    if (!(await fsp.stat(tracePath).catch(() => null))?.isDirectory()) {
      throw new Error(`xctrace finished without a trace at ${tracePath}; see ${recordLog}.`);
    }
    const exportErrors: Record<string, string> = {};
    const exported: Partial<Record<keyof typeof EXPORTS, string>> = {};
    let schemas: string[] = [];
    try {
      const { stdout } = await execFileAsync(
        "xcrun",
        ["xctrace", "export", "--input", tracePath, "--toc"],
        { timeout: 120_000, maxBuffer: 4 * 1024 * 1024, signal: ctx?.signal }
      );
      await fsp.writeFile(path.join(context.runDir, "toc.xml"), stdout);
      schemas = [...stdout.matchAll(/schema="([^"]+)"/g)].map((match) => match[1]!);
    } catch (error) {
      ctx?.signal?.throwIfAborted();
      exportErrors.toc = error instanceof Error ? error.message : String(error);
    }
    for (const [key, schemaName] of Object.entries(EXPORTS) as Array<
      [keyof typeof EXPORTS, string]
    >) {
      ctx?.signal?.throwIfAborted();
      if (!schemas.includes(schemaName)) {
        exportErrors[key] = `Trace does not contain ${schemaName}.`;
        continue;
      }
      const output = path.join(context.runDir, `${key}.xml`);
      try {
        await runLogged(
          "xcrun",
          [
            "xctrace",
            "export",
            "--input",
            tracePath,
            "--output",
            output,
            "--xpath",
            `/trace-toc/run[@number="1"]/data/table[@schema="${schemaName}"]`,
          ],
          {
            cwd: params.workspace_path,
            logPath: path.join(context.runDir, `xctrace-export-${key}.log`),
            timeoutMs: 120_000,
            signal: ctx?.signal,
          }
        );
        exported[key] = output;
      } catch (error) {
        ctx?.signal?.throwIfAborted();
        exportErrors[key] = error instanceof Error ? error.message : String(error);
      }
    }
    ctx?.signal?.throwIfAborted();
    const findings = await analyzeAppLaunchExports(params.workspace_path, exported);
    ctx?.signal?.throwIfAborted();
    const reportPath = path.join(context.runDir, "findings.md");
    const findingsTable = renderLaunchFindings(findings);
    await fsp.writeFile(reportPath, findingsTable);
    await fsp.writeFile(
      path.join(context.runDir, "analysis.json"),
      JSON.stringify(
        {
          configuration: "Release",
          launchState: "warm",
          tracePath,
          exported,
          exportErrors,
          findings,
        },
        null,
        2
      )
    );
    ctx?.emitProgress?.({ type: "artifact", tracePath, reportPath });
    return {
      configuration: "Release",
      launchState: "warm",
      device: { id: context.deviceId, name: context.deviceName, simulator: context.simulator },
      bundleId: context.bundleId,
      tracePath,
      reportPath,
      findingsTable,
      exportErrors,
      warning: context.warning,
    };
  },
};
