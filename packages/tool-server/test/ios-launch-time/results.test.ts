import { describe, expect, it } from "vitest";
import {
  coreExportFailureMessage,
  failedCoreExport,
  launchSampleStats,
  optionalExportCrashNote,
  simulatorLaunchWindow,
  simulatorProfileNote,
  stalledAtRecordingStart,
  stallsSimulatorLaunchRecording,
} from "../../src/utils/ios-launch-time/results";
import { parseXcodeVersion } from "../../src/utils/ios-profiler/capture-strategy/select";

describe("launchSampleStats", () => {
  const device = { expected: 5, simulator: false };

  it("averages a full set of five samples with no warning", () => {
    expect(launchSampleStats([0.5, 0.3, 0.4, 0.2, 0.1], device)).toEqual({
      averageMs: 300,
      medianMs: 300,
      samplesMs: [500, 300, 400, 200, 100],
      samplesCollected: 5,
      dropped: 0,
      warning: null,
    });
  });

  it("takes the mean of the two middle samples for an even count", () => {
    const stats = launchSampleStats([0.4, 0.1, 0.3, 0.2], device)!;
    expect(stats.medianMs).toBe(250);
    expect(stats.averageMs).toBe(250);
    expect(stats.samplesCollected).toBe(4);
    expect(stats.dropped).toBe(1);
    expect(stats.warning).toContain("dropped 1 of 5");
    expect(stats.warning).toContain("iOS 18");
  });

  it("takes the middle sample of three", () => {
    const stats = launchSampleStats([0.21, 0.2, 0.9], device)!;
    expect(stats.medianMs).toBe(210);
    expect(stats.averageMs).toBe(437);
    expect(stats.dropped).toBe(2);
    expect(stats.warning).toContain("dropped 2 of 5");
  });

  it("does not blame iOS 18 on a simulator", () => {
    const stats = launchSampleStats([0.2, 0.3, 0.4], { expected: 5, simulator: true })!;
    expect(stats.warning).toContain("dropped 2 of 5");
    expect(stats.warning).not.toContain("iOS 18");
  });

  it("returns null without samples", () => {
    expect(launchSampleStats([], device)).toBeNull();
  });
});

describe("stalledAtRecordingStart", () => {
  it("detects a stall with the unicode ellipsis and trailing blank lines", () => {
    expect(stalledAtRecordingStart("Launching app\nStarting recording…\n\n  \n")).toBe(true);
  });

  it("detects a stall when other output follows the start line", () => {
    expect(
      stalledAtRecordingStart("Starting recording...\nwarning: some instrument is slow\n")
    ).toBe(true);
  });

  it("is false for an empty log", () => {
    expect(stalledAtRecordingStart("")).toBe(false);
  });

  it("is false for a completed recording", () => {
    expect(
      stalledAtRecordingStart(
        "Starting recording…\nReached specified time limit. Ending recording…\nRecording completed. Saving output file…\n"
      )
    ).toBe(false);
  });
});

describe("stallsSimulatorLaunchRecording", () => {
  it("matches Xcode 26.4.x only", () => {
    const check = (text: string) => stallsSimulatorLaunchRecording(parseXcodeVersion(text));
    expect(check("Xcode 26.4.1 Build version 17E202")).toBe(true);
    expect(check("Xcode 26.4 Build version 17E192")).toBe(true);
    expect(check("Xcode 26.3 Build version 17C52")).toBe(false);
    expect(check("Xcode 26.5 Build version 17F42")).toBe(false);
    expect(check("Xcode 27.0 Build version 18A1")).toBe(false);
    expect(check("unknown-xcode")).toBe(false);
  });
});

