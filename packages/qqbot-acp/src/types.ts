export interface AcpAgentOptions {
  /** ACP agent command (e.g. "claude-agent-acp", "codex-acp") */
  command: string;
  /** ACP agent arguments */
  args?: string[];
}
