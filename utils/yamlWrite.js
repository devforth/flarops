// Writing YAML by hand, safely.
//
// Values here come straight out of the scanned repository, so they can hold a
// quote, a backslash or a newline. Interpolating them raw produced broken (or
// attacker-shaped) YAML - the HCL side already had hclEscapeString for exactly
// this, the YAML side did not. A double-quoted YAML scalar takes the same
// escapes as JSON, so this is the full set that matters here.
function yamlEscapeDoubleQuoted(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}

// `context.hasLocalhostWarnings` is set when any value still points at
// localhost, which inside a cluster reaches the pod itself rather than the
// service that was meant - the caller reports it once at the end.
function generateEnvString(envObj, context, indent = '    ') {
  if (Object.keys(envObj).length === 0) return `${indent}# KEY: "VALUE"`;
  return Object.entries(envObj).map(([k, v]) => {
    let line = `${indent}${k}: "${yamlEscapeDoubleQuoted(v)}"`;
    if (String(v).toLowerCase().includes('localhost')) {
      context.hasLocalhostWarnings = true;
      line += ` # Change "localhost" to your endpoint service name (api, frontend or db)`;
    }
    return line;
  }).join('\n');
}

module.exports = { yamlEscapeDoubleQuoted, generateEnvString };
