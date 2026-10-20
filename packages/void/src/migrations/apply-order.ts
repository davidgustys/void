/** The cf CLI's D1 migration file order. Imports nothing, so trusted CI code can load it cheaply. */

/**
 * The cf CLI's D1 migration order: per path segment, the leading number before `_` compares
 * numerically (`2_x.sql` before `10_x.sql`), numbers sort before non-numbers, and ties fall
 * back to string order.
 */
function leadingWranglerMigrationNumber(relativePath: string): number {
  const firstSegment = relativePath.split('/')[0] ?? '';
  return parseInt(firstSegment.split('_')[0] ?? '', 10);
}

function compareWranglerMigrationSegments(a: string, b: string): number {
  const aNum = leadingWranglerMigrationNumber(a);
  const bNum = leadingWranglerMigrationNumber(b);
  if (aNum !== bNum) {
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      return aNum - bNum;
    }
    if (Number.isFinite(aNum)) {
      return -1;
    }
    if (Number.isFinite(bNum)) {
      return 1;
    }
  }
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

export function compareWranglerMigrationPaths(a: string, b: string): number {
  const aSegments = a.split('/');
  const bSegments = b.split('/');
  const shared = Math.min(aSegments.length, bSegments.length);
  for (let i = 0; i < shared; i++) {
    const cmp = compareWranglerMigrationSegments(aSegments[i] as string, bSegments[i] as string);
    if (cmp !== 0) {
      return cmp;
    }
  }
  return aSegments.length - bSegments.length;
}
