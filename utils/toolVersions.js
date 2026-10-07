// The tool versions the generated CI installs. Pinned here and raised deliberately, never looked up
// at generation time or left to an action's "latest".
module.exports = {
  TERRAFORM_VERSION: '1.15.8',
  TERRAFORM_REQUIRED: '~> 1.15',
  WERF_VERSION: 'v2.78.2',
};
