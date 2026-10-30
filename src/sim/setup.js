// Car setup definitions and the mapping from setup + car performance ratings to physics parameters.
import { clamp } from './util.js';

export const SETUP_GROUPS = [
  {
    id: 'aero', name: 'Aerodynamics', params: [
      { id: 'frontWing', name: 'Front Wing Aero', min: 1, max: 50, step: 1, def: 25, hint: 'More front downforce: sharper turn-in, more drag.' },
      { id: 'rearWing', name: 'Rear Wing Aero', min: 1, max: 50, step: 1, def: 25, hint: 'More rear downforce: stability and traction, lower top speed.' },
    ],
  },
  {
    id: 'trans', name: 'Transmission', params: [
      { id: 'diffOn', name: 'Differential On Throttle', min: 10, max: 100, step: 5, def: 60, unit: '%', hint: 'Higher locks the rear for traction, but adds exit understeer.' },
      { id: 'diffOff', name: 'Differential Off Throttle', min: 10, max: 100, step: 5, def: 55, unit: '%', hint: 'Higher gives entry stability, lower helps rotation.' },
    ],
  },
  {
    id: 'geo', name: 'Suspension Geometry', params: [
      { id: 'frontCamber', name: 'Front Camber', min: -3.5, max: -2.5, step: 0.05, def: -3.0, unit: '°', hint: 'More negative: cornering grip, more wear, less braking grip.' },
      { id: 'rearCamber', name: 'Rear Camber', min: -2.0, max: -1.0, step: 0.05, def: -1.5, unit: '°', hint: 'More negative: cornering grip, less traction, more wear.' },
      { id: 'frontToe', name: 'Front Toe-Out', min: 0.0, max: 0.5, step: 0.01, def: 0.08, unit: '°', hint: 'More toe-out: sharper initial turn-in, more wear.' },
      { id: 'rearToe', name: 'Rear Toe-In', min: 0.1, max: 0.5, step: 0.01, def: 0.3, unit: '°', hint: 'More toe-in: stability, more drag and wear.' },
    ],
  },
  {
    id: 'susp', name: 'Suspension', params: [
      { id: 'frontSusp', name: 'Front Suspension', min: 1, max: 41, step: 1, def: 21, hint: 'Stiffer: responsive, worse over kerbs.' },
      { id: 'rearSusp', name: 'Rear Suspension', min: 1, max: 41, step: 1, def: 18, hint: 'Softer: traction and kerb compliance.' },
      { id: 'frontARB', name: 'Front Anti-Roll Bar', min: 1, max: 21, step: 1, def: 11, hint: 'Stiffer front bar shifts balance to understeer.' },
      { id: 'rearARB', name: 'Rear Anti-Roll Bar', min: 1, max: 21, step: 1, def: 9, hint: 'Stiffer rear bar shifts balance to oversteer.' },
      { id: 'frontRide', name: 'Front Ride Height', min: 10, max: 40, step: 1, def: 22, hint: 'Lower: more downforce, risks bottoming on kerbs.' },
      { id: 'rearRide', name: 'Rear Ride Height', min: 30, max: 60, step: 1, def: 44, hint: 'More rake: more front downforce, less stability.' },
    ],
  },
  {
    id: 'brakes', name: 'Brakes', params: [
      { id: 'brakePressure', name: 'Brake Pressure', min: 80, max: 100, step: 1, def: 95, unit: '%', hint: 'Higher: more stopping power, easier lock-ups.' },
      { id: 'brakeBias', name: 'Front Brake Bias', min: 50, max: 70, step: 1, def: 57, unit: '%', hint: 'Higher: front lock-ups, more stable.' },
    ],
  },
  {
    id: 'tyres', name: 'Tyres', params: [
      { id: 'frontPressure', name: 'Front Tyre Pressure', min: 22.5, max: 29.5, step: 0.1, def: 25.0, unit: 'psi', hint: 'Higher: less grip, faster warm-up, lower wear.' },
      { id: 'rearPressure', name: 'Rear Tyre Pressure', min: 20.5, max: 26.5, step: 0.1, def: 22.5, unit: 'psi', hint: 'Higher: less grip, faster warm-up, lower wear.' },
    ],
  },
];

export const SETUP_PARAMS = SETUP_GROUPS.flatMap((g) => g.params);

export function defaultSetup() {
  const s = {};
  for (const p of SETUP_PARAMS) s[p.id] = p.def;
  return s;
}

