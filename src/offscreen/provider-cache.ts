/** Read provider cache metadata only; Transformers.js still owns all file I/O. */
export async function cachedProviderFiles(modelId: string, revision: string, host: string, template: string): Promise<ReadonlySet<string>> {
  try {
    if (typeof caches === "undefined") return new Set();
    const prefix = new URL(template.replaceAll("{model}", modelId).replaceAll("{revision}", encodeURIComponent(revision)).replace(/\/?$/, "/"), host).href;
    const cache = await caches.open("transformers-cache");
    return new Set((await cache.keys()).map(request => request.url).filter(url => url.startsWith(prefix)).map(url => url.slice(prefix.length)));
  } catch { return new Set(); } // If storage is unavailable, the provider must fetch.
}
