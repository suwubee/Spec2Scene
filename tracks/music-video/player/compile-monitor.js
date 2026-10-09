/** Runtime-only diagnostics for shader/program churn. It never changes quality. */
export function programCount(renderer) {
  const programs = renderer?.info?.programs;
  if (Array.isArray(programs)) return programs.length;
  if (Number.isInteger(programs?.length)) return programs.length;
  if (Array.isArray(programs?.programs)) return programs.programs.length;
  return null;
}

export function programIdentitySet(renderer) {
  const programs = renderer?.info?.programs;
  const list = Array.isArray(programs) ? programs : Array.isArray(programs?.programs) ? programs.programs : [];
  return new Set(list.map(program => program?.program || program?.cacheKey || program?.id || program));
}

export function createCompileMonitor(renderer, { limit = 600 } = {}) {
  const records = [], switches = [], baseline = programCount(renderer);
  const record = (entry = {}) => {
    const row = { at: performance.now?.() ?? Date.now(), programs: programCount(renderer), identities: programIdentitySet(renderer).size, ...entry };
    records.push(row); if (records.length > limit) records.shift(); return row;
  };
  return {
    baseline,
    records,
    switches,
    record,
    markQualitySwitch(from, to, { engineBefore, engineAfter, definesBefore = null, definesAfter = null } = {}) {
      const row = { from, to, at: performance.now?.() ?? Date.now(), rebuilt: Boolean(engineBefore && engineAfter && engineBefore !== engineAfter), definesChanged: definesBefore !== null && definesAfter !== null && JSON.stringify(definesBefore) !== JSON.stringify(definesAfter), programsBefore: programCount(engineBefore?.renderer || renderer), programsAfter: programCount(engineAfter?.renderer || renderer) };
      switches.push(row); if (switches.length > limit) switches.shift(); record({ kind: 'quality-switch', ...row }); return row;
    },
    snapshot(kind = 'frame') { return record({ kind }); },
    report() {
      const current = programCount(renderer);
      return { baseline, current, records: records.slice(), switches: switches.slice(), newPrograms: baseline === null || current === null ? null : Math.max(0, current - baseline), qualityRebuilds: switches.filter(s => s.rebuilt).length, defineChanges: switches.filter(s => s.definesChanged).length };
    },
  };
}

/** Constraint check used by tests and review reports; it deliberately throws on a violation. */
export function assertNoQualityRebuild(reportOrSwitches) {
  const switches = Array.isArray(reportOrSwitches) ? reportOrSwitches : reportOrSwitches?.switches || [];
  const bad = switches.filter(row => row.rebuilt || row.definesChanged);
  if (bad.length) throw new Error(`quality switch rebuilt engine or changed shader defines (${bad.length})`);
  return true;
}

export function assertNoNewPrograms(before, after) {
  if(before instanceof Set && after instanceof Set){const added=[...after].filter(p=>!before.has(p));if(added.length)throw new Error(`playback compiled ${added.length} new program identities`);return true;}
  if (Number.isFinite(before) && Number.isFinite(after) && after > before) throw new Error(`playback compiled ${after - before} new programs`);
  return true;
}
