const fs = require("fs");
const JSON5 = require("json5");
const { UDPClient } = require("dns2");
const levelup = require("levelup");
const leveldown = require("leveldown");
const CacheableLookup = require("cacheable-lookup");
const lookup = new CacheableLookup();
const config = JSON5.parse(fs.readFileSync("./config.json5"));
lookup.servers = config.nameservers;
let mainPortal = config.siaPortals[0];
let skylinkCache = levelup(leveldown("./record_cache"));
(async () => {
	const dns2 = require("dns2");

	const fetch = (await import("node-fetch")).default;

	const { Packet } = dns2;

	setInterval(async () => {
		mainPortal = await getAlivePortal();
	}, 100000);
	const rootResolve = UDPClient({
		dns: config.rootNameserver.split(":")[0],
		port: parseInt(config.rootNameserver.split(":")[1]),
	});

	const server = dns2.createServer({
		udp: true,
		handle: async (request, send, rinfo) => {
			const response = Packet.createResponseFromRequest(request);
			const [question] = request.questions;
			const { name } = question;

			let blockchainRecords = await rootResolve(name);

			let recordsLink = blockchainRecords.authorities.find(
				(record) =>
					record &&
					record.ns &&
					(record.ns.endsWith("._skyname") ||
						record.ns.endsWith(".skyname.xyz"))
			);

			if (!recordsLink || !recordsLink.ns) {
				return send(response);
			} else {
				recordsLink = recordsLink.ns;
			}

			let records = await fetchSia("sia://" + recordsLink.split(".")[0]);

			if (!records || (typeof records != "object" && Array.isArray(records))) {
				return send(response);
			} else {
				records.forEach((record) => {
					if (
						!record.type ||
						!Object.keys(Packet.TYPE).includes(record.type) ||
						!record.ttl
					) {
						return send(response);
					}
					response.answers.push({
						...record,
						name: (record.name + "." + name)
							.split(".")
							.join(" ")
							.trim()
							.split(" ")
							.join("."), //trim dots if no subdomain provided
						type: Packet.TYPE[record.type],
						class: Packet.CLASS.IN,
					});
				});
			}

			send(response);
		},
	});

	server.on("request", (request, response, rinfo) => {});

	server.on("close", () => {
		console.log("server closed");
	});

	server.listen({
		udp: 53,
	});

	// eventually
})();

async function getAlivePortal() {
	const fetch = (await import("node-fetch")).default;
	return new Promise(async (resolve, reject) => {
		let found = false;
		config.siaPortals.forEach((portal, index) => {
			setTimeout(async () => {
				if (found) {
					return;
				} else {
					try {
						let resource = await (
							await fetch(
								portal + "AACo6KGldohjcBP39JUxFEWWMwiTTV_wQfrd5z28gUoYxA",
								{
									headers: {
										"User-agent": "Sia-Agent",
									},
								}
							)
						).text();
						if (resource == "test") {
							found = true;
							resolve(portal);
						} else {
							return;
						}
					} catch (e) {
						return;
					}
				}
			}, index * 200);
		});
	});
}
async function fetchSia(siaLink) {
	let cached = await skylinkCache.get(siaLink).catch((e) => {
		if (e.notFound) {
			return;
		}
	});

	let resolverSkylink;
	if (cached) {
		return JSON.parse(cached.toString());
	}
	const fetch = (await import("node-fetch")).default;
	let resource;
	try {
		let fileMeta = await fetch(mainPortal + siaLink.slice("sia://".length), {
			headers: { "User-agent": "Sia-Agent" },
		});
		if (siaLink == "sia://" + fileMeta.headers.get("skynet-skylink")) {
			resource = fileMeta;
			resolverSkylink = false;
			if (
				resource.headers.get("content-length") > 20480 ||
				resource.headers.get("content-type") !== "application/json"
			) {
				return null;
			} else {
				let data = await resource.json();

				if (!resolverSkylink) {
					skylinkCache.put(siaLink, JSON.stringify(data));
				}
				return data;
			}
		} else {
			siaLink = "sia://" + fileMeta.headers.get("skynet-skylink");
			resource = await fetchSia(siaLink);
			resolverSkylink = true;
			return resource;
		}
	} catch (error) {
		return null;
	}
}
