// Polyfill Bun.hash.xxHash32 for Node.js test runner (vitest)
// Must run before any @oh-my-pi/hashline import since that package ships
// Bun-only TypeScript source that calls Bun.hash.xxHash32().
if (typeof (globalThis as any).Bun === "undefined") {
  const fnv1a32 = (input: string, seed: number): number => {
    let hash = seed === 0 ? 0x811c9dc5 : (seed | 0);
    for (let i = 0; i < input.length; i++) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  };
  (globalThis as any).Bun = {
    hash: { xxHash32: fnv1a32 },
  };
}