describe("simulatorLaunchWindow", () => {
  it("ends at the signpost and estimates from the earliest dyld activity", () => {
    expect(simulatorLaunchWindow(1_396_637_875, 396_637_875)).toEqual({
      endNs: 1_396_637_875,
      simulatorLaunchEstimateMs: 1000,
      signpostMissing: false,
    });
  });

  it("has no estimate without dyld activity or when dyld starts after the signpost", () => {
    expect(simulatorLaunchWindow(400_000_000, null).simulatorLaunchEstimateMs).toBeNull();
    expect(simulatorLaunchWindow(400_000_000, 500_000_000).simulatorLaunchEstimateMs).toBeNull();
  });

  it("leaves the session uncut without the signpost", () => {
    expect(simulatorLaunchWindow(null, 396_637_875)).toEqual({
      endNs: null,
      simulatorLaunchEstimateMs: null,
      signpostMissing: true,
    });
  });
});

describe("simulatorProfileNote", () => {
  it("adds the missing-signpost sentence only when the signpost is missing", () => {
    expect(simulatorProfileNote(false)).toContain("ApplicationFirstFramePresentation");
    expect(simulatorProfileNote(false)).not.toContain("is missing");
    expect(simulatorProfileNote(true)).toContain("The signpost is missing");
  });
});

describe("failedCoreExport", () => {
  const none = { cpu: false, lifecycle: false, simulator: false };

  it("names the TOC first, then the CPU samples", () => {
    expect(failedCoreExport({ toc: "crashed" }, none)).toBe("toc");
    expect(failedCoreExport({ cpu: "Trace TOC has no table for this export." }, none)).toBe("cpu");
    expect(failedCoreExport({}, none)).toBe("cpu");
  });

  it("requires the lifecycle phases on an iPhone", () => {
    const errors = {
      lifecycle: "xcrun was killed by SIGSEGV",
      dyld: "xcrun was killed by SIGSEGV",
    };
    expect(failedCoreExport(errors, { ...none, cpu: true })).toBe("lifecycle");
    expect(failedCoreExport({ dyld: "y" }, { ...none, cpu: true, lifecycle: true })).toBeNull();
  });

  it("does not require lifecycle on a simulator, where Instruments never records it", () => {
    expect(
      failedCoreExport(
        { lifecycle: "x", dyld: "y", signpost: "z" },
        { ...none, cpu: true, simulator: true }
      )
    ).toBeNull();
  });
});

describe("coreExportFailureMessage", () => {
  const failure = {
    table: "toc" as const,
    reason: "Command failed: xcrun xctrace export --toc",
    attempts: 3,
    xcodeVersion: "Xcode 26.4.1 Build version 17E202",
    tracePath: "/w/.argent/traces/x/app-launch.trace",
  };

  it("names the Xcode version, the trace and the fix after repeated crashes", () => {
    const message = coreExportFailureMessage({ ...failure, crashed: true });
    expect(message).toContain("crashed 3 times");
    expect(message).toContain("Xcode 26.4.1");
    expect(message).toContain(failure.tracePath);
    expect(message).toContain("Instruments");
    expect(message).toContain("Seen with Xcode 26.4.1");
    expect(message).toContain("profile with Xcode 27");
    expect(message).not.toContain("26.3");
  });

  it("keeps the underlying error for an ordinary failure", () => {
    const message = coreExportFailureMessage({ ...failure, table: "cpu", crashed: false });
    expect(message).toContain("CPU samples");
    expect(message).toContain(failure.reason);
    expect(message).toContain(failure.tracePath);
    expect(message).not.toContain("crashed");
  });
});

describe("optionalExportCrashNote", () => {
  it("is null when no optional export crashed", () => {
    expect(optionalExportCrashNote([], "Xcode 26.4.1 Build version 17E202")).toBeNull();
  });

  it("names the crashed tables and the active Xcode", () => {
    const note = optionalExportCrashNote(
      ["lifecycle", "dyld"],
      "Xcode 26.4.1 Build version 17E202"
    );
    expect(note).toContain("lifecycle, dyld");
    expect(note).toContain("Xcode 26.4.1 Build version 17E202");
    expect(note).toContain("Run the tool again");
  });
});
