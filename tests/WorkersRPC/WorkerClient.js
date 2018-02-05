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
};
