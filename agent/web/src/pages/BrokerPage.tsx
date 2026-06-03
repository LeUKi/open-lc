import { useSetAtom } from 'jotai'
import { type ChangeEvent, useEffect, useState, type ReactNode } from 'react'
import { Eye, Play, Radio, RefreshCw } from 'lucide-react'
import { api, messageFromError, type BrokerRun, type BrokerRuntime } from '../api'
import { BrokerRunDetailDrawer } from '../components/BrokerRunDetailDrawer'
import { Button, EmptyState, InlineAlert, Input, MiddleEllipsis, Panel, Select, StatusBadge, Table } from '../components/ui'
import { formatBytes, formatDateTime } from '../lib/format'
import { errorAtom, pushNotificationAtom } from '../state'

const sourceLabel = (source?: string | null) => {
  if (source === 'database') return '页面'
  if (source === 'env') return '环境变量'
  return '默认值'
}

const currentFailureSignature = (broker: BrokerRuntime['broker']) => {
  if (broker.lastHeartbeatStatus === 'failed' && (broker.lastHeartbeatErrorCode || broker.lastHeartbeatErrorMessage || broker.lastHeartbeatAt)) {
    return ['heartbeat', broker.lastHeartbeatErrorCode ?? '', broker.lastHeartbeatErrorMessage ?? '', broker.lastHeartbeatAt ?? ''].join(':')
  }
  if (broker.lastPollStatus === 'failed' && (broker.lastPollErrorCode || broker.lastPollErrorMessage || broker.lastPollAt)) {
    return ['poll', broker.lastPollErrorCode ?? '', broker.lastPollErrorMessage ?? '', broker.lastPollAt ?? ''].join(':')
  }
  return null
}

const currentFailureMessage = (broker: BrokerRuntime['broker']) => {
  if (broker.lastHeartbeatStatus === 'failed') return broker.lastHeartbeatErrorMessage || broker.lastError || '最近一次 Heartbeat 失败。'
  if (broker.lastPollStatus === 'failed') return broker.lastPollErrorMessage || broker.lastError || '最近一次 Poll 失败。'
  return null
}

const runtimeStateLabel = (state?: string) => {
  if (state === 'running') return '运行中'
  if (state === 'disabled') return '未启用'
  if (state === 'misconfigured') return '未配置'
  if (state === 'paused_no_usable_accounts') return '无可用账号'
  if (state === 'maintenance_stopping') return '维护中'
  return '未知'
}

const runtimeDiagnosis = (runtime: BrokerRuntime) => {
  const broker = runtime.broker
  if (!broker.agentTokenConfigured) return { variant: 'warning' as const, message: 'Agent Token 未配置，Broker 不会接收心跳或任务轮询。' }
  if (!broker.baseUrl) return { variant: 'warning' as const, message: 'Broker Base URL 未配置，Agent 无法发起连接。' }
  if (!broker.enabled) return { variant: 'warning' as const, message: 'Broker 执行未启用，自动心跳和 Poll 不会运行。' }
  if (runtime.runtime.state === 'paused_no_usable_accounts') {
    return { variant: 'warning' as const, message: runtime.runtime.stateMessage || '无可用 SVIP 账号，Broker 执行已暂停。' }
  }
  if (
    (broker.lastHeartbeatStatus === 'failed' && broker.lastHeartbeatErrorCode === 'INVALID_AGENT_TOKEN') ||
    (broker.lastPollStatus === 'failed' && broker.lastPollErrorCode === 'INVALID_AGENT_TOKEN')
  ) {
    return { variant: 'error' as const, message: 'Broker 拒绝了当前 Bearer token。通常是复制了旧 token、Broker 端已轮换 token，或当前 Agent 已被禁用。' }
  }
  if (broker.lastHeartbeatStatus === 'failed' || broker.lastPollStatus === 'failed') {
    return { variant: 'error' as const, message: broker.lastError || '最近一次 Broker 请求失败。' }
  }
  if (broker.lastHeartbeatStatus === 'idle' && broker.lastPollStatus === 'idle') {
    return { variant: 'warning' as const, message: 'Broker Runtime 已启动，但还没有成功的 Heartbeat 或 Poll 记录。' }
  }
  return null
}

