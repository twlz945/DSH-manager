// Minimal stand-in for a DSH-like service: listens on a port until killed.
import http from 'node:http';

const port = Number(process.argv[2]);
const host = process.argv[3] ?? '127.0.0.1';

const server = http.createServer((req, res) => {
  res.statusCode = 200;
  res.end('ok');
});

server.listen(port, host, () => {
  process.stdout.write(`fake service listening on http://${host}:${port}\n`);
});

function bye() {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
