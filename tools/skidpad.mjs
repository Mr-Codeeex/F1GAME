// Measures steady-state lateral capacity of the physics vs the lap-model prediction.
import { CarPhysics } from '../src/sim/car.js';
import { carLimits } from '../src/sim/profile.js';
const wet = +(process.env.WET ?? 0);
for (const vT of [20, 35, 50, 65, 80]) {
  const car = new CarPhysics({ compound: process.env.C ?? 'M' });
  car.wetness = wet; car.fuel = 30;
  car.tyres.temp.fill(+(process.env.T ?? 95));
  car.vx = vT; car.gear = 8;
  const lim = carLimits(car.params, { compound: car.tyres.compound, fuel: 30 });
  let best = 0, bestSteer = 0;
  const dt = 1 / 240;
  for (let t = 0; t < 14; t += dt) {
    const steer = Math.min(1, t / 14);
    const err = vT - car.vx;
    car.tyres.temp.fill(+(process.env.T ?? 95));
    car.step(dt, { throttle: err > 0 ? Math.min(1, err * 0.5) : 0, brake: err < -0.5 ? Math.min(1, -err * 0.1) : 0, steer });
    const ay = Math.abs(car.vx * car.r);
    if (ay > best && Math.abs(car.vx - vT) < 2) { best = ay; bestSteer = steer; }
  }
  console.log(`v ${vT} m/s: physics max ay ${(best / 9.81).toFixed(2)} g at steer ${bestSteer.toFixed(2)}  model ${(lim.latMax(vT) / 9.81).toFixed(2)} g`);
}
