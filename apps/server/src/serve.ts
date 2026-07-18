import { getLogger } from "@logtape/logtape";

import { env } from "./env";
import { app } from "./index";

const { NODE_ENV, PORT } = env;

getLogger("api-server").info("Starting server", {
  port: PORT,
  environment: NODE_ENV,
});

Deno.serve({ port: PORT }, app.fetch);
