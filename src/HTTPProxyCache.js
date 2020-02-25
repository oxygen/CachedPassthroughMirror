const assert = require("assert");
const http = require("http");
const https = require("https");
const url = require("url");
const os = require("os");
const path = require("path");
const cluster = require("cluster");

const HTTPProxy = require("http-proxy");
const sleep = require("sleep-promise");
const fs = require("fs-promise");
const fetch = require("node-fetch");

const dir = require("node-dir");
const stream = require("stream");
stream.copy = require("stream-copy").copy;


module.exports = 
class HTTPProxyCache
{
	/**
	 * @param {string} strTargetURLBasePath 
	 * @param {number} nBytesMinimumFileSize 
	 * @param {string} strCacheDirectoryRootPath 
	 */
	constructor(strTargetURLBasePath, nBytesMinimumFileSize, strCacheDirectoryRootPath)
	{
		this._strTargetURLBasePath = strTargetURLBasePath.split("?")[0].split("#")[0];
		if(this._strTargetURLBasePath.substr(-1) !== "/")
		{
			this._strTargetURLBasePath += "/";
		}
		this._objParsedTargetURL = url.parse(this._strTargetURLBasePath);

		this._nBytesMinimumFileSize = nBytesMinimumFileSize;
		this._strCacheDirectoryRootPath = strCacheDirectoryRootPath;

		this._proxy = HTTPProxy.createProxyServer();

		this._objOngoingCacheWrites = {};

		setTimeout(() => {
			//this.sync().catch(console.error);
		}, 10000);
	}


