#!/usr/bin/env node

export * from "..";

import commander from "commander";
import exitHook from "exit-hook";

import main from "..";

async function start(): Promise<void> {
  const program = new commander.Command();

  program.option("--level <level>", "logging level", Number, 3);
  program.option("--port <port>", "port to listen", Number, 3000);
  program.option("--host <host>", "host to listen", String, "0.0.0.0");
  program.option("--hooks <path>", "hooks path", String, "hooks");
  program.option("--logs <path>", "logs path", String, "logs");
  program.option("--no-history", "disable the history plugin");
  program.option("--no-health", "disable the health plugin");

  program.parse(process.argv);

  const close = await main({
    logger: {
      level: program.level,
    },
    paths: {
      hooks: program.hooks,
      logs: program.logs,
    },
    plugins: {
      health: program.health,
      history: program.history,
    },
    server: {
      port: program.port,
      host: program.host,
    },
  });

  exitHook(close);
}

if (require.main === module) {
  start();
}