const runTitle = (run: Pick<BrokerRun, 'taskId' | 'payloadSummary'>) => run.payloadSummary?.fileName || `Task ${run.taskId}`

const runStatuses = [
  'idle',
  'polling',
  'participating',
  'waiting',
  'active',
  'parsing',
  'submitting',
  'success',
  'failed',
  'not_selected',
  'expired',
  'submitted_success',
  'submitted_failure',
] as const

export function BrokerPage() {
  const setError = useSetAtom(errorAtom)
  const pushNotification = useSetAtom(pushNotificationAtom)
  const [dismissedFailureSignature, setDismissedFailureSignature] = useState<string | null>(null)
  const [filters, setFilters] = useState({ status: '', q: '', page: 1 })
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null)
  const runtimeQuery = api.api.broker.runtime.$get.useQuery({
    refetchInterval: 5000,
  })
  const historyQuery = api.api.broker.history.$get.useQuery({
    query: {
      status: filters.status || undefined,
      q: filters.q || undefined,
      page: String(filters.page),
      pageSize: '20',
    },
  })
  const heartbeatMutation = api.api.broker.heartbeat.$post.useMutation()
  const pollMutation = api.api.broker.poll.$post.useMutation()

  const runtime = runtimeQuery.data?.data
  const broker = runtime?.broker
  const history = historyQuery.data?.data
  const records = history?.records ?? []
  const activeRuns = runtime?.activeRuns ?? []
  const failureSignature = broker ? currentFailureSignature(broker) : null
  const failureMessage = broker ? currentFailureMessage(broker) : null
  const diagnosis = runtime ? runtimeDiagnosis(runtime) : null
  const brokerActionsDisabled = !broker || runtime?.runtime.state !== 'running'
  const brokerActionTitle = runtime?.runtime.state === 'paused_no_usable_accounts' ? '无可用 SVIP 账号，已暂停 Heartbeat 和 Poll' : undefined

  useEffect(() => {
    if (!failureSignature) {
      setDismissedFailureSignature(null)
      return
    }
    if (dismissedFailureSignature !== failureSignature && failureMessage) {
      pushNotification({
        variant: 'error',
        message: failureMessage,
      })
      setDismissedFailureSignature(failureSignature)
    }
  }, [dismissedFailureSignature, failureMessage, failureSignature, pushNotification])

  const heartbeat = async () => {
    setError(null)
    try {
      await heartbeatMutation.mutateAsync({ json: {} })
      await Promise.all([runtimeQuery.refetch(), historyQuery.refetch()])
    } catch (error) {
      setError(messageFromError(error, 'Broker heartbeat 失败'))
    }
  }

  const poll = async () => {
    setError(null)
    try {
      await pollMutation.mutateAsync({ json: {} })
      await Promise.all([runtimeQuery.refetch(), historyQuery.refetch()])
    } catch (error) {
      setError(messageFromError(error, 'Broker poll 失败'))
    }
  }

  const refreshRuntime = async () => {
    setError(null)
    try {
      await Promise.all([runtimeQuery.refetch(), historyQuery.refetch()])
    } catch (error) {
      setError(messageFromError(error, 'Broker 执行状态刷新失败'))
    }
  }

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-bold">Broker 执行</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
            {runtimeQuery.isFetching ? '刷新中' : '自动刷新 5 秒'}
          </span>
          <Button disabled={runtimeQuery.isFetching} onClick={refreshRuntime} size="sm" variant="secondary">
            <RefreshCw className={`size-4 ${runtimeQuery.isFetching ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </div>

      <Panel className="grid gap-4">
        {diagnosis ? <InlineAlert variant={diagnosis.variant}>{diagnosis.message}</InlineAlert> : null}
        <div className="grid gap-3 md:grid-cols-4">
          <MetricCard
            action={
              <Button
                className="w-full"
                disabled={brokerActionsDisabled || heartbeatMutation.isPending || runtime?.runtime.heartbeatLoopRunning}
                onClick={heartbeat}
                size="sm"
                title={brokerActionTitle}
                variant="secondary"
              >
                <Radio className="size-4" />
                {runtime?.runtime.heartbeatLoopRunning ? 'Heartbeat 中' : 'Heartbeat'}
              </Button>
            }
            label="心跳"
            value={broker?.lastHeartbeatStatus ?? 'idle'}
            detail={formatDateTime(broker?.lastHeartbeatAt)}
          />
          <MetricCard
            action={
              <Button
                className="w-full"
                disabled={brokerActionsDisabled || pollMutation.isPending || runtime?.runtime.pollLoopRunning}
                onClick={poll}
                size="sm"
                title={brokerActionTitle}
                variant="secondary"
              >
                <Play className="size-4" />
                {runtime?.runtime.pollLoopRunning ? 'Poll 中' : '执行一轮 Poll'}
              </Button>
            }
            label="Poll"
            value={broker?.lastPollStatus ?? 'idle'}
            detail={formatDateTime(broker?.lastPollAt)}
          />
          <MetricCard
            label="可用账号"
            value={runtime?.runtime.usableAccountCount ?? 0}
            detail={`不可用 ${runtime?.runtime.blockedAccountCount ?? 0} · 并发空位 ${runtime?.runtime.capacity ?? 0}/${runtime?.runtime.maxConcurrentRuns ?? 0}`}
          />
          <MetricCard
            label="Runtime"
            value={runtimeStateLabel(runtime?.runtime.state)}
            detail={runtime?.runtime.stateMessage || (runtime?.runtime.started ? 'Runtime 已启动' : 'Runtime 未启动')}
          />
        </div>
        {broker ? (
          <div className="grid gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-4 text-sm text-slate-600 md:grid-cols-2 xl:grid-cols-4">
            <RuntimeCell label="Broker Base URL" meta={`来源 ${sourceLabel(broker.baseUrlSource)}`} value={broker.baseUrl || '-'} />
            <RuntimeCell label="Agent Token" meta={`来源 ${sourceLabel(broker.agentTokenSource)}`} value={broker.agentTokenConfigured ? '已配置' : '未配置'} />
            <RuntimeCell label="启用状态" meta={`来源 ${sourceLabel(broker.enabledSource)}`} value={broker.enabled ? '已启用' : '未启用'} />
            <RuntimeCell
              label="运行锁"
              meta={`Heartbeat ${runtime?.runtime.heartbeatLoopStartedAt ? formatDateTime(runtime.runtime.heartbeatLoopStartedAt) : '-'} · Poll ${
                runtime?.runtime.pollLoopStartedAt ? formatDateTime(runtime.runtime.pollLoopStartedAt) : '-'
              }`}
              value={[
                runtime?.runtime.heartbeatLoopRunning ? 'Heartbeat 运行中' : 'Heartbeat 空闲',
                runtime?.runtime.pollLoopRunning ? 'Poll 运行中' : 'Poll 空闲',
              ].join(' · ')}
            />
            <RuntimeCell
              label="最近请求"
              meta={broker.lastRequestBaseUrl || '-'}
              value={[`Heartbeat ${broker.lastHeartbeatHttpStatus ?? '-'}`, `Poll ${broker.lastPollHttpStatus ?? '-'}`].join(' · ')}
            />
          </div>
        ) : null}
      </Panel>

      <Panel className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-lg font-bold">执行记录</h3>
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-500">
            <RefreshCw className="size-4" />
            {historyQuery.isFetching ? '刷新中' : `共 ${history?.total ?? 0} 条`}
          </div>
        </div>
        <div className="grid gap-3 md:grid-cols-[180px_minmax(0,1fr)_auto]">
          <Field label="状态">
            <Select
              value={filters.status}
              onChange={(event: ChangeEvent<HTMLSelectElement>) => setFilters((prev) => ({ ...prev, status: event.target.value, page: 1 }))}
            >
              <option value="">全部</option>
              {runStatuses.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="搜索">
            <Input
              value={filters.q}
              onChange={(event: ChangeEvent<HTMLInputElement>) => setFilters((prev) => ({ ...prev, q: event.target.value, page: 1 }))}
              placeholder="Task / Participation / 文件名 / 错误码 / 消息"
            />
          </Field>
          <div className="flex items-end">
            <Button className="w-full" disabled={historyQuery.isFetching} onClick={() => historyQuery.refetch()} variant="secondary">
              <RefreshCw className={`size-4 ${historyQuery.isFetching ? 'animate-spin' : ''}`} />
              刷新列表
            </Button>
          </div>
        </div>
        {!history || records.length === 0 ? (
          <EmptyState title="暂无执行记录" />
        ) : (
          <div className="grid gap-3">
            <RunTable runs={records} onOpenDetail={setSelectedRunId} />
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
              <span>
                第 {history.page} / {history.totalPages} 页，共 {history.total} 条
              </span>
              <div className="flex gap-2">
                <Button disabled={filters.page <= 1} onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))} size="sm" variant="secondary">
                  上一页
                </Button>
                <Button
                  disabled={filters.page >= history.totalPages}
                  onClick={() => setFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
                  size="sm"
                  variant="secondary"
                >
                  下一页
                </Button>
              </div>
            </div>
          </div>
        )}
      </Panel>
      <BrokerRunDetailDrawer open={selectedRunId !== null} runId={selectedRunId} onClose={() => setSelectedRunId(null)} />
    </div>
  )
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid gap-1 text-sm font-semibold text-slate-600">
      <span>{label}</span>
      {children}
    </label>
  )
}

function MetricCard({ label, value, detail, action }: { label: string; value: string | number; detail?: string; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className="mt-1 text-xl font-bold text-slate-900">{value}</div>
      {detail ? <div className="mt-1 truncate text-xs text-slate-500">{detail}</div> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

function RuntimeCell({ label, value, meta }: { label: string; value: string; meta: string }) {
  return (
    <div>
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className="mt-1 break-all font-semibold text-slate-900">{value}</div>
      <div className="mt-1 text-xs text-slate-500 break-all">{meta}</div>
    </div>
  )
}

function RunTable({ runs, onOpenDetail }: { runs: BrokerRun[]; onOpenDetail: (runId: string) => void }) {
  return (
    <Table>
      <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
        <tr>
          <th className="p-3">文件</th>
          <th className="p-3">状态</th>
          <th className="p-3">失败码</th>
          <th className="p-3">时间</th>
          <th className="p-3">操作</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {runs.map((run) => (
          <tr key={run.id}>
            <td className="p-3">
              <MiddleEllipsis text={runTitle(run)} className="font-semibold" maxWidthPx={320} copyable={!run.payloadSummary?.fileName} />
              <div className="mt-1 text-xs text-slate-500">Task {run.taskId}</div>
              {run.payloadSummary ? (
                <div className="mt-1 text-xs text-slate-500">
                  {run.payloadSummary.provider} · {formatBytes(run.payloadSummary.fileSizeBytes)}
                </div>
              ) : null}
              {run.message ? <div className="mt-1 max-w-[360px] truncate text-xs text-slate-600">{run.message}</div> : null}
            </td>
            <td className="p-3">
              <StatusBadge status={run.status} />
            </td>
            <td className="p-3 text-sm text-slate-600">{run.failureCode || '-'}</td>
            <td className="p-3 text-sm text-slate-600">{formatDateTime(run.updatedAt)}</td>
            <td className="p-3">
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => onOpenDetail(run.id)} size="sm" variant="secondary">
                  <Eye className="size-4" />
                  详情
                </Button>
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  )
}
