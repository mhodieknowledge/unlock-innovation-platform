/**
 * `cloudflare:workers` is a module built into the Workers runtime, not a package, so there is
 * nothing on disk for TypeScript to resolve. `wrangler types` generates a declaration for it
 * alongside a full copy of every Cloudflare type; this app needs one export from it, and a
 * generated file that has to be regenerated to stay true is a worse trade than four honest
 * lines. The shape is deliberately loose: lib/runtime.ts is where this app says what its own
 * environment contains.
 */
declare module "cloudflare:workers" {
  export const env: Record<string, unknown>;
}
