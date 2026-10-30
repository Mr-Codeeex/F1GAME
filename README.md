# Apex Grand Prix

A formula racing simulator for **PC and Android**, built on WebGL (three.js) with no build step.
It runs in any modern browser, installs as a Progressive Web App (desktop and Android), and can be
wrapped as a native Android APK with Capacitor. All teams, drivers, and circuits are original and
fictional.

## Quick start

```bash
npm start
```

Then open http://localhost:8080 in Chrome, Edge, or Firefox. On Android, open the same URL in Chrome
(same network or a hosted copy) and choose **Add to Home screen** to install it as a full-screen app.

Requirements: Node 18+ (only for the local static server and tests). The game itself has no
dependencies. three.js is vendored in `vendor/`.

## Game modes

- **Career:** sign for one of 10 teams, replacing their second driver. Race a 6-round calendar (Practice → Qualifying → Race) and score championship points. Earn resource points to spend on R&D (aero, power unit, chassis, durability, energy store). Rival teams develop over the season, and seasons roll over.
- **Grand Prix:** choose race only, qualifying + race, or a full weekend on any circuit. You pick the race length (3 laps up to 100%), the weather (dynamic or fixed), the qualifying format (short, Q1/Q2/Q3 knockout, or one-shot), and the AI difficulty.
- **Time Trial:** hot laps with a recorded ghost and a live delta against your record.

## Simulation features

- **Vehicle physics:** a 240 Hz, 4-wheel planar model.
  - Longitudinal and lateral load transfer, with roll-stiffness distribution.
  - Pacejka-style combined-slip tyres with load sensitivity and tyre relaxation.
  - Downforce and drag with aero balance, ride height and rake.
  - 8-speed gearbox, launch clutch, engine braking.
  - Brake bias, ABS, and traction control (off, medium, or full).
  - Differential on/off throttle settings.
  - Kerbs, grass, gravel and run-off surfaces, plus barrier collisions.
- **Tyres:** Soft, Medium, Hard, Intermediate and Wet compounds.
  - Per-wheel temperature from slip power and carcass flex, with cooling.
  - Wear with a performance cliff past ~75%, plus flat spots.
  - Grip curves that depend on track wetness.
- **Power unit:**
  - ERS with a 4 MJ store. It harvests under braking (MGU-K) and at full throttle (MGU-H). Deployment is capped at 4 MJ per lap. Modes are None, Medium and Hotlap, plus an Overtake button.
  - Fuel load and consumption, with Lean, Standard and Rich mixes.
- **DRS:** detection and activation zones. It needs a gap under 1 s at the detection point and is enabled 2 laps after the start or a restart. It closes on braking and is disabled in the wet or under yellow flags.
- **Aero wake:** slipstream reduces drag and dirty air costs downforce.
- **Weather:** a forecast timeline with rain intensity, track wetness (wetting and drying), and track temperature. Visuals include rain, spray and a wet road.
- **Race control:**
  - Flags:
    - Sector yellow and double yellow.
    - Blue flags.
    - Black & white flag.
    - Chequered flag.
  - Safety Car with queueing, "SC in this lap" and restarts; Virtual Safety Car with a speed delta.
  - Track limits: lap deletion, plus warnings followed by 5 s penalties.
  - Other penalties: causing a collision, overtaking under SC/VSC, ignoring blue flags.
  - Penalties are served at the next pit stop or added to your race time.
  - Two-compound rule for dry races of 8 or more laps.
  - Mechanical failures that cause retirements.
- **Pit stops:**
  - Team boxes on a pit lane with an 80 km/h speed limit.
  - Crew stop times include a chance of a slow stop.
  - Front wing repairs and stacking behind a team-mate.
  - Pit assist (auto-drive) is available.
