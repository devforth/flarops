// Values come from the scanned repository; escape everything written into a double-quoted scalar.
const { LOOPBACK_HOST_REGEX } = require('./constants');

function yamlEscapeDoubleQuoted(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

// `owner` names the block in flarops.yaml ("api"), so a warning can name the field.
function generateEnvString(envObj, context, indent = '    ', owner = null) {
  if (Object.keys(envObj).length === 0) return `${indent}# KEY: "VALUE"`;
  return Object.entries(envObj).map(([k, v]) => {
    let line = `${indent}${k}: "${yamlEscapeDoubleQuoted(v)}"`;
    if (LOOPBACK_HOST_REGEX.test(String(v))) {
      context.hasLocalhostWarnings = true;
      if (!context.localhostKeys) context.localhostKeys = [];
      context.localhostKeys.push(owner ? `${owner}.env.${k}` : k);
      line += ` # Points at this container - set the right address in flarops.yaml`;
    }
    return line;
  }).join('\n');
}

module.exports = { yamlEscapeDoubleQuoted, generateEnvString };
