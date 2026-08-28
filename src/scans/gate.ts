// Bounded concurrency, so a spike degrades instead of dying.
//
// The vision service holds a ~350 MB OCR model resident and runs OpenCV plus
// RapidOCR on full-resolution phone photos. pm2 runs ONE copy of it, on
// purpose, because a second copy is another 350 MB. Nothing between the API
// and that process limited how many requests hit it at once, so concurrency
// was simply however many people happened to press the button: every request
// decoded its own 12-megapixel image, the box ran out of memory, and the
// kernel picked a process to kill.
//
// Two limits, doing different jobs:
//
//   MAX_INFLIGHT  how many analyses actually run at once. This is the one
//                 that protects memory and CPU. Extra requests WAIT.
//   MAX_QUEUED    how many may be waiting. Past this we refuse immediately.
//
// The second matters as much as the first. A queue with no bound just moves
// the failure: everyone waits, everyone times out, and the work done for them
// is thrown away at the end. Refusing the 200th person in 2 milliseconds is a
// better outcome for them AND for the 199 already in the queue, who now get
// answers. Shed load at the door, not in the kitchen.

export class Gate {
  private inflight = 0;
  private queued = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxInflight: number,
    private readonly maxQueued: number,
    private readonly label = "gate",
  ) {}

  /** True when there is no room to even wait. */
  get saturated(): boolean {
    return this.queued >= this.maxQueued;
  }

  get depth(): { inflight: number; queued: number } {
    return { inflight: this.inflight, queued: this.queued };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inflight >= this.maxInflight) {
      if (this.saturated) {
        throw new GateSaturated(
          `${this.label}: ${this.inflight} running, ${this.queued} queued — refusing rather than queueing forever`,
        );
      }
      this.queued++;
      try {
        await new Promise<void>((resolve) => this.waiting.push(resolve));
      } finally {
        this.queued--;
      }
    }
    this.inflight++;
    try {
      return await fn();
    } finally {
      this.inflight--;
      // hand the slot to whoever has been waiting longest
      this.waiting.shift()?.();
    }
  }
}

export class GateSaturated extends Error {}

/** One analysis is one full-resolution image through OpenCV and RapidOCR, so
 *  this tracks CPU count rather than request count. Default is deliberately
 *  small: the vision box is the constraint, not the API box. */
export const visionGate = new Gate(
  Number(process.env.VISION_MAX_INFLIGHT ?? 4),
  Number(process.env.VISION_MAX_QUEUED ?? 64),
  "vision",
);
