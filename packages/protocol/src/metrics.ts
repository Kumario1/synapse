/**
 * Tiny in-process metrics registry shared by the server and the daemon — no
 * heavy client dependency, just counters + fixed-bucket histograms rendered in
 * the Prometheus text exposition format for a `GET /metrics` endpoint.
 *
 * Holds only aggregate numbers (counts, latency buckets) keyed by low-
 * cardinality labels like message type or conflict rule — never repo content,
 * symbol names, or member identity — so exposing it carries no team data.
 */

/** Histogram buckets tuned to the hot-path budget (p95 ≤ 50ms warm). */
export const LATENCY_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500];

type Labels = Record<string, string>;

interface HistogramSeries {
  bucketCounts: number[];
  sum: number;
  count: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<
    string,
    { buckets: number[]; series: Map<string, HistogramSeries> }
  >();

  /** Increment a counter series by `delta` (default 1). */
  count(name: string, labels: Labels = {}, delta = 1): void {
    let series = this.counters.get(name);
    if (!series) {
      series = new Map();
      this.counters.set(name, series);
    }
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + delta);
  }

  /** Record one observation into a fixed-bucket histogram. */
  observe(name: string, value: number, labels: Labels = {}, buckets = LATENCY_BUCKETS_MS): void {
    let histogram = this.histograms.get(name);
    if (!histogram) {
      histogram = { buckets, series: new Map() };
      this.histograms.set(name, histogram);
    }
    const key = labelKey(labels);
    let entry = histogram.series.get(key);
    if (!entry) {
      entry = { bucketCounts: histogram.buckets.map(() => 0), sum: 0, count: 0 };
      histogram.series.set(key, entry);
    }
    for (let i = 0; i < histogram.buckets.length; i += 1) {
      if (value <= histogram.buckets[i]) {
        entry.bucketCounts[i] += 1;
      }
    }
    entry.sum += value;
    entry.count += 1;
  }

  /** Prometheus text exposition (counters as `counter`, histograms as `histogram`). */
  renderPrometheus(): string {
    const lines: string[] = [];

    for (const [name, series] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [key, value] of series) {
        lines.push(`${name}${key ? `{${key}}` : ""} ${value}`);
      }
    }

    for (const [name, { buckets, series }] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      for (const [key, entry] of series) {
        for (let i = 0; i < buckets.length; i += 1) {
          lines.push(`${name}_bucket{${withLabel(key, "le", String(buckets[i]))}} ${entry.bucketCounts[i]}`);
        }
        lines.push(`${name}_bucket{${withLabel(key, "le", "+Inf")}} ${entry.count}`);
        lines.push(`${name}_sum${key ? `{${key}}` : ""} ${round(entry.sum)}`);
        lines.push(`${name}_count${key ? `{${key}}` : ""} ${entry.count}`);
      }
    }

    return `${lines.join("\n")}\n`;
  }
}

function labelKey(labels: Labels): string {
  const names = Object.keys(labels).sort();
  return names.map((name) => `${name}="${escapeLabel(labels[name])}"`).join(",");
}

function withLabel(key: string, name: string, value: string): string {
  const pair = `${name}="${escapeLabel(value)}"`;
  return key ? `${key},${pair}` : pair;
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
