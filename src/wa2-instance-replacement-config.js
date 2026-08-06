function enabledValue(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

export function wa2InstanceReplacementConfig(env = process.env) {
  const enabled = enabledValue(env.WA2_INSTANCE_REPLACEMENT_ENABLED);
  return Object.freeze({
    enabled,
    executionEnabled: enabled && enabledValue(env.WA2_INSTANCE_REPLACEMENT_EXECUTION_ENABLED),
  });
}
