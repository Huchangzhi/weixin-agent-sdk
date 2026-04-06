export interface AcpAgentOptions {
  /** ACP agent command (e.g. "claude-agent-acp", "codex-acp") */
  command: string;
  /** ACP agent arguments */
  args?: string[];
  /** Working directory for the subprocess */
  cwd?: string;
  /** Environment variables to merge into subprocess */
  env?: Record<string, string>;
}
