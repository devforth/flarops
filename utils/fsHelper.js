const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const { IGNORED_DIRS } = require('./constants');

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB

function logDebug(err) {
  if (process.env.FLAROPS_DEBUG) {
    console.warn(`[DEBUG] ${err.message}`);
  }
}

// Warn once when the depth cap cuts the scan short.
let depthLimitWarned = false;

async function walkDir(dir, fileList = [], maxDepth = 16, currentDepth = 0) {
  if (currentDepth > maxDepth) {
    if (!depthLimitWarned) {
      depthLimitWarned = true;
      console.warn(`\x1b[33mWARNING: Directory tree deeper than ${maxDepth} levels at "${dir}" - anything below that level was not analyzed.\x1b[0m`);
    }
    return fileList;
  }

  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      const filePath = path.join(dir, file);
      
      let stat;
      try {
        stat = await fs.lstat(filePath); // Use lstat to check for symlinks without following
      } catch (e) {
        logDebug(e);
        continue;
      }

      if (stat.isSymbolicLink()) {
        continue;
      }

      if (stat.isDirectory()) {
        if (IGNORED_DIRS.has(file) || (file.startsWith('.') && file !== '.env' && file !== '.env.local' && file !== '.env.example')) {
          continue;
        }
        await walkDir(filePath, fileList, maxDepth, currentDepth + 1);
      } else {
        if (stat.size <= MAX_FILE_SIZE) {
          fileList.push(filePath);
        } else {
          logDebug(new Error(`Skipping large file: ${filePath} (${Math.round(stat.size / 1024 / 1024)}MB)`));
        }
      }
    }
  } catch (err) {
    logDebug(err);
  }
  return fileList;
}

module.exports = {
  walkDir,
  logDebug,
  MAX_FILE_SIZE
};
