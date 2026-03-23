/**
 * Simple stopwatch utility for measuring elapsed time of sync operations.
 * Collects timing data for individual steps and produces a summary report.
 */

export interface TimingEntry {
  label: string;
  durationMs: number;
  detail?: string;
}

export class Stopwatch {
  private entries: TimingEntry[] = [];
  private active: Map<string, number> = new Map();
  private globalStart: number;

  constructor() {
    this.globalStart = performance.now();
  }

  /** Start timing a labeled operation. */
  start(label: string): void {
    this.active.set(label, performance.now());
  }

  /** Stop timing a labeled operation and record the duration. */
  stop(label: string, detail?: string): number {
    const startTime = this.active.get(label);
    if (startTime === undefined) {
      return 0;
    }
    const durationMs = performance.now() - startTime;
    this.active.delete(label);
    this.entries.push({ label, durationMs, ...(detail !== undefined && { detail }) });
    return durationMs;
  }

  /** Measure an async operation and record the duration. */
  async measure<T>(label: string, fn: () => Promise<T>, detail?: string): Promise<T> {
    this.start(label);
    try {
      const result = await fn();
      this.stop(label, detail);
      return result;
    } catch (error) {
      this.stop(label, detail ? `${detail} (failed)` : '(failed)');
      throw error;
    }
  }

  /** Get all recorded timing entries. */
  getEntries(): TimingEntry[] {
    return [...this.entries];
  }

  /** Get total elapsed time since stopwatch creation. */
  getTotalMs(): number {
    return performance.now() - this.globalStart;
  }

  /** Format entries as a human-readable report. */
  formatReport(): string[] {
    const lines: string[] = [];
    const totalMs = this.getTotalMs();

    lines.push(`Sync timing report (total: ${formatMs(totalMs)})`);
    lines.push('─'.repeat(60));

    for (const entry of this.entries) {
      const pct = totalMs > 0 ? ((entry.durationMs / totalMs) * 100).toFixed(1) : '0.0';
      const detail = entry.detail ? ` [${entry.detail}]` : '';
      lines.push(
        `  ${padEnd(entry.label, 40)} ${padStart(formatMs(entry.durationMs), 8)}  ${padStart(pct, 5)}%${detail}`,
      );
    }

    lines.push('─'.repeat(60));
    return lines;
  }

  /** Format entries as structured data (for JSON output). */
  toJSON(): { totalMs: number; steps: Array<{ label: string; durationMs: number; detail?: string }> } {
    return {
      totalMs: Math.round(this.getTotalMs()),
      steps: this.entries.map((e) => ({
        label: e.label,
        durationMs: Math.round(e.durationMs),
        ...(e.detail && { detail: e.detail }),
      })),
    };
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function padEnd(str: string, len: number): string {
  return str.length >= len ? str : str + ' '.repeat(len - str.length);
}

function padStart(str: string, len: number): string {
  return str.length >= len ? str : ' '.repeat(len - str.length) + str;
}
