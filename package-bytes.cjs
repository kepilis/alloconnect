'use strict';

// Large packages are stored as ordered Git blobs. The caller verifies the
// complete byte count and SHA-256 before installing any downloaded content.
async function* packageBytes(fetchFile, urls, options) {
  for (const url of urls) {
    const response = await fetchFile(url, options);
    if (!response.ok || !response.body) throw new Error('Не удалось скачать пакет: HTTP ' + response.status);
    yield* response.body;
  }
}
module.exports = { packageBytes };
