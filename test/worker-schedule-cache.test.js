const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { test } = require("node:test");

const airportCsv = [
  "ident,iata_code,name,municipality,iso_country,latitude_deg,longitude_deg",
  "KAAA,AAA,Test Airport,Test City,US,0,0"
].join("\n");

function createWorker(adsbResponse) {
  const source = fs.readFileSync(path.join(__dirname, "../src/worker.js"), "utf8")
    .replace("export default {", "globalThis.worker = {");
  const storedResponses = new Map();
  const cache = {
    async match(request) {
      return storedResponses.get(request.url)?.clone();
    },
    async put(request, response) {
      storedResponses.set(request.url, response.clone());
    }
  };
  let adsbRequests = 0;
  const context = {
    URL,
    Request,
    Response,
    caches: { default: cache },
    fetch: async url => {
      if (String(url).includes("airports.csv")) {
        return new Response(airportCsv, { status: 200 });
      }
      if (String(url).includes("api.adsb.lol")) {
        adsbRequests += 1;
        return adsbResponse();
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }
  };

  vm.runInNewContext(source, context);
  return {
    worker: context.worker,
    cache,
    get adsbRequests() { return adsbRequests; }
  };
}

function aircraftResponse() {
  return new Response(JSON.stringify({ ac: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

test("serves multiple schedule tabs from one shared edge snapshot", async () => {
  const app = createWorker(aircraftResponse);
  const env = {};
  const ctx = { waitUntil() {} };

  const allResponse = await app.worker.fetch(new Request("https://example.test/api/schedule/KAAA/all"), env, ctx);
  const arrivalResponse = await app.worker.fetch(new Request("https://example.test/api/schedule/KAAA/arrival"), env, ctx);

  assert.equal(allResponse.status, 200);
  assert.equal(arrivalResponse.status, 200);
  assert.equal(app.adsbRequests, 1);
});

test("uses a recent shared snapshot when ADS-B returns a rate limit", async () => {
  const app = createWorker(() => new Response("Rate limited", {
    status: 429,
    headers: { "Retry-After": "60" }
  }));
  const cacheKey = new Request("https://example.test/__cache/schedule/KAAA");
  await app.cache.put(cacheKey, new Response(JSON.stringify({
    fetchedAt: Date.now() - 180000,
    flights: [{ movementType: "arrival", flight: { number: "CACHED1" } }]
  }), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=600"
    }
  }));

  const response = await app.worker.fetch(
    new Request("https://example.test/api/schedule/KAAA/all"),
    {},
    { waitUntil() {} }
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.flights[0].flight.number, "CACHED1");
  assert.equal(app.adsbRequests, 1);
});
