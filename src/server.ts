import { buildApp } from "./app.js";
import { environment } from "./config/env.js";

const app = await buildApp();

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void app.close();
  });
}
