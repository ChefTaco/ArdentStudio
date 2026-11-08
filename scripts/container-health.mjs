// Container health check: the liveness route on the loopback listener.
import http from 'node:http';

const port = Number(process.env.ARDENT_STUDIO_PORT ?? '8097');
if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(1);
const request = http.get({ host: '127.0.0.1', port, path: '/api/ardentstudio/v1/health/live', timeout: 3000 }, response => {
  response.resume();
  process.exitCode = response.statusCode === 200 ? 0 : 1;
});
request.on('timeout', () => request.destroy());
request.on('error', () => { process.exitCode = 1; });
