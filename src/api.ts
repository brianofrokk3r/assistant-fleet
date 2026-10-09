import type { ActivityRecord, BackupSnapshot, BackupStatus, ContributionApproval, ContributionRepository, ContributionRepositoryInput, Deployment, FleetState, OperationResult, RepositorySnapshot, TenantConfiguration } from '../shared/types';

export class ApiError extends Error {
  status: number;
  details?: string[];

  constructor(message: string, status: number, details?: string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const payload = await response.json() as { error?: string; errors?: string[] } & T;
  if (!response.ok) throw new ApiError(payload.error || `Request failed with status ${response.status}.`, response.status, payload.errors);
  return payload;
}

export const fleetApi = {
  state: (): Promise<FleetState> => request<FleetState>('/api/state'),
  backupStatus: (): Promise<{ backup: BackupStatus }> => request('/api/backups/status'),
  backupSnapshots: (): Promise<{ snapshots: BackupSnapshot[] }> => request('/api/backups/snapshots'),
  runBackup: (): Promise<{ backup: BackupStatus }> => request('/api/backups/run', { method: 'POST', body: '{}' }),
  verifyBackup: (): Promise<{ backup: BackupStatus }> => request('/api/backups/verify', { method: 'POST', body: '{}' }),
  restoreBackup: (snapshotId: string): Promise<{ backup: BackupStatus }> => request('/api/backups/restore', { method: 'POST', body: JSON.stringify({ snapshotId }) }),
  createDeployment: (configuration: TenantConfiguration): Promise<{ deployment: Deployment }> => request('/api/deployments', { method: 'POST', body: JSON.stringify(configuration) }),
  updateDeployment: (id: string, configuration: TenantConfiguration): Promise<{ deployment: Deployment }> => request(`/api/deployments/${id}`, { method: 'PUT', body: JSON.stringify(configuration) }),
  addRepository: (id: string, repository: RepositorySnapshot): Promise<{ deployment: Deployment }> => request(`/api/deployments/${id}/repositories`, { method: 'POST', body: JSON.stringify(repository) }),
  contributionRepositories: (): Promise<{ repositories: ContributionRepository[] }> => request('/api/contribution-repositories'),
  createContributionRepository: (repository: ContributionRepositoryInput): Promise<{ repository: ContributionRepository }> => request('/api/contribution-repositories', { method: 'POST', body: JSON.stringify(repository) }),
  updateContributionRepository: (id: string, repository: ContributionRepositoryInput): Promise<{ repository: ContributionRepository }> => request(`/api/contribution-repositories/${id}`, { method: 'PUT', body: JSON.stringify(repository) }),
  deleteContributionRepository: (id: string): Promise<{ repository: ContributionRepository }> => request(`/api/contribution-repositories/${id}`, { method: 'DELETE' }),
  contributionApproval: (token: string): Promise<{ approval: ContributionApproval }> => request(`/api/contribution-approvals/${encodeURIComponent(token)}`),
  publishContributionApproval: (token: string): Promise<{ approval: ContributionApproval }> => request(`/api/contribution-approvals/${encodeURIComponent(token)}/publish`, { method: 'POST', body: '{}' }),
  abortContributionApproval: (token: string): Promise<{ approval: ContributionApproval }> => request(`/api/contribution-approvals/${encodeURIComponent(token)}/abort`, { method: 'POST', body: '{}' }),
  operate: (id: string, action: 'deploy' | 'suspend' | 'resume' | 'verify' | 'rollback'): Promise<OperationResult> => request(`/api/deployments/${id}/actions/${action}`, { method: 'POST', body: '{}' }),
  logs: (id: string): Promise<{ logs: string }> => request(`/api/deployments/${id}/logs`),
  composeUrl: (id: string): string => `/api/deployments/${id}/compose`,
};

export type { ActivityRecord };
