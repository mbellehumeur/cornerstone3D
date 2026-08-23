/**
 * Volume load order: from center, take ~1/4 of slices toward one end,
 * then ~1/4 toward the other, and repeat until all indices are covered.
 *
 * Example (n=100, mid=50, chunk=25):
 *   50→26, then 51→75, then 25→1, then 76→99, then remaining edge.
 */
export default function centerQuarterAlternatingIndices(
  length: number
): number[] {
  if (length <= 0) {
    return [];
  }
  if (length === 1) {
    return [0];
  }

  const mid = Math.floor(length / 2);
  const chunk = Math.max(1, Math.ceil(length / 4));
  const order: number[] = [];
  let nextLow = mid;
  let nextHigh = mid + 1;
  let towardLow = true;

  while (order.length < length) {
    if (towardLow) {
      let taken = 0;
      while (taken < chunk && nextLow >= 0) {
        order.push(nextLow);
        nextLow -= 1;
        taken += 1;
      }
    } else {
      let taken = 0;
      while (taken < chunk && nextHigh < length) {
        order.push(nextHigh);
        nextHigh += 1;
        taken += 1;
      }
    }
    towardLow = !towardLow;
    if (nextLow < 0 && nextHigh >= length) {
      break;
    }
  }

  return order;
}
