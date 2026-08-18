module.exports = function werfGiterminismTemplate() {
  return `giterminismConfigVersion: 1
config:
  helm:
    allowUncommitted:
      - deploy/helm/**/*
      - deploy/helm/*
  dockerfile:
    allowUncommitted:
      - .env
      - deploy/.env
`;
};
