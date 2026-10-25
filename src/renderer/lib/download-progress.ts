/**
 * The finished stretches of a download as `[left, width]` percentages of its
 * progress bar, given the byte ranges still missing (in file order).
 */
export function finishedStretches(missing: Array<[number, number]>, totalBytes: number): Array<[number, number]> {
  const stretches: Array<[number, number]> = [];
  const add = (first: number, last: number) => {
    if (totalBytes > 0 && last >= first) {
      stretches.push([(first / totalBytes) * 100, ((last - first + 1) / totalBytes) * 100]);
    }
  };
  let cursor = 0;
  for (const [first, last] of missing) {
    add(cursor, first - 1);
    cursor = Math.max(cursor, last + 1);
  }
  add(cursor, totalBytes - 1);
  return stretches;
}
