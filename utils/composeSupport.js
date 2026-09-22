// Docker-compose routinely declares third-party components an application
// genuinely needs at runtime but that live in no directory of the repository:
// a Redis cache, a RabbitMQ broker, a Keycloak identity provider, a search
// cluster. Flarops only ever generated the services it BUILDS, plus the
// project's database - so those components silently vanished from the chart
// while every reference to them survived in the generated environment
// (SPRING_RABBITMQ_HOST=notification-rabbitmq, an issuer URI pointing at
// keycloak-server). The result is a chart that renders perfectly and a
// deployment where half the pods crash-loop on a DNS name nothing serves.
//
// This module reads such a service out of its compose block so it can be
// generated as an ordinary Deployment + Service running the same public image.

// Container ports for images that conventionally declare none in compose
// (because the compose author only ever reached them from inside the default
// bridge network). Without a port a Service cannot be created at all, and
// without a Service the hostname still does not resolve.
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

// Reads a nested block ("environment:", "ports:", ...) by indentation and
// hands back its raw lines. Compose allows both a mapping and a sequence
// under most of these keys, so the caller decides how to read the lines.
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
  // Only a " #" sequence starts a comment in a compose scalar; a '#' inside a
  // value (a URL fragment, a generated password) does not.
  return value.replace(/\s+#.*$/, '').trim();
}