	/**
	 * @param {http.IncomingRequest} incomingRequest 
	 * @param {http.ServerResponse} serverResponse 
	 */
	async processHTTPRequest(incomingRequest, serverResponse)
	{
		const objParsedURL = url.parse(incomingRequest.url);

		// default.
		serverResponse.statusCode = 200;


		if(incomingRequest.headers["range"])
		{
			console.log(`Range header exists: ${incomingRequest.headers["range"]}. Will skip cache even if a .keep flag file exists. ${incomingRequest.url}`);
		}


		if(
			incomingRequest.method === "GET"
			&& !objParsedURL.pathname.includes("..")
			&& !incomingRequest.headers["range"]
		)
		{
			try
			{
				const strCachedFilePath = path.join(this._strCacheDirectoryRootPath, objParsedURL.pathname);
				let bSkipCacheWrite = false;
				let bSkipStorageCache = false;
				let cachedFileStats = null;

				
				if(incomingRequest.headers["authorization"] || incomingRequest.headers["proxy-authorization"] || incomingRequest.headers["www-authenticate"])
				{
					bSkipCacheWrite = true;
					bSkipStorageCache = true;
				}


				if(fs.existsSync(strCachedFilePath))
				{
					cachedFileStats = fs.statSync(strCachedFilePath);
				}

				if(
					objParsedURL.pathname === "/"
					|| objParsedURL.pathname === ""
					|| objParsedURL.pathname.substr(-1) === "/"
					|| (
						cachedFileStats !== null
						&& cachedFileStats.isDirectory()
					)
				)
				{
					bSkipCacheWrite = true;
					bSkipStorageCache = true;
				}

				if(this._objOngoingCacheWrites[strCachedFilePath] !== undefined)
				{
					// Holding the request until the cache is ready would conserve bandwidth, 
					// however it might trigger timeouts in certain clients.
					// It is better to proxy it it right away, in parallel with the being cached request.
					bSkipCacheWrite = true;

					/*try
					{
						await this._objOngoingCacheWrites[strCachedFilePath];
					}
					catch(error)
					{
						console.log(error);
					}*/
				}


				const bKeepFlagAndFileExists = (
					fs.existsSync(strCachedFilePath)
					&& fs.existsSync(strCachedFilePath + ".keep")
				);


				if(!bKeepFlagAndFileExists)
				{
					let fetchHeadResponse = null;
					let headers = new fetch.Headers();

					if(!bSkipCacheWrite)
					{
						try
						{
							assert(this._objParsedTargetURL.path.substr(-1) === "/", "Path root sandbox must end in /");

							for(let strHeaderName of ["range", "content-length", "user-agent", "authorization", "proxy-authorization", "www-authenticate", "accept", "accept-language", "cache-control", "cookie", "referer"])
							{
								if(incomingRequest.headers[strHeaderName] !== undefined)
								{
									headers.set(strHeaderName, incomingRequest.headers[strHeaderName]);
								}
							}

							// Obtain headers with a HEAD request.
							// Content-length is used to determine if the file is big enough to warrant caching.
							// Last-modified is used to determine if the file has changed in the meantime.
							try
							{
								fetchHeadResponse = await fetch(this._strTargetURLBasePath + objParsedURL.path.substr(1), {method: "HEAD", headers: headers});
								fetchHeadResponse.text().catch(console.error);
							}
							catch(error)
							{
								console.error("fetch HEAD error: " + error.message);
								fetchHeadResponse = {status: 0, error: error};
							}

							if(
								parseInt(fetchHeadResponse.status, 10) === 404
								&& fs.existsSync(strCachedFilePath)
								
								// Asked by developers to be able to put files in the cache and not have them deleted if not found on the repo.
								&& path.extname(strCachedFilePath) !== ".keep"
								&& !fs.existsSync(strCachedFilePath + ".keep")

								&& !cachedFileStats.isDirectory()
							)
							{
								console.error("HEAD request status code " + JSON.stringify(fetchHeadResponse.status) + ", deleting existing cached file.");
								
								cachedFileStats = null;
								try
								{
									console.log(`Deleting ${strCachedFilePath} because HTTP server returned 404 Not Found for ${this._strTargetURLBasePath + objParsedURL.path.substr(1)}`);
									await fs.unlink(strCachedFilePath);
								}
								catch(error)
								{
									if(error.code !== "ENOENT")
									{
										console.error(error);
									}
								}
							}
							
							if(
								fetchHeadResponse.status < 200
								|| fetchHeadResponse.status > 299
							)
							{
								if(!fs.existsSync(strCachedFilePath))
								{
									serverResponse.statusCode = fetchHeadResponse.status ? fetchHeadResponse.status : 500;
									serverResponse.write("HEAD request failed and there is no cached file.");
									serverResponse.end();

									return;
								}
								else
								{
									console.error("HEAD request status code " + JSON.stringify(fetchHeadResponse.status) + ". Skipping cache write.");
									bSkipCacheWrite = true;
								}
							}
						}
						catch(error)
						{
							console.error(error);
							
							bSkipCacheWrite = true;

							if(!fs.existsSync(strCachedFilePath))
							{
								console.error("HEAD request failed with thrown error and there is no cached file. Proxying the HTTP code and returning.");

								serverResponse.statusCode = 500;
								serverResponse.write(error.message + "\r\n" + error.stack);
								serverResponse.end();

								return;
							}
						}
					}


					if(
						!bSkipCacheWrite
						&& (
							fetchHeadResponse.headers.get("content-length")
							|| fetchHeadResponse.headers.get("content-length") === 0
						)
						&& fetchHeadResponse.headers.get("content-length") < this._nBytesMinimumFileSize
						&& !bKeepFlagAndFileExists
					)
					{
						if(fs.existsSync(strCachedFilePath))
						{
							try
							{
								await fs.unlink(strCachedFilePath);
							}
							catch(error)
							{
								console.error(error);
							}
						}
					}
					
					
					if(
						!bSkipCacheWrite
						&& fetchHeadResponse.headers.get("content-length")
						&& fetchHeadResponse.headers.get("content-length") >= this._nBytesMinimumFileSize
					)
					{
						for(let strHeaderName of Object.keys(fetchHeadResponse.headers.raw()))
						{
							serverResponse.setHeader(strHeaderName, fetchHeadResponse.headers.get(strHeaderName));
						}

						if(
							!fs.existsSync(strCachedFilePath)
							|| (
								serverResponse.hasHeader("content-length")
								&& cachedFileStats !== null
								&& cachedFileStats.size !== parseInt(serverResponse.getHeader("content-length"), 10)
							)
							|| (
								// If the web server's last modified timestamp is earlier than the local copy, then the local copy's modified timestamp is useless.
								serverResponse.hasHeader("last-modified")
								&& cachedFileStats !== null
								&& Math.floor(cachedFileStats.mtime.getTime() / 1000) < Math.floor(new Date(serverResponse.getHeader("last-modified")).getTime() / 1000)
							)
						)
						{
							bSkipStorageCache = true;

							await HTTPProxyCache.mkdirRecursive(path.dirname(strCachedFilePath));

							const strSufixExtension = ".httpproxy.worker-" + (cluster.isMaster ? "master" : cluster.worker.id) + ".download";

							try
							{
								// Condition to avoid race condition.
								if(this._objOngoingCacheWrites[strCachedFilePath] === undefined)
								{
									this._objOngoingCacheWrites[strCachedFilePath] = new Promise(async (fnResolve, fnReject) => {
										//let nStreamsFinished = 0;

										const wstream = fs.createWriteStream(strCachedFilePath + strSufixExtension);

										wstream.on("error",	fnReject);
										
										let bServerResponseGotFinishEvent = false;

										serverResponse.on("error", fnReject);
										serverResponse.on("close", () => {
											if (!bServerResponseGotFinishEvent)
											{
												fnReject(new Error("Connection closed before sending the whole response."));
											}
										});

										serverResponse.on(
											"finish", 
											async () => {
												bServerResponseGotFinishEvent = true;
												serverResponse.end();

												await sleep(20);
												wstream.end();

												fnResolve();
											}
										);

										const fetchResponse = await fetch(this._strTargetURLBasePath + objParsedURL.path.substr(1), {headers: headers});
										stream.copy(serverResponse, wstream);
										fetchResponse.body.pipe(serverResponse);
									});
								}
								else
								{
									// Not waiting for the cache to be written, cause for a long wait HTTP clients may time out.
									// Proxying the request around the cache system, while it is being populated, triggered by another previous request.
									this._proxyRequest(incomingRequest, serverResponse);
									return;
								}

								await this._objOngoingCacheWrites[strCachedFilePath];
							}
							catch(error)
							{
								console.log(error);
								serverResponse.statusCode = 500;
								serverResponse.end();

								delete this._objOngoingCacheWrites[strCachedFilePath];

								return;
							}

							await this._renameTempToFinal(
								strCachedFilePath, 
								strSufixExtension, 
								serverResponse.getHeader("last-modified") ? new Date(serverResponse.getHeader("last-modified")).getTime() : 0, 
								parseInt(serverResponse.getHeader("content-length"), 10)
							);
							
							return;
						}
					}
				}

				// If internet is down,
				// or target HTTP server did not respond with with 200 success code for the HEAD request,
				// or some other error
				// then attempt to server the file from cache if it exists.
				if(
					(
						!bSkipStorageCache
						|| bKeepFlagAndFileExists
					)
					&& fs.existsSync(strCachedFilePath)
				)
				{
					await new Promise(async (fnResolve, fnReject) => {
						serverResponse.statusCode = 200;

						serverResponse.setHeader("content-type", "application/octet-stream");
						
						if(!cachedFileStats && fs.existsSync(strCachedFilePath))
						{
							cachedFileStats = fs.statSync(strCachedFilePath);
						}

						serverResponse.setHeader("content-length", cachedFileStats.size);
						serverResponse.setHeader("last-modified", (new Date(cachedFileStats.mtimeMs)).toUTCString());
						
						serverResponse.removeHeader("content-encoding");

						var rstream = fs.createReadStream(strCachedFilePath);
						const pipeStream = rstream.pipe(serverResponse);

						pipeStream.on(
							"error",
							(error) => {
								serverResponse.statusCode = 500;
								serverResponse.end();

								fnReject(error);
							}
						);

						pipeStream.on(
							"finish",
							() => {
								serverResponse.statusCode = 200;
								serverResponse.end();
								
								fnResolve();
							}
						);
					});

					return;
				}
			}
			catch(error)
			{
				console.error(error);

				try
				{
					serverResponse.statusCode = 500;
					serverResponse.write(error.message + "\r\n" + error.stack);
					serverResponse.end();

					return;
				}
				catch(errorWritingError)
				{
					console.error(errorWritingError);
				}
			}
		}

		this._proxyRequest(incomingRequest, serverResponse);
	}