- **AI:**
  - Steering is pure-pursuit plus PD, limited to peak-slip steering angles.
  - Speed comes from a physics-derived lap model with look-ahead braking.
  - Racecraft: following, overtaking, holding side-by-side, the outside car conceding, defending, yielding to blue flags, and queueing behind the Safety Car.
  - Per-driver skill, aggression, consistency and wet-weather skill, plus occasional mistakes.
  - Tyre strategy that plans stints and reacts to wear, rain, Safety Cars and damage.
  - Recovery after spins.
- **Weekend formats:**
  - Practice with programme rewards in career.
  - Qualifying: short, knockout, or one-shot.
  - Race distance from 3 laps to the full length.
  - Skip or simulate any session.

## Circuits

| Circuit | Theme | Length |
|---|---|---|
| Aurora Bay International Circuit | Coastal | 5.84 km |
| Circuito Sierra Roja | Desert, asphalt run-off | 4.90 km |
| Kaltwald Ring | Forest, gravel traps | 4.45 km |
| Marina Lumen Street Circuit | City streets, walls | 4.33 km |
| Highland Park Raceway | Alpine | 4.56 km |
| Autodromo Cascata Verde | Tropical, rain-prone | 5.21 km |

## Controls

| Keyboard | Action |
|---|---|
| W / ↑, S / ↓ | Throttle, brake |
| A D / ← → | Steer |
| E / Q | Gear up / down (manual gearbox) |
| Space | DRS |
| F (hold) | ERS Overtake |
| R / M | Cycle ERS mode / fuel mix |
| P | Box request |
| Tab | Strategy MFD (tyres, ERS, mix, brake bias, forecast) |
| C / B | Camera (chase, chase far, T-cam, cockpit, nose, TV) / look back |
| H | Toggle HUD |
| Backspace | Reset to track |
| Esc | Pause |

- **Gamepad:** Xbox-style controllers are supported: analog steering and triggers, A for DRS, B for Overtake, X for box, Y for camera, LB/RB for gears.
- **Touch (Android):** on-screen steering buttons or tilt steering, GAS and BRAKE pedals, and DRS, OT, ERS, PIT, camera, MFD and pause buttons. Optional auto-throttle.

## Assists and settings

- **Driving assists:** ABS; traction control (full, medium or off); automatic or manual gears; speed-sensitive steering assist; braking assist (low or high); racing line (corners or full); pit auto-drive; auto DRS.
- **Race rules:** AI difficulty from 40 to 110; damage (simulation, reduced or off); Safety Car (on, reduced or off); penalties; mechanical failures.
- **Graphics:** quality (auto, low, medium or high) and resolution scale. Low quality turns off shadows and reduces scenery and particles. Mobile devices default to Medium or Low.
- **Audio:** volumes and spoken engineer radio (uses speech synthesis).

## Android APK (Capacitor)

The web build doubles as the Capacitor web directory:

```bash
npm i -D @capacitor/cli @capacitor/core @capacitor/android
npx cap add android
```

```bash
npm run android:sync
```

```bash
npm run android:open
```

The last command opens Android Studio, where you build or run the APK. Use landscape orientation.

## Development

```bash
npm test
```

This runs the headless simulation tests: circuits, physics envelope, AI laps on every track, a full
race, Q1/Q2/Q3 knockout, Safety Car, pit stops, weather, strategy and career.

```bash
npm start
```

```bash
NODE_PATH=$(npm root -g) npm run test:e2e
```

With the server from `npm start` running, this browser smoke test drives every mode through the real UI with Playwright.

```bash
npm run lapsim -- aurora 3 M
```

```bash
npm run racesim -- sierra 12
```

```bash
npm run tracks
```

These tools run a single-car lap simulation with telemetry, simulate a full race, and render circuit layout SVGs, respectively.

### Layout

```
src/sim/      DOM-free simulation (track, car, tyres, setup, profile, ai, weather, strategy, session)
src/render/   three.js scene: track builder, car models, effects, cameras
src/ui/       HUD and menus
src/data/     teams, drivers, circuits
src/career.js career, R&D, saves (localStorage)
src/input.js  keyboard / gamepad / touch
src/audio.js  procedural WebAudio engine & effects
```
