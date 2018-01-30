const http = require("http");
const https = require("https");
const HTTPProxy = require("http-proxy");
const url = require("url");
const fs = require("fs-promise");
const path = require("path");
const sleep = require("sleep-promise");

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
				let bSkipCacheWrite = false;
				let bSkipStorageCache = false;

				const strCachedFilePath = path.join(this._strCacheDirectoryRootPath, objParsedURL.pathname);

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

				if(!bSkipCacheWrite)
				{
					try
					{
						var requestOptions = {
							method: "HEAD", 
							host: url.parse(this._strTargetURLBasePath).hostname, 
							port: objParsedURL.port ? objParsedURL.port : (objParsedURL.protocol === "https:" ? 443 : 80), 
							path: objParsedURL.path
						};

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
							_incomingMessageHEAD.statusCode < 200
							|| _incomingMessageHEAD.statusCode > 299
						)
						{
							bSkipCacheWrite = true;
						}
					}
					catch(error)
					{
						console.error(error);

						bSkipCacheWrite = true;
					}
				}

				bSkipCacheWrite = true;

				if(
					!bSkipCacheWrite
					&& _incomingMessageHEAD.headers["content-length"]
					&& _incomingMessageHEAD.headers["content-length"] >= this._nBytesMinimumFileSize
				)
				{
					serverResponse.headers = _incomingMessageHEAD.headers;

					if(
						!fs.existsSync(strCachedFilePath)
						|| (
							serverResponse.headers["content-length"]
							&& fs.statSync(strCachedFilePath).size !== parseInt(serverResponse.headers["content-length"], 10)
						)
						|| (
							// If the web server's last modified timestamp is earlier than the local copy, then the local copy's modified timestamp is useless.
							serverResponse.headers["last-modified"]
							&& Math.floor(fs.statSync(strCachedFilePath).mtime.getTime() / 1000) < Math.floor(new Date(serverResponse.headers["last-modified"]).getTime() / 1000)
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

						try
						{
							// Condition to avoid race condition.
							if(this._objOngoingCacheWrites[strCachedFilePath] === undefined)
							{
								this._objOngoingCacheWrites[strCachedFilePath] = new Promise(async (fnResolve, fnReject) => {
									//let nStreamsFinished = 0;

									const wstream = fs.createWriteStream(strCachedFilePath + ".httpproxy.download");

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

						await fs.rename(strCachedFilePath + ".httpproxy.download", strCachedFilePath);

						// Somehow the write stream has some sort of delay in updating the modified date (OS thing?).
						// Writing the time later.
						await sleep(1000);
						const nUnixTimeSeconds = Math.floor(new Date(serverResponse.headers["last-modified"]).getTime() / 1000);
						await fs.utimes(strCachedFilePath, nUnixTimeSeconds, nUnixTimeSeconds);

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
					&& await fs.exists(strCachedFilePath)
				)
				{
					await new Promise(async (fnResolve, fnReject) => {
						serverResponse.statusCode = 200;

						const objFileStats = await fs.stat(strCachedFilePath);

						serverResponse.headers = {};
						serverResponse.headers["content-type"] = "application/octet-stream";
						serverResponse.headers["content-length"] = objFileStats.size;
						serverResponse.headers["last-modified"] = (new Date(objFileStats.mtimeMs)).toUTCString();
						
						delete serverResponse.headers["content-encoding"];

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
