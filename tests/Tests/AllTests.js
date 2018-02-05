const assert = require("assert");
const cluster = require("cluster");

const fetch = require("node-fetch");
const fs = require("fs-promise");
const path = require("path");
const os = require("os");

const WorkerEndpoint = require("../WorkersRPC/WorkerEndpoint");

module.exports =
class AllTests
{
	/**
	 * @param {string} strCacheDirectoryPath 
	 * @param {WorkersRPC.MasterEndpoint} masterEndpoint
	 */
	constructor(strCacheDirectoryPath, masterEndpoint)
	{
		this._strCacheDirectoryPath = strCacheDirectoryPath;
		this._masterEndpoint = masterEndpoint;

		this._strRootCachedURL = `http://${WorkerEndpoint.httpListenHostname}:${WorkerEndpoint.httpCachedProxyServerPort}`;

		Object.seal(this);
	}


	/**
	 * @returns {undefined}
	 */
	async runTests()
	{
		// @TODO: find a way to delete 200-OK.10MB-10seconds.bin during transfer.

		assert(cluster.isMaster, "Expecting cluster.isMaster to be true.");

		
		const strTestFile = path.join(this._strCacheDirectoryPath, "200-OK.10MB-10seconds.bin");

		assert(!fs.existsSync(strTestFile), `Was expecting ${strTestFile} NOT to exist`);
		await this.manyParallel200OKRequests();
		
		assert(fs.existsSync(strTestFile), `Was expecting ${strTestFile} to exist`);
		assert((await fs.stat(strTestFile)).size === WorkerEndpoint.minimumCacheableSizeBytes, `Was expecting ${strTestFile} to have a 10 MB size.`);


		// Once again with the file in the cache.
		await this.manyParallel200OKRequests();


		// Once again with the file in the cache with the static HTTP repo down.
		for(let mxKey in this._masterEndpoint.workerClients)
		{
			await this._masterEndpoint.workerClients[mxKey].client.setConnectionRefusedMode(true);
		}
		await this.manyParallel200OKRequests();
		for(let mxKey in this._masterEndpoint.workerClients)
		{
			await this._masterEndpoint.workerClients[mxKey].client.setConnectionRefusedMode(false);
		}
		
		
		const strNukeFilePath = path.join(this._strCacheDirectoryPath, "some-file-not-on-the-repo");
		assert(!fs.existsSync(strNukeFilePath), `Was expecting ${strNukeFilePath} NOT to exist`);
		fs.closeSync(fs.openSync(strNukeFilePath, "w"));
		assert(fs.existsSync(strNukeFilePath), `Was expecting ${strNukeFilePath} to exist`);
		await this.testValidHTTPResponse(await fetch(this._strRootCachedURL + "/some-file-not-on-the-repo"), 404);
		assert(!fs.existsSync(strNukeFilePath), `Was expecting ${strNukeFilePath} NOT to exist anymore.`);


		// Should be must faster than 10 seconds, it needs to come from the cache.
		await this.testValidHTTPResponse(await fetch(this._strRootCachedURL + "/200-OK.10MB-10seconds.bin?129831798792792"), 200);

		// The temporary download file must not persist in the cache folder.
		await this.testValidHTTPResponse(await fetch(this._strRootCachedURL + "/200-OK.1MB-1seconds-ConnectionReset.bin", 200, parseInt(WorkerEndpoint.minimumCacheableSizeBytes / 10, 10)));

		await this.testValidHTTPResponse(await fetch(this._strRootCachedURL + "/401-Unauthorized"), 401);

		await this.testValidHTTPResponse(await fetch(this._strRootCachedURL + "/403-Forbidden"), 403);

		await this.testValidHTTPResponse(await fetch(this._strRootCachedURL + "/500-InternalServerError"), 500);

		try
		{
			await fetch(this._strRootCachedURL + "/GatewayConnectionRefused");
		}
		catch(error)
		{
			if(error.code !== "ECONNREFUSED")
			{
				console.error(error);
				throw new Error("Was expecting error code ECONNREFUSED");
			}
		}

		await this.testValidHTTPResponse(await fetch(this._strRootCachedURL + "/404"), 404);

		console.log("[" + process.pid + "] Done!!!");
		this._masterEndpoint.gracefulExit(/*incomingRequest*/ undefined);
	}


	/**
	 * @returns {undefined}
	 */
	async manyParallel200OKRequests()
	{
		const arrManyParallelFetchPromises = [];
		for(let i = 0; i < os.cpus().length * 10; i++)
		{
			arrManyParallelFetchPromises.push(fetch(this._strRootCachedURL + "/200-OK.10MB-10seconds.bin?i=" + i));
		}
		console.log("Launched " + arrManyParallelFetchPromises.length + " requests.");
		await Promise.all(arrManyParallelFetchPromises);
		
		const arrPromisesBufferBody = []; 

		for(let i = 0; i < arrManyParallelFetchPromises.length; i++)
		{
			if(!(await arrManyParallelFetchPromises[i]).ok || parseInt((await arrManyParallelFetchPromises[i]).status, 10) !== 200)
			{
				throw new Error("Request failed, status code " + JSON.stringify((await arrManyParallelFetchPromises[i]).status));
			}

			arrPromisesBufferBody.push((await arrManyParallelFetchPromises[i]).buffer());
		}

		await Promise.all(arrPromisesBufferBody);

		for(let i = 0; i < arrPromisesBufferBody.length; i++)
		{
			assert((await arrPromisesBufferBody[i]).length === WorkerEndpoint.minimumCacheableSizeBytes, "Body was suposed to be 10 MB");
		}

		console.log("Finished the " + arrManyParallelFetchPromises.length + " requests.");
	}


	/**
	 * @param {fetch.Response} fetchResponse 
	 * @param {number} nExpectedHTTPStatus 
	 * @param {number} nExpectedFileSize = -1
	 */
	async testValidHTTPResponse(fetchResponse, nExpectedHTTPStatus, nExpectedFileSize = -1)
	{
		if(nExpectedHTTPStatus && parseInt(fetchResponse.status, 10) !== nExpectedHTTPStatus)
		{
			throw new Error(`Unexpected HTTP status ${parseInt(fetchResponse.status, 10)}, was expecting ${nExpectedHTTPStatus}.`);
		}

		const nBodySize = (await fetchResponse.buffer()).size;

		if(nExpectedFileSize >= 0 && nExpectedFileSize !== nBodySize)
		{
			throw new Error(`Unexpected body size ${nBodySize} bytes, was expecting ${nExpectedFileSize} bytes`);
		}
	}
};
