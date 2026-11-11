const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");
const { after, before, test } = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
let serverProcess;
let baseUrl;

async function findAvailablePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return port;
}

before(async () => {
  const port = await findAvailablePort();
  baseUrl = `http://127.0.0.1:${port}`;
  serverProcess = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: "ignore"
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Local server exited before starting (code ${serverProcess.exitCode}).`);
    }

    try {
      const response = await fetch(baseUrl);
      if (response.ok) return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  serverProcess.kill();
  throw new Error("Local server did not start in time.");
});

after(async () => {
  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exited = once(serverProcess, "exit");
  serverProcess.kill();
  await exited;
});

test("serves the main page with the map and credits entry point", async () => {
  const response = await fetch(baseUrl);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(html, /id="map"/);
  assert.match(html, /href="\/credits\.html"/);
});

test("serves the custom SVG browser-tab icon", async () => {
  const response = await fetch(`${baseUrl}/favicon.svg`);
  const svg = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(svg, /<svg\b/);
});

test("rejects an invalid airport code before requesting provider data", async () => {
  const response = await fetch(`${baseUrl}/api/briefing/x`);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, "Enter a valid four-character ICAO code.");
});

test("does not allow write methods", async () => {
  const response = await fetch(baseUrl, { method: "POST" });

  assert.equal(response.status, 405);
  assert.equal(await response.text(), "Method not allowed");
});
