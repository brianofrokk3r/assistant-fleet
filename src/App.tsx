import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity, Box, Check, ChevronDown, ChevronRight, CircleAlert,
  Clock3, Copy, Database, Download, ExternalLink, FileText, FolderGit2, HardDrive, Hexagon,
  Layers3, MoreHorizontal, Pause, Plus, RefreshCw, RotateCcw, Search,
  Server, Settings, ShieldCheck, Sparkles, TerminalSquare, Users, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { type ActivityRecord, type AdapterType, type Deployment, type DeploymentStatus, type ProviderType, type RepositorySnapshot, type TenantConfiguration } from '../shared/types';
import { fleetApi } from './api';

type PageName = 'deployments' | 'activity' | 'repositories' | 'access' | 'settings' | 'contract';
type ActivityTone = 'green' | 'blue' | 'amber';
interface UIActivity { icon: LucideIcon; tone: ActivityTone; title: string; detail: string }

const activityIcon: Record<ActivityRecord['kind'], LucideIcon> = {
  created: Plus, updated: RefreshCw, deploy: Check, suspend: Pause, resume: Activity,
  verify: ShieldCheck, rollback: RotateCcw, repository: FolderGit2, error: CircleAlert,
};

function toUIActivity(record: ActivityRecord): UIActivity {
  return {
    icon: activityIcon[record.kind],
    tone: record.tone,
    title: record.title,
    detail: record.kind === 'verify' ? 'Runtime and Compose checks passed.' : record.detail,
  };
}

function compactImageReference(image: string): string {
  const digestMarker = '@sha256:';
  const digestAt = image.indexOf(digestMarker);
  const repository = (digestAt >= 0 ? image.slice(0, digestAt) : image).split('/').at(-1) ?? image;
  if (digestAt >= 0) return `sha:${image.slice(digestAt + digestMarker.length, digestAt + digestMarker.length + 12)}`;
  return repository.replace(/^assistant:/, '');
}

const initialDeployments: Deployment[] = [
  {
    id: 'acme', name: 'Acme, Inc.', monogram: 'AC', color: 'violet', environment: 'Production',
    status: 'healthy', adapter: 'slack', image: 'assistant:v1.14.2', desiredImage: 'assistant:v1.14.2',
    teamId: 'T02ACME81', installationId: 'acme-prod', channels: 8, users: 42,
    volume: 'assistant-acme-data', project: 'assistant-acme', updated: '4 min ago', latency: '1.2s',
    repositoryList: [{ name: 'acme-handbook', revision: 'c52f941' }, { name: 'product-docs', revision: '91aa3b2' }],
    sharedSkills: 6, tenantSkills: 2, storage: '1.8 GB', prompt: 'prompt.md', provider: 'Codex',
  },
  {
    id: 'northstar', name: 'Northstar Labs', monogram: 'NL', color: 'blue', environment: 'Production',
    status: 'deploying', adapter: 'slack', image: 'assistant:v1.14.1', desiredImage: 'assistant:v1.14.2',
    teamId: 'T08NORTH2', installationId: 'northstar-prod', channels: 5, users: 18,
    volume: 'assistant-northstar-data', project: 'assistant-northstar', updated: 'Just now', latency: '—',
    repositoryList: [{ name: 'northstar-wiki', revision: '2de8a01' }],
    sharedSkills: 6, tenantSkills: 1, storage: '842 MB', prompt: 'prompt.md', provider: 'Codex', progress: 68,
  },
  {
    id: 'atlas', name: 'Atlas & Co.', monogram: 'A', color: 'amber', environment: 'Staging',
    status: 'attention', adapter: 'slack', image: 'assistant:v1.13.8', desiredImage: 'assistant:v1.13.8',
    teamId: 'T04ATLAS7', installationId: 'atlas-staging', channels: 3, users: 11,
    volume: 'assistant-atlas-data', project: 'assistant-atlas', updated: '19 min ago', latency: '3.8s',
    repositoryList: [{ name: 'atlas-ops', revision: '7e4c912' }],
    sharedSkills: 6, tenantSkills: 0, storage: '514 MB', prompt: 'prompt.md', provider: 'Copilot',
    issue: 'Browser worker failed its last health check',
  },
  {
    id: 'ember', name: 'Ember Studio', monogram: 'ES', color: 'rose', environment: 'Production',
    status: 'suspended', adapter: 'slack', image: 'assistant:v1.14.0', desiredImage: 'assistant:v1.14.0',
    teamId: 'T03EMBER5', installationId: 'ember-prod', channels: 4, users: 23,
    volume: 'assistant-ember-data', project: 'assistant-ember', updated: '2 days ago', latency: '—',
    repositoryList: [{ name: 'ember-guide', revision: 'a13f64e' }],
    sharedSkills: 6, tenantSkills: 3, storage: '1.1 GB', prompt: 'prompt.md', provider: 'Codex',
  },
];

const activitySeed: UIActivity[] = [
  { icon: Check, tone: 'green', title: 'Acme, Inc. deployed successfully', detail: 'assistant:v1.14.2 · 4 minutes ago' },
  { icon: RefreshCw, tone: 'blue', title: 'Northstar Labs rollout started', detail: 'assistant:v1.14.1 → v1.14.2 · 7 minutes ago' },
  { icon: CircleAlert, tone: 'amber', title: 'Atlas browser health check failed', detail: 'Attempt 2 of 3 · 19 minutes ago' },
];

const statusMeta: Record<DeploymentStatus, { label: string; className: string }> = {
  healthy: { label: 'Healthy', className: 'healthy' },
  deploying: { label: 'Deploying', className: 'deploying' },
  attention: { label: 'Needs attention', className: 'attention' },
  suspended: { label: 'Suspended', className: 'suspended' },
  stopped: { label: 'Stopped', className: 'suspended' },
};

const readStored = (): Deployment[] => {
  try { return JSON.parse(localStorage.getItem('fleetline.deployments') ?? 'null') as Deployment[] || initialDeployments; }
  catch { return initialDeployments; }
};

function BrandMark() {
  return <div className="brand-mark"><Hexagon size={22} strokeWidth={1.7} /><span>F</span></div>;
}

function StatusPill({ status }: { status: DeploymentStatus }) {
  const meta = statusMeta[status];
  return <span className={`status-pill ${meta.className}`}><i />{meta.label}</span>;
}

