const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = process.env.PORT || 4173;
const AIRPORTS_CSV = "https://davidmegginson.github.io/ourairports-data/airports.csv";
const METAR_API = "https://aviationweather.gov/api/data/metar";

let airportCache = null;

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function cleanIcao(value) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
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

async function getMetar(icao) {
  const url = `${METAR_API}?ids=${encodeURIComponent(icao)}&format=decoded`;
  const response = await fetch(url);
  const decoded = await response.text();

  if (!response.ok) throw new Error("Could not load METAR.");

  const rawMatch = decoded.match(/Text:\s*(.+)/);
  return {
    raw: rawMatch ? rawMatch[1].trim() : decoded.trim(),
    decoded: decoded.trim()
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/") {
    const htmlPath = path.join(__dirname, "index.html");
    fs.readFile(htmlPath, (err, data) => {
      if (err) {
        send(res, 500, "Could not load index.html");
        return;
      }
      send(res, 200, data, "text/html; charset=utf-8");
    });
    return;
  }

  if (url.pathname.startsWith("/api/airport/")) {
    const icao = cleanIcao(url.pathname.split("/").pop());

    try {
      const airport = await getAirport(icao);
      if (!airport) {
        send(res, 404, JSON.stringify({ error: `No airport found for ${icao}` }), "application/json; charset=utf-8");
        return;
      }
      send(res, 200, JSON.stringify({ airport }), "application/json; charset=utf-8");
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
    }
    return;
  }

  if (url.pathname.startsWith("/api/metar/")) {
    const icao = cleanIcao(url.pathname.split("/").pop());

    try {
      const metar = await getMetar(icao);
      send(res, 200, JSON.stringify(metar), "application/json; charset=utf-8");
    } catch (err) {
      send(res, 500, JSON.stringify({ error: err.message }), "application/json; charset=utf-8");
    }
    return;
  }

  send(res, 404, "Not found");
});

server.listen(PORT, () => {
  console.log(`Open http://localhost:${PORT}`);
});