	async _renameTempToFinal(strCachedFilePath, strSufixExtension, nUnixTimeLastModifiedMilliseconds, nContentLength)
	{
		let cachedFileStats = null;
		let tempFileStats = null;

		if (fs.existsSync(strCachedFilePath + strSufixExtension))
		{
			tempFileStats = fs.statSync(strCachedFilePath + strSufixExtension);
		}

		if (fs.existsSync(strCachedFilePath))
		{
			cachedFileStats = fs.statSync(strCachedFilePath);
		}

		if (
			cachedFileStats
			&& tempFileStats
			&& (
				cachedFileStats.size !== tempFileStats.size
				|| Math.floor(cachedFileStats.mtime.getTime() / 1000) < Math.floor(tempFileStats.mtime.getTime() / 1000)
			)
		)
		{
			try
			{
				fs.unlinkSync(strCachedFilePath);
			}
			catch(error)
			{
				if(error.code !== "ENOENT")
				{
					console.error(error);
				}
			}
		}

		if(
			!fs.existsSync(strCachedFilePath)
			&& tempFileStats
			&& nContentLength >= 0
			&& tempFileStats.size === nContentLength
		)
		{
			try
			{
				await fs.rename(strCachedFilePath + strSufixExtension, strCachedFilePath);
			}
			catch(error)
			{
				if(!fs.existsSync(strCachedFilePath))
				{
					try
					{
						await fs.rename(strCachedFilePath + strSufixExtension, strCachedFilePath);
					}
					catch(error)
					{
						console.error(error);

						if(!fs.existsSync(strCachedFilePath + strSufixExtension))
						{
							delete this._objOngoingCacheWrites[strCachedFilePath];
							return;
						}
					}
				}
			}
			//await fs.rename(strCachedFilePath + strSufixExtension, strCachedFilePath);

			// Somehow the write stream has some sort of delay in updating the modified date (OS thing?).
			// Writing the time later.
			await sleep(1000);
			if(nUnixTimeLastModifiedMilliseconds)
			{
				const nUnixTimeSeconds = Math.floor(nUnixTimeLastModifiedMilliseconds / 1000);
				
				if(fs.existsSync(strCachedFilePath))
				{
					try
					{
						await fs.utimes(strCachedFilePath, /*atime*/ nUnixTimeSeconds, /*mtime*/ nUnixTimeSeconds);
					}
					catch(error)
					{
						console.error(error);
					}
				}
			}
		}
		else
		{
			try
			{
				if(fs.existsSync(strCachedFilePath + strSufixExtension))
				{
					console.log(`Deleting garbage file ${strCachedFilePath + strSufixExtension}`);
					await fs.unlink(strCachedFilePath + strSufixExtension);
				}
			}
			catch(error)
			{
				if(error.code !== "ENOENT")
				{
					console.error(error);
				}
			}
		}

		delete this._objOngoingCacheWrites[strCachedFilePath];
	}


