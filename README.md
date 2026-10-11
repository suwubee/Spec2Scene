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

## Music video essentials

This section describes current usage only; see the [changelog](CHANGELOG.md) (newest first, current 0.9.0) for what changed in each release.

**Mood before lyrics.** Start with a mood book and an imagery translation table: let moonlit footprints suggest a journey; use a small figure, negative space and motivated light to convey solitude. Words are emotional evidence, not a shot-by-shot illustration script. Every shot needs foreground, middle ground and background, half-float HDR and tone mapping, motivated lighting, atmospheric depth, lens-driven depth of field and a camera track. See the [directing quality bar](tracks/music-video/directing/05-quality-bar.md).

**Independent gates.** G1 (concept, shots, reference frames) → G1b (rerender with the current engine) → G2G3 (complete song, performance, subtitles) → FINAL, each passed by an independent reviewer. Self-review cannot approve a gate. See the [concept template](templates/CONCEPT-music-video.md) and [gate template](templates/GATE-music-video.md).

**Original worlds and deep production.** Every film defines its own world and forbidden-content list ([world rules](playbook/12-distinct-worlds.md)); one owner per set works in stages ([deep production](playbook/11-deep-production.md)); integration, resumable rendering, per-encode QA and the MP4 download follow the [delivery workflow](playbook/13-film-delivery.md).

**Picture gate.** Every review round first passes the model-free [picture-qa](tools/picture-qa/README.md); fix claims need `--compare --claim` evidence, exemptions need a stated basis, and loosened configs raise an alarm. See [picture gate and model division](playbook/14-picture-gate.md).

**Engine and kits.** The [cinematic engine](tracks/music-video/engine/README.md), [parametric kits](tracks/music-video/kits/README.md), [characters](tracks/music-video/character/README.md), [lyric alignment](tools/music/lyrics/README.md) and [preview / validation tools](tools/cinematic/README.md). `npm run test:cinematic` writes evidence only into an ignored generated project.

**Real-time playback.** The [default resident player](tracks/music-video/realtime/README.md) unlocks audio inside the click, shows the selected first frame immediately, overlays warm-up percentage and ETA on that picture, then plays audio-driven with resident scenes and zero new shader programs. A text-only loading screen is a defect; click-to-first-picture and total warm-up are measured against a budget. Deterministic capture uses `?mode=capture` / `?quality=final`. The [layered player](tracks/music-video/player/README.md) is experimental. Run `npm run check:flicker` and `timeout 960s npm run test:playback -- <temporary-output>`.

**Evidence limits.** Software rendering proves function, not target-GPU performance, independent review, human listening or production acceptance. Per-round evidence lives in [validation](validation/README.md).

## License and responsibility

Original repository content: [Apache-2.0](LICENSE), copyright suwubee and contributors. No third-party creative assets are bundled. Dependencies keep their licenses; the model fetcher records upstream license information for users to verify. You are responsible for permissions covering all imported, downloaded and generated content and third-party services. Outputs need human review. Motion activities are not medical or professional fitness advice. Camera data stays local by default. See the bilingual [disclaimer](DISCLAIMER.md), [privacy/licensing workflow](playbook/09-privacy-and-licensing.md) and [security policy](SECURITY.md).
