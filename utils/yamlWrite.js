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

function generateEnvString(envObj, context, indent = '    ') {
  if (Object.keys(envObj).length === 0) return `${indent}# KEY: "VALUE"`;
  return Object.entries(envObj).map(([k, v]) => {
    let line = `${indent}${k}: "${yamlEscapeDoubleQuoted(v)}"`;
    if (LOOPBACK_HOST_REGEX.test(String(v))) {
      context.hasLocalhostWarnings = true;
      line += ` # Points at this container - set the right address in flarops.yaml`;
    }
    return line;
  }).join('\n');
}

module.exports = { yamlEscapeDoubleQuoted, generateEnvString };
