// fs.promises for code that only analyses a repository: text reads come back with "\n" line endings,
// so a file saved on Windows parses the same as any other. Never used for files that get written back.
const fsp = require('fs').promises;

const normalize = (text) => text.replace(/\r\n?/g, '\n');

module.exports = {
  ...fsp,
  async readFile(file, options) {
    const content = await fsp.readFile(file, options);
    return typeof content === 'string' ? normalize(content) : content;
  },
  normalize,
};
