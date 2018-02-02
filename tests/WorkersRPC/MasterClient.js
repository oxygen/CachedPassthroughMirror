const JSONRPC = require("jsonrpc-bidirectional");


module.exports = 
class MasterClient extends JSONRPC.NodeClusterBase.MasterClient
{
	/**
	 * @returns {string}
	 */
	async cacheDirectoryPath()
	{
		return this.rpc("cacheDirectoryPath", [...arguments]);
	}
};