export const SETUP_PRESETS = {
  balanced: { name: 'Balanced', mod: {} },
  lowDrag: { name: 'Low Downforce', mod: { frontWing: 12, rearWing: 9, rearRide: 40, diffOn: 70 } },
  highDf: { name: 'High Downforce', mod: { frontWing: 40, rearWing: 42, frontARB: 9, rearARB: 8, diffOn: 55 } },
  wet: { name: 'Wet Weather', mod: { frontWing: 38, rearWing: 45, frontSusp: 12, rearSusp: 8, frontARB: 6, rearARB: 4, frontRide: 30, rearRide: 52, diffOn: 50, brakeBias: 55, brakePressure: 88 } },
};

export function applyPreset(name) {
  return { ...defaultSetup(), ...(SETUP_PRESETS[name]?.mod ?? {}) };
}

export function sanitizeSetup(s) {
  const out = defaultSetup();
  for (const p of SETUP_PARAMS) {
    if (typeof s?.[p.id] === 'number' && isFinite(s[p.id])) out[p.id] = clamp(s[p.id], p.min, p.max);
  }
  return out;
}

/**
 * perf: team car ratings 0..1 { aero, power, chassis, reliability, ers }
 * Returns parameters consumed by CarPhysics.
 */
export function computeCarParams(setup, perf = {}) {
  const s = sanitizeSetup(setup);
  const aero = perf.aero ?? 0.8, power = perf.power ?? 0.8, chassis = perf.chassis ?? 0.8;
  const avgRide = (s.frontRide + (s.rearRide - 22)) / 2; // ~22 neutral
  const rake = (s.rearRide - s.frontRide) - 22;
  const aeroEff = 0.9 + 0.12 * aero;
  const ClA = (3.4 + 0.024 * (s.frontWing + s.rearWing) + 0.018 * (24 - avgRide)) * aeroEff;
  const CdA = (0.92 + 0.0095 * s.rearWing + 0.0035 * s.frontWing + 0.0015 * Math.max(0, rake)) * (1.04 - 0.05 * aero) + (s.rearToe - 0.3) * 0.08;
  const aeroBalance = clamp(0.41 + 0.0032 * (s.frontWing - s.rearWing) + 0.0018 * rake, 0.32, 0.52);
  const camberF = -s.frontCamber - 2.5, camberR = -s.rearCamber - 1.0; // 0..1
  const pressF = s.frontPressure - 25, pressR = s.rearPressure - 22.5;
  const mechGrip = 0.985 + 0.03 * chassis;
  const p = {
    mass: 798 - 6 * chassis,
    ClA, CdA, aeroBalance,
    maxPowerICE: 545000 + 50000 * power,
    ersPower: 120000,
    ersEfficiency: 0.92 + 0.08 * (perf.ers ?? power),
    // per-axle grip multipliers (lateral) and longitudinal
    gripLatF: mechGrip * (1 + 0.025 * camberF - 0.006 * pressF + 0.012 * s.frontToe),
    gripLatR: mechGrip * (1 + 0.02 * camberR - 0.006 * pressR),
    gripLonF: mechGrip * (1 - 0.02 * camberF - 0.006 * pressF),
    gripLonR: mechGrip * (1 - 0.025 * camberR - 0.006 * pressR),
    wearF: 1 + 0.18 * camberF + 0.25 * s.frontToe - 0.025 * pressF,
    wearR: 1 + 0.18 * camberR + 0.2 * (s.rearToe - 0.1) - 0.025 * pressR,
    heatF: 1 + 0.06 * pressF,
    heatR: 1 + 0.06 * pressR,
    // roll stiffness share at the front: >0.5 means more understeer
    rollFront: clamp(0.5 + 0.012 * (s.frontARB - s.rearARB) + 0.004 * (s.frontSusp - s.rearSusp), 0.3, 0.7),
    kerbPenalty: 0.03 + 0.0025 * (s.frontSusp + s.rearSusp) / 2 + 0.003 * Math.max(0, 22 - s.frontRide),
    diffOn: s.diffOn / 100,
    diffOff: s.diffOff / 100,
    turnIn: 1 + 0.3 * s.frontToe,
    rearStab: 1 + 0.15 * (s.rearToe - 0.3),
    brakeForce: 30000 * (s.brakePressure / 100) * (1 + 0.04 * chassis),
    brakeBias: s.brakeBias / 100,
    reliability: perf.reliability ?? 0.9,
  };
  return p;
}
