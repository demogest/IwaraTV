/**
 * Which byte ranges of a download are still missing, and which connection is
 * fetching each one. Connections claim work here; when one runs out, it takes
 * over the back half of the largest range another connection is still on, so
 * a slow connection never holds up the end of a download.
 */

/** A range a connection works through: bytes `start..next-1` are written, `next..end` (inclusive) are missing. */
export interface Segment {
  start: number;
  next: number;
  end: number;
  busy: boolean;
}

export class SegmentPlan {
  private readonly segments: Segment[];

  /**
   * `missing` lists inclusive `[first, last]` byte ranges still to fetch. They
   * are cut into about `connections` even pieces, never smaller than `minPieceBytes`.
   */
  constructor(
    readonly totalBytes: number,
    missing: Array<[number, number]>,
    connections: number,
    private readonly minPieceBytes: number
  ) {
    const ranges = missing.filter(([first, last]) => first <= last).sort((a, b) => a[0] - b[0]);
    const missingBytes = ranges.reduce((sum, [first, last]) => sum + last - first + 1, 0);
    const pieceBytes = Math.max(Math.ceil(missingBytes / Math.max(1, connections)), minPieceBytes, 1);
    this.segments = [];
    for (const [first, last] of ranges) {
      const length = last - first + 1;
      const pieces = Math.max(1, Math.round(length / pieceBytes));
      const size = Math.ceil(length / pieces);
      for (let start = first; start <= last; start += size) {
        this.segments.push({ start, next: start, end: Math.min(start + size - 1, last), busy: false });
      }
    }
  }

  /** Bytes already on disk. */
  get doneBytes(): number {
    return this.totalBytes - this.segments.reduce((sum, segment) => sum + remainingOf(segment), 0);
  }

  get complete(): boolean {
    return this.segments.every((segment) => remainingOf(segment) === 0);
  }

  /** Connections currently fetching. */
  get busyCount(): number {
    return this.segments.filter((segment) => segment.busy).length;
  }

  /**
   * The next range for a free connection: an unclaimed one first, otherwise the
   * back half of the largest range in progress, if it is worth a new request.
   */
  claim(): Segment | undefined {
    const idle = this.segments.find((segment) => !segment.busy && remainingOf(segment) > 0);
    if (idle) {
      idle.busy = true;
      return idle;
    }
    let largest: Segment | undefined;
    for (const segment of this.segments) {
      if (segment.busy && (!largest || remainingOf(segment) > remainingOf(largest))) {
        largest = segment;
      }
    }
    if (!largest || remainingOf(largest) < this.minPieceBytes * 2) {
      return undefined;
    }
    const middle = largest.next + Math.ceil(remainingOf(largest) / 2);
    const stolen: Segment = { start: middle, next: middle, end: largest.end, busy: true };
    largest.end = middle - 1;
    this.segments.splice(this.segments.indexOf(largest) + 1, 0, stolen);
    return stolen;
  }

  release(segment: Segment): void {
    segment.busy = false;
  }

  /**
   * Records `bytes` written at `segment.next`. The range may have shrunk while
   * the write was in flight; only bytes inside it count. Returns the bytes counted.
   */
  advance(segment: Segment, bytes: number): number {
    const counted = Math.max(0, Math.min(bytes, remainingOf(segment)));
    segment.next += counted;
    return counted;
  }

  /** Missing `[first, last]` ranges in file order, merged where they touch. */
  missing(): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (const segment of [...this.segments].sort((a, b) => a.start - b.start)) {
      if (remainingOf(segment) === 0) {
        continue;
      }
      const previous = ranges.at(-1);
      if (previous && previous[1] + 1 === segment.next) {
        previous[1] = segment.end;
      } else {
        ranges.push([segment.next, segment.end]);
      }
    }
    return ranges;
  }
}

function remainingOf(segment: Segment): number {
  return Math.max(0, segment.end - segment.next + 1);
}
