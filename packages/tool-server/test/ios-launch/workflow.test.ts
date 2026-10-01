import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../../src/utils/setup-registry";
import { definitionsById } from "../helpers/catalog";
import {
  appBuildArgs,
  appBuildKey,
  assertResolvedConfiguration,
  runLogged,
  showBuildSettingsArgs,
} from "../../src/utils/ios-launch/workflow";

let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

it("advertises both launch commands as long running", () => {
  const definitions = definitionsById(createRegistry());
  expect(definitions.get("ios-launch-measure")?.longRunning).toBe(true);
  expect(definitions.get("ios-launch-profile")?.longRunning).toBe(true);
});

it("stops a logged subprocess when its tool request is cancelled", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-abort-"));
  const controller = new AbortController();
  const work = runLogged(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: directory,
    logPath: join(directory, "child.log"),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 100);
  await expect(work).rejects.toMatchObject({ name: "AbortError" });
});

it("passes the requested configuration to xcodebuild", () => {
  const settings = showBuildSettingsArgs("App.xcodeproj", "App", "Production", "dest", "/dd");
  expect(settings[settings.indexOf("-configuration") + 1]).toBe("Production");
  const build = appBuildArgs("App.xcodeproj", "App", "Production", "dest", "/dd", ["X=1"]);
  expect(build[0]).toBe("build");
  expect(build[build.indexOf("-configuration") + 1]).toBe("Production");
  expect(build).not.toContain("Release");
  expect(build.at(-1)).toBe("X=1");
});

it("checks the resolved CONFIGURATION against the requested one", () => {
  expect(() =>
    assertResolvedConfiguration({ CONFIGURATION: "Production" }, "Production")
  ).not.toThrow();
  expect(() => assertResolvedConfiguration({ CONFIGURATION: "Release" }, "Production")).toThrow(
    "Xcode did not resolve the app to Production."
  );
});

it("keeps build caches of different configurations apart", () => {
  const a = appBuildKey("c", "s", "d", "Release");
  expect(a).toBe(appBuildKey("c", "s", "d", "Release"));
  expect(a).not.toBe(appBuildKey("c", "s", "d", "Production"));
});

it("defaults the app configuration to Release in both tool schemas", () => {
  const definitions = definitionsById(createRegistry());
  for (const id of ["ios-launch-measure", "ios-launch-profile"]) {
    const schema = definitions.get(id)!.zodSchema as import("zod").ZodType;
    const parsed = schema.parse({ workspace_path: "/x" }) as { configuration: string };
    expect(parsed.configuration).toBe("Release");
  }
});
