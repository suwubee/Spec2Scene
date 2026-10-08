# Spec2Scene

**From spec to scene — an AI-agent playbook for music videos, 3D simulations and motion games.**

[简体中文](README.zh-CN.md) · [Workflow / 方法](playbook/00-overview.md) · [Tools / 工具](tools/README.md)

Spec2Scene turns a written specification into a reviewable creative project. It provides a director/reviewer workflow, three production tracks, project templates, parameterized tools and adapters for Claude Code and Codex. It contains no finished works, media, models or datasets. Most detailed playbooks are in Chinese; the overview, roles and release pages include English guidance.

## Five-minute start

Requires Node.js ≥20, npm and Python 3. FFmpeg/ffprobe and a Playwright Chromium installation are needed for media and browser checks.

```bash
npm ci
npx playwright install chromium
scripts/doctor.sh
scripts/new-project.sh music-video my-scene
node tools/serve.mjs --root projects/my-scene --port 39920
```

Open `http://127.0.0.1:39920`. A local three.js cinematic starter runs immediately: a 60-second snowfield crane shot followed by a rainy platform with cuts, a focus pull and a restrained turn. Main imagery uses three.js 3D; SVG/Canvas are for overlays and typography. Stop your foreground server with Ctrl+C. Background jobs must be stopped by their recorded PID. Other tracks:

```bash
scripts/new-project.sh 3d-simulation my-world
scripts/new-project.sh motion-games my-motion
```

Each project gets its own `SPEC.md`, agent instructions, `assets/`, `src/`, `tests/`, `docs/`, `tools.local/` and `package.json`. Fill in the specification, send it with [a task prompt](templates/codex-prompt.md), then have the reviewer reproduce the tests and inspect screenshots. `projects/*` is ignored except its README. Initialize a separate Git repository there if you want to publish your work. Copied tools work independently after `npm install` inside the generated project.

The motion starter includes a labelled synthetic skeleton and a real camera input. Install local model assets explicitly with `scripts/fetch-models.sh --project projects/my-motion --kind pose`; the camera then draws detected landmarks locally. No model or camera recording ships in this repository. The 3D starter is a procedural perspective wireframe and a provenance view, not a surveyed scene.

## Navigation

| Directory | Purpose |
|---|---|
| [playbook](playbook/00-overview.md) | Feedback → specification → implementation → independent review → merge → tests → separate release → online verification |
| [lessons](playbook/lessons/README.md) | Symptoms, causes, fixes and prevention; [coverage matrix](validation/coverage.md) |
| [templates](templates/SPEC.md) | Specification, review, report, release, hotfix and measurable UI acceptance |
| [tracks/music-video](tracks/music-video/README.md) | Music analysis, shots, world curves, deterministic frames, encode and QA |
| [tracks/3d-simulation](tracks/3d-simulation/README.md) | Source provenance, procedural geometry, navigation and memory budgets |
| [tracks/motion-games](tracks/motion-games/README.md) | Local perception, forgiving input, hands-free flow, audio and real-data regression |
| [agents](agents/codex/README.md) | Repository instructions, skills and task dispatch example |
| [tools](tools/README.md) | Static server, rendering, screenshots, analysis, speech, deployment, packaging and pose harness |
| [projects](projects/README.md) | Ignored, independent output projects |
| [validation](validation/README.md) | Baseline validation procedure and evidence |

Run `npm test`, `npm run test:browser`, and the Python `--selftest` commands in the tools guide. The browser suite generates all three demonstration projects, serves only loopback ports 39920–39939, verifies them, closes its own servers, and removes the demonstrations. Optional real datasets are explicitly reported as SKIP when absent; synthetic checks do not establish real recognition accuracy.

## Quality threshold (v0.2)

Start with a mood book and an imagery translation table. Let moonlit footprints suggest a journey; use a small figure, negative space and motivated light to convey solitude. Words are emotional evidence, not a shot-by-shot illustration script.

Every shot needs foreground, middle ground and background, half-float HDR and tone mapping, motivated lighting, atmospheric depth, lens-driven depth of field and a camera track. Character hinge limits and anatomy checks run in `npm test`. See the [directing quality bar](tracks/music-video/directing/05-quality-bar.md).

