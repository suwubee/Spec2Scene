const finiteArray = value => Array.from(value || []).every(Number.isFinite);

function inspectAttribute(attribute) {
  if (!attribute?.array) return { invalid: 0, count: 0 };
  let invalid = 0;
  for (const value of attribute.array) if (!Number.isFinite(value)) invalid++;
  return { invalid, count: attribute.array.length };
}

/** Inspect position/normal/color attributes without changing the geometry. */
export function inspectGeometry(geometry) {
  if (!geometry?.attributes) throw new TypeError('BufferGeometry required');
  return { position: inspectAttribute(geometry.attributes.position), normal: inspectAttribute(geometry.attributes.normal), color: inspectAttribute(geometry.attributes.color), valid: ['position', 'normal', 'color'].every(key => inspectAttribute(geometry.attributes[key]).invalid === 0) };
}

/** Replace invalid normal/color components and report every repaired component. */
export function guardGeometry(geometry, { repair = false, normal = [0, 1, 0], color = [0, 0, 0] } = {}) {
  if (!geometry?.attributes) throw new TypeError('BufferGeometry required');
  const report = inspectGeometry(geometry), repairAttribute = (attribute, fallback) => {
    if (!attribute?.array) return;
    const itemSize = attribute.itemSize || fallback.length, values = attribute.array;
    for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) { if (!repair) continue; values[i] = fallback[i % itemSize] ?? 0; attribute.needsUpdate = true; }
  };
  if (repair) { repairAttribute(geometry.attributes.normal, normal); repairAttribute(geometry.attributes.color, color); }
  const after = inspectGeometry(geometry);
  return { ...after, original: report, repaired: repair ? report.normal.invalid + report.color.invalid : 0, valid: after.position.invalid === 0 && after.normal.invalid === 0 && after.color.invalid === 0 };
}

export function assertFiniteGeometry(geometry, options = {}) {
  const report = guardGeometry(geometry, options);
  if (!report.valid) throw new Error(`nonfinite geometry attribute: position=${report.position.invalid}, normal=${report.normal.invalid}, color=${report.color.invalid}`);
  return report;
}

export function guardNormalAttribute(attribute, options = {}) { const fake = { attributes: { position: { array: new Float32Array(0) }, normal: attribute } }; return guardGeometry(fake, options).normal; }
export function guardColorAttribute(attribute, options = {}) { const fake = { attributes: { position: { array: new Float32Array(0) }, color: attribute } }; return guardGeometry(fake, options).color; }
export const finiteAttribute = finiteArray;