function Metric({ icon: Icon, value, label, tone }: { icon: LucideIcon; value: ReactNode; label: string; tone: 'indigo' | 'green' | 'slate' | 'amber' }) {
  return (
    <div className="metric-card">
      <div className={`metric-icon ${tone}`}><Icon size={18} /></div>
      <div><strong>{value}</strong><span>{label}</span></div>
    </div>
  );
}

function TenantAvatar({ tenant, small = false }: { tenant: Deployment; small?: boolean }) {
  return <div className={`tenant-avatar ${tenant.color} ${small ? 'small' : ''}`}>{tenant.monogram}</div>;
}

interface DetailPanelProps {
  tenant?: Deployment;
  onClose: () => void;
  onAction: (id: string, action: 'deploy' | 'suspend' | 'resume' | 'verify' | 'rollback') => Promise<void>;
  onEdit: (configuration: TenantConfiguration) => void;
  onNavigate: (page: PageName) => void;
}

function DetailPanel({ tenant, onClose, onAction, onEdit, onNavigate }: DetailPanelProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  if (!tenant) return null;
  const run = async (action: 'deploy' | 'suspend' | 'resume' | 'verify' | 'rollback') => {
    setPending(action);
    try { await onAction(tenant.id, action); } catch { /* Parent surfaces the operation error. */ } finally { setPending(null); }
  };
  const loadLogs = async () => {
    setPending('logs');
    try { setLogs((await fleetApi.logs(tenant.id)).logs || 'No logs are available.'); }
    catch (error) { setLogs(error instanceof Error ? error.message : String(error)); }
    finally { setPending(null); }
  };
  return (
    <aside className="detail-panel">
      <div className="detail-head">
        <button className="icon-button mobile-close" onClick={onClose}><X size={18} /></button>
        <TenantAvatar tenant={tenant} />
        <div><p>{tenant.environment}</p><h2>{tenant.name}</h2></div>
        <button className="icon-button detail-menu" onClick={() => tenant.configuration && onEdit(tenant.configuration)} disabled={!tenant.configuration} title="Edit deployment"><Settings size={18} /></button>
      </div>

      <div className="detail-status">
        <StatusPill status={tenant.status} />
        <span>Updated {tenant.updated}</span>
      </div>

      {tenant.issue && <div className="alert"><CircleAlert size={17} /><div><strong>Action needed</strong><span>{tenant.issue}</span></div></div>}
      {tenant.status === 'deploying' && (
        <div className="rollout-card"><div><span>Rolling out {tenant.desiredImage}</span><b>{tenant.progress || 68}%</b></div><div className="progress"><i style={{ width: `${tenant.progress || 68}%` }} /></div></div>
      )}

      <section className="detail-section">
        <div className="section-label">Runtime</div>
        <dl className="facts">
          <div><dt>Image</dt><dd><code title={tenant.image}>{compactImageReference(tenant.image)}</code></dd></div>
          <div><dt>Compose project</dt><dd>{tenant.project}</dd></div>
          <div><dt>Network adapter</dt><dd className="capitalize">{tenant.adapter || 'slack'}</dd></div>
          <div><dt>Provider</dt><dd>{tenant.provider}</dd></div>
          {tenant.model && <div><dt>Model</dt><dd>{tenant.model}</dd></div>}
          <div><dt>Response latency</dt><dd>{tenant.latency}</dd></div>
        </dl>
      </section>

      <section className="detail-section">
        <div className="section-label">Isolation & access <ShieldCheck size={14} /></div>
        <dl className="facts">
          {tenant.adapter === 'slack' && <div><dt>Slack app</dt><dd><code>{tenant.configuration?.slackAppId || 'Not configured'}</code></dd></div>}
          <div><dt>{tenant.adapter === 'discord' ? 'Discord guild' : 'Slack team'}</dt><dd><code>{tenant.teamId}</code></dd></div>
          <div><dt>Installation</dt><dd>{tenant.installationId}</dd></div>
          <div><dt>Allowlists</dt><dd>{tenant.channels} channels · {tenant.users} users</dd></div>
          <div><dt>Data volume</dt><dd>{tenant.volume}</dd></div>
        </dl>
      </section>

      <section className="detail-section">
        <div className="section-title"><div className="section-label">Knowledge snapshots</div><button className="text-button" onClick={() => onNavigate('repositories')}>Manage</button></div>
        <div className="repo-list">
          {tenant.repositoryList.map(repo => <div className="repo" key={repo.name}><FolderGit2 size={16} /><span>{repo.name}</span><code>{repo.revision}</code></div>)}
        </div>
      </section>

      <section className="detail-section compact-section">
        <div className="skill-summary"><Sparkles size={16} /><span><b>{tenant.sharedSkills + tenant.tenantSkills}</b> skills mounted</span><small>{tenant.sharedSkills} shared · {tenant.tenantSkills} tenant</small></div>
      </section>

      <div className="detail-ops">
        <button onClick={() => run('verify')} disabled={pending !== null}><ShieldCheck size={14} />Verify</button>
        <button onClick={() => { if (window.confirm(`Roll back ${tenant.name} to its previous saved configuration?`)) void run('rollback'); }} disabled={pending !== null}><RotateCcw size={14} />Rollback</button>
        <button onClick={loadLogs} disabled={pending !== null}><TerminalSquare size={14} />Logs</button>
      </div>
      {logs !== null && <div className="log-viewer"><div><span>Container logs</span><button onClick={() => setLogs(null)}><X size={13} /></button></div><pre>{logs}</pre></div>}

      <div className="detail-actions">
        <button className="secondary-button" onClick={() => run(tenant.status === 'suspended' ? 'resume' : 'suspend')} disabled={pending !== null}>{tenant.status === 'suspended' ? <Activity size={16} /> : <Pause size={16} />}{pending === 'suspend' || pending === 'resume' ? 'Working…' : tenant.status === 'suspended' ? 'Resume' : 'Suspend'}</button>
        <button className="primary-button" onClick={() => run('deploy')} disabled={pending !== null || tenant.status === 'deploying'}><RefreshCw size={16} />{pending === 'deploy' || tenant.status === 'deploying' ? 'Deploying…' : 'Deploy changes'}</button>
      </div>
    </aside>
  );
}

