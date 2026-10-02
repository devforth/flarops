// Supporting services: third-party components declared in docker-compose (a cache, a broker, an
// identity provider) that the application references but the repository does not build.

// Container ports for images whose compose files usually declare none.
const WELL_KNOWN_IMAGE_PORTS = [
  [/redis|valkey/i, [6379]],
  [/rabbitmq/i, [5672, 15672]],
  [/keycloak/i, [8080]],
  [/memcached/i, [11211]],
  [/elasticsearch|opensearch/i, [9200, 9300]],
  [/clickhouse/i, [8123, 9000]],
  [/cassandra|scylla/i, [9042]],
  [/kafka/i, [9092]],
  [/zookeeper/i, [2181]],
  [/nats/i, [4222]],
  [/etcd/i, [2379]],
  [/consul/i, [8500]],
  [/vault/i, [8200]],
  [/minio/i, [9000, 9001]],
  [/mailhog|mailpit/i, [1025, 8025]],
  [/influxdb/i, [8086]],
  [/neo4j/i, [7474, 7687]],
  [/solr/i, [8983]],
];

function blockLines(block) {
  return block.split('\n');
}

function readSection(block, sectionName) {
  const lines = blockLines(block);
  let indent = null;
  const out = [];
  for (const line of lines) {
    if (indent === null) {
      const m = line.match(new RegExp(`^([ \\t]+)${sectionName}:\\s*(.*)$`));
      if (!m) continue;
      indent = m[1].length;
      if (m[2].trim() !== '') out.push({ inline: m[2].trim() });
      continue;
    }
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const lineIndent = line.match(/^([ \t]*)/)[1].length;
    if (lineIndent <= indent) break;
    out.push({ line });
  }
  return out;
}

function stripInlineComment(value) {
  return value.replace(/\s+#.*$/, '').trim();
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '');
}

function extractImage(block) {
  const m = block.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/m);
  return m ? m[1] : null;
}

// Container-side ports only: in the cluster "5433:5432" exists only as 5432.
function extractPorts(block, image) {
  const ports = new Set();
  for (const section of ['ports', 'expose']) {
    for (const entry of readSection(block, section)) {
      const raw = entry.inline || entry.line || '';
      const item = unquote(stripInlineComment(raw.replace(/^\s*-\s*/, '')));
      if (!item) continue;
      const parts = item.split(':');
      const candidate = parts[parts.length - 1].split('/')[0].trim();
      if (/^\d+$/.test(candidate)) {
        ports.add(parseInt(candidate, 10));
        continue;
      }
      // Expand a port range, bounded.
      const range = candidate.match(/^(\d+)-(\d+)$/);
      if (range) {
        const from = parseInt(range[1], 10);
        const to = parseInt(range[2], 10);
        if (to >= from && to - from <= 64) {
          for (let p = from; p <= to; p++) ports.add(p);
        } else if (to >= from) {
          ports.add(from);
        }
      }
    }
  }
  if (ports.size === 0 && image) {
    for (const [pattern, defaults] of WELL_KNOWN_IMAGE_PORTS) {
      if (pattern.test(image)) {
        for (const p of defaults) ports.add(p);
        break;
      }
    }
  }
  return Array.from(ports);
}

function extractEnv(block) {
  const env = {};
  for (const entry of readSection(block, 'environment')) {
    const raw = entry.line;
    if (!raw) continue;
    const m = raw.match(/^[ \t]*(?:-\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*[:=]\s*([\s\S]*)$/);
    if (!m) continue;
    env[m[1]] = parseComposeScalar(m[2]);
  }
  return env;
}

function tokenizeShellWords(line) {
  const out = [];
  let current = '';
  let quote = null;
  let started = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) { quote = null; continue; }
      if (quote === '"' && ch === '\\' && i + 1 < line.length) { current += line[++i]; continue; }
      current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { current += line[++i]; started = true; continue; }
    if (/\s/.test(ch)) {
      if (current !== '' || started) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += ch;
    started = true;
  }
  if (current !== '' || started) out.push(current);
  return out;
}

