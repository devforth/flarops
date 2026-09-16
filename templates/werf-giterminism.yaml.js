module.exports = function werfGiterminismTemplate() {
  // NOTE: "helm" is a TOP-LEVEL key, a sibling of "config" - NOT nested inside
  // it. Verified against werf's own source: the root Config struct is
  // `{ Cli, Config, Helm, Includes }` (pkg/giterminism_manager/config/config.go)
  // and its helm.allowUncommittedFiles is the only valid key under helm (no
  // "allowUncommitted" there - that name only exists under config.dockerfile).
  // A misplaced/misnamed key here is silently ignored (schema allows unknown
  // additionalProperties), so it produces no error - it just never takes
  // effect, which is exactly what happened before this was fixed.
  //
  // deploy/helm/flarops-ci-values.json is the ephemeral, gitignored values file
  // the CI workflow (deploy.yml/pr-capsule.yml) writes with secrets at deploy
  // time and passes to `werf converge --values` - it must stay uncommitted.
  //
  // NOTE on config.dockerfile.allowUncommitted: verified against werf's own
  // source (pkg/giterminism_manager/file_reader/dockerfile.go), this key only
  // allow-lists the Dockerfile config file's OWN relative path (and the
  // sibling allowUncommittedDockerignoreFiles does the same for .dockerignore
  // itself) - it has nothing to do with files a COPY/ADD instruction pulls
  // into the image. That scan is driven entirely by each image's own
  // .dockerignore (see the root .dockerignore init.js maintains whenever a
  // service's build context is the repo root) - there is no giterminism.yaml
  // key that allow-lists an arbitrary uncommitted file inside a build context.
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