function unquote(value) {
  return value.replace(/^["']|["']$/g, '');
}

function extractImage(block) {
  const m = block.match(/^\s*image:\s*["']?([^\s"'#]+)["']?/m);
  return m ? m[1] : null;
}

// Container-side ports only. "5433:5432" publishes the container's 5432 on
// the host's 5433; inside the cluster only 5432 exists, and generating a
// Service on 5433 would point at nothing.
function extractPorts(block, image) {
  const ports = new Set();
  for (const section of ['ports', 'expose']) {
    for (const entry of readSection(block, section)) {
      const raw = entry.inline || entry.line || '';
      const item = unquote(stripInlineComment(raw.replace(/^\s*-\s*/, '')));
      if (!item) continue;
      // host:container, ip:host:container, or a bare container port
      const parts = item.split(':');
      const candidate = parts[parts.length - 1].split('/')[0].trim();
      if (/^\d+$/.test(candidate)) {
        ports.add(parseInt(candidate, 10));
        continue;
      }
      // "8000-8010:8000-8010" publishes a whole range. Dropped silently, the
      // Service came out with no ports at all and nothing resolved; expand it,
      // bounded so a careless range cannot generate thousands of entries.
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
    env[m[1]] = unquote(stripInlineComment(m[2]));
  }
  return env;
}

// Splits a shell-form compose command into arguments, respecting single and
// double quotes and backslash escapes. Not a full shell parser - it does not
// expand anything - which is exactly right here: the arguments are handed to
// the container verbatim, not to a shell.
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

function extractCommand(block) {
  const args = [];
  const section = readSection(block, 'command');
  for (const entry of section) {
    if (entry.inline) {
      const inline = entry.inline;
      if (inline.startsWith('[')) {
        for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
          const v = unquote(part.trim());
          if (v) args.push(v);
        }
      } else {
        // Shell form. Splitting on whitespace alone broke every quoted
        // argument - `--requirepass "my pass"` became three arguments, two of
        // them wrong - so honour the quoting the same way a shell would.
        for (const part of tokenizeShellWords(stripInlineComment(inline))) {
          args.push(part);
        }
      }
      continue;
    }
    const item = (entry.line || '').match(/^\s*-\s*([\s\S]+)$/);
    if (item) args.push(unquote(stripInlineComment(item[1])));
  }
  return args.length > 0 ? args : null;
}

// Two very different things share the "volumes:" key. A NAMED volume
// ("pgdata:/var/lib/...") is real persistence and becomes a PVC. A BIND mount
// ("./docker/keycloak/realms/:/opt/keycloak/data/import/") ships host files
// into the container - configuration, seed data, certificates - which cannot
// be carried into a cluster by this generator at all, so it is reported
// rather than silently dropped.
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

// docker-compose's build.args are how a frontend image is told, at BUILD
// time, which configuration to compile and which API base URL to bake in.
// They are not runtime environment and no amount of env wiring replaces them:
// miss them and the image quietly builds with its Dockerfile's ARG defaults -
// which, by convention, are the developer's local ones.
function extractBuildArgs(block) {
  const args = {};
  for (const entry of readSection(block, 'args')) {
    const raw = entry.line;
    if (!raw) continue;
    // Mapping form ("KEY: value") and sequence form ("- KEY=value").
    const m = raw.match(/^[ \t]*(?:-\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*[:=]\s*([\s\S]*)$/);
    if (!m) continue;
    args[m[1]] = unquote(stripInlineComment(m[2]));
  }
  return Object.keys(args).length > 0 ? args : null;
}

// Host paths that only ever appear in a node-level agent: a container that
// instruments the machine it runs on (Datadog, cAdvisor, a log shipper)
// rather than serving the application. In Kubernetes that is a DaemonSet with
// hostPath volumes and its own RBAC, not a Deployment - and generated as a
// Deployment with those mounts silently dropped, it starts, instruments
// nothing, and adds a required secret for an API key nobody asked for.
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

// RFC 1123: a Kubernetes object name is lowercase alphanumerics and "-", and
// must START and END alphanumeric, at most 63 characters. Lowercasing and
// replacing the rest was not enough - a compose service spelled "_cache" or
// "redis_" produced "-cache" / "redis-", which the API server rejects, so the
// whole chart failed to apply on a name nobody would think to look at.
function toK8sName(raw) {
  let name = String(raw).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  name = name.replace(/-+/g, '-').replace(/^-+/, '').replace(/-+$/, '');
  if (name.length > 63) name = name.slice(0, 63).replace(/-+$/, '');
  // Nothing usable survived (a name of only separators, or only digits after
  // trimming is still fine - a leading digit is legal in RFC 1123).
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

// A bind mount is usually the supporting service's ENTIRE configuration: the
// gateway's nginx.conf, the identity provider's realm export, the broker's
// definitions file. Reported and dropped, the generated Deployment starts the
// stock image with none of it - an nginx serving its welcome page where the
// project expects an API gateway - and the chart looks complete while the
// component does nothing it was included to do.
//
// Those files are in the repository and readable right here, so carry them as
// a ConfigMap instead. Only what cannot be carried (a host path outside the
// repo, something too large for a ConfigMap, a binary) is reported.
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

function isProbablyText(buf) {
  // A NUL byte never appears in the text formats these mounts carry, and
  // ConfigMap data is a UTF-8 string field, so anything binary has to be
  // reported rather than mangled.
  return !buf.includes(0);
}

// fsMod is injected so this stays testable and the module keeps no top-level
// filesystem dependency of its own.
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
    const key = configMapKeyFor(displayName, taken);
    if (!key) return { error: 'has a name a ConfigMap key cannot represent' };
    data[key] = buf.toString('utf8');
    totalBytes += stat.size;
    return { key };
  };

  for (const mount of bindMounts) {
    const abs = pathMod.resolve(baseDir, mount.source);
    // Never reach outside the repository: a mount of /etc or ~/ is the host's
    // own configuration, not this project's, and copying it into a ConfigMap
    // would put whatever it holds into the cluster.
    const rel = pathMod.relative(baseDir, abs);
    if (rel.startsWith('..') || pathMod.isAbsolute(rel)) {
      unresolved.push({ ...mount, reason: 'points outside the repository' });
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
      // One level only: a ConfigMap has no notion of nested directories, and
      // "items" can only place each key at a flat path under the mount.
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

module.exports = { parseSupportService, extractBuildArgs, looksLikeNodeAgent, materializeBindMounts, toK8sName, tokenizeShellWords, WELL_KNOWN_IMAGE_PORTS };
