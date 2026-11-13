export interface BenchSpot {
  name: string;
  x: number;
  z: number;
  f: number;
}

export interface BenchWindow {
  name: string;
  look: number;
}

export interface PollRow {
  ers?: number;
  lv?: unknown;
  sh?: unknown;
  post?: unknown;
  programs?: number;
  [key: string]: unknown;
}

export interface PollSummary {
  renderScale: [number, number] | null;
  renderScaleChanges: number;
  budgetLevelSets: number;
  shadowSteps: string[];
  postRungs: string[];
  programs: [number, number] | null;
  programsGrowth: number;
  reasons: Record<string, number>;
}

export interface PaceTrace {
  dt: number[];
  calls: number[];
  ticks?: number[];
}

export interface DrawnFrameStats {
  frames: number;
  drawnPerSec: number | null;
  medianMs: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
  over40: number;
  over50: number;
}

export interface BenchReport {
  mainSimMs?: number;
  mainRendererMs?: number;
  mainHudMs?: number;
  phaseSubmitMs?: number;
  phaseWorldMs?: number;
  phaseEntitiesMs?: number;
  [key: string]: unknown;
}

export interface BenchWindowResult {
  window: string;
  look?: number;
  report?: BenchReport;
  pace?: PaceTrace;
  newPrograms?: number;
  freezes?: { byCause?: Record<string, number> };
  [key: string]: unknown;
}

export interface BenchRun {
  label?: string;
  cpuThrottle?: number;
  env?: Record<string, unknown> & {
    tier?: string;
    glRenderer?: string;
    drawingBuffer?: { width?: number; height?: number; cssWidth?: number; cssHeight?: number };
  };
  spots?: Array<{ spot: string; windows: BenchWindowResult[] }>;
}

export interface CalibrationRatios {
  windows: number;
  sim: number;
  renderer: number;
  submit: number;
  world: number;
  entities: number;
  hud: number;
  total: number;
}

export declare const DEFAULT_SPOTS: ReadonlyArray<Readonly<BenchSpot>>;
export declare const DEFAULT_WINDOWS_SPEC: string;
export declare const WARM_WINDOWS: ReadonlyArray<string>;
export declare const PHASES: ReadonlyArray<readonly [string, string]>;

export declare function parseWindows(spec: string): BenchWindow[];
export declare function percentile(values: number[], q: number): number;
export declare function median(values: number[]): number;
export declare function summarizePoll(rows: PollRow[]): PollSummary;
export declare function shareOf(rows: PollRow[], key: string): Record<string, number>;
export declare function drawnIntervals(pace: PaceTrace): number[];
export declare function drawnFrameStats(pace: PaceTrace): DrawnFrameStats;
export declare function drawnShare(pace: PaceTrace): number | null;
export declare function mainThreadMs(report: BenchReport): number;
export declare function calibrationRatios(
  reference: BenchRun,
  emulation: BenchRun,
  warm?: ReadonlyArray<string>,
): CalibrationRatios;
export declare function formatRunTable(run: BenchRun): string;
export declare function formatCalibration(
  referenceLabel: string,
  rows: Array<{ label: string; ratios: CalibrationRatios }>,
): string;
export declare function pollUntil(
  check: () => unknown,
  opts?: {
    timeoutMs?: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<true>;