	/**
	 * @param {http.IncomingRequest} incomingRequest 
	 * @param {http.ServerResponse} serverResponse 
	 */
	_proxyRequest(incomingRequest, serverResponse)
	{
		console.log("Proxying " + incomingRequest.method + " " + incomingRequest.url);

		this._proxy.web(
			incomingRequest, 
			serverResponse, 
			{
				target: this._strTargetURLBasePath,
				
				// { '0': [Error: Hostname/IP doesn't match certificate's altnames] }
				// https://stackoverflow.com/a/45579167/584490
				changeOrigin: true
			},
			(error) => {
				console.error(error);

				serverResponse.statusCode = 500;
				serverResponse.write(error.message + "\r\n" + error.stack);
				serverResponse.end();
			}
		);
	}


	/**
	 * Scans the cache folder recursively and deletes files which respond with 404 on the repo.
	 * It then tries to retrieve /cache_prefetch.txt and prefetch or update the cached files.
	 * 
	 * @returns {undefined}
	 */
	async sync()
	{
		const arrFilePaths = await dir.promiseFiles(this._strCacheDirectoryRootPath);

		for(let strFilePathAbsolute of arrFilePaths)
		{
			let strFilePath = path.relative(this._strCacheDirectoryRootPath, strFilePathAbsolute);

			try
			{
				if(os.platform() === "win32")
				{
					strFilePath = strFilePath.replace(/\\/g, "/");
				}

				const fetchHeadResponse = await fetch(this._strTargetURLBasePath + strFilePath, {method: "HEAD"});
				fetchHeadResponse.text().catch(console.error);

				if(
					parseInt(fetchHeadResponse.status, 10) === 404

					// Asked by developers to be able to put files in the cache and not have them deleted if not found on the repo.
					&& path.extname(strFilePathAbsolute) !== ".keep"
					&& !fs.existsSync(strFilePathAbsolute + ".keep")
				)
				{
					console.log(`Deleting ${strFilePathAbsolute} because HTTP server returned 404 Not Found for ${this._strTargetURLBasePath + strFilePath}`);
					await fs.unlink(path.join(this._strCacheDirectoryRootPath, strFilePath));
				}
			}
			catch(error)
			{
				console.error(error);
			}
		}


		try
		{
			let strCachePrefetch;

			if(
				fs.existsSync(path.join(this._strCacheDirectoryRootPath, "cache_prefetch.txt"))
				&& fs.existsSync(path.join(this._strCacheDirectoryRootPath, "cache_prefetch.txt.keep"))
			)
			{
				strCachePrefetch = fs.readFileSync(path.join(this._strCacheDirectoryRootPath, "cache_prefetch.txt"), "utf8");
			}
			else
			{
				const fetchResponse = await fetch(this._strTargetURLBasePath /*already has a / suffix, see constructor*/ + "cache_prefetch.txt");
				if(fetchResponse.ok && parseInt(fetchResponse.status, 10) === 200)
				{
					strCachePrefetch = await (await fetchResponse.text());
					fs.writeFileSync(path.join(this._strCacheDirectoryRootPath, "cache_prefetch.txt"), strCachePrefetch);
				}
				else
				{
					if(fs.existsSync(path.join(this._strCacheDirectoryRootPath, "cache_prefetch.txt")))
					{
						strCachePrefetch = fs.readFileSync(path.join(this._strCacheDirectoryRootPath, "cache_prefetch.txt"), "utf8");
					}
					else
					{
						strCachePrefetch = "";
					}
				}
			}

			const arrPrefetchFilePaths = strCachePrefetch.replace(/^[ \t]+/gm, "").replace(/[ \t]+$/gm, "").trim().split(/\s+/gm);

			if(arrPrefetchFilePaths.length)
			{
				try
				{
					for(let strFilePath of arrPrefetchFilePaths)
					{
						if(strFilePath === "")
						{
							continue;
						}
						
						while(strFilePath.substr(0, 1) === "/")
						{
							strFilePath = strFilePath.substr(1);
						}

						const strCachedFilePath = path.join(this._strCacheDirectoryRootPath, strFilePath);

						let bNeedsUpdate = false;
						
						if(fs.existsSync(strCachedFilePath))
						{
							const cachedFileStats = await fs.stat(strCachedFilePath);

							const fetchHeadResponse = await fetch(this._strTargetURLBasePath + strFilePath, {method: "HEAD"});
							fetchHeadResponse.text().catch(console.error);

							if(
								fetchHeadResponse.ok 
								&& parseInt(fetchHeadResponse.status, 10) === 200 
								&& parseInt(fetchHeadResponse.headers.get("content-length"), 10) !== cachedFileStats.size
								&& !cachedFileStats.isDirectory()
							)
							{
								bNeedsUpdate = true;

								if(
									path.extname(strCachedFilePath) !== ".keep"
									&& !fs.existsSync(strCachedFilePath + ".keep")
								)
								{
									try
									{
										console.log(`Deleting ${strCachedFilePath} because HTTP server returned file size ${parseInt(fetchHeadResponse.headers.get("content-length"), 10)} and file has size ${cachedFileStats.size} ${this._strTargetURLBasePath + strFilePath}`);
										await fs.unlink(strCachedFilePath);
									}
									catch(error)
									{
										console.error(error);
									}
								}
							}
						}
						else
						{
							bNeedsUpdate = true;
						}

						// Asked by developers to be able to put files in the cache and not have them deleted if not found on the repo.
						if(
							path.extname(strCachedFilePath) === ".keep"
							|| fs.existsSync(strCachedFilePath + ".keep")
						)
						{
							bNeedsUpdate = false;
						}

						if(bNeedsUpdate)
						{
							const strSufixExtension = ".httpproxy.worker-" + (cluster.isMaster ? "master" : cluster.worker.id) + ".download";

							if(this._objOngoingCacheWrites[strCachedFilePath] === undefined)
							{
								this._objOngoingCacheWrites[strCachedFilePath] = new Promise(async (fnResolve, fnReject) => {
									console.log(`Prefetching or updating ${strCachedFilePath}.`);

									await HTTPProxyCache.mkdirRecursive(path.dirname(strCachedFilePath));

									const wstream = fs.createWriteStream(strCachedFilePath + strSufixExtension);

									wstream.on("error",	fnReject);

									const fetchResponse = await fetch(this._strTargetURLBasePath + strFilePath);

									wstream.on(
										"finish",
										async() => {
											try
											{
												await sleep(20);

												wstream.end();

												await this._renameTempToFinal(
													strCachedFilePath, 
													strSufixExtension, 
													fetchResponse.headers.get("last-modified") ? new Date(fetchResponse.headers.get("last-modified")).getTime() : 0, 
													parseInt(fetchResponse.headers.get("content-length"), 10)
												);
												
												fnResolve();
											}
											catch(error)
											{
												fnReject(error);
											}
										}
									);

									fetchResponse.body.pipe(wstream);
								});
							}

							try
							{
								await this._objOngoingCacheWrites[strCachedFilePath];
							}
							finally
							{
								delete this._objOngoingCacheWrites[strCachedFilePath];
							}
						}
					}
				}
				catch(error)
				{
					console.error(error);
				}
			}
		}
		catch(error)
		{
			console.error(error);
		}
	}


	/**
	 * @param {string} strDirectoryPath 
	 * 
	 * @returns {undefined}
	 */
	static async mkdirRecursive(strDirectoryPath)
	{
		let strPathSoFar = "";

		for(let strFolderName of strDirectoryPath.split(path.sep))
		{
			strPathSoFar += strFolderName + path.sep;
			
			if(!fs.existsSync(strPathSoFar))
			{
				try
				{
					await fs.mkdir(strPathSoFar);
				}
				catch(error)
				{
					if(error.code !== "EEXIST")
					{
						throw error;
					}
				}
			}
		}
	}
};
