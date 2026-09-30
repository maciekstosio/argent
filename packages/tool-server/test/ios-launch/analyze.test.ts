import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeAppLaunchExports } from "../../src/utils/ios-launch/analyze";

let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

it("uses only the first App Launch time-profile node and maps a unique app source", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-analyze-"));
  const source = join(directory, "MyLaunchTask.swift");
  await writeFile(source, "struct MyLaunchTask { func run() {} }");
  await writeFile(join(directory, "MyLaunchTaskExtra.swift"), "struct MyLaunchTaskExtra {}");
  const row =
    `<row><sample-time id="1">10000000</sample-time>` +
    `<thread id="2" fmt="Main Thread (App)"></thread>` +
    `<thread-state id="3" fmt="Running">Running</thread-state>` +
    `<weight id="4">5000000</weight>` +
    `<tagged-backtrace id="5"><frame id="6" name="MyLaunchTask.run()">` +
    `<binary id="7" name="App" path="/private/App.app/App"/></frame></tagged-backtrace></row>`;
  const lateRow = row
    .replace("10000000", "30000000")
    .replaceAll("MyLaunchTask.run()", "MyLaunchTask.lateWork()");
  const cpu = join(directory, "cpu.xml");
  const lifecycle = join(directory, "lifecycle.xml");
  await writeFile(
    cpu,
    `<trace-query-result><node>${row}${lateRow}</node><node>${row}</node></trace-query-result>`
  );
  await writeFile(
    lifecycle,
    `<trace-query-result><node><row>` +
      `<start-time id="1">20000000</start-time>` +
      `<app-period id="2" fmt="Foreground - Active">Foreground - Active</app-period>` +
      `</row></node></trace-query-result>`
  );

  const findings = await analyzeAppLaunchExports(directory, { cpu, lifecycle });
  const task = findings.find((finding) => finding.finding === "MyLaunchTask.run()");
  expect(task).toMatchObject({ spot: source, confidence: "medium" });
  expect(task?.time).toContain("5.0 ms sampled weight");
  expect(findings.some((finding) => finding.finding.includes("lateWork"))).toBe(false);
});

it("excludes the foreground-active recording window from launch weak spots", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-lifecycle-"));
  const lifecycle = join(directory, "lifecycle.xml");
  await writeFile(
    lifecycle,
    `<trace-query-result><node>` +
      `<row><start-time id="5">200000000</start-time>` +
      `<app-period id="1" fmt="Foreground - Active">Foreground - Active</app-period>` +
      `<duration id="2">8000000000</duration></row>` +
      `<row><start-time id="6">10000000</start-time>` +
      `<app-period id="3" fmt="Launching - didFinishLaunchingWithOptions()">` +
      `Launching - didFinishLaunchingWithOptions()</app-period>` +
      `<duration id="4">150000000</duration></row>` +
      `</node></trace-query-result>`
  );
  const findings = await analyzeAppLaunchExports(directory, { lifecycle });
  expect(findings.map((finding) => finding.finding)).toEqual([
    "Launching - didFinishLaunchingWithOptions()",
  ]);
});
