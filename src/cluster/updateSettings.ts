import { prisma } from '../db';
import { config } from '../config';
import { normalizeRepo, validBranch } from './rollout';

// Where the cluster's updates come from (updates.ts): the replicated row
// "cluster" of update_settings, or the CLUSTER_UPDATE_* settings without it.

const COMMIT = /^[0-9a-f]{40}$/;
export const SETTINGS_ID = 'cluster';

export interface UpdateSettings {
  repo: string;
  branch: string;
  auto: boolean;
  requireCi: boolean;
  approvedCommit: string;
  source: 'panel' | 'env';
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function loadSettings(): Promise<UpdateSettings> {
  const defaults = config.cluster.update;
  const row = await prisma.updateSettings.findUnique({ where: { id: SETTINGS_ID } }).catch(() => null);
  if (!row) {
    return {
      repo: normalizeRepo(defaults.repo) ?? '',
      branch: validBranch(defaults.branch) ? defaults.branch : 'main',
      auto: defaults.auto,
      requireCi: defaults.requireCi,
      approvedCommit: '',
      source: 'env',
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    repo: normalizeRepo(row.repo) ?? '',
    branch: validBranch(row.branch) ? row.branch : 'main',
    auto: row.auto,
    requireCi: row.requireCi,
    approvedCommit: COMMIT.test(row.approvedCommit) ? row.approvedCommit : '',
    source: 'panel',
    updatedBy: row.updatedBy,
    updatedAt: row.updatedAt.toISOString(),
  };
}