// One YAML scalar as compose reads it, escapes included.
function parseComposeScalar(raw) {
  const text = String(raw).trim();
  if (text.startsWith('"')) {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      const ch = text[i];
      if (ch === '"') return out;
      if (ch === '\\' && i + 1 < text.length) {
        const next = text[++i];
        out += ({ n: '\n', t: '\t', r: '\r', '0': '\0', '"': '"', '\\': '\\', '/': '/', ' ': ' ' })[next] ?? ('\\' + next);
        continue;
      }
      out += ch;
    }
    return out; // unterminated - keep what there is rather than drop it
  }
  if (text.startsWith("'")) {
    let out = '';
    for (let i = 1; i < text.length; i++) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") { out += "'"; i++; continue; }
        return out;
      }
      out += text[i];
    }
    return out;
  }
  return stripInlineComment(text);
}

function splitFlowItems(body) {
  const items = [];
  let current = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      current += ch;
      if (quote === '"' && ch === '\\' && i + 1 < body.length) { current += body[++i]; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === ',') { items.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') items.push(current);
  return items.map(s => s.trim()).filter(s => s !== '');
}

// `command:` in every form compose accepts: block list, flow list or a single string.
function extractCommand(block) {
  const args = [];
  const section = readSection(block, 'command');
  for (const entry of section) {
    if (entry.inline) {
      const inline = stripInlineComment(entry.inline);
      if (inline.startsWith('[')) {
        const body = inline.replace(/^\[/, '').replace(/\]\s*$/, '');
        for (const part of splitFlowItems(body)) args.push(parseComposeScalar(part));
      } else {
        // Shell form: YAML first (the string may be quoted), then the shell-style split.
        for (const part of tokenizeShellWords(parseComposeScalar(inline))) args.push(part);
      }
      continue;
    }
    const item = (entry.line || '').match(/^\s*-\s*([\s\S]+)$/);
    if (item) args.push(parseComposeScalar(item[1]));
  }
  return args.length > 0 ? args : null;
}

// `env_file:` in every form compose accepts. Paths are relative to the compose file.
function extractEnvFiles(block) {
  const out = [];
  let pending = null;
  for (const entry of readSection(block, 'env_file')) {
    if (entry.inline) {
      const inline = stripInlineComment(entry.inline);
      const items = inline.startsWith('[')
        ? splitFlowItems(inline.replace(/^\[/, '').replace(/\]\s*$/, ''))
        : [inline];
      for (const item of items) out.push({ path: parseComposeScalar(item), required: true });
      continue;
    }
    const line = entry.line || '';
    const longPath = line.match(/^\s*(?:-\s+)?path:\s*(.+)$/);
    const longRequired = line.match(/^\s*(?:-\s+)?required:\s*(.+)$/);
    if (longPath) {
      pending = { path: parseComposeScalar(longPath[1]), required: true };
      out.push(pending);
    } else if (longRequired && pending) {
      pending.required = !/^(false|no|off)$/i.test(parseComposeScalar(longRequired[1]));
    } else {
      const item = line.match(/^\s*-\s*(.+)$/);
      if (item) { pending = null; out.push({ path: parseComposeScalar(item[1]), required: true }); }
    }
  }
  return out.filter(e => e.path);
}

// A named volume becomes a PVC; a bind mount ships host files and is handled separately.
function extractVolumes(block) {
  const persistent = [];
  const bindMounts = [];
  for (const entry of readSection(block, 'volumes')) {
    const raw = entry.line;
    if (!raw) continue;
    const item = raw.match(/^\s*-\s*([\s\S]+)$/);
    if (!item) continue;
    const spec = unquote(stripInlineComment(item[1]));
    const parts = spec.split(':');
    if (parts.length < 2) continue;
    const source = parts[0];
    const target = parts[1];
    if (source.startsWith('.') || source.startsWith('/') || source.startsWith('~')) {
      bindMounts.push({ source, target });
    } else if (/^[A-Za-z0-9._-]+$/.test(source)) {
      persistent.push({ name: source, target });
    }
  }
  return { persistent, bindMounts };
}

function extractBuildArgs(block) {
  const args = {};
  for (const entry of readSection(block, 'args')) {
    const raw = entry.line;
    if (!raw) continue;
    const m = raw.match(/^[ \t]*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*([\s\S]*)$/);
    if (!m) continue;
    args[m[1]] = parseComposeScalar(m[2]);
  }
  return Object.keys(args).length > 0 ? args : null;
}

// Host paths that mark a node-level agent (it belongs in a DaemonSet, not a Deployment).
const NODE_AGENT_HOST_PATHS = [
  '/var/run/docker.sock',
  '/proc',
  '/sys',
  '/var/lib/docker',
  '/run/containerd',
  '/var/log/pods',
];

function looksLikeNodeAgent(bindMounts) {
  return bindMounts.some(({ source }) =>
    NODE_AGENT_HOST_PATHS.some((p) => source === p || source.startsWith(p + '/')));
}

// RFC 1123 object name: lowercase alphanumerics and "-", starting and ending alphanumeric, max 63.
function toK8sName(raw) {
  let name = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  name = name.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  if (name.length > 63) name = name.slice(0, 63).replace(/-+$/, '');
  if (name === '') return null;
  return name;
}

function parseSupportService(composeName, block) {
  const image = extractImage(block);
  if (!image) return null;
  if (!toK8sName(composeName)) return null;
  const { persistent, bindMounts } = extractVolumes(block);
  return {
    composeName,
    name: toK8sName(composeName),
    image,
    ports: extractPorts(block, image),
    env: extractEnv(block),
    command: extractCommand(block),
    volumes: persistent,
    bindMounts,
    isNodeAgent: looksLikeNodeAgent(bindMounts),
  };
}

// A bind mount is usually a supporting service's whole configuration; it is carried as a ConfigMap.
const MAX_CONFIG_FILE_BYTES = 256 * 1024;
const MAX_CONFIG_TOTAL_BYTES = 768 * 1024;
const MAX_CONFIG_FILES = 24;

function configMapKeyFor(name, taken) {
  let key = String(name).replace(/[^-._a-zA-Z0-9]/g, '-');
  if (!/^[-._a-zA-Z0-9]+$/.test(key) || key === '') return null;
  let candidate = key;
  let n = 2;
  while (taken.has(candidate)) candidate = `${key}-${n++}`;
  taken.add(candidate);
  return candidate;
}

// A ConfigMap is committed and readable by anything with configmap access, so files that look like
// secret material are refused.
const SECRET_FILENAME_REGEX = /(^|[-_.])(id_rsa|id_dsa|id_ecdsa|id_ed25519)($|[-_.])|\.(key|pem|p12|pfx|jks|keystore|truststore|asc|gpg|kdbx|ppk)$|(^|[-_.])(secret|secrets|credential|credentials|password|passwords|token|tokens|htpasswd)($|[-_.])|^\.?env(\..*)?$/i;

const SECRET_CONTENT_REGEX = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|-----BEGIN PGP PRIVATE|-----BEGIN OPENSSH PRIVATE KEY-----|PuTTY-User-Key-File/;

const SECRET_ASSIGNMENT_REGEX = /^[ \t]*["']?[A-Za-z0-9_.-]*(PASSWORD|PASSWD|SECRET|TOKEN|API[_-]?KEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY|CREDENTIAL)[A-Za-z0-9_.-]*["']?[ \t]*[:=][ \t]*["']?(?!\s*$)(?!\$\{)(?!<)(?!changeme\b)(?!change_me\b)(?!your[-_])(?!example\b)(?!placeholder\b)(?!todo\b)(?!tbd\b)(?!""|'')\S/im;

function secretMaterialReason(name, content) {
  if (SECRET_FILENAME_REGEX.test(name)) return `"${name}" is named like key or credential material`;
  if (SECRET_CONTENT_REGEX.test(content)) return `"${name}" contains a private key block`;
  if (SECRET_ASSIGNMENT_REGEX.test(content)) return `"${name}" assigns a credential a real value`;
  return null;
}

function isProbablyText(buf) {
  return !buf.includes(0);
}

function materializeBindMounts(fsMod, pathMod, baseDir, bindMounts) {
  const data = {};
  const fileMounts = [];
  const dirMounts = [];
  const unresolved = [];
  const taken = new Set();
  let totalBytes = 0;

  const addFile = (absPath, displayName) => {
    if (Object.keys(data).length >= MAX_CONFIG_FILES) return { error: 'too many files for one ConfigMap' };
    let stat;
    try { stat = fsMod.statSync(absPath); } catch (e) { return { error: 'not found in the repository' }; }
    if (stat.size > MAX_CONFIG_FILE_BYTES) return { error: `larger than ${MAX_CONFIG_FILE_BYTES} bytes` };
    if (totalBytes + stat.size > MAX_CONFIG_TOTAL_BYTES) return { error: 'ConfigMap size budget exhausted' };
    let buf;
    try { buf = fsMod.readFileSync(absPath); } catch (e) { return { error: 'could not be read' }; }
    if (!isProbablyText(buf)) return { error: 'is a binary file' };
    const secretReason = secretMaterialReason(displayName, buf.toString('utf8'));
    if (secretReason) return { error: secretReason, secret: true };
    const key = configMapKeyFor(displayName, taken);
    if (!key) return { error: 'has a name a ConfigMap key cannot represent' };
    data[key] = buf.toString('utf8');
    totalBytes += stat.size;
    return { key };
  };

  for (const mount of bindMounts) {
    const abs = pathMod.resolve(baseDir, mount.source);
    // Never read outside the repository; the check is on the resolved path, so symlinks cannot escape.
    let realAbs;
    try {
      realAbs = fsMod.realpathSync(abs);
    } catch (e) {
      unresolved.push({ ...mount, reason: 'does not exist in the repository' });
      continue;
    }
    let realBase;
    try {
      realBase = fsMod.realpathSync(baseDir);
    } catch (e) {
      realBase = baseDir;
    }
    const rel = pathMod.relative(realBase, realAbs);
    if (rel.startsWith('..') || pathMod.isAbsolute(rel)) {
      unresolved.push({ ...mount, reason: 'resolves outside the repository' });
      continue;
    }

    let stat;
    try { stat = fsMod.statSync(abs); } catch (e) {
      unresolved.push({ ...mount, reason: 'does not exist in the repository' });
      continue;
    }

    if (stat.isFile()) {
      const res = addFile(abs, pathMod.basename(abs));
      if (res.error) unresolved.push({ ...mount, reason: res.error });
      else fileMounts.push({ key: res.key, mountPath: mount.target });
      continue;
    }

    if (stat.isDirectory()) {
      let entries = [];
      try { entries = fsMod.readdirSync(abs, { withFileTypes: true }); } catch (e) {
        unresolved.push({ ...mount, reason: 'could not be listed' });
        continue;
      }
      // One directory level only (ConfigMaps are flat). One secret-looking file refuses the whole mount.
      let dirSecretReason = null;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        let buf;
        try { buf = fsMod.readFileSync(pathMod.join(abs, entry.name)); } catch (e) { continue; }
        if (!isProbablyText(buf)) continue;
        const reason = secretMaterialReason(entry.name, buf.toString('utf8'));
        if (reason) { dirSecretReason = reason; break; }
      }
      if (dirSecretReason) {
        unresolved.push({ ...mount, reason: dirSecretReason + ' - the whole directory was left for you to provide as a Secret' });
        continue;
      }

      const items = [];
      let failed = null;
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const res = addFile(pathMod.join(abs, entry.name), entry.name);
        if (res.error) { failed = res.error; break; }
        items.push({ key: res.key, path: entry.name });
      }
      if (failed) unresolved.push({ ...mount, reason: failed });
      else if (items.length === 0) unresolved.push({ ...mount, reason: 'holds no files to carry' });
      else dirMounts.push({ mountPath: mount.target, items });
      continue;
    }

    unresolved.push({ ...mount, reason: 'is neither a file nor a directory' });
  }

  const carried = Object.keys(data).length > 0;
  return { data: carried ? data : null, fileMounts, dirMounts, unresolved };
}

module.exports = { parseSupportService, extractBuildArgs, extractCommand, extractEnvFiles, parseComposeScalar, extractVolumes, looksLikeNodeAgent, materializeBindMounts, secretMaterialReason, toK8sName, tokenizeShellWords, WELL_KNOWN_IMAGE_PORTS };
