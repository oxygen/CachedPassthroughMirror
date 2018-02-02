const JSONRPC = require("jsonrpc-bidirectional");

const HTTPProxyCache = require("../..");
const MasterClient = require("./MasterClient");

const http = require("http");
const url = require("url");

const sleep = require("sleep-promise");


module.exports = 
class WorkerEndpoint extends JSONRPC.NodeClusterBase.WorkerEndpoint
{
	constructor()
	{
		super(/*classReverseCallsClient*/ MasterClient);
		
		// Fake root HTTP file repository, with simulated errors at predefined paths.
		this._httpStaticFileServerSimulator = null;
		
		// The being tested component. 
		// Running in a worker to also test multi process concurrency over the same cache directory path.
		this._httpCachedProxy = null;
		this._httpServerForCachedProxy = null;
	}


	/**
	 * @returns {number}
	 */
	static get httpListenHostname()
	{
		return "127.0.0.1";
	}


	/**
	 * @returns {number}
	 */
	static get httpStaticFileServerPort()
	{
		return 7613;
	}

	/**
	 * @returns {number}
	 */
	static get httpCachedProxyServerPort()
	{
		return 7614;
	}


	/**
	 * @returns {number}
	 */
	static get httpStaticFileServerPortConnectionRefused()
	{
		return 7615;
	}
	

	/**
	 * Files under this value must not be cached.
	 */
	static get minimumCacheableSizeBytes()
	{
		return 10 * 1024 * 1024;
	}


