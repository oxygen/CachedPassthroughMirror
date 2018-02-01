const assert = require("assert");
const http = require("http");
const https = require("https");
const HTTPProxy = require("http-proxy");
const url = require("url");
const fs = require("fs-promise");
const path = require("path");
const sleep = require("sleep-promise");
const cluster = require("cluster");

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
	}


	/**
	 * @param {http.IncomingRequest} incomingRequest 
	 * @param {http.ServerResponse} serverResponse 
	 */
	async processHTTPRequest(incomingRequest, serverResponse)
	{
		const objParsedURL = url.parse(incomingRequest.url);

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
				let bCachedFileExists = fs.existsSync(strCachedFilePath);
				let cachedFileStats = null;

				if(bCachedFileExists)
				{
					cachedFileStats = await fs.stat(strCachedFilePath);
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


				let _incomingMessageHEAD = null;
				let requestOptions = null;

				if(!bSkipCacheWrite)
				{
					try
					{
						assert(this._objParsedTargetURL.path.substr(-1) === "/", "Path root sandbox must end in /");

						requestOptions = {
							method: "HEAD", 
							host: this._objParsedTargetURL.hostname, 
							port: this._objParsedTargetURL.port ? this._objParsedTargetURL.port : undefined, 
							path: this._objParsedTargetURL.path /*ends in /, see constructor() */ + objParsedURL.path.substr(1),
							headers: {}
						};

						for(let strHeaderName of ["range", "content-length", "user-agent", "authorization", "proxy-authorization", "www-authenticate", "accept", "accept-language", "cache-control", "cookie", "referer"])
						{
							if(incomingRequest.headers[strHeaderName] !== undefined)
							{
								requestOptions.headers[strHeaderName] = incomingRequest.headers[strHeaderName];
							}
						}

						// Obtain headers with a HEAD request.
						// Content-length is used to determine if the file is big enough to warrant caching.
						// Last-modified is used to determine if the file has changed in the meantime.
						_incomingMessageHEAD = await new Promise((fnResolve, fnReject) => {
							const req = (objParsedURL.protocol === "https:" ? https : http).request(requestOptions, function(_incomingMessageHEAD) {
								fnResolve(_incomingMessageHEAD);
							});

							req.on("error", fnReject);

							req.end();
						});
						

						if(
							parseInt(_incomingMessageHEAD.statusCode, 10) === 404
							
							// check again, don't use bCachedFileExists
							&& fs.existsSync(strCachedFilePath)
							&& !cachedFileStats.isDirectory()
						)
						{
							console.error("HEAD request status code " + JSON.stringify(_incomingMessageHEAD.statusCode) + ", deleting existing cached file.");
							fs.unlink(strCachedFilePath).catch(console.error);
						}
						
						if(
							_incomingMessageHEAD.statusCode < 200
							|| _incomingMessageHEAD.statusCode > 299
						)
						{
							console.error("HEAD request status code " + JSON.stringify(_incomingMessageHEAD.statusCode) + ", skipping cache write.");
							bSkipCacheWrite = true;
						}
					}
					catch(error)
					{
						console.error(error);

						console.error("HEAD request failed with error.");
						console.error(error);
						bSkipCacheWrite = true;
					}
				}

				if(
					!bSkipCacheWrite
					&& _incomingMessageHEAD.headers["content-length"]
					&& _incomingMessageHEAD.headers["content-length"] >= this._nBytesMinimumFileSize
				)
				{
					for(let strHeaderName in _incomingMessageHEAD.headers)
					{
						serverResponse.setHeader(strHeaderName, _incomingMessageHEAD.headers[strHeaderName]);
					}

					if(
						// Check again, don't use bCachedFileExists
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

						requestOptions.method = "GET";

						// Synchronous mode to almost guarantee no concurrency in creating the missing directories.
						let strPathSoFar = "";

						for(let strFolderName of path.dirname(strCachedFilePath).split(path.sep))
						{
							strPathSoFar += strFolderName + path.sep;
							
							if(!fs.existsSync(strPathSoFar))
							{
								fs.mkdirSync(strPathSoFar);
							}
						}

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
									
									wstream.on(
										"finish", 
										async () => {
											//if(++nStreamsFinished >= 2)
											//{
												//fnResolve();
											//}
										}
									);


									serverResponse.on("error", fnReject);
									serverResponse.on("close", () => {
										fnReject(new Error("Connection closed before sending the whole response."));
									});

									serverResponse.on(
										"finish", 
										async () => {
											serverResponse.statusCode = 200;
											serverResponse.end();

											// The 'finish' event is never fired on wstream for some reason.
											// Forcibly calling wstream.end() will fire the 'finish' event... (uselessly).
											await sleep(20);
											wstream.end();

											//if(++nStreamsFinished >= 2)
											//{
												//fnResolve();
											//}
											fnResolve();
										}
									);


									const req = http.request(requestOptions, function(_incomingMessage) {
										stream.copy(serverResponse, wstream);
										_incomingMessage.pipe(serverResponse);
									});
									
									req.on("error", fnReject);

									req.end();
								});
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

						// Check again, don't use bCachedFileExists.
						if(!fs.existsSync(strCachedFilePath))
						{
							try
							{
								fs.renameSync(strCachedFilePath + strSufixExtension, strCachedFilePath);
							}
							catch(error)
							{
								console.error(error);
							}
							//await fs.rename(strCachedFilePath + strSufixExtension, strCachedFilePath);

							cachedFileStats = await fs.stat(strCachedFilePath);

							// Somehow the write stream has some sort of delay in updating the modified date (OS thing?).
							// Writing the time later.
							await sleep(1000);
							const nUnixTimeSeconds = Math.floor(new Date(serverResponse.getHeader("last-modified")).getTime() / 1000);
							await fs.utimes(strCachedFilePath, nUnixTimeSeconds, nUnixTimeSeconds);
						}
						else
						{
							try
							{
								fs.unlinkSync(strCachedFilePath + strSufixExtension);
							}
							catch(error)
							{
								console.error(error);
							}
						}

						delete this._objOngoingCacheWrites[strCachedFilePath];
						
						return;
					}
				}

				// If internet is down,
				// or target HTTP server did not respond with with 200 success code for the HEAD request,
				// or some other error
				// then attempt to server the file from cache if it exists.
				if(
					!bSkipStorageCache
					
					// check again, don't use bCachedFileExists
					&& fs.existsSync(strCachedFilePath)
				)
				{
					await new Promise(async (fnResolve, fnReject) => {
						serverResponse.statusCode = 200;

						serverResponse.setHeader("content-type", "application/octet-stream");
						
						cachedFileStats = await fs.stat(strCachedFilePath);

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
};
