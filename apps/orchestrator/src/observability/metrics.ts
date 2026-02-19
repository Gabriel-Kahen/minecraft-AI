import { createServer, type Server } from "node:http";
import os from "node:os";
import client from "prom-client";

export class MetricsService {
  private readonly registry = new client.Registry();

  private readonly llmCalls = new client.Counter({
    name: "mc_llm_calls_total",
    help: "Total planner calls",
    labelNames: ["bot_id", "status"] as const,
    registers: [this.registry]
  });

  private readonly subgoalDuration = new client.Histogram({
    name: "mc_subgoal_duration_ms",
    help: "Subgoal execution duration",
    labelNames: ["bot_id", "subgoal", "outcome"] as const,
    buckets: [250, 500, 1000, 3000, 5000, 10000, 30000, 60000],
    registers: [this.registry]
  });

  private readonly failures = new client.Counter({
    name: "mc_failures_total",
    help: "Skill failures by error code",
    labelNames: ["bot_id", "error_code"] as const,
    registers: [this.registry]
  });

  private readonly activeBotsGauge = new client.Gauge({
    name: "mc_active_bots",
    help: "Connected bot count",
    registers: [this.registry]
  });

  private readonly reconnects = new client.Counter({
    name: "mc_bot_reconnects_total",
    help: "Bot reconnect count",
    labelNames: ["bot_id"] as const,
    registers: [this.registry]
  });

  private readonly processRss = new client.Gauge({
    name: "mc_process_rss_mb",
    help: "Process RSS memory in MB",
    registers: [this.registry]
  });

  private readonly cpuUserMs = new client.Gauge({
    name: "mc_process_cpu_user_ms",
    help: "CPU user time in ms",
    registers: [this.registry]
  });

  private readonly cpuSystemMs = new client.Gauge({
    name: "mc_process_cpu_system_ms",
    help: "CPU system time in ms",
    registers: [this.registry]
  });

  private readonly hostLoad = new client.Gauge({
    name: "mc_host_load_1m",
    help: "Host load average (1m)",
    registers: [this.registry]
  });

  private server: Server | null = null;

  constructor() {
    this.registry.setDefaultLabels({
      app: "mc-orchestrator"
    });
  }

  start(port: number): void {
    if (this.server) {
      return;
    }

    this.server = createServer(async (req, res) => {
      if (req.url === "/metrics") {
        const body = await this.registry.metrics();
        res.statusCode = 200;
        res.setHeader("Content-Type", this.registry.contentType);
        res.end(body);
        return;
      }

      if (req.url === "/healthz") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      res.statusCode = 404;
      res.end();
    });

    this.server.listen(port);

    setInterval(() => {
      const usage = process.memoryUsage();
      const cpu = process.cpuUsage();
      this.processRss.set(usage.rss / (1024 * 1024));
      this.cpuUserMs.set(cpu.user / 1000);
      this.cpuSystemMs.set(cpu.system / 1000);
      this.hostLoad.set(os.loadavg()[0] ?? 0);
    }, 10000).unref();
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  recordLlmCall(botId: string, status: string): void {
    this.llmCalls.inc({ bot_id: botId, status });
  }

  recordSubgoal(botId: string, subgoal: string, outcome: "SUCCESS" | "FAILURE", durationMs: number): void {
    this.subgoalDuration.observe({ bot_id: botId, subgoal, outcome }, durationMs);
  }

  recordFailure(botId: string, errorCode: string): void {
    this.failures.inc({ bot_id: botId, error_code: errorCode });
  }

  setActiveBots(count: number): void {
    this.activeBotsGauge.set(count);
  }

  recordReconnect(botId: string): void {
    this.reconnects.inc({ bot_id: botId });
  }
}
