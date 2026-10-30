// Fictional teams and drivers. Car ratings are 0..1; driver ratings 0..1.

export const TEAMS = [
  { id: 'valkyr', name: 'Valkyr Racing', short: 'VAL', colors: ['#121212', '#d4a531', '#f2f2f2'], perf: { aero: 0.95, power: 0.93, chassis: 0.94, reliability: 0.95, ers: 0.94 }, pitCrew: 0.95 },
  { id: 'meridian', name: 'Meridian Grand Prix', short: 'MER', colors: ['#b9c3c9', '#14b3a5', '#101820'], perf: { aero: 0.93, power: 0.96, chassis: 0.92, reliability: 0.96, ers: 0.95 }, pitCrew: 0.93 },
  { id: 'aurelia', name: 'Aurelia Corse', short: 'AUR', colors: ['#c3121e', '#f6e7c1', '#1b1b1b'], perf: { aero: 0.92, power: 0.94, chassis: 0.91, reliability: 0.9, ers: 0.92 }, pitCrew: 0.9 },
  { id: 'solaris', name: 'Solaris Motorsport', short: 'SOL', colors: ['#ff7a00', '#1d3c8f', '#ffffff'], perf: { aero: 0.91, power: 0.9, chassis: 0.92, reliability: 0.93, ers: 0.9 }, pitCrew: 0.96 },
  { id: 'northwind', name: 'Northwind Racing', short: 'NWR', colors: ['#0d4d3a', '#c9f227', '#e8e8e8'], perf: { aero: 0.87, power: 0.89, chassis: 0.86, reliability: 0.92, ers: 0.88 }, pitCrew: 0.88 },
  { id: 'kestrel', name: 'Kestrel Racing', short: 'KES', colors: ['#56b4f0', '#ffffff', '#0b2545'], perf: { aero: 0.85, power: 0.87, chassis: 0.86, reliability: 0.9, ers: 0.86 }, pitCrew: 0.89 },
  { id: 'halcyon', name: 'Halcyon GP', short: 'HAL', colors: ['#f25fa5', '#ffffff', '#2b2d42'], perf: { aero: 0.83, power: 0.88, chassis: 0.84, reliability: 0.88, ers: 0.85 }, pitCrew: 0.86 },
  { id: 'ironclad', name: 'Ironclad Engineering', short: 'IRN', colors: ['#5d6268', '#e03c31', '#f0f0f0'], perf: { aero: 0.82, power: 0.85, chassis: 0.83, reliability: 0.87, ers: 0.83 }, pitCrew: 0.85 },
  { id: 'vortex', name: 'Vortex Racing', short: 'VTX', colors: ['#5b2a86', '#ffd400', '#ffffff'], perf: { aero: 0.8, power: 0.84, chassis: 0.81, reliability: 0.86, ers: 0.82 }, pitCrew: 0.84 },
  { id: 'tempest', name: 'Tempest F1 Team', short: 'TMP', colors: ['#132a5e', '#ffffff', '#e63946'], perf: { aero: 0.78, power: 0.83, chassis: 0.8, reliability: 0.85, ers: 0.8 }, pitCrew: 0.83 },
];

