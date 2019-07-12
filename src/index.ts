import consola, { Consola } from "consola";
import Emittery from "emittery";
import execa, { ExecaChildProcess } from "execa";
import fastify, { FastifyInstance, FastifyRequest } from "fastify";
import fs from "fs";
import loadJsonFile from "load-json-file";
import locatePath from "locate-path";
import makeDir from "make-dir";
import path from "path";
import pupa from "pupa";
import sift, { Query } from "sift";
import stream from "stream";

export interface MainOptions {
  logger: {
    level: number;
  };
  paths: {
    hooks: string;
    logs: string;
  };
  plugins: {
    health: boolean;
    history: boolean;
  };
  server: {
    host: string;
    port: number;
  };
}

export interface HookRules {
  body?: Query<FastifyRequest["body"]>;
  headers?: Query<FastifyRequest["headers"]>;
  hostname?: Query<FastifyRequest["hostname"]>;
  ip?: Query<FastifyRequest["ip"]>;
  method?: Query<FastifyRequest["req"]["method"]>;
  query?: Query<FastifyRequest["query"]>;
  url?: Query<FastifyRequest["req"]["url"]>;
}

export interface HookResponse {
  statusCode?: number;
  contentType?: string;
  headers?: Record<string, unknown>;
  body?: unknown;
}

export interface HookEvents {
  error?: string;
  exit?: string;
  run?: string;
}

export interface Hook {
  command: string;
  rules?: HookRules;
  workingDirectory?: string;
  shell?: boolean | string;
  response?: HookResponse;
  events?: HookEvents;
}

export interface PluginContext {
  events: Emittery;
  hooksPath: string;
  hookProcesses: Map<string, ExecaChildProcess>;
  logsPath: string;
  mainLogger: Consola;
  options: MainOptions;
  server: FastifyInstance;
}

export interface Plugin {
  readonly name: string;
  readonly version: string;
  setup(options: PluginContext): void | Promise<void>;
}

function getRulesQuery(rules: HookRules): Query<Record<string, unknown>> {
  const result = {};

  for (const fieldName in rules) {
    const fieldRules = rules[fieldName];

    if (typeof fieldRules === "object") {
      for (const key in fieldRules) {
        result[`${fieldName}.${key}`] = fieldRules[key];
      }

      continue;
    }

    result[fieldName] = fieldRules;
  }

  return result;
}

async function resolveHookPath(hooksPath: string, hookName: string): Promise<string> {
  const paths = [
    path.join(hooksPath, `${hookName}/index.json`),
    path.join(hooksPath, `${hookName}/hook.json`),
    path.join(hooksPath, `${hookName}.json`),
  ];

  return locatePath(paths);
}

export function plugin(
  name: string,
  setup: (context: PluginContext) => void | Promise<void>,
): Plugin {
  return {
    version: "1",
    setup,
    name,
  };
}

export default async function main(options: MainOptions): Promise<() => Promise<void>> {
  const mainLogger = consola.create(options.logger);
  const server = fastify();

  const hooksPath = await makeDir(options.paths.hooks);
  const logsPath = await makeDir(options.paths.logs);

  const events = new Emittery();
  const plugins = new Set<PromiseLike<Plugin> | Plugin>();
  const hookProcesses = new Map<string, ExecaChildProcess>();

  if (options.plugins.health) {
    plugins.add(import("./plugins/health"));
  }

  if (options.plugins.history) {
    plugins.add(import("./plugins/history"));
  }

  server.all(
    "/hooks/*",
    async (request, reply): Promise<void> => {
      const hookName = request.params["*"];
      const hookLogger = mainLogger.withTag(hookName);

      const hookPath = await resolveHookPath(hooksPath, hookName);

      if (!hookPath) {
        return reply.callNotFound();
      }

      const hook = await loadJsonFile<Hook>(hookPath);

      if (hook.rules) {
        const rulesQuery = getRulesQuery(hook.rules);
        const isValid = sift(rulesQuery);

        const data = {
          body: request.body,
          headers: request.headers,
          hostname: request.hostname,
          ip: request.ip,
          method: request.raw.method,
          query: request.query,
          url: request.raw.url,
        };

        if (!isValid(data)) {
          return reply.callNotFound();
        }
      }

      const hookProcess = hookProcesses.get(hookName);

      if (hookProcess) {
        hookProcess.cancel();
      }

      const runCommand = (
        command: string,
        data: unknown,
        options?: execa.Options<string>,
      ): ExecaChildProcess => {
        const workingDirectory = hook.workingDirectory ?? path.dirname(hookPath);
        const formattedCommand = pupa(command, data);

        return execa.command(formattedCommand, {
          cwd: workingDirectory,
          shell: hook.shell,
          stdin: "inherit",
          buffer: false,
          all: true,
          ...options,
        });
      };

      const callEvent = (eventName: string, data: unknown): void => {
        const eventCommand = hook.events && hook.events[eventName];

        if (eventCommand) {
          runCommand(eventCommand, data, {
            detached: true,
          });
        }

        events.emit(`hook:${eventName}`, data);
      };

      const logDirPath = await makeDir(path.join(logsPath, hookName));
      const logFilePath = path.join(logDirPath, `${Date.now()}.log`);
      const logWriteStream = fs.createWriteStream(logFilePath, {
        flags: "a",
      });

      const childProcess = runCommand(hook.command, request);

      hookLogger.start("Running command...");
      hookProcesses.set(hookName, childProcess);

      callEvent("run", {
        childProcess,
        hookName,
      });

      stream.pipeline(childProcess.all, logWriteStream, (): void => {
        hookProcesses.delete(hookName);
      });

      childProcess
        .then((result): void => {
          hookLogger.info("Command exitted with code %d", result.exitCode);

          callEvent("exit", {
            hookName,
            result,
          });
        })
        .catch((error): void => {
          hookLogger.error(error);

          callEvent("error", {
            error,
            hookName,
          });
        });

      if (hook.response) {
        if (hook.response.statusCode) {
          reply.status(hook.response.statusCode);
        }

        if (hook.response.contentType) {
          reply.type(hook.response.contentType);
        }

        if (hook.response.headers) {
          reply.headers(hook.response.headers);
        }
      }

      reply.send(hook.response && hook.response.body);
    },
  );

  for await (const plugin of plugins) {
    mainLogger.debug("Setup plugin %s...", plugin.name);

    await plugin.setup({
      events,
      hooksPath,
      hookProcesses,
      logsPath,
      mainLogger,
      options,
      server,
    });
  }

  events.emit("start");
  mainLogger.info("Server is ready: %s", await server.listen(options.server));

  return async (): Promise<void> => {
    events.emit("close");
    server.close();

    hookProcesses.forEach((process): void => {
      process.cancel();
    });
  };
}
