/**
 * Simple longitudinal cycling model: converts rider power into virtual
 * speed on a road with the given grade.
 *
 *   m * dv/dt = P / v - (F_gravity + F_rolling + F_aero)
 */
export interface RiderParams {
  riderKg: number;
  bikeKg: number;
  cda: number; // m^2
  crr: number;
}

export const DEFAULT_PARAMS: RiderParams = { riderKg: 75, bikeKg: 9, cda: 0.32, crr: 0.004 };

const G = 9.81;
const RHO = 1.225;
const DRIVETRAIN_EFF = 0.976;

export function resistiveForce(v: number, gradePct: number, p: RiderParams, draftFactor = 1): number {
  const m = p.riderKg + p.bikeKg;
  const theta = Math.atan(gradePct / 100);
  const gravity = m * G * Math.sin(theta);
  const rolling = m * G * Math.cos(theta) * p.crr;
  const aero = 0.5 * RHO * p.cda * draftFactor * v * Math.abs(v);
  return gravity + rolling + aero;
}

/** Advances velocity (m/s) by dt seconds. */
export function stepSpeed(
  v: number,
  powerW: number,
  gradePct: number,
  dt: number,
  p: RiderParams,
  draftFactor = 1,
): number {
  const m = p.riderKg + p.bikeKg + 1.5; // + rotating-mass equivalent
  // Propulsive force, capped at low speed so starting from 0 is not infinite.
  const propulsive = (powerW * DRIVETRAIN_EFF) / Math.max(v, 1.0);
  const a = (propulsive - resistiveForce(v, gradePct, p, draftFactor)) / m;
  let nv = v + a * dt;
  if (nv < 0) nv = 0; // no rolling backwards
  return nv;
}

/** Steady-state speed for a power on a grade (used for tests / bots). */
export function steadySpeed(powerW: number, gradePct: number, p: RiderParams): number {
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (powerW * DRIVETRAIN_EFF - resistiveForce(mid, gradePct, p) * mid > 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}
