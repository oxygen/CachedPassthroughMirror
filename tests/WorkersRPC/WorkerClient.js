const JSONRPC = require("jsonrpc-bidirectional");


module.exports = 
class WorkerClient extends JSONRPC.NodeClusterBase.WorkerClient
{
	/**
	 * @param {boolean} bEnabled
	 * 
	 * @returns {undefined}
	 */
	async setConnectionRefusedMode(bEnabled)
	{
		return this.rpc("setConnectionRefusedMode", [...arguments]);
	}


	/**
	 * @returns {undefined}
	 */
	async sync()
	{
		return this.rpc("sync", [...arguments]);
	}


	/**
	 * @returns {undefined}
	 */
	async deletePrefetchTxt()
	{
		return this.rpc("deletePrefetchTxt", [...arguments]);
	}
};
