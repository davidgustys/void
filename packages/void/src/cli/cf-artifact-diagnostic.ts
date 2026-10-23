/** Share escaping and clipping while preserving each reader's diagnostic format. */
export function quoteArtifactValue(
  value: string,
  count: 'quoted' | 'unquoted' | 'code-points' = 'quoted',
): string {
  const quoted = JSON.stringify(count === 'unquoted' ? value.slice(0, 80) : value);
  if (count === 'unquoted') {
    return value.length > 80 ? `${quoted}...` : quoted;
  }
  const characters = count === 'code-points' ? Array.from(quoted) : quoted;
  const head = characters.slice(0, 77);
  return characters.length > 80 ? `${typeof head === 'string' ? head : head.join('')}...` : quoted;
}
