const cluster = require("cluster");

const tmp = require("tmp");

const WorkersRPC = require("./WorkersRPC");

process.on(
	"unhandledRejection", 
	(reason, promise) => 
	{
		console.log("[" + process.pid + "] Unhandled Rejection at: Promise", promise, "reason", reason);
		
		process.exit(1);
	}
);

process.on(
	"uncaughtException",
	(error) => {
		console.log("[" + process.pid + "] Unhandled exception.");
		console.error(error);

		process.exit(1);
	}
);

(
	async () =>
	{
		if(cluster.isMaster)
		{
			// Setup static files directory for the root HTTP server
			// and a separate empty static files directory for the being tested proxy cached HTTP server.
			const strCacheDirectoryPath = tmp.dirSync().name;

			this.masterEndpoint = new WorkersRPC.MasterEndpoint(strCacheDirectoryPath);
			await this.masterEndpoint.start();
		}
		else
		{
			this.workerEndpoint = new WorkersRPC.WorkerEndpoint();
			await this.workerEndpoint.start();
		}
	}
)();
