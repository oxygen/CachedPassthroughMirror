const cluster = require("cluster");

const JSONRPC = require("jsonrpc-bidirectional");
const sleep = require("sleep-promise");

const AllTests = require("../Tests/AllTests");

const WorkerClient = require("./WorkerClient");

module.exports = 
class MasterEndpoint extends JSONRPC.NodeClusterBase.MasterEndpoint
{
	/**
	 * @param {string} strCacheDirectoryPath
	 */
	constructor(strCacheDirectoryPath)
	{
		super(/*classReverseCallsClient*/ WorkerClient);

		this._strCacheDirectoryPath = strCacheDirectoryPath;
		console.log("Cache directory path: " + this._strCacheDirectoryPath);

		this._nMaxWorkersCount = 2;

		this._promiseRunningTests = null;
	}


	/**
	 * @override
	 * 
	 * @param {undefined} incomingRequest
	 */
	async _startServices(incomingRequest)
	{
		await super._startServices(incomingRequest);
	}


	/**
	 * @override
	 * 
	 * @param {undefined} incomingRequest
	 */
	async _stopServices(incomingRequest)
	{
		await super._stopServices(incomingRequest);
	}


	/**
	 * @param {JSONRPC.IncomingRequest} incomingRequest 
	 * 
	 * @returns {string}
	 */
	async cacheDirectoryPath(incomingRequest)
	{
		return this._strCacheDirectoryPath;
	}


	/**
	 * Override this method to start calling into workers as soon as the first one is ready.
	 * 
	 * Signals a worker's JSONRPC endpoint is ready to receive calls.
	 * 
	 * @param {JSONRPC.IncomingRequest} incomingRequest
	 * @param {number} nWorkerID
	 */
	async workerServicesReady(incomingRequest, nWorkerID)
	{
		await super.workerServicesReady(incomingRequest, nWorkerID);

		if(this._promiseRunningTests === null)
		{
			await sleep(5000);
			for(let i = this.workerClients.length - 1; i >= 0; i--)
			{
				if(!this.workerClients[i].ready)
				{
					console.log("Waiting for all workers to be ready to properly test for process concurency.");
					return;
				}
			}

			if(this._promiseRunningTests === null)
			{
				cluster.on(
					"exit", 
					(worker, nExitCode, nKillSignal) => {
						if(nExitCode !== 0)
						{
							console.error(`One of the workers has exited with code ${nExitCode} and kill signal ${nKillSignal}. Testing failed.`);
							process.exit(1);
						}
					}
				);
				
				this._promiseRunningTests = new AllTests(this._strCacheDirectoryPath, this).runTests(this._strCacheDirectoryPath, this);
			}
		}
	}
};
