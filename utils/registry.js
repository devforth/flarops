const DOCKER_HUB_HOSTS = new Set(['', 'docker.io', 'index.docker.io', 'registry-1.docker.io']);

const NAME_PART = '[a-z0-9]+(?:[._-][a-z0-9]+)*';
const REGISTRY_HOST = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/;
const IMAGE_PATH = new RegExp(`^${NAME_PART}(?:/${NAME_PART})*$`);

function isDockerHub(host) {
  return DOCKER_HUB_HOSTS.has(String(host || '').toLowerCase());
}

function imageHost(image) {
  const first = String(image || '').split('/')[0];
  const isHost = String(image || '').includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  return isHost ? first.toLowerCase() : 'docker.io';
}

function splitRegistry(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\/+$/, '');
  const [host, ...rest] = raw ? raw.split('/') : [''];
  return { host: isDockerHub(host) ? '' : host, project: rest.length > 0 ? rest.join('/') : null };
}

function registrySettings(config) {
  const fromRegistry = splitRegistry(config.dockerRegistry);
  return {
    host: fromRegistry.host || 'docker.io',
    project: config.dockerProject || fromRegistry.project || null,
    repository: config.dockerRepository || config.projectName,
  };
}

function imageRepository(config) {
  const { host, project, repository } = registrySettings(config);
  const namespace = project || (isDockerHub(host) ? '${{ env.REGISTRY_USER }}' : null);
  return [host, namespace, repository].filter(Boolean).join('/');
}

module.exports = { registrySettings, imageRepository, splitRegistry, isDockerHub, imageHost, REGISTRY_HOST, IMAGE_PATH };
