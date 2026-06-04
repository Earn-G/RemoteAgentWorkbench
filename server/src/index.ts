import "dotenv/config";
import { buildApp } from "./app.js";
import { config } from "./config.js";

const app = await buildApp();

try {
  await app.listen({
    host: config.host,
    port: config.port
  });
  app.log.info(`RemoteAgentWorkbench server listening at http://${config.host}:${config.port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}
