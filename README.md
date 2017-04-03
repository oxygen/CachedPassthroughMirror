Node-HTTPProxyCache
===================
Very simple transparent HTTP proxy with cache for large files. Originally written to cache large files for some repetitive operations.

Writes to the cache and serves the large files at the same time (stream copy).

The `Content-length` and `Last-modified` headers (from a `HEAD` request to the target server) to determine if the local cache large file is to be invalided.

So far tested on Windows.

@TODO: write tests, examples, etc.

Usage
=====
```JavaScript
	const httpServer = http.createServer();

	const httpProxyCache = new HTTPProxyCache(
		/*strTargetURLBasePath*/ "http://kakao.go.ro/", 
		/*nBytesMinimumFileSize*/ 4 * 1024 * 1024 /*4 MB*/, 
		/*strCacheDirectoryRootPath*/ "/tmp/repo-cache"
	);

	httpServer.on(
		"request",
		async (incomingMessage, serverResponse) => {
			await httpProxyCache.processHTTPRequest(incomingMessage, serverResponse);
		}
	);

	httpServer.listen(8008, "127.0.0.1");
```