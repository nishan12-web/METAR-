const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const METAR_API = "https://aviationweather.gov/api/data/metar";
const AVIATION_EDGE_API = "https://aviation-edge.com/v2/public/timetable";
const ADSB_LOL_API = "https://api.adsb.lol/v2/lat";
const ADSBDB_API = "https://api.adsbdb.com/v0/callsign";
const TILE_SERVER = "https://tile.openstreetmap.org";
const MAX_TILE_ZOOM = 19;

let airportCache = null;

function cleanIcao(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function cleanAirportQuery(value) {
  const encodedValue = String(value || "");
  let decodedValue = encodedValue;

  try {
    decodedValue = decodeURIComponent(encodedValue);
  } catch {
    // Keep malformed input routable so it can produce a normal not-found response.
  }

  return decodedValue.trim().replace(/\s+/g, " ");
}

function parseCsvLine(line) {
  const out = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      out.push(value);
      value = "";
    } else {
      value += char;
    }
  }

  out.push(value);
  return out;
}

async function loadAirports() {
  if (airportCache) return airportCache;

  const response = await fetch(AIRPORTS_CSV);
  if (!response.ok) throw new Error("Could not load airport database.");

  const csv = await response.text();
  const lines = csv.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift());
  const idx = Object.fromEntries(headers.map((header, index) => [header, index]));
  const airports = new Map();

  for (const line of lines) {
    const row = parseCsvLine(line);
    const ident = row[idx.ident];
    if (!ident || ident.length !== 4) continue;

    airports.set(ident.toUpperCase(), {
      icao: ident.toUpperCase(),
      iata: row[idx.iata_code] || "--",
      name: row[idx.name] || ident.toUpperCase(),
      city: row[idx.municipality] || "",
      country: row[idx.iso_country] || "",
      lat: row[idx.latitude_deg] || "",
      lon: row[idx.longitude_deg] || ""
    });
  }

  airportCache = airports;
  return airportCache;
}

async function getAirport(icao) {
  const airports = await loadAirports();
  return airports.get(icao) || null;
}

async function findAirport(query) {
  const airports = await loadAirports();
  const normalizedQuery = query.toLowerCase();
  const icao = cleanIcao(query);
  const exactAirport = airports.get(icao);
  if (exactAirport) return exactAirport;

  return [...airports.values()]
    .filter(airport =>
      [airport.name, airport.city, airport.iata].some(value =>
        value.toLowerCase().includes(normalizedQuery)
      )
    )
    .sort((first, second) => {
      const firstName = first.name.toLowerCase();
      const secondName = second.name.toLowerCase();
      return Number(!firstName.startsWith(normalizedQuery)) - Number(!secondName.startsWith(normalizedQuery));
    })[0] || null;
}

async function findAirports(query, limit = 8) {
  const airports = await loadAirports();
  const normalizedQuery = query.toLowerCase();
  return [...airports.values()]
    .filter(airport =>
      [airport.icao, airport.iata, airport.name, airport.city].some(value =>
        value.toLowerCase().includes(normalizedQuery)
      )
    )
    .sort((first, second) => {
      const firstValues = [first.icao, first.iata, first.name, first.city].map(value => value.toLowerCase());
      const secondValues = [second.icao, second.iata, second.name, second.city].map(value => value.toLowerCase());
      const firstRank = firstValues.findIndex(value => value.startsWith(normalizedQuery));
      const secondRank = secondValues.findIndex(value => value.startsWith(normalizedQuery));
      return (firstRank < 0 ? 4 : firstRank) - (secondRank < 0 ? 4 : secondRank);
    })
    .slice(0, limit);
}

async function getMetar(icao) {
  const url = `${METAR_API}?ids=${encodeURIComponent(icao)}&format=decoded`;
  const response = await fetch(url);
  if (!response.ok) throw new Error("Could not load METAR.");

  const decoded = await response.text();
  if (!decoded.trim()) throw new Error("No METAR found for this airport.");
  const rawMatch = decoded.match(/Text:\s*(.+)/);
  return {
    raw: rawMatch ? rawMatch[1].trim() : decoded.trim(),
    decoded: decoded.trim()
  };
}

async function getFreeTraffic(airport, type) {
  const scheduleUrl = new URL(`${ADSB_LOL_API}/${airport.lat}/lon/${airport.lon}/dist/50`);
  const response = await fetch(scheduleUrl);
  if (!response.ok) throw new Error("Could not load free live flight movements.");
  const data = await response.json();
  const flights = (data.ac || []).filter(flight => {
    const climbRate = Number(flight.baro_rate || 0);
    return type === "arrival" ? climbRate <= -100 : climbRate >= 100;
  });

  return Promise.all(flights.slice(0, 30).map(async flight => {
    const callsign = flight.flight?.trim() || flight.icao24 || "Unknown flight";
    let route = null;

    if (callsign !== "Unknown flight") {
      try {
        const routeResponse = await fetch(`${ADSBDB_API}/${encodeURIComponent(callsign)}`);
        if (routeResponse.ok) route = (await routeResponse.json()).response?.flightroute || null;
      } catch {
        route = null;
      }
    }

    const observedAt = new Date(Date.now() - Number(flight.seen_pos || flight.seen || 0) * 1000).toISOString();
    return {
      flight: { iataNumber: route?.callsign_iata || callsign, icaoNumber: route?.callsign_icao || callsign },
      airline: route?.airline || { name: "Airline unavailable" },
      departure: {
        iataCode: route?.origin?.iata_code || "Unknown",
        icaoCode: route?.origin?.icao_code || "",
        scheduledTime: null
      },
      arrival: {
        iataCode: route?.destination?.iata_code || airport.iata || airport.icao,
        icaoCode: route?.destination?.icao_code || airport.icao,
        scheduledTime: null
      },
      status: type === "arrival" ? "descending · live" : "climbing · live",
      observedAt,
      liveSource: "ADSB.lol + ADSBdb"
    };
  }));
}

async function getSchedule(airport, type, apiKey) {
  if (apiKey && airport.iata && airport.iata !== "--") {
    const scheduleUrl = new URL(AVIATION_EDGE_API);
    scheduleUrl.searchParams.set("key", apiKey);
    scheduleUrl.searchParams.set("iataCode", airport.iata);
    scheduleUrl.searchParams.set("type", type);

    try {
      const response = await fetch(scheduleUrl);
      const data = await response.json();
      if (response.ok && Array.isArray(data)) return data;
    } catch {
      // Use the free provider below when Aviation Edge is unavailable.
    }
  }

  return getFreeTraffic(airport, type);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // API: Get airport info
    if (pathname.startsWith("/api/airport/")) {
      const query = cleanAirportQuery(pathname.split("/").pop());

      try {
        const airport = await findAirport(query);
        if (!airport) {
          return new Response(JSON.stringify({ error: `No airport found for ${query}` }), {
            status: 404,
            headers: { 
              "Content-Type": "application/json; charset=utf-8",
              "Access-Control-Allow-Origin": "*"
            }
          });
        }
        return new Response(JSON.stringify({ airport }), {
          status: 200,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    // API: Search airports for autocomplete suggestions
    if (pathname === "/api/airports") {
      const query = cleanAirportQuery(url.searchParams.get("query"));
      if (query.length < 3) return new Response(JSON.stringify({ airports: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
      });

      try {
        const airports = await findAirports(query);
        return new Response(JSON.stringify({ airports }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // API: Get METAR data
    if (pathname.startsWith("/api/metar/")) {
      const icao = cleanIcao(pathname.split("/").pop());

      try {
        const metar = await getMetar(icao);
        return new Response(JSON.stringify(metar), {
          status: 200,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { 
            "Content-Type": "application/json; charset=utf-8",
            "Access-Control-Allow-Origin": "*"
          }
        });
      }
    }

    // API: Get airport arrivals or departures
    if (pathname.startsWith("/api/schedule/")) {
      const [, , , icaoCode, type] = pathname.split("/");
      const normalizedIcao = cleanIcao(icaoCode);
      if (!normalizedIcao || !["arrival", "departure"].includes(type)) {
        return new Response(JSON.stringify({ error: "Invalid schedule request." }), {
          status: 400,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }

      try {
        const airport = await getAirport(normalizedIcao);
        if (!airport) {
          return new Response(JSON.stringify({ error: "Airport not found." }), {
            status: 404,
            headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
          });
        }
        const flights = await getSchedule(airport, type, env.AVIATION_EDGE_API_KEY);
        return new Response(JSON.stringify({ flights }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*" }
        });
      }
    }

    // Proxy tiles
    if (pathname.startsWith("/tiles/")) {
      const parts = pathname.split("/");
      const z = parts[2];
      const x = parts[3];
      const file = parts[4];
      
      if (file && file.endsWith(".png")) {
        const y = file.replace(".png", "");
        const zNum = Number(z);
        const xNum = Number(x);
        const yNum = Number(y);

        if (
          Number.isInteger(zNum) && Number.isInteger(xNum) && Number.isInteger(yNum) &&
          zNum >= 0 && zNum <= MAX_TILE_ZOOM &&
          xNum >= 0 && yNum >= 0
        ) {
          const tileUrl = `${TILE_SERVER}/${z}/${x}/${y}.png`;
          try {
            const response = await fetch(tileUrl, {
              headers: {
                "User-Agent": "flightweather"
              }
            });

            if (!response.ok) {
              return new Response("Unable to load tile", { status: 502 });
            }

            return new Response(response.body, {
              status: 200,
              headers: {
                "Content-Type": "image/png",
                "Cache-Control": "public, max-age=3600"
              }
            });
          } catch (err) {
            return new Response("Tile proxy error", { status: 502 });
          }
        }
      }
    }

    // Serve static files from assets - be explicit about file types
    const hasExtension = /\.[a-zA-Z0-9]+$/.test(pathname);
    if (pathname === "/" || pathname === "/index.html" || hasExtension) {
      try {
        return await env.ASSETS.fetch(request);
      } catch (err) {
        // If assets fail, serve index for root
        if (pathname === "/" || pathname === "/index.html") {
          try {
            return await env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString()));
          } catch (e) {
            return new Response("Not found", { status: 404 });
          }
        }
        return new Response("Not found", { status: 404 });
      }
    }

    // Default to index.html for SPA routing
    try {
      return await env.ASSETS.fetch(new Request(new URL("/index.html", request.url).toString()));
    } catch (err) {
      return new Response("Not found", { status: 404 });
    }
  }
};
