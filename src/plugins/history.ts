import { plugin } from "..";

interface HistoryEvent {
  date: number;
  type: string;
  data: unknown;
}

export = plugin("history", ({ events, server }) => {
  const history = new Array<HistoryEvent>();

  const createEvent = (type: string, data: unknown): HistoryEvent => ({
    date: Date.now(),
    type,
    data,
  });

  events.on("hook:error", data => {
    history.push(createEvent("error", data));
  });

  events.on("hook:exit", data => {
    history.push(createEvent("exit", data));
  });

  events.on("hook:run", data => {
    history.push(createEvent("run", data));
  });

  server.get("/history", async () => history);
});
