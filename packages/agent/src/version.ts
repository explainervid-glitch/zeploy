// The zeploy version, in its own module so scripts/build.mjs can read it
// without loading the agent. The admin app offers an agent update to every
// PC that runs an older version than the zeploy-agent.exe it holds, so bump
// this whenever the agent changes.
export const AGENT_VERSION = "0.4.0";
