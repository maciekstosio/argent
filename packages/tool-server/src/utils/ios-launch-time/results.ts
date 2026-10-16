/**
 * Pure helpers that turn launch measurements and trace values into the tool
 * results, kept apart from the tools so they test without a device.
 */
import type { XcodeVersion } from "../ios-profiler/capture-strategy/select";

const ms = (ns: number) => Math.round(ns / 100_000) / 10;

interface LaunchSampleStats {
  averageMs: number;
  medianMs: number;
  samplesMs: number[];
  samplesCollected: number;
  dropped: number;
  warning: string | null;
}

/**
 * Average, median and drop count of XCTApplicationLaunchMetric samples, which
 * XCTest reports in seconds. Null without samples.
 */
export function launchSampleStats(
  measurements: number[],
  options: { expected: number; simulator: boolean }
): LaunchSampleStats | null {
  if (measurements.length === 0) return null;
  const samplesCollected = measurements.length;
  const dropped = Math.max(0, options.expected - samplesCollected);
  const sorted = [...measurements].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
  return {
    averageMs: Math.round(
      (measurements.reduce((sum, value) => sum + value, 0) / samplesCollected) * 1000
    ),
    medianMs: Math.round(median * 1000),
    samplesMs: measurements.map((value) => Math.round(value * 1000)),
    samplesCollected,
    dropped,
    warning:
      dropped > 0
        ? `XCTest dropped ${dropped} of ${options.expected} launch measurements (XCTApplicationLaunchMetric returned no value for some iterations${options.simulator ? "" : "; seen on iOS 18 devices"}). The average uses the remaining samples; rerun for a full set.`
        : null,
  };
}

/**
 * True when an xctrace record log shows the recording started but never
 * finished: "Starting recording" is present and no completion marker follows.
 */
export function stalledAtRecordingStart(log: string): boolean {
  return (
    /starting recording/i.test(log) &&
    !/reached specified time limit|recording completed/i.test(log)
  );
}

/**
 * True for the Xcode versions where `xctrace record --launch` on a simulator
 * stalls after "Starting recording". Verified on 26.4.x only; Xcode 27.0
 * records normally. This is not the `--device` attach deadlock that
 * `isDegraded` in capture-strategy/select.ts assumes for every version from
 * 26.4 up: that is a different capture mode, so the two bounds differ.
 */
export function stallsSimulatorLaunchRecording(version: XcodeVersion | null): boolean {
  return version?.major === 26 && version.minor === 4;
}

/**
 * Launch end and estimate on a simulator: the first-frame signpost ends the
 * launch, and the estimate runs from the earliest dyld activity to it.
 */
export function simulatorLaunchWindow(
  signpostNs: number | null,
  dyldStartNs: number | null
): { endNs: number | null; simulatorLaunchEstimateMs: number | null; signpostMissing: boolean } {
  return {
    endNs: signpostNs,
    simulatorLaunchEstimateMs:
      signpostNs !== null && dyldStartNs !== null && signpostNs >= dyldStartNs
        ? ms(signpostNs - dyldStartNs)
        : null,
    signpostMissing: signpostNs === null,
  };
}

/** The note a simulator profile adds to its warning. */
export function simulatorProfileNote(signpostMissing: boolean): string {
  return (
    "Lifecycle phases exist only on a physical iPhone; Instruments does not record them on simulators. " +
    "The first frame comes from the system ApplicationFirstFramePresentation signpost. " +
    "Timings under xctrace on a simulator run roughly 2x slower than an uninstrumented launch and reflect Mac hardware, " +
    "so use them for relative CPU analysis only." +
    (signpostMissing
      ? " The signpost is missing, so the CPU session covers the whole recording and is not cut."
      : "")
  );
}
