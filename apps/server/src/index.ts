import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const { app, workspace } = await buildApp(config);

await app.listen({ host: config.host, port: config.port });

console.log(`
  Thư mục làm việc: ${workspace.root}
  Mở trong trình duyệt: ${config.openUrl}/?token=${config.token}
`);

async function shutdown() {
  await app.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
