// The Flarops section of AGENTS.md - the file coding agents read on their own (CLAUDE.md imports it).
// It sits between markers: init adds it, sync rewrites it, and everything outside it is the project's.

const BEGIN = '<!-- flarops:begin - managed by flarops: "flarops sync" rewrites this block, edits inside it are lost -->';
const END = '<!-- flarops:end -->';
const BLOCK_REGEX = /<!-- flarops:begin[^\n]*-->[\s\S]*?<!-- flarops:end -->/;

const AGENTS_BLOCK = `${BEGIN}
## Deployment (Flarops)

This project is deployed by Flarops, and \`flarops.yaml\` is the source of truth for the deployment.

- To change what is deployed - services, replicas, ports, commands, env, secrets, routes, volumes,
  databases - edit \`flarops.yaml\`, run \`npx flarops sync\`, and commit everything it changed.
- Do not edit \`deploy/helm/\`, \`werf.yaml\` or \`.github/workflows/\` by hand: sync regenerates them.
  For a change \`flarops.yaml\` cannot express, edit the generated file and list it under \`syncLock\`
  in \`flarops.yaml\`; a template you add to \`deploy/helm/templates/\` yourself is left alone.
- \`deploy/terraform/\` is generated once and never touched by sync: edit it directly.
- Field reference: the comment block at the end of \`flarops.yaml\`. Sync refuses an invalid file,
  names the field, and writes nothing - read its message and fix that field.
- Secrets: list each under \`secretEnvs\` of the service that reads it (\`ENV_NAME: GITHUB_SECRET_NAME\`).
  Values go into the repository's GitHub Secrets, never into the repository; the git-ignored
  \`deploy/.env\` lists the secrets to create.
- Database connection URLs: list the variable under \`databaseUrls\` - the chart builds the URL from
  the database's user, password and name. Do not store such a URL as a secret.
${END}`;

const CLAUDE_BLOCK = `${BEGIN}
@AGENTS.md
${END}`;

// The file's content with the block added (or brought up to date), or null when nothing changes.
function withBlock(current, block) {
  if (current === null || current === undefined) return `${block}\n`;
  if (BLOCK_REGEX.test(current)) {
    const updated = current.replace(BLOCK_REGEX, block);
    return updated === current ? null : updated;
  }
  return `${current.replace(/\s*$/, '')}${current.trim() ? '\n\n' : ''}${block}\n`;
}

// Whether a file already holds the block; sync only refreshes one that is there.
function hasBlock(content) {
  return BLOCK_REGEX.test(String(content || ''));
}

module.exports = { AGENTS_BLOCK, CLAUDE_BLOCK, withBlock, hasBlock };
