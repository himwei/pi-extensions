export type LineRange = readonly [start: number, end: number];

export interface Observation {
  hash: string;
  full: boolean;
  ranges: LineRange[];
}

export interface ObservationToken {
  epoch: number;
  key: string;
  revision: number;
}

/** Metadata only: no source text or credentials are retained here. */
export class ObservationStore {
  private generation = 0;
  private readonly records = new Map<string, Observation>();
  private readonly revisions = new Map<string, number>();

  get epoch(): number { return this.generation; }

  clear(): void {
    this.generation++;
    this.records.clear();
    this.revisions.clear();
  }

  assertEpoch(epoch: number): void {
    if (epoch !== this.generation) throw new Error("Session reading state changed. Read the file again before editing.");
  }

  token(key: string): ObservationToken {
    return { epoch: this.generation, key, revision: this.revisions.get(key) ?? 0 };
  }

  invalidate(key: string, epoch = this.generation): void {
    if (epoch !== this.generation) return;
    this.records.delete(key);
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }

  recordRead(token: ObservationToken, hash: string, totalLines: number, range: LineRange): void {
    if (token.epoch !== this.generation || token.revision !== (this.revisions.get(token.key) ?? 0)) return;
    const previous = this.records.get(token.key);
    const record: Observation = previous?.hash === hash
      ? previous
      : { hash, full: false, ranges: [] };
    const ranges = [...record.ranges, range].sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [start, end] of ranges) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    record.ranges = merged;
    record.full ||= totalLines === 0 || (merged[0]?.[0] === 1 && merged[0][1] >= totalLines);
    this.records.set(token.key, record);
  }

  require(key: string, hash: string, displayPath: string, full: boolean): Observation {
    const record = this.records.get(key);
    if (!record) {
      throw new Error("Read required: use read on " + displayPath + " before editing or overwriting it.");
    }
    if (record.hash !== hash) {
      this.invalidate(key);
      throw new Error("File changed since it was read: " + displayPath + ". Read its current version and retry.");
    }
    if (full && !record.full) {
      throw new Error("Full read required before overwriting " + displayPath +
        ". Use read with offset/limit to read all remaining ranges, or use edit for a targeted change.");
    }
    return record;
  }

  recordMutation(epoch: number, key: string, hash: string, full: boolean): void {
    this.assertEpoch(epoch);
    this.invalidate(key);
    this.records.set(key, { hash, full, ranges: [] });
  }
}
