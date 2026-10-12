import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../../src/utils/setup-registry";
import { definitionsById } from "../helpers/catalog";
import {
  appBuildArgs,
  appBuildKey,
  assertResolvedConfiguration,
  freeProfileLimitMessage,
  iosAppTargets,
  launchBuildCacheDir,
  pickScheme,
  runLogged,
  showBuildSettingsArgs,
} from "../../src/utils/ios-launch-time/workflow";

let directory: string | null = null;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

it("advertises both launch commands as long running", () => {
  const definitions = definitionsById(createRegistry());
  expect(definitions.get("ios-launch-time-measure")?.longRunning).toBe(true);
  expect(definitions.get("ios-launch-time-profile")?.longRunning).toBe(true);
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
  const a = appBuildKey("c", "s", "d", "Release", "Xcode 26.3");
  expect(a).toBe(appBuildKey("c", "s", "d", "Release", "Xcode 26.3"));
  expect(a).not.toBe(appBuildKey("c", "s", "d", "Production", "Xcode 26.3"));
});

it("keeps build caches of different Xcode versions apart", () => {
  expect(appBuildKey("c", "s", "d", "Release", "Xcode 26.3")).not.toBe(
    appBuildKey("c", "s", "d", "Release", "Xcode 26.4")
  );
});

describe("freeProfileLimitMessage", () => {
  const cap =
    "This device has reached the maximum number of installed apps using a free developer profile.";

  it("ignores text without the free-profile cap", () => {
    expect(
      freeProfileLimitMessage("No profiles for x", { subject: "s", logPath: "/l" })
    ).toBeNull();
  });

  it("explains the cap and names the log", () => {
    const message = freeProfileLimitMessage(cap, { subject: "the runner", logPath: "/l.log" });
    expect(message).toContain("no slot for the runner");
    expect(message).toContain("Log: /l.log");
    expect(message).not.toContain("leftover");
  });

  it("names an Argent runner of another team as a leftover", () => {
    const text = `${cap} Installed: com.example.app, com.argent.runner.tabc123, com.argent.runner.tmine99.uitests`;
    const message = freeProfileLimitMessage(text, {
      subject: "the runner",
      logPath: "/l",
      ownBundleIdPrefix: "com.argent.runner.tMINE99",
    });
    expect(message).toContain("com.argent.runner.tabc123 looks like a leftover");
    expect(message).not.toContain("tmine99 looks");
  });

  it("does not call the own runner a leftover", () => {
    const message = freeProfileLimitMessage(`${cap} com.argent.runner.tmine99`, {
      subject: "the runner",
      logPath: "/l",
      ownBundleIdPrefix: "com.argent.runner.tmine99",
    });
    expect(message).not.toContain("leftover");
  });
});

it("reports the free-profile cap from a failed logged command, not a signing hint", async () => {
  directory = await mkdtemp(join(tmpdir(), "argent-launch-free-"));
  const script =
    "console.error('error: Provisioning Profile: x'); " +
    "console.error('maximum number of installed apps using a free developer profile'); process.exit(65)";
  const error = await runLogged(process.execPath, ["-e", script], {
    cwd: directory,
    logPath: join(directory, "child.log"),
  }).catch((e: Error) => e);
  expect((error as Error).message).toContain("free developer profile");
  expect((error as Error).message).not.toContain("Provisioning failed");
});

it("defaults the app configuration to Release in both tool schemas", () => {
  const definitions = definitionsById(createRegistry());
  for (const id of ["ios-launch-time-measure", "ios-launch-time-profile"]) {
    const schema = definitions.get(id)!.zodSchema as import("zod").ZodType;
    const parsed = schema.parse({ workspace_path: "/x" }) as { configuration: string };
    expect(parsed.configuration).toBe("Release");
  }
});

it("picks the app scheme among the schemes CocoaPods adds", () => {
  const pods = new Set(["React-Core", "Yoga", "Pods-App"]);
  const all = ["App", "React-Core", "Yoga", "Pods-App"];
  expect(pickScheme(all, "/r/ios/App.xcworkspace", pods)).toBe("App");
  expect(pickScheme(["Only"], "/r/ios/App.xcworkspace", new Set())).toBe("Only");
  // Several app schemes: the one named after the workspace wins.
  expect(pickScheme(["Runner", "Runner-Dev", "Yoga"], "/r/ios/Runner.xcworkspace", pods)).toBe(
    "Runner"
  );
  expect(pickScheme(["Dev", "Prod"], "/r/ios/App.xcworkspace", new Set())).toBeNull();
});

it("selects the iOS app target over embedded watch apps and App Clips", () => {
  const target = (name: string, settings: Record<string, string>) => ({
    target: name,
    buildSettings: { WRAPPER_EXTENSION: "app", ...settings },
  });
  const app = target("App", {
    PRODUCT_TYPE: "com.apple.product-type.application",
    PLATFORM_NAME: "iphoneos",
  });
  const watch = target("Watch", {
    PRODUCT_TYPE: "com.apple.product-type.application",
    PLATFORM_NAME: "watchos",
  });
  const clip = target("Clip", {
    PRODUCT_TYPE: "com.apple.product-type.application.on-demand-install-capable",
    PLATFORM_NAME: "iphoneos",
  });
  const widget = { target: "Widget", buildSettings: { WRAPPER_EXTENSION: "appex" } };
  expect(iosAppTargets([app, watch, clip, widget])).toEqual([app]);
  const unknown = target("Legacy", {});
  expect(iosAppTargets([unknown, widget])).toEqual([unknown]);
});

it("keeps launch build caches out of the app project", () => {
  expect(launchBuildCacheDir("app", "k")).toBe(
    join(homedir(), ".argent", "build-cache", "ios-launch-time", "k")
  );
  expect(launchBuildCacheDir("runner", "k")).toBe(
    join(homedir(), ".argent", "build-cache", "ios-launch-time-runner", "k")
  );
});
