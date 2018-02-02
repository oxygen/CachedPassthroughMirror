const assert = require("assert");
const cluster = require("cluster");

const fetch = require("node-fetch");

const HTTPProxyCache = require("../..");

const WorkerEndpoint = require("../WorkersRPC/WorkerEndpoint");

module.exports =
class AllTests
{
	/**
	 * @param {string} strCacheDirectoryPath 
	 */
	constructor(strCacheDirectoryPath)
	{
		this._strCacheDirectoryPath = strCacheDirectoryPath;

		Object.seal(this);
	}


	/**
	 * @returns {undefined}
	 */
	async runTests()
	{
		assert(cluster.isMaster, "Expecting cluster.isMaster to be true.");

		const strRootCachedURL = `http://${WorkerEndpoint.httpListenHostname}:${WorkerEndpoint.httpCachedProxyServerPort}`;

		// @TODO:

		// TODO: check returned status, the expected files exist in this._strCacheDirectoryPath and is of exactly 10MB.
		await fetch(strRootCachedURL + "/200-OK.10MB-10seconds.bin");
		//assert(fs.fileExists());
		
		// put some file in this._strCacheDirectoryPath by hand.
		await fetch(strRootCachedURL + "/some-file-not-on-the-repo");
		// it needs to be gone from the directory now.

		// Should be must faster than 10 seconds, it needs to come from the cache.
		await fetch(strRootCachedURL + "/200-OK.10MB-10seconds.bin?129831798792792");

		// The temporary download file must not persist in the cache folder.
		await fetch(strRootCachedURL + "/200-OK.5MB-5seconds-ConnectionReset.bin");

		// Must not crash
		await fetch(strRootCachedURL + "/401-Unauthorized");

		// Must not crash
		await fetch(strRootCachedURL + "/403-Forbidden");

		// Must not crash
		await fetch(strRootCachedURL + "/500-InternalServerError");

		// Must not crash
		await fetch(strRootCachedURL + "/GatewayConnectionRefused");

		// Must not crash
		await fetch(strRootCachedURL + "/404");
	}
};
