export function echo(input) { return { value: input.value + 1 }; }
export function spin() { const until = performance.now() + 250; while (performance.now() < until) {} return 'done'; }
export async function wait() { await new Promise((resolve) => setTimeout(resolve, 250)); return 'done'; }
export function allocate() { const values = new Array(5_000_000).fill(1); return values.length; }
export async function allocateNative() { const value = Buffer.alloc(96 * 1024 * 1024, 1); await new Promise((resolve) => setTimeout(resolve, 250)); return value.length; }
