/**
 * Pure parsers for the standard Bluetooth SIG fitness profiles.
 * Kept free of any Web Bluetooth types so they can be unit tested.
 *
 *  - FTMS  Indoor Bike Data          (0x2AD2)
 *  - CPS   Cycling Power Measurement (0x2A63)
 *  - CSC   CSC Measurement           (0x2A5B)
 *  - HRS   Heart Rate Measurement    (0x2A37)
 */

export interface IndoorBikeData {
  speedKmh?: number;
  cadence?: number;
  distanceM?: number;
  resistance?: number;
  power?: number;
  heartRate?: number;
}

export function parseIndoorBikeData(dv: DataView): IndoorBikeData {
  const flags = dv.getUint16(0, true);
  let o = 2;
  const out: IndoorBikeData = {};
  // Bit 0 is "More Data": when it is 0 the instantaneous speed IS present.
  if ((flags & 0x0001) === 0) {
    out.speedKmh = dv.getUint16(o, true) / 100;
    o += 2;
  }
  if (flags & 0x0002) o += 2; // average speed
  if (flags & 0x0004) {
    out.cadence = dv.getUint16(o, true) / 2;
    o += 2;
  }
  if (flags & 0x0008) o += 2; // average cadence
  if (flags & 0x0010) {
    out.distanceM = dv.getUint16(o, true) | (dv.getUint8(o + 2) << 16);
    o += 3;
  }
  if (flags & 0x0020) {
    out.resistance = dv.getInt16(o, true);
    o += 2;
  }
  if (flags & 0x0040) {
    out.power = dv.getInt16(o, true);
    o += 2;
  }
  if (flags & 0x0080) o += 2; // average power
  if (flags & 0x0100) o += 5; // expended energy (total, per hour, per minute)
  if (flags & 0x0200) {
    out.heartRate = dv.getUint8(o);
    o += 1;
  }
  return out;
}

export interface CyclingPowerData {
  power: number;
  /** Cumulative crank revolutions + last event time (1/1024 s) if present. */
  crank?: { revs: number; time: number };
  /** Cumulative wheel revolutions + last event time (1/2048 s) if present. */
  wheel?: { revs: number; time: number };
}

export function parseCyclingPower(dv: DataView): CyclingPowerData {
  const flags = dv.getUint16(0, true);
  const power = dv.getInt16(2, true);
  let o = 4;
  const out: CyclingPowerData = { power };
  if (flags & 0x0001) o += 1; // pedal power balance
  if (flags & 0x0004) o += 2; // accumulated torque
  if (flags & 0x0010) {
    out.wheel = { revs: dv.getUint32(o, true), time: dv.getUint16(o + 4, true) };
    o += 6;
  }
  if (flags & 0x0020) {
    out.crank = { revs: dv.getUint16(o, true), time: dv.getUint16(o + 2, true) };
    o += 4;
  }
  return out;
}

export interface CscData {
  wheel?: { revs: number; time: number };
  crank?: { revs: number; time: number };
}

export function parseCsc(dv: DataView): CscData {
  const flags = dv.getUint8(0);
  let o = 1;
  const out: CscData = {};
  if (flags & 0x01) {
    out.wheel = { revs: dv.getUint32(o, true), time: dv.getUint16(o + 4, true) };
    o += 6;
  }
  if (flags & 0x02) {
    out.crank = { revs: dv.getUint16(o, true), time: dv.getUint16(o + 2, true) };
    o += 4;
  }
  return out;
}

export function parseHeartRate(dv: DataView): number {
  const flags = dv.getUint8(0);
  return flags & 0x01 ? dv.getUint16(1, true) : dv.getUint8(1);
}

/**
 * Turns cumulative revolution counters (crank or wheel) into a rate.
 * Handles 16-bit counter / event-time rollover and sensors that repeat the
 * same event while coasting.
 */
export class RevolutionRate {
  private lastRevs = -1;
  private lastTime = -1;
  private lastChangeMs = 0;
  private rpm = 0;

  constructor(
    private readonly timeUnit: number, // ticks per second (1024 or 2048)
    private readonly revMask: number = 0xffff,
    private readonly staleMs = 3000,
  ) {}

  /** Feed a sample, returns revolutions per minute. */
  update(revs: number, time: number, nowMs: number): number {
    if (this.lastRevs >= 0) {
      const dRevs = (revs - this.lastRevs + this.revMask + 1) & this.revMask;
      const dTicks = (time - this.lastTime + 0x10000) & 0xffff;
      if (dRevs > 0 && dTicks > 0) {
        const r = (dRevs * 60 * this.timeUnit) / dTicks;
        // Reject absurd spikes (e.g. after a long reconnect gap).
        if (r < 250) this.rpm = r;
        this.lastChangeMs = nowMs;
      } else if (nowMs - this.lastChangeMs > this.staleMs) {
        this.rpm = 0;
      }
    } else {
      this.lastChangeMs = nowMs;
    }
    this.lastRevs = revs;
    this.lastTime = time;
    return this.rpm;
  }

  /** Call periodically so the rate drops to 0 when the sensor stops sending. */
  current(nowMs: number): number {
    if (nowMs - this.lastChangeMs > this.staleMs) this.rpm = 0;
    return this.rpm;
  }
}

/** Builds FTMS control point commands. */
export const FtmsCommand = {
  requestControl: () => new Uint8Array([0x00]),
  reset: () => new Uint8Array([0x01]),
  start: () => new Uint8Array([0x07]),
  setTargetPower(watts: number): Uint8Array {
    const w = Math.max(0, Math.min(2000, Math.round(watts)));
    return new Uint8Array([0x05, w & 0xff, (w >> 8) & 0xff]);
  },
  /** Resistance level in percent (0..100), FTMS unit is 0.1. */
  setTargetResistance(pct: number): Uint8Array {
    const r = Math.max(0, Math.min(255, Math.round(pct * 2.54)));
    return new Uint8Array([0x04, r]);
  },
  setSimulation(gradePct: number, crr = 0.004, cw = 0.51, windMs = 0): Uint8Array {
    const buf = new DataView(new ArrayBuffer(7));
    buf.setUint8(0, 0x11);
    buf.setInt16(1, Math.round(windMs * 1000), true);
    buf.setInt16(3, Math.round(Math.max(-40, Math.min(40, gradePct)) * 100), true);
    buf.setUint8(5, Math.max(0, Math.min(255, Math.round(crr * 10000))));
    buf.setUint8(6, Math.max(0, Math.min(255, Math.round(cw * 100))));
    return new Uint8Array(buf.buffer);
  },
};
