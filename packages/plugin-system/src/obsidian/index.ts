export { validateObsidianConfig, emptyObsidianConfig, type ObsidianConfig, type Hotkey } from './config.js';
export { applyObsidian, backupDir, vaultFile, writePlan, type ObsidianRun } from './apply.js';
export { applyChanges, describeObsidianPlan, diffObject, isEmptyObsidianPlan, planObsidian, readVault, type Change, type FileChange, type ObsidianPlan, type VaultState } from './plan.js';
export { detectObsidian, listVaults, obsidianConfigDir, obsidianJsonPath, obsidianRunning, parseVaultList, resolveVault, type Vault, type VaultList } from './vaults.js';