Independent reviewers must pass G1 (concept/frames), G1b (engine rerender), G2G3 (complete film/performance/subtitles) and FINAL. Self-review cannot approve a gate. `npm run test:cinematic` generates keyframes, eight-view turntables, action sequences, pixel repeatability and software-rendering measurements. Evidence is ignored under `validation/v0.2/artifacts/`; the [validation report](validation/v0.2/README.md) states review and hardware limits.

## License and responsibility

Original repository content: [Apache-2.0](LICENSE), copyright suwubee and contributors. No third-party creative assets are bundled. Dependencies keep their licenses; the model fetcher records upstream license information for users to verify. You are responsible for permissions covering all imported, downloaded and generated content and third-party services. Outputs need human review. Motion activities are not medical or professional fitness advice. Camera data stays local by default. See the bilingual [disclaimer](DISCLAIMER.md), [privacy/licensing workflow](playbook/09-privacy-and-licensing.md) and [security policy](SECURITY.md).

## Cinematic engine v0.3

The complete authorized cinematic engine is ported with content removed, retaining HDR post, sky, terrain, water, materials, particles and deterministic offline tools. See [engine](tracks/music-video/engine/README.md), [kits](tracks/music-video/kits/README.md), and [preview / validation tools](tools/cinematic/README.md). `npm run test:cinematic` writes full-resolution evidence only into an ignored generated project. The character workstream is independent.


## Version 0.4.0: capabilities and evidence limits

The independent production gates are **G1** (concept, shots, reference frames) → **G1b** (rerender with the current engine) → **G2G3** (complete song, performance, subtitles) → **FINAL**. Automated library checks cannot sign a creative gate. See the [complete concept template with a fictional example](templates/CONCEPT-music-video.md), [gate submission template](templates/GATE-music-video.md), [changelog](CHANGELOG.md), and [validation record](validation/v0.4/README.md).

| Area | Implemented and exercised | Unverified or limited |
|---|---|---|
| Sky and atmosphere | Per-frame lunar phase, neutral low moon disc, ray-marched cloud sea with self shadow and silver edges, project terrain fog | Complex embedded geometry in clouds; target GPU performance |
| Reusable scene parts | Basin/jar/puddle planar reflections, telephoto mountain subdivisions, indoor moonlight bounce and diffuse fill, detailed procedural rocks | Full GI, fluid simulation, extreme close-ups, semantic city LOD |
| Camera and post | Shot exposure/WB override global defaults; absolute-time shot curves; current-draw shaft uniforms | Real-device full-song synchronization and frame budget |
| Character | Crossfades, additive head motion, seated hands on knees, knees held close, restrained bun highlights; anatomy and front/side sequences | Medium-shot faces, hands and cloth; arbitrary slope IK and complete contact/collision |
| Lyrics | Preserved vocals, silence-delimited phrases, ordered paragraphs, proportional line windows, reviewer approval and ±0.3 s onset validation, subject-aware subtitle placement | Real-song recognition accuracy and human listening; proportional boundaries remain estimates |
| Execution | Command timeouts, bounded context reads, restart checkpoints, a 60-minute source-stall watchdog | No automatic independent review or deployment approval |

Run `npm run test:browser -- --isolated --offline` to generate fixtures with the normal project generator inside a temporary repository without touching this checkout's projects or downloading models. `npm run test:v04 -- <temporary-evidence-directory>` checks screenshots and identical same-time/reverse renders under the default autoplay policy. Software rendering is evidence of functionality, not a real-time GPU claim. No real-person, listening, model-inference or production acceptance is implied. API details: [v0.4 kits](tracks/music-video/kits/v04.md).

## Real-time playback v0.4.1

Music-video projects now start with the [shared player](tracks/music-video/player/README.md): synchronous trusted-click media playback, an audio master clock, Worker rendering, ordered idle shader compilation, adaptive quality, measured fps, buffering progress and subtitles. Medium/low previews use distant character geometry and batched scenery; high retains the cinematic pipeline. Explicit `?mode=capture` or `?quality=final` selects fixed high-quality deterministic capture with no audio or adaptation.

`npm test` and isolated browser validation exercise audible decoded signal, a 20-second audio clock, slow networking and CPU throttling. Run `timeout 360s npm run test:playback -- /tmp/scene-player-evidence` separately. Reviewers must click the live page themselves; screenshots do not approve playback. Software rendering and decoded signal do not establish target GPU performance or human speaker listening.