export const DRIVERS = [
  { id: 'dvoss', name: 'Dante Voss', short: 'VOS', number: 1, team: 'valkyr', nat: 'DE', skill: 0.98, aggression: 0.75, consistency: 0.93, wetSkill: 0.95 },
  { id: 'ksato', name: 'Kenji Sato', short: 'SAT', number: 22, team: 'valkyr', nat: 'JP', skill: 0.9, aggression: 0.55, consistency: 0.9, wetSkill: 0.85 },
  { id: 'lmoreau', name: 'Luc Moreau', short: 'MOR', number: 16, team: 'meridian', nat: 'FR', skill: 0.95, aggression: 0.65, consistency: 0.92, wetSkill: 0.9 },
  { id: 'aokafor', name: 'Ada Okafor', short: 'OKA', number: 44, team: 'meridian', nat: 'NG', skill: 0.94, aggression: 0.6, consistency: 0.94, wetSkill: 0.93 },
  { id: 'mrossi', name: 'Matteo Ricci', short: 'RIC', number: 7, team: 'aurelia', nat: 'IT', skill: 0.93, aggression: 0.8, consistency: 0.86, wetSkill: 0.88 },
  { id: 'scastro', name: 'Sofia Castro', short: 'CAS', number: 55, team: 'aurelia', nat: 'ES', skill: 0.92, aggression: 0.6, consistency: 0.91, wetSkill: 0.86 },
  { id: 'jharlow', name: 'James Harlow', short: 'HAR', number: 4, team: 'solaris', nat: 'GB', skill: 0.94, aggression: 0.7, consistency: 0.9, wetSkill: 0.92 },
  { id: 'nlindqvist', name: 'Nils Lindqvist', short: 'LIN', number: 81, team: 'solaris', nat: 'SE', skill: 0.9, aggression: 0.5, consistency: 0.9, wetSkill: 0.84 },
  { id: 'rmehta', name: 'Rohan Mehta', short: 'MEH', number: 14, team: 'northwind', nat: 'IN', skill: 0.88, aggression: 0.65, consistency: 0.88, wetSkill: 0.83 },
  { id: 'cbaptiste', name: 'Claire Baptiste', short: 'BAP', number: 18, team: 'northwind', nat: 'CA', skill: 0.86, aggression: 0.5, consistency: 0.89, wetSkill: 0.85 },
  { id: 'tkowalski', name: 'Tomasz Kowalski', short: 'KOW', number: 10, team: 'kestrel', nat: 'PL', skill: 0.87, aggression: 0.7, consistency: 0.85, wetSkill: 0.88 },
  { id: 'esilva', name: 'Eduardo Silva', short: 'SIL', number: 31, team: 'kestrel', nat: 'BR', skill: 0.86, aggression: 0.75, consistency: 0.84, wetSkill: 0.9 },
  { id: 'mvanderberg', name: 'Milan van der Berg', short: 'VDB', number: 23, team: 'halcyon', nat: 'NL', skill: 0.87, aggression: 0.8, consistency: 0.83, wetSkill: 0.84 },
  { id: 'yhan', name: 'Yuna Han', short: 'HAN', number: 27, team: 'halcyon', nat: 'KR', skill: 0.84, aggression: 0.55, consistency: 0.88, wetSkill: 0.82 },
  { id: 'obrien', name: "Owen O'Brien", short: 'OBR', number: 3, team: 'ironclad', nat: 'IE', skill: 0.84, aggression: 0.65, consistency: 0.86, wetSkill: 0.86 },
  { id: 'afischer', name: 'Anika Fischer', short: 'FIS', number: 63, team: 'ironclad', nat: 'AT', skill: 0.83, aggression: 0.5, consistency: 0.87, wetSkill: 0.8 },
  { id: 'gduarte', name: 'Gabriel Duarte', short: 'DUA', number: 12, team: 'vortex', nat: 'PT', skill: 0.82, aggression: 0.7, consistency: 0.83, wetSkill: 0.81 },
  { id: 'iwalker', name: 'Isaac Walker', short: 'WAL', number: 77, team: 'vortex', nat: 'AU', skill: 0.82, aggression: 0.6, consistency: 0.85, wetSkill: 0.83 },
  { id: 'pnovak', name: 'Petra Novak', short: 'NOV', number: 9, team: 'tempest', nat: 'CZ', skill: 0.8, aggression: 0.55, consistency: 0.85, wetSkill: 0.84 },
  { id: 'hmaalouf', name: 'Hadi Maalouf', short: 'MAA', number: 21, team: 'tempest', nat: 'LB', skill: 0.8, aggression: 0.75, consistency: 0.8, wetSkill: 0.79 },
];

export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];

export const teamById = (id) => TEAMS.find((t) => t.id === id) ?? TEAMS[0];
export const teamIndex = (id) => Math.max(0, TEAMS.findIndex((t) => t.id === id));

/** A team colour that stays visible on dark UI backgrounds. */
export function teamAccent(team) {
  const c = team.colors[0];
  const n = parseInt(c.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum < 0.18 ? team.colors[1] : c;
}
