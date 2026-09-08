/**
 * Node ESM resolve hook: retry extensionless relative imports with ".ts"
 * appended, so the smoke test can run the real TS sources with plain Node
 * (type stripping) instead of a bundler.
 */
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (
      (specifier.startsWith("./") || specifier.startsWith("../")) &&
      !specifier.endsWith(".ts")
    ) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw err;
  }
}
