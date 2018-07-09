[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Foxygen%2FCachedPassthroughMirror.svg?type=shield)](https://app.fossa.io/projects/git%2Bgithub.com%2Foxygen%2FCachedPassthroughMirror?ref=badge_shield)

Cached passthrough HTTP mirror
==============================
Very simple HTTP passthrough mirror (proxy) with an aggresive cache for large files (ignores cache headers and caches everything larger than a specified minimum size). Originally written to cache large files to accelerate some repetitive operations.

Writes to the cache and serves the large files at the same time ([stream-copy](https://github.com/alexmingoia/stream-copy)).

Uses [http-proxy](https://github.com/nodejitsu/node-http-proxy) for the HTTP proxy part.

This cache saves bandwidth (or speeds up transfers) and makes some files highly available locally (prefetch).

It replicates the directory structure of the target server, only for the cached files (which have at least `nBytesMinimumFileSize`).

The `Content-length` and `Last-modified` headers (from a `HEAD` request to the target server) are used to determine if the cached file is to be invalided. __The `HEAD` request is always made__ and so is depended upon (to proxy updated headers and for immediate cache invalidation).

To prevent cache invalidation (deletion of files which respond with 404 on HTTP or updating of files which changes) place an empty file next to the file that needs to persist, sufixed with .keep, like this: `[original path name].keep`.

There are no plans to add non-ASCII characters support or saving of headers, or 100% independent mirror capabilities.

Place a file with whitespace separated file paths (URL encoded), named `cache_prefetch.txt`, in the root of the target URL base path and then call the `.sync()` method of the `HTTPProxyCache` class to prefetch or update the list of files.

__Security WARNING:__ HTTP authorization skip: when the HEAD request fails either with a non-200 HTTP status code or at network level (or something else), and the file is served directly from the cache storage, there will be no HTTP authorization. This might be fixed in the future, but at the present time, it presents a risk where security matters.

@TODO: write examples, CLI endpoint, etc.

Usage
=====
```JavaScript
	const HTTPProxyCache = require("http-proxy-cache-lf");
	const http = require("http");

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


## License
[![FOSSA Status](https://app.fossa.io/api/projects/git%2Bgithub.com%2Foxygen%2FCachedPassthroughMirror.svg?type=large)](https://app.fossa.io/projects/git%2Bgithub.com%2Foxygen%2FCachedPassthroughMirror?ref=badge_large)