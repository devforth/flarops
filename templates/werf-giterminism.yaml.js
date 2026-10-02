module.exports = function werfGiterminismTemplate() {
  // "helm" is a top-level key, a sibling of "config" (werf's root Config struct). The CI values file is
  // written at deploy time, so it is allowed uncommitted.
  return `giterminismConfigVersion: 1
config:
  dockerfile:
    allowUncommitted:
      - .env
      - deploy/.env
helm:
  allowUncommittedFiles:
    - deploy/helm/flarops-ci-values.json
`;
};
