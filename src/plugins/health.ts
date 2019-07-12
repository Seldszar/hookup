import { plugin } from "..";

export = plugin("health", ({ server }) => {
  server.get("/health", (request, reply) => {
    reply.send({
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
      resourceUsage: process.resourceUsage(),
      uptime: process.uptime(),
    });
  });
});
