import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, steadySpeed, stepSpeed } from '../src/sim/physics';
import { Route, ROUTES } from '../src/world/route';
import { WORKOUTS, workoutStateAt } from '../src/workouts';
import { Recorder, normalizedPower } from '../src/recorder';

describe('physics', () => {
  it('gives realistic flat speed for 200 W', () => {
    const kmh = steadySpeed(200, 0, DEFAULT_PARAMS) * 3.6;
    expect(kmh).toBeGreaterThan(30);
    expect(kmh).toBeLessThan(37);
  });
  it('is slow up an 8% climb', () => {
    const kmh = steadySpeed(250, 8, DEFAULT_PARAMS) * 3.6;
    expect(kmh).toBeGreaterThan(9);
    expect(kmh).toBeLessThan(14);
  });
  it('integrates toward steady state', () => {
    let v = 0;
    for (let i = 0; i < 2000; i++) v = stepSpeed(v, 200, 0, 0.05, DEFAULT_PARAMS);
    expect(v).toBeCloseTo(steadySpeed(200, 0, DEFAULT_PARAMS), 1);
  });
  it('coasts downhill without power', () => {
    let v = 5;
    for (let i = 0; i < 2000; i++) v = stepSpeed(v, 0, -6, 0.05, DEFAULT_PARAMS);
    expect(v * 3.6).toBeGreaterThan(40);
  });
});

describe('route', () => {
  for (const def of ROUTES) {
    it(`${def.name} is a closed loop with sane grades`, () => {
      const r = new Route(def);
      expect(r.length).toBeGreaterThan(4000);
      const a = r.pointAt(0);
      const b = r.pointAt(r.length);
      expect(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)).toBeLessThan(0.01);
      // Joining segment is continuous.
      const e = r.pointAt(r.length - r.step);
      expect(Math.hypot(a.x - e.x, a.z - e.z)).toBeLessThan(r.step * 1.5);
      let maxG = 0;
      for (let d = 0; d < r.length; d += 25) maxG = Math.max(maxG, Math.abs(r.gradeAt(d)));
      expect(maxG).toBeLessThan(16);
      expect(maxG).toBeGreaterThan(1);
    });
  }
});

describe('workouts', () => {
  it('ramps targets and finishes', () => {
    const w = WORKOUTS.find((x) => x.id === 'sweetspot3x10')!;
    expect(workoutStateAt(w, 0, 200).target).toBe(90);
    expect(workoutStateAt(w, 600, 200).target).toBe(180);
    expect(workoutStateAt(w, 99999, 200).done).toBe(true);
  });
  it('supports absolute ramp steps', () => {
    const w = WORKOUTS.find((x) => x.id === 'ramp')!;
    expect(workoutStateAt(w, 300, 250).target).toBe(100);
    expect(workoutStateAt(w, 361, 250).target).toBe(120);
  });
});

describe('recorder', () => {
  it('computes summary and TCX', () => {
    const r = new Recorder();
    for (let t = 0; t < 120; t++) r.add({ t, power: 200, cadence: 90, hr: 140, speed: 9, distance: t * 9, altitude: 20 + t * 0.1 });
    const s = r.summary();
    expect(s.avgPower).toBe(200);
    expect(s.normalizedPower).toBe(200);
    expect(s.elevationGainM).toBe(12);
    const tcx = r.toTcx();
    expect(tcx).toContain('<ns3:Watts>200</ns3:Watts>');
    expect(tcx.match(/<Trackpoint>/g)!.length).toBe(120);
  });
  it('NP exceeds avg for variable power', () => {
    const p = Array.from({ length: 600 }, (_, i) => (Math.floor(i / 60) % 2 ? 350 : 100));
    expect(normalizedPower(p)).toBeGreaterThan(225);
  });
});