function NewDeployment({ onClose, onCreate, initial }: { onClose: () => void; onCreate: (form: TenantConfiguration) => Promise<void>; initial?: TenantConfiguration }) {
  const [advanced, setAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<TenantConfiguration>(() => initial ? { ...initial, slackAppId: initial.slackAppId ?? '' } : ({
    name: '', slug: '', environment: 'Staging', type: 'slack',
    image: 'ghcr.io/rubiss-projects/ai-assistant:v1.26.0', provider: 'copilot', model: 'claude-haiku-4.5',
    slackAppId: '', teamId: '', installationId: 'default', allowedChannels: '', allowedUsers: '',
    slackAppTokenRef: 'secret://slack/app-token', slackBotTokenRef: 'secret://slack/bot-token',
    discordAppId: '', discordGuildId: '', discordAllowedUsers: '', discordAdminUsers: '',
    discordTokenRef: 'secret://discord/bot-token', freeChannels: '',
    securityMode: 'shared', stateDir: '/data/adapter-state', workspaceRoot: '/data/workspaces',
    configDir: '/data', systemPromptFile: '/config/prompt.md', browserUrl: 'http://browser:3123',
    registerCommands: false, attachmentMode: 'native', participationMode: 'smart', suppressEmbeds: false,
    historyTokenRef: '', excludedSlackUsers: '', timeoutMs: '3600000', progressIntervalMs: '60000',
    outputMaxBytes: '10485760', inputMaxBytes: '104857600', mcpConfigPath: '',
    openCodeBin: 'opencode', webSearchMode: 'cached', reasoningEffort: 'low',
    providerAuthMode: 'persisted-login', providerSecretRef: '', mediaTimeoutMs: '300000', cancellationGraceMs: '5000',
    schedulesEnabled: false, enableSites: false, enableGithubContributions: false, extraEnv: '',
    participationEvaluator: 'provider', participationReasoning: 'none', participationTimeoutMs: '15000',
    searchCandidateLimit: '200', searchContextLimit: '50', memoryRecallLimit: '5',
  }));
  const update = (key: keyof TenantConfiguration, value: string | boolean) => setForm(current => {
    const derivedSlug = key === 'name' && !current.slug && typeof value === 'string'
      ? value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      : key === 'slug' && typeof value === 'string' ? value : current.slug;
    const wasAutomatic = (reference: string, suffix: string) => reference === `secret://${suffix}` || reference === `secret://${suffix.replace('/', `/${current.slug}/`)}`;
    return {
      ...current,
      [key]: value,
      ...(derivedSlug !== current.slug ? { slug: derivedSlug } : {}),
      ...(derivedSlug && wasAutomatic(current.slackAppTokenRef, 'slack/app-token') ? { slackAppTokenRef: `secret://slack/${derivedSlug}/app-token` } : {}),
      ...(derivedSlug && wasAutomatic(current.slackBotTokenRef, 'slack/bot-token') ? { slackBotTokenRef: `secret://slack/${derivedSlug}/bot-token` } : {}),
      ...(derivedSlug && wasAutomatic(current.discordTokenRef, 'discord/bot-token') ? { discordTokenRef: `secret://discord/${derivedSlug}/bot-token` } : {}),
    } as TenantConfiguration;
  });
  const selectType = (type: AdapterType) => setForm(v => ({ ...v, type, registerCommands: type === 'discord' }));
  const selectProvider = (provider: ProviderType) => setForm(v => ({ ...v, provider, model: provider === 'copilot' ? 'claude-haiku-4.5' : provider === 'codex' ? 'gpt-5.6-sol' : '' }));
  const typeValid = form.type === 'slack'
    ? form.slackAppId && form.teamId && form.installationId && form.allowedChannels && form.allowedUsers && form.slackAppTokenRef && form.slackBotTokenRef
    : form.discordAppId && form.discordGuildId && form.discordTokenRef;
  const authValid = form.providerAuthMode === 'persisted-login' || form.providerSecretRef;
  const valid = form.name && form.slug && form.image.includes(':') && !form.image.endsWith(':latest') && typeValid && authValid;
  const types: Array<{ id: AdapterType; icon: LucideIcon; label: string; detail: string }> = [
    { id: 'slack', icon: Box, label: 'Slack', detail: 'Socket Mode workspace' },
    { id: 'discord', icon: Users, label: 'Discord', detail: 'Bot-enabled server' },
  ];
  return (
    <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal tenant-modal">
        <div className="modal-head"><div><span>{initial ? 'Edit deployment' : 'New deployment'}</span><h2>{initial ? `Configure ${initial.name}` : 'Add a tenant stack'}</h2></div><button className="icon-button" onClick={onClose}><X size={19} /></button></div>
        <p className="modal-copy">{initial ? 'Update the rendered deployment configuration. The previous revision is retained for rollback.' : 'Choose a deployment preset, then provide its minimum viable configuration. Credentials remain external; this record stores secret references only.'}</p>
        <div className="type-picker">
          {types.map(item => { const Icon = item.icon; return <button className={form.type === item.id ? 'selected' : ''} onClick={() => selectType(item.id)} key={item.id}><span className="type-icon"><Icon size={19} /></span><span><b>{item.label}</b><small>{item.detail}</small></span>{form.type === item.id && <Check size={16} />}</button>; })}
        </div>

        <div className="form-section-title"><span>Required configuration</span><small>{form.type === 'slack' ? 'Slack workspace + provider' : 'Discord application + provider'}</small></div>
        <div className="form-grid">
          <label><span>Tenant name</span><input autoFocus value={form.name} onChange={e => update('name', e.target.value)} placeholder="Example Company" /></label>
          <label><span>Tenant slug</span><input value={form.slug} onChange={e => update('slug', e.target.value)} placeholder="example-company" disabled={Boolean(initial)} /></label>
          <label><span>Environment</span><select value={form.environment} onChange={e => update('environment', e.target.value)}><option>Staging</option><option>Production</option><option>Development</option></select></label>
          <label><span>Default provider</span><select value={form.provider} onChange={e => selectProvider(e.target.value as ProviderType)}><option value="copilot">GitHub Copilot</option><option value="codex">OpenAI Codex</option><option value="opencode">OpenCode</option></select></label>

          {form.type === 'slack' && <>
            <label><span>Slack app ID</span><input value={form.slackAppId} onChange={e => update('slackAppId', e.target.value.toUpperCase())} placeholder="A0123456789" /></label>
            <label><span>Slack team ID</span><input value={form.teamId} onChange={e => update('teamId', e.target.value.toUpperCase())} placeholder="T0123456789" /></label>
            <label><span>Installation ID</span><input value={form.installationId} onChange={e => update('installationId', e.target.value)} placeholder="default" /></label>
            <label><span>Allowed channel IDs</span><input value={form.allowedChannels} onChange={e => update('allowedChannels', e.target.value)} placeholder="C0123,C0456" /></label>
            <label><span>Allowed user IDs</span><input value={form.allowedUsers} onChange={e => update('allowedUsers', e.target.value)} placeholder="U0123,U0456" /></label>
            <label><span>App token secret reference</span><input value={form.slackAppTokenRef} onChange={e => update('slackAppTokenRef', e.target.value)} /></label>
            <label><span>Bot token secret reference</span><input value={form.slackBotTokenRef} onChange={e => update('slackBotTokenRef', e.target.value)} /></label>
          </>}

          {form.type === 'discord' && <>
            <label><span>Discord application ID</span><input value={form.discordAppId} onChange={e => update('discordAppId', e.target.value)} placeholder="123456789012345678" /></label>
            <label><span>Discord guild ID</span><input value={form.discordGuildId} onChange={e => update('discordGuildId', e.target.value)} placeholder="123456789012345678" /></label>
            <label className="full"><span>Bot token secret reference</span><input value={form.discordTokenRef} onChange={e => update('discordTokenRef', e.target.value)} /></label>
          </>}

          <label className="full"><span>Application image</span><input value={form.image} onChange={e => update('image', e.target.value)} /></label>
          <label className="full"><span>{form.provider === 'opencode' ? 'Model override' : 'Default model'}</span><input value={form.model} onChange={e => update('model', e.target.value)} placeholder={form.provider === 'opencode' ? 'provider/model (optional)' : 'Model name'} /></label>
          <label><span>Provider authentication</span><select value={form.providerAuthMode} onChange={e => update('providerAuthMode', e.target.value)}><option value="persisted-login">Persisted CLI login</option><option value="secret-reference">Secret reference</option></select></label>
          {form.providerAuthMode === 'secret-reference' && <label><span>{form.provider === 'codex' ? 'OPENAI_API_KEY reference' : form.provider === 'copilot' ? 'COPILOT_GITHUB_TOKEN reference' : 'Provider key reference'}</span><input value={form.providerSecretRef} onChange={e => update('providerSecretRef', e.target.value)} placeholder={`secret://${form.provider}/credential`} /></label>}
        </div>

        <button className="advanced-toggle" onClick={() => setAdvanced(v => !v)}><Settings size={16} /><span><b>Advanced configuration</b><small>Runtime paths, timeouts, attachments, and adapter behavior</small></span><ChevronDown className={advanced ? 'open' : ''} size={17} /></button>
        {advanced && <div className="advanced-fields form-grid">
          <label><span>Security mode</span><select value={form.securityMode} onChange={e => update('securityMode', e.target.value)}><option value="shared">Shared (recommended)</option><option value="unrestricted">Unrestricted</option></select></label>
          <label><span>Provider timeout (ms)</span><input value={form.timeoutMs} onChange={e => update('timeoutMs', e.target.value)} /></label>
          <label><span>Adapter state directory</span><input value={form.stateDir} onChange={e => update('stateDir', e.target.value)} /></label>
          <label><span>Workspace root</span><input value={form.workspaceRoot} onChange={e => update('workspaceRoot', e.target.value)} /></label>
          <label><span>Config directory</span><input value={form.configDir} onChange={e => update('configDir', e.target.value)} /></label>
          <label><span>System prompt file</span><input value={form.systemPromptFile} onChange={e => update('systemPromptFile', e.target.value)} /></label>
          <label><span>Browser worker URL</span><input value={form.browserUrl} onChange={e => update('browserUrl', e.target.value)} /></label>
          <label><span>Progress interval (ms)</span><input value={form.progressIntervalMs} onChange={e => update('progressIntervalMs', e.target.value)} /></label>
          <label><span>Input file limit (bytes)</span><input value={form.inputMaxBytes} onChange={e => update('inputMaxBytes', e.target.value)} /></label>
          <label><span>Output file limit (bytes)</span><input value={form.outputMaxBytes} onChange={e => update('outputMaxBytes', e.target.value)} /></label>
          <label><span>Media timeout (ms)</span><input value={form.mediaTimeoutMs} onChange={e => update('mediaTimeoutMs', e.target.value)} /></label>
          <label><span>Cancellation grace (ms)</span><input value={form.cancellationGraceMs} onChange={e => update('cancellationGraceMs', e.target.value)} /></label>
          <label className="full"><span>MCP config path</span><input value={form.mcpConfigPath} onChange={e => update('mcpConfigPath', e.target.value)} placeholder="/data/mcp.json (optional)" /></label>

          {form.type === 'slack' && <>
            <label><span>History token secret reference</span><input value={form.historyTokenRef} onChange={e => update('historyTokenRef', e.target.value)} placeholder="Uses bot token by default" /></label>
            <label><span>Excluded context users</span><input value={form.excludedSlackUsers} onChange={e => update('excludedSlackUsers', e.target.value)} placeholder="U0111,U0222" /></label>
          </>}
          {form.type === 'discord' && <>
            <label><span>Allowed users</span><input value={form.discordAllowedUsers} onChange={e => update('discordAllowedUsers', e.target.value)} placeholder="Empty permits everyone" /></label>
            <label><span>Admin users</span><input value={form.discordAdminUsers} onChange={e => update('discordAdminUsers', e.target.value)} /></label>
            <label><span>Free channels</span><input value={form.freeChannels} onChange={e => update('freeChannels', e.target.value)} /></label>
            <label><span>Attachment mode</span><select value={form.attachmentMode} onChange={e => update('attachmentMode', e.target.value)}><option value="native">Native</option><option value="text">Untrusted inline text</option></select></label>
            <label><span>Thread participation</span><select value={form.participationMode} onChange={e => update('participationMode', e.target.value)}><option value="smart">Smart</option><option value="always">Always</option><option value="mentions-only">Mentions only</option></select></label>
            <label><span>Participation evaluator</span><select value={form.participationEvaluator} onChange={e => update('participationEvaluator', e.target.value)}><option value="provider">Provider</option><option value="jev">Jev</option></select></label>
            <label><span>Participation reasoning</span><select value={form.participationReasoning} onChange={e => update('participationReasoning', e.target.value)}><option>none</option><option>low</option></select></label>
            <label><span>Participation timeout (ms)</span><input value={form.participationTimeoutMs} onChange={e => update('participationTimeoutMs', e.target.value)} /></label>
            <label><span>Search candidates</span><input value={form.searchCandidateLimit} onChange={e => update('searchCandidateLimit', e.target.value)} /></label>
            <label><span>Search context messages</span><input value={form.searchContextLimit} onChange={e => update('searchContextLimit', e.target.value)} /></label>
            <label><span>Memory recall results</span><input value={form.memoryRecallLimit} onChange={e => update('memoryRecallLimit', e.target.value)} /></label>
            <label className="check-label"><input type="checkbox" checked={form.suppressEmbeds} onChange={e => update('suppressEmbeds', e.target.checked)} /><span>Suppress Discord link embeds</span></label>
            <label className="check-label"><input type="checkbox" checked={form.registerCommands} onChange={e => update('registerCommands', e.target.checked)} /><span>Register commands on start</span></label>
          </>}
          {form.provider === 'codex' && <>
            <label><span>Reasoning effort</span><select value={form.reasoningEffort} onChange={e => update('reasoningEffort', e.target.value)}><option>minimal</option><option>low</option><option>medium</option><option>high</option><option>xhigh</option><option>max</option><option>ultra</option></select></label>
            <label><span>Web search mode</span><select value={form.webSearchMode} onChange={e => update('webSearchMode', e.target.value)}><option>cached</option><option>disabled</option><option>indexed</option><option>live</option></select></label>
          </>}
          {form.provider === 'opencode' && <label className="full"><span>OpenCode binary</span><input value={form.openCodeBin} onChange={e => update('openCodeBin', e.target.value)} /></label>}
          <div className="advanced-checks full">
            <label><input type="checkbox" checked={form.schedulesEnabled} onChange={e => update('schedulesEnabled', e.target.checked)} /><span>Enable schedules</span></label>
            <label><input type="checkbox" checked={form.enableSites} onChange={e => update('enableSites', e.target.checked)} /><span>Enable Codex Sites</span></label>
            <label><input type="checkbox" checked={form.enableGithubContributions} onChange={e => update('enableGithubContributions', e.target.checked)} /><span>Enable GitHub contributions</span></label>
          </div>
          <label className="full"><span>Additional environment overrides</span><textarea value={form.extraEnv} onChange={e => update('extraEnv', e.target.value)} placeholder={'KEY=value\n# Secret values are not permitted here'} /></label>
        </div>}

        <div className="contract-note"><ShieldCheck size={18} /><div><b>{form.type === 'slack' ? 'Slack isolation requirements are enforced' : 'Isolation defaults are applied automatically'}</b><span>Dedicated Compose project, data volume, adapter state, and writable workspace. Secret values remain outside the provider workspace.</span></div></div>
        {error && <div className="form-error"><CircleAlert size={15} />{error}</div>}
        <div className="modal-actions"><button className="secondary-button" onClick={onClose} disabled={submitting}>Cancel</button><button className="primary-button" disabled={!valid || submitting} onClick={async () => { setSubmitting(true); setError(''); try { await onCreate(form); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); setSubmitting(false); } }}>{initial ? <Check size={16} /> : <Plus size={16} />}{submitting ? 'Saving…' : initial ? 'Save configuration' : 'Create deployment'}</button></div>
      </div>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, action }: { eyebrow: string; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="page-heading">
      <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>
      {action}
    </div>
  );
}

