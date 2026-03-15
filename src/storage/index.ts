/**
 * Storage system — per-project .researcher/ folders + global registry.
 */

export {
  getGlobalDir,
  getGlobalConfigPath,
  getRegistryDbPath,
  getGlobalKnowledgeDbPath,
  getProfilesDir,
  getProfilePath,
  getLocalDir,
  getLocalDbPath,
  getLocalConfigPath,
  getLocalKnowledgeDir,
  getLocalCyclesDir,
  getLocalSandboxesDir,
  getLocalLogsDir,
  findProjectRoot,
  isGitRepo,
  getGitRemote,
  ensureGlobalDir,
  createLocalDir,
  resolveDbPath,
} from "./paths.ts"

export {
  getRegistryDb,
  closeRegistryDb,
  registerProject,
  listRegisteredProjects,
  getRegisteredProject,
  updateProjectStats,
  updateProjectHealth,
  unregisterProject,
  scanAndRegister,
  type RegisteredProject,
} from "./registry.ts"
