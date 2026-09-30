import { afterEach, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistry } from "../../src/utils/setup-registry";
import { definitionsById } from "../helpers/catalog";
import { runLogged } from "../../src/utils/ios-launch/workflow";

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
