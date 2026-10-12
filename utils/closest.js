// The known word a typo most likely meant, or null when none is close.

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}

function closest(word, candidates, maxDistance = 3) {
  const w = String(word).toLowerCase();
  let best = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const dist = distance(w, String(c).toLowerCase());
    if (dist < bestDistance) { best = c; bestDistance = dist; }
  }
  return bestDistance <= Math.min(maxDistance, Math.max(1, Math.floor(w.length / 2))) ? best : null;
}

module.exports = { closest };
