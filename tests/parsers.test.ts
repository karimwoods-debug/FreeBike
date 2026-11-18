import { describe, expect, it } from 'vitest';
import {
  FtmsCommand,
  RevolutionRate,
  parseCsc,
  parseCyclingPower,
  parseHeartRate,
  parseIndoorBikeData,
} from '../src/ble/parsers';

const dv = (bytes: number[]) => new DataView(new Uint8Array(bytes).buffer);

describe('FTMS indoor bike data', () => {
  it('parses speed, cadence and power', () => {
    // flags: speed present (bit0=0), cadence (bit2), power (bit6) => 0x0044
    const d = parseIndoorBikeData(dv([0x44, 0x00, 0xc4, 0x09, 0xb4, 0x00, 0xfa, 0x00]));
    expect(d.speedKmh).toBeCloseTo(25.0);
    expect(d.cadence).toBe(90);
    expect(d.power).toBe(250);
  });

  it('skips optional fields before power and reads heart rate', () => {
    // flags: avg speed (bit1), cadence (bit2), distance (bit4), resistance (bit5), power (bit6), energy (bit8), HR (bit9)
    const flags = 0x0002 | 0x0004 | 0x0010 | 0x0020 | 0x0040 | 0x0100 | 0x0200;
    const bytes = [
      flags & 0xff, flags >> 8,
      0x10, 0x27, // speed 100.00 km/h
      0x00, 0x00, // avg speed
      0x50, 0x00, // cadence 40
      0x01, 0x02, 0x03, // distance
      0x05, 0x00, // resistance
      0x2c, 0x01, // power 300
      0, 0, 0, 0, 0, // energy
      150, // hr
    ];
    const d = parseIndoorBikeData(dv(bytes));
    expect(d.speedKmh).toBeCloseTo(100);
    expect(d.cadence).toBe(40);
    expect(d.distanceM).toBe(0x030201);
    expect(d.power).toBe(300);
    expect(d.heartRate).toBe(150);
  });

  it('has no speed when More Data bit is set', () => {
    const d = parseIndoorBikeData(dv([0x41, 0x00, 0x64, 0x00]));
    expect(d.speedKmh).toBeUndefined();
    expect(d.power).toBe(100);
  });
});

describe('Cycling power', () => {
  it('parses power and crank data after balance + torque', () => {
    const flags = 0x0001 | 0x0004 | 0x0020;
    const d = parseCyclingPower(dv([flags, 0x00, 0xc8, 0x00, 50, 0x10, 0x00, 0x0a, 0x00, 0x00, 0x04]));
    expect(d.power).toBe(200);
    expect(d.crank).toEqual({ revs: 10, time: 1024 });
  });
});

describe('CSC', () => {
  it('parses wheel and crank', () => {
    const d = parseCsc(dv([0x03, 0x64, 0, 0, 0, 0x00, 0x08, 0x05, 0x00, 0x00, 0x02]));
    expect(d.wheel).toEqual({ revs: 100, time: 2048 });
    expect(d.crank).toEqual({ revs: 5, time: 512 });
  });
});

describe('Heart rate', () => {
  it('reads uint8 and uint16 formats', () => {
    expect(parseHeartRate(dv([0x00, 72]))).toBe(72);
    expect(parseHeartRate(dv([0x01, 0x2c, 0x01]))).toBe(300);
  });
});

describe('RevolutionRate', () => {
  it('computes cadence and handles rollover', () => {
    const r = new RevolutionRate(1024);
    r.update(65534, 64000, 0);
    // 2 revs in 1.5s across both counter rollovers => 80 rpm
    const rpm = r.update(0, (64000 + 1536) & 0xffff, 1500);
    expect(rpm).toBeCloseTo(80);
  });

  it('drops to zero when stale', () => {
    const r = new RevolutionRate(1024);
    r.update(1, 1024, 0);
    r.update(2, 2048, 1000);
    expect(r.current(1500)).toBeGreaterThan(0);
    expect(r.current(5000)).toBe(0);
  });
});

describe('FTMS commands', () => {
  it('encodes target power', () => {
    expect([...FtmsCommand.setTargetPower(250)]).toEqual([0x05, 0xfa, 0x00]);
  });
  it('encodes simulation params with negative grade', () => {
    const b = FtmsCommand.setSimulation(-2.5);
    const v = new DataView(b.buffer);
    expect(v.getUint8(0)).toBe(0x11);
    expect(v.getInt16(3, true)).toBe(-250);
    expect(v.getUint8(5)).toBe(40);
    expect(v.getUint8(6)).toBe(51);
  });
});
