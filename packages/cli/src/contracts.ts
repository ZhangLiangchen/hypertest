/**
 * @hypertest/cli — `hypertest` command line.
 *
 *   hypertest init [--dir .]                       write hypertest.config.yaml (+ .gitignore entries)
 *   hypertest run "<goal>" [--repo <path>] [--commit <sha>] [--base <sha>] [--url <sutUrl>] [--config f] [--detach]
 *   hypertest status [<runId>]                     run status / list
 *   hypertest resume                               resume incomplete runs (after crash)
 *   hypertest report <runId> [--json]
 *   hypertest events <runId> [--follow]
 *   hypertest evidence verify <runId>
 *   hypertest approvals [--run <id>] | hypertest approve <approvalId> [--deny] --by <name> --reason "<text>"
 *   hypertest oracle decide <proposalId> [--reject] --by <name> --reason "<text>"
 *   hypertest eval run <suite> [--trials n] [--arms a,b]
 *   hypertest worker                               Temporal worker (durable.kind=temporal, workerMode=external)
 *   hypertest serve [--port 7420]                  HTTP API
 *   hypertest doctor                               check config, providers, infra, BUGate binding
 *
 * Implementations to export from src/index.ts:
 *   main(argv: string[], io?: { stdout; stderr; env; cwd }): Promise<number>   (exit code; never process.exit)
 */
export {};