	/**
	 * @override
	 * 
	 * @param {undefined} incomingRequest 
	 */
	async _startServices(incomingRequest)
	{
		await super._startServices(incomingRequest);


		const strCacheDirectoryPath = await this.masterClient.cacheDirectoryPath();


		this._httpStaticFileServerSimulator = http.createServer(async (incomingRequest, serverResponse) => {
			const objParsedURL = url.parse(incomingRequest.url);
			const strRelativeFilePath = objParsedURL.pathname;

			if(incomingRequest.method === "GET" || incomingRequest.method === "HEAD" || incomingRequest.method === "OPTIONS")
			{
				if(strRelativeFilePath === "/")
				{
					const strIndex = `
						<a href="/200-OK.10MB-10seconds.bin">/200-OK.10MB-10seconds.bin</a><br>
						<a href="/200-OK.5MB-5seconds-ConnectionReset.bin">/200-OK.5MB-5seconds-ConnectionReset.bin</a><br>
						<a href="/401-Unauthorized">/401-Unauthorized</a><br>
						<a href="/403-Forbidden">/403-Forbidden</a><br>
						<a href="/500-InternalServerError">/500-InternalServerError</a><br>
						<a href="/GatewayConnectionRefused">/GatewayConnectionRefused</a><br>
						<a href="/404">/404</a><br>
						<a href="/../404">/../404</a>
					`;

					serverResponse.statusCode = 200;
					serverResponse.setHeader("content-length", strIndex.length);
					serverResponse.setHeader("content-type", "text/html");

					serverResponse.write(strIndex, "utf8", () => {
						serverResponse.end();
					});
				}

				// This file will be served over a period of 1MB/s (10 seconds == 10 MB)
				// to enable concurrency testing between workers, for these concurrency contexts:
				// 1) For a single worker, concurrency is handled by saving the promise of the ongoing transfer.
				// Concurrent requests for the same cached file path inside the same worker will be proxied and skipping any caching.
				// 2) Concurrent requests of multiple workers for the same cached file path will have the worker ID sufixed to the temporary file name, 
				// and then will only rename the downloaded file into the final path if no overwrite would happen. 
				// This avoids locking and timeout issues, if locking would have been the way to go for efficiency.
				else if(strRelativeFilePath === "/200-OK.10MB-10seconds.bin")
				{
					const nSizeBytes = WorkerEndpoint.minimumCacheableSizeBytes;
					const nSizeBytesIncrement = parseInt(WorkerEndpoint.minimumCacheableSizeBytes / 10, 10);

					serverResponse.statusCode = 200;
					serverResponse.setHeader("content-length", nSizeBytes);
					serverResponse.setHeader("content-type", "application/octet-stream");

					if(incomingRequest.method === "GET")
					{
						let nSentBytes = 0;
						while(nSentBytes < nSizeBytes)
						{
							await new Promise((fnResolve, fnReject) => {
								serverResponse.write(Buffer.allocUnsafe(nSizeBytesIncrement), "binary", fnResolve);
							});

							nSentBytes += nSizeBytesIncrement;

							await sleep(1000);
						}
					}

					serverResponse.end();
				}

				// After this, the temporary download file should be cleaned up after losing the connection.
				// The test HTTP client should be configured to timeout fast.
				else if(strRelativeFilePath === "/200-OK.5MB-5seconds-ConnectionReset.bin")
				{
					const nSizeBytes = WorkerEndpoint.minimumCacheableSizeBytes;
					const nSizeBytesIncrement = parseInt(WorkerEndpoint.minimumCacheableSizeBytes / 10, 10);

					serverResponse.statusCode = 200;
					serverResponse.setHeader("content-length", nSizeBytes);
					serverResponse.setHeader("content-type", "application/octet-stream");

					if(incomingRequest.method === "GET")
					{
						let nSentBytes = 0;
						while(nSentBytes < nSizeBytes)
						{
							await new Promise((fnResolve, fnReject) => {
								serverResponse.write(Buffer.allocUnsafe(nSizeBytesIncrement), "binary", fnResolve);
							});

							nSentBytes += nSizeBytesIncrement;

							await sleep(1000);

							console.log("Simulating connection reset, destroying incoming socket.");
							incomingRequest.socket.end();
							incomingRequest.socket.destroy();

							try
							{
								// Maybe cleans up.
								serverResponse.end();
							}
							catch(error)
							{
								// Silently ignore anything here.
							}

							return;
						}
					}
					else
					{
						serverResponse.end();
						return;
					}

					throw new Error("Unreachable code.");
				}

				else if(strRelativeFilePath === "/401-Unauthorized")
				{
					serverResponse.statusCode = 401;
					
					if(incomingRequest.method === "GET")
					{
						serverResponse.setHeader("content-type", "text/plain");
						serverResponse.write(`${strRelativeFilePath} does not feel the same way about you personally!`, "utf8", () => {
							serverResponse.end();
						});
					}
					else
					{
						serverResponse.end();
					}
				}

				else if(strRelativeFilePath === "/403-Forbidden")
				{
					serverResponse.statusCode = 403;

					if(incomingRequest.method === "GET")
					{
						serverResponse.setHeader("content-type", "text/plain");
						serverResponse.write(`${strRelativeFilePath} is not allowed from the internet!`, "utf8", () => {
							serverResponse.end();
						});
					}
					else
					{
						serverResponse.end();
					}
				}

				else if(strRelativeFilePath === "/500-InternalServerError")
				{
					serverResponse.statusCode = 500;

					if(incomingRequest.method === "GET")
					{
						serverResponse.setHeader("content-type", "text/plain");
						serverResponse.write(`${strRelativeFilePath} has crashed!`, "utf8", () => {
							serverResponse.end();
						});
					}
					else
					{
						serverResponse.end();
					}
				}

				else if(strRelativeFilePath === "/GatewayConnectionRefused")
				{
					serverResponse.statusCode = 500;

					if(incomingRequest.method === "GET")
					{
						serverResponse.setHeader("content-type", "text/plain");
						serverResponse.write("this._httpProxyCacheConnectionRefused.processHTTPRequest() proxied the request and reached a file server. This must not happen.", "utf8", () => {
							serverResponse.end();
						});
					}
					else
					{
						serverResponse.end();
					}
					// throw new Error("this._httpProxyCacheConnectionRefused.processHTTPRequest() proxied the request and reached a file server. This must not happen.");
				}

				// The test HTTP client should be configured to timeout fast.
				else if(strRelativeFilePath === "/ConnectionReset")
				{
					incomingRequest.socket.destroy();

					try
					{
						// Maybe cleans up.
						serverResponse.end();
					}
					catch(error)
					{
						// Silently ignore anything here.
					}
				}

				// 404 should be used to test if files in the cache directory are deleted from disk when gone on the HTTP static file repository.
				else
				{
					serverResponse.statusCode = 404;

					if(incomingRequest.method === "GET")
					{
						serverResponse.setHeader("content-type", "text/plain");
						serverResponse.write(`${strRelativeFilePath} not found.`, "utf8", () => {
							serverResponse.end();
						});
					}
					else
					{
						serverResponse.end();
					}
				}
			}
			else
			{
				throw new Error("HTTP static file server simulator unhandled HTTP request " + JSON.stringify(incomingRequest.method) + ".");
			}
		});

		this._httpStaticFileServerSimulator.listen(WorkerEndpoint.httpStaticFileServerPort, WorkerEndpoint.httpListenHostname);
		console.log("[" + process.pid + "] HTTP static file server simulator listening.");


		this._httpProxyCache = new HTTPProxyCache(
			/*strTargetURLBasePath*/ `http://${WorkerEndpoint.httpListenHostname}:${WorkerEndpoint.httpStaticFileServerPort}/`, 
			/*nBytesMinimumFileSize*/ WorkerEndpoint.minimumCacheableSizeBytes, 
			strCacheDirectoryPath
		);

		// Nobody is listening at the target repository when trying to proxy an incoming request.
		// This HTTP server should respond with internal server error 500 or something of the sort, without crashing or going into limbo.
		this._httpProxyCacheConnectionRefused = new HTTPProxyCache(
			/*strTargetURLBasePath*/ `http://${WorkerEndpoint.httpListenHostname}:${WorkerEndpoint.httpStaticFileServerPortConnectionRefused}/`, 
			/*nBytesMinimumFileSize*/ WorkerEndpoint.minimumCacheableSizeBytes, 
			strCacheDirectoryPath
		);
		
		this._httpServerForCachedProxy = http.createServer(async (incomingRequest, serverResponse) => {
			const objParsedURL = url.parse(incomingRequest.url);
			const strRelativeFilePath = objParsedURL.pathname;

			if(strRelativeFilePath === "/GatewayConnectionRefused")
			{
				this._httpProxyCacheConnectionRefused.processHTTPRequest(incomingRequest, serverResponse).catch((error) => {
					console.error(error);
					process.exit(1);
				});
			}
			else
			{
				this._httpProxyCache.processHTTPRequest(incomingRequest, serverResponse).catch((error) => {
					console.error(error);
					process.exit(1);
				});
			}
		});

		this._httpServerForCachedProxy.listen(WorkerEndpoint.httpCachedProxyServerPort, WorkerEndpoint.httpListenHostname);
		console.log("[" + process.pid + "] HTTP proxy cache listening.");
	}


	/**
	 * @override
	 * 
	 * @param {undefined} incomingRequest 
	 */
	async _stopServices(incomingRequest)
	{
		await super._stopServices(incomingRequest);

		this._httpStaticFileServerSimulator.close();
		this._httpServerForCachedProxy.close();

		this._httpStaticFileServerSimulator = null;
		this._httpServerForCachedProxy = null;
	}
};
