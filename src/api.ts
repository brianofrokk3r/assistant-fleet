import type { ActivityRecord, Deployment, FleetState, OperationResult, RepositorySnapshot, TenantConfiguration } from '../shared/types';

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
  createDeployment: (configuration: TenantConfiguration): Promise<{ deployment: Deployment }> => request('/api/deployments', { method: 'POST', body: JSON.stringify(configuration) }),
  updateDeployment: (id: string, configuration: TenantConfiguration): Promise<{ deployment: Deployment }> => request(`/api/deployments/${id}`, { method: 'PUT', body: JSON.stringify(configuration) }),
  addRepository: (id: string, repository: RepositorySnapshot): Promise<{ deployment: Deployment }> => request(`/api/deployments/${id}/repositories`, { method: 'POST', body: JSON.stringify(repository) }),
  operate: (id: string, action: 'deploy' | 'suspend' | 'resume' | 'verify' | 'rollback'): Promise<OperationResult> => request(`/api/deployments/${id}/actions/${action}`, { method: 'POST', body: '{}' }),
  logs: (id: string): Promise<{ logs: string }> => request(`/api/deployments/${id}/logs`),
  composeUrl: (id: string): string => `/api/deployments/${id}/compose`,
};

export type { ActivityRecord };