function ActivityPage({ activity, deployments }: { activity: UIActivity[]; deployments: Deployment[] }) {
  const [scope, setScope] = useState('All tenants');
  const events = [...activity,
    { icon: ShieldCheck, tone: 'green', title: 'Isolation verification passed', detail: 'Acme, Inc. · 38 minutes ago' },
    { icon: FolderGit2, tone: 'blue', title: 'Knowledge snapshot promoted', detail: 'atlas-ops@7e4c912 · 2 hours ago' },
    { icon: Pause, tone: 'amber', title: 'Ember Studio suspended', detail: 'Local operator · 2 days ago' },
  ].filter(item => scope === 'All tenants' || item.title.includes(scope));
  const exportLog = () => {
    const blob = new Blob([JSON.stringify(events.map(({ title, detail }) => ({ title, detail })), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'assistant-fleet-activity.json'; link.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="page subpage">
      <PageHeading eyebrow="OPERATIONS" title="Activity" description="Review local rollout, health, and configuration events across the fleet." action={
        <label className="select-control"><span>Tenant</span><select value={scope} onChange={e => setScope(e.target.value)}><option>All tenants</option>{deployments.map(d => <option key={d.id}>{d.name}</option>)}</select></label>
      } />
      <div className="subpage-card activity-log">
        <div className="subpage-card-head"><div><b>Event log</b><span>{events.length} local events</span></div><button className="secondary-button" onClick={exportLog}><Download size={15} />Export log</button></div>
        {events.map((item, index) => { const Icon = item.icon; return (
          <div className="log-row" key={`${item.title}-${index}`}>
            <div className={`event-icon ${item.tone}`}><Icon size={15} /></div>
            <div className="log-copy"><b>{item.title}</b><span>{item.detail}</span></div>
            <code>{index < 3 ? 'operator' : 'system'}</code>
            <ChevronRight size={16} />
          </div>
        ); })}
      </div>
    </div>
  );
}

function RepositoriesPage({ deployments, onSelectTenant, onAddRepository }: { deployments: Deployment[]; onSelectTenant: (id: string) => void; onAddRepository: (tenantId: string, repository: RepositorySnapshot) => void }) {
  const repos = deployments.flatMap(tenant => tenant.repositoryList.map(repo => ({ ...repo, tenant })));
  const [copiedRepo, setCopiedRepo] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ tenantId: deployments[0]?.id || '', name: '', revision: '' });
  const copyPath = (repo: RepositorySnapshot) => {
    navigator.clipboard?.writeText(`/data/workspaces/knowledge/${repo.name}`);
    setCopiedRepo(repo.name); setTimeout(() => setCopiedRepo(null), 1500);
  };
  return (
    <div className="page subpage">
      <PageHeading eyebrow="KNOWLEDGE DELIVERY" title="Repositories" description="Track immutable, tenant-scoped repository snapshots mounted read-only." action={<button className="primary-button" onClick={() => setAdding(v => !v)}>{adding ? <X size={16} /> : <Plus size={16} />}{adding ? 'Cancel' : 'Add snapshot'}</button>} />
      {adding && <div className="snapshot-form">
        <label><span>Tenant</span><select value={form.tenantId} onChange={e => setForm(v => ({ ...v, tenantId: e.target.value }))}>{deployments.map(d => <option value={d.id} key={d.id}>{d.name}</option>)}</select></label>
        <label><span>Repository name</span><input value={form.name} onChange={e => setForm(v => ({ ...v, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }))} placeholder="product-docs" /></label>
        <label><span>Exact revision</span><input value={form.revision} onChange={e => setForm(v => ({ ...v, revision: e.target.value }))} placeholder="c52f941" /></label>
        <button className="primary-button" disabled={!form.tenantId || !form.name || !form.revision} onClick={() => { onAddRepository(form.tenantId, { name: form.name, revision: form.revision }); setAdding(false); setForm(v => ({ ...v, name: '', revision: '' })); }}><Check size={16} />Mount snapshot</button>
      </div>}
      <div className="metrics compact-metrics">
        <Metric icon={FolderGit2} value={repos.length} label="Mounted snapshots" tone="slate" />
        <Metric icon={Layers3} value={new Set(repos.map(r => r.tenant.id)).size} label="Tenants with knowledge" tone="indigo" />
        <Metric icon={ShieldCheck} value="100%" label="Read-only mounts" tone="green" />
      </div>
      <div className="subpage-card repo-table">
        <div className="repo-table-head"><span>Repository</span><span>Tenant</span><span>Revision</span><span>Mount path</span><span /></div>
        {repos.map(repo => <div className="repo-table-row" key={`${repo.tenant.id}-${repo.name}`}>
          <div className="repo-name"><div className="metric-icon slate"><FolderGit2 size={17} /></div><span><b>{repo.name}</b><small>Immutable snapshot</small></span></div>
          <button className="tenant-link" onClick={() => onSelectTenant(repo.tenant.id)}><TenantAvatar tenant={repo.tenant} small />{repo.tenant.name}</button>
          <code>{repo.revision}</code>
          <button className="path-copy" onClick={() => copyPath(repo)}><code>/knowledge/{repo.name}</code>{copiedRepo === repo.name ? <Check size={14} /> : <Copy size={14} />}</button>
          <button className="icon-button" onClick={() => copyPath(repo)} title="Copy mount path">{copiedRepo === repo.name ? <Check size={16} /> : <Copy size={16} />}</button>
        </div>)}
      </div>
    </div>
  );
}

function AccessPage({ deployments, onSelectTenant }: { deployments: Deployment[]; onSelectTenant: (id: string) => void }) {
  return (
    <div className="page subpage">
      <PageHeading eyebrow="SECURITY BOUNDARY" title="Tenant access" description="Audit adapter identities, explicit allowlists, and isolated state ownership." />
      <div className="guardrail"><ShieldCheck size={20} /><div><b>Shared security mode is enforced</b><span>Every active network tenant has an explicit adapter identity, installation namespace, access policy, and dedicated data volume.</span></div><span className="status-pill healthy"><i />Verified</span></div>
      <div className="tenant-access-grid">
        {deployments.map(tenant => <button className="access-card" key={tenant.id} onClick={() => onSelectTenant(tenant.id)}>
          <div className="access-card-head"><TenantAvatar tenant={tenant} /><div><b>{tenant.name}</b><span>{tenant.environment}</span></div><StatusPill status={tenant.status} /></div>
          <dl className="facts">
            <div><dt>Adapter</dt><dd className="capitalize">{tenant.adapter || 'slack'}</dd></div>
            {tenant.adapter === 'slack' && <div><dt>Slack app</dt><dd><code>{tenant.configuration?.slackAppId || 'Not configured'}</code></dd></div>}
            <div><dt>{tenant.adapter === 'discord' ? 'Discord guild' : 'Slack team'}</dt><dd><code>{tenant.teamId}</code></dd></div>
            <div><dt>Installation</dt><dd>{tenant.installationId}</dd></div>
            <div><dt>Allowed channels</dt><dd>{tenant.channels}</dd></div>
            <div><dt>Allowed users</dt><dd>{tenant.users}</dd></div>
            <div><dt>Dedicated volume</dt><dd>{tenant.volume}</dd></div>
          </dl>
          <div className="access-card-foot"><ShieldCheck size={14} />Isolation contract satisfied <ChevronRight size={15} /></div>
        </button>)}
      </div>
    </div>
  );
}

function SettingsPage({ deployments, onOpenContract }: { deployments: Deployment[]; onOpenContract: () => void }) {
  const [settings, setSettings] = useState({ health: true, isolation: true, confirm: true, refresh: '30 seconds' });
  const toggle = (key: 'health' | 'isolation' | 'confirm') => setSettings(v => ({ ...v, [key]: !v[key] }));
  const exportConfig = () => {
    const blob = new Blob([JSON.stringify({ version: 1, deployments }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = 'assistant-fleet-local.json'; link.click(); URL.revokeObjectURL(url);
  };
  return (
    <div className="page subpage">
      <PageHeading eyebrow="LOCAL CONTROL PLANE" title="Settings" description="Configure the local control plane and export its non-secret deployment records." action={<button className="primary-button" onClick={exportConfig}><Download size={16} />Export configuration</button>} />
      <div className="settings-grid">
        <section className="subpage-card settings-section">
          <div className="settings-title"><Activity size={18} /><div><b>Monitoring</b><span>Local health and verification behavior</span></div></div>
          <div className="setting-row"><div><b>Health checks</b><span>Show assistant and browser worker health in deployment status.</span></div><button className={`toggle ${settings.health ? 'on' : ''}`} onClick={() => toggle('health')}><i /></button></div>
          <div className="setting-row"><div><b>Isolation checks</b><span>Validate tenant volume, workspace, and Slack identity boundaries.</span></div><button className={`toggle ${settings.isolation ? 'on' : ''}`} onClick={() => toggle('isolation')}><i /></button></div>
          <div className="setting-row"><div><b>Refresh interval</b><span>How often the console refreshes local runtime status.</span></div><select value={settings.refresh} onChange={e => setSettings(v => ({ ...v, refresh: e.target.value }))}><option>15 seconds</option><option>30 seconds</option><option>1 minute</option><option>Manual</option></select></div>
        </section>
        <section className="subpage-card settings-section">
          <div className="settings-title"><HardDrive size={18} /><div><b>Local data</b><span>Browser storage and operator safeguards</span></div></div>
          <div className="storage-summary"><div className="metric-icon green"><Database size={17} /></div><div><b>{deployments.length} deployment records</b><span>Persisted by the local API · no secret values included</span></div></div>
          <div className="setting-row"><div><b>Confirm runtime actions</b><span>Require confirmation before suspend, deploy, or rollback operations.</span></div><button className={`toggle ${settings.confirm ? 'on' : ''}`} onClick={() => toggle('confirm')}><i /></button></div>
          <div className="setting-row"><div><b>Deployment contract</b><span>The architecture and isolation requirements this console follows.</span></div><button className="secondary-button" onClick={onOpenContract}><FileText size={15} />View contract</button></div>
        </section>
      </div>
    </div>
  );
}

function ContractPage() {
  const rules = [
    ['One process per workspace', 'Each Slack workspace runs as an independent Compose project.'],
    ['Dedicated persistent state', 'Data volumes, adapter state, and writable workspaces are never shared.'],
    ['Explicit Slack access', 'Team identity, installation namespace, channels, and users must be configured.'],
    ['Pinned reviewed artifacts', 'Application images, skill bundles, and repository snapshots use exact revisions.'],
    ['Read-only knowledge', 'Approved repository snapshots mount below the tenant knowledge workspace.'],
    ['Secrets outside the workspace', 'Slack tokens, provider credentials, and Git keys are not persisted here.'],
  ];
  return <div className="page subpage"><PageHeading eyebrow="ARCHITECTURE" title="Deployment contract" description="The operational boundaries every local tenant stack must preserve." /><div className="contract-grid">{rules.map(([title, text], index) => <div className="contract-rule" key={title}><span>{String(index + 1).padStart(2, '0')}</span><div><b>{title}</b><p>{text}</p></div><Check size={17} /></div>)}</div></div>;
}

export default function App() {
  const [deployments, setDeployments] = useState<Deployment[]>(readStored);
  const [selectedId, setSelectedId] = useState<string | null>('acme');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('All');
  const [activity, setActivity] = useState<UIActivity[]>(activitySeed);
  const [showNew, setShowNew] = useState(() => new URLSearchParams(window.location.search).get('new') === '1');
  const [editingConfiguration, setEditingConfiguration] = useState<TenantConfiguration | null>(null);
  const [copied, setCopied] = useState(false);
  const [pageName, setPageName] = useState<PageName>('deployments');
  const [apiConnected, setApiConnected] = useState<boolean | null>(null);
  const [notice, setNotice] = useState<{ tone: 'error' | 'success'; message: string } | null>(null);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const state = await fleetApi.state();
        if (!active) return;
        setDeployments(state.deployments);
        setActivity(state.activities.map(toUIActivity));
        setSelectedId(current => state.deployments.some(item => item.id === current) ? current : state.deployments[0]?.id ?? null);
        setApiConnected(true);
      } catch (error) {
        if (!active) return;
        setApiConnected(false);
        setNotice({ tone: 'error', message: `Control-plane API unavailable: ${error instanceof Error ? error.message : String(error)}` });
      }
    };
    void load();
    const interval = window.setInterval(load, 15_000);
    return () => { active = false; window.clearInterval(interval); };
  }, []);

  const refreshState = async () => {
    const state = await fleetApi.state();
    setDeployments(state.deployments);
    setActivity(state.activities.map(toUIActivity));
    setApiConnected(true);
  };
  const selected = deployments.find(d => d.id === selectedId);
  const filtered = useMemo(() => deployments.filter(d => {
    const matchQuery = `${d.name} ${d.teamId} ${d.project}`.toLowerCase().includes(query.toLowerCase());
    const matchFilter = filter === 'All' || (filter === 'Active' ? d.status !== 'suspended' : d.environment === filter);
    return matchQuery && matchFilter;
  }), [deployments, query, filter]);
  const healthy = deployments.filter(d => d.status === 'healthy').length;
  const attention = deployments.filter(d => d.status === 'attention').length;
  const repositories = deployments.reduce((n, d) => n + d.repositoryList.length, 0);

  const createDeployment = async (form: TenantConfiguration) => {
    const { deployment } = editingConfiguration
      ? await fleetApi.updateDeployment(editingConfiguration.slug, form)
      : await fleetApi.createDeployment(form);
    await refreshState();
    setSelectedId(deployment.id); setPageName('deployments'); setShowNew(false); setEditingConfiguration(null);
    setNotice({ tone: 'success', message: `${deployment.name} was ${editingConfiguration ? 'updated' : 'created'} and its Compose project was rendered.` });
  };
  const addRepository = async (tenantId: string, repository: RepositorySnapshot) => {
    try {
      await fleetApi.addRepository(tenantId, repository);
      await refreshState();
      setNotice({ tone: 'success', message: `${repository.name}@${repository.revision} was mounted read-only.` });
    } catch (error) {
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  };
  const runAction = async (id: string, action: 'deploy' | 'suspend' | 'resume' | 'verify' | 'rollback') => {
    if (action === 'deploy') setDeployments(items => items.map(item => item.id === id ? { ...item, status: 'deploying', progress: 15 } : item));
    try {
      const result = await fleetApi.operate(id, action);
      await refreshState();
      setNotice({ tone: 'success', message: `${action[0].toUpperCase()}${action.slice(1)} completed successfully.` });
      if (!result.ok) throw new Error(result.error || `${action} failed.`);
    } catch (error) {
      await refreshState().catch(() => undefined);
      setNotice({ tone: 'error', message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  const copyCommand = () => {
    const tenant = selected ?? deployments[0];
    navigator.clipboard?.writeText(tenant ? `docker compose -p ${tenant.project} -f tenants/${tenant.id}/compose.generated.yaml up -d` : 'docker compose up -d');
    setCopied(true); setTimeout(() => setCopied(false), 1600);
  };
  const pageTitles: Record<PageName, string> = { deployments: 'Deployments', activity: 'Activity', repositories: 'Repositories', access: 'Tenant access', settings: 'Settings', contract: 'Deployment contract' };
  const navigate = (page: PageName) => { setPageName(page); if (page !== 'deployments') setSelectedId(null); };
  const openTenant = (id: string) => { setSelectedId(id); setPageName('deployments'); };

  return (
    <div className={`app-shell ${pageName !== 'deployments' || !selected ? 'no-detail' : ''}`}>
      <nav className="rail">
        <BrandMark />
        <div className="rail-group">
          <button className={`rail-button ${pageName === 'deployments' ? 'active' : ''}`} onClick={() => navigate('deployments')} aria-label="Deployments" title="Deployments"><Layers3 size={20} /></button>
          <button className={`rail-button ${pageName === 'activity' ? 'active' : ''}`} onClick={() => navigate('activity')} aria-label="Activity" title="Activity"><Activity size={20} /></button>
          <button className={`rail-button ${pageName === 'repositories' ? 'active' : ''}`} onClick={() => navigate('repositories')} aria-label="Repositories" title="Repositories"><Database size={20} /></button>
          <button className={`rail-button ${pageName === 'access' ? 'active' : ''}`} onClick={() => navigate('access')} aria-label="Tenant access" title="Tenant access"><Users size={20} /></button>
        </div>
        <div className="rail-bottom"><button className={`rail-button ${pageName === 'settings' ? 'active' : ''}`} onClick={() => navigate('settings')} title="Settings"><Settings size={20} /></button><div className="user-avatar">BH</div></div>
      </nav>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb"><button onClick={() => navigate('deployments')}>Assistant fleet</button><ChevronRight size={15} /><b>{pageTitles[pageName]}</b></div>
          <div className="top-actions">
            <button className="local-chip" onClick={() => navigate('settings')}><i /> Local environment <ChevronRight size={14} /></button>
            <button className="icon-button" onClick={copyCommand} title={copied ? 'Command copied' : 'Copy local Compose command'}>{copied ? <Check size={18} /> : <TerminalSquare size={18} />}</button>
            <button className="primary-button" onClick={() => { setEditingConfiguration(null); setShowNew(true); }}><Plus size={17} />New deployment</button>
          </div>
        </header>
        {notice && <div className={`api-notice ${notice.tone}`}><span>{notice.message}</span><button onClick={() => setNotice(null)}><X size={15} /></button></div>}

        {pageName === 'deployments' && <div className="page">
          <div className="page-heading">
            <div><span className="eyebrow">LOCAL CONTROL PLANE</span><h1>Deployments</h1><p>Operate isolated assistant stacks across Slack and Discord.</p></div>
            <button className="command" onClick={copyCommand}><code>{apiConnected === false ? 'API offline' : `docker compose · ${selected?.project ?? 'select a tenant'}`}</code>{copied ? <Check size={15} /> : <Copy size={15} />}</button>
          </div>

          <div className="metrics">
            <Metric icon={Layers3} value={deployments.length} label="Tenant stacks" tone="indigo" />
            <Metric icon={Activity} value={`${healthy}/${deployments.length}`} label="Healthy" tone="green" />
            <Metric icon={FolderGit2} value={repositories} label="Repo snapshots" tone="slate" />
            <Metric icon={CircleAlert} value={attention} label="Needs attention" tone="amber" />
          </div>

          <section className="content-grid">
            <div className="deployment-card">
              <div className="card-toolbar">
                <div className="filters">{['All', 'Active', 'Production', 'Staging'].map(item => <button className={filter === item ? 'selected' : ''} onClick={() => setFilter(item)} key={item}>{item}</button>)}</div>
                <div className="search"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search deployments" /></div>
              </div>

              <div className="table-head"><span>Tenant</span><span>Status</span><span>Version</span><span>Knowledge</span><span>Updated</span><span /></div>
              <div className="deployment-list">
                {filtered.map(tenant => (
                  <button className={`deployment-row ${selectedId === tenant.id ? 'active' : ''}`} key={tenant.id} onClick={() => setSelectedId(tenant.id)}>
                    <div className="tenant-cell"><TenantAvatar tenant={tenant} small /><span><b>{tenant.name}</b><small>{tenant.environment} · {tenant.teamId}</small></span></div>
                    <div><StatusPill status={tenant.status} />{tenant.status === 'deploying' && <div className="mini-progress"><i style={{ width: `${tenant.progress || 68}%` }} /></div>}</div>
                    <div className="version-cell" title={tenant.image}><code>{compactImageReference(tenant.image)}</code>{tenant.image !== tenant.desiredImage && <small title={tenant.desiredImage}>→ {compactImageReference(tenant.desiredImage)}</small>}</div>
                    <div className="knowledge-cell"><FolderGit2 size={15} /><span>{tenant.repositoryList.length}</span><small>{tenant.repositoryList.length === 1 ? 'repository' : 'repositories'}</small></div>
                    <div className="updated-cell">{tenant.updated}</div>
                    <ChevronRight className="row-arrow" size={17} />
                  </button>
                ))}
                {!filtered.length && <div className="empty-state"><Search size={24} /><b>No deployments found</b><span>Try another search or filter.</span></div>}
              </div>
            </div>

            <aside className="activity-card">
              <div className="activity-title"><div><span>Recent activity</span><small>Local fleet events</small></div><button className="icon-button" onClick={() => navigate('activity')} title="Open activity"><ExternalLink size={16} /></button></div>
              <div className="timeline">
                {activity.map((item, index) => { const Icon = item.icon; return <div className="event" key={`${item.title}-${index}`}><div className={`event-icon ${item.tone}`}><Icon size={14} /></div><div><b>{item.title}</b><span>{item.detail}</span></div></div>; })}
              </div>
              <button className="activity-link" onClick={() => navigate('activity')}>View all activity <ChevronRight size={15} /></button>
            </aside>
          </section>

          <div className="footer-note"><ShieldCheck size={15} /><span>Tenant isolation checks enabled</span><i /> <span>Configuration stored locally</span><button onClick={() => navigate('contract')}>View deployment contract <ExternalLink size={13} /></button></div>
        </div>
        }
        {pageName === 'activity' && <ActivityPage activity={activity} deployments={deployments} />}
        {pageName === 'repositories' && <RepositoriesPage deployments={deployments} onSelectTenant={openTenant} onAddRepository={addRepository} />}
        {pageName === 'access' && <AccessPage deployments={deployments} onSelectTenant={openTenant} />}
        {pageName === 'settings' && <SettingsPage deployments={deployments} onOpenContract={() => navigate('contract')} />}
        {pageName === 'contract' && <ContractPage />}
      </main>

      {pageName === 'deployments' && <DetailPanel tenant={selected} onClose={() => setSelectedId(null)} onAction={runAction} onEdit={configuration => { setEditingConfiguration(configuration); setShowNew(true); }} onNavigate={navigate} />}
      {showNew && <NewDeployment initial={editingConfiguration ?? undefined} onClose={() => { setShowNew(false); setEditingConfiguration(null); }} onCreate={createDeployment} />}
    </div>
  );
}
