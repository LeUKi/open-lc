import { useSetAtom } from 'jotai'
import { Activity, Download, ExternalLink, Eye, HelpCircle, LogIn, PauseCircle, PlayCircle, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useMemo, useState, type FormEvent } from 'react'
import { api, messageFromError, type LocalAccount, type LocalAccountCredentialExport, type LocalAccountDetail, type RiskConsentType } from '../api'
import { RiskConsentDialog } from '../components/RiskConsentDialog'
import { Button, ConfirmDialog, EmptyState, Field, InlineAlert, Input, Modal, Panel, Select, StatusBadge, Table, Textarea } from '../components/ui'
import { formatBytes, formatDateTime, formatVipRemaining } from '../lib/format'
import { errorAtom, pushNotificationAtom } from '../state'

type CredentialSource = 'cookie' | 'open_platform'
type AccountProbeData = Awaited<ReturnType<ReturnType<typeof api.api.local.accounts.probe.$post.useMutation>['mutateAsync']>>['data']

const vipSummaryText = (input?: { vipLeftSeconds?: number | null; vipExpiresAt?: Date | string | number | null } | null) => {
  const remaining = formatVipRemaining(input?.vipLeftSeconds)
  const expiresAt = formatDateTime(input?.vipExpiresAt)
  if (remaining && expiresAt) return `会员剩余 ${remaining} · 到期 ${expiresAt}`
  if (remaining) return `会员剩余 ${remaining}`
  if (expiresAt) return `会员到期 ${expiresAt}`
  return ''
}

const accountEnableBlockReason = (account: LocalAccount) => {
  if (account.status === 'active') return null
  if (account.usabilityReason === 'not_svip' || account.isSvip === false) return '账号不是 SVIP，不能启用'
  if (account.usabilityReason === 'health_not_healthy' || account.healthStatus !== 'healthy') return account.healthMessage || '账号未通过健康检测'
  if (account.usabilityReason === 'open_platform_token_invalid') return '开放平台 token 不可用'
  if (account.usabilityReason === 'cooldown') return '账号冷却中'
  return null
}

export function MyAccountsPage() {
  return <MyAccountsContent />
}

function MyAccountsContent() {
  const query = api.api.local.accounts.$get.useQuery()
  const settingsQuery = api.api.settings.$get.useQuery()
  const setError = useSetAtom(errorAtom)
  const pushNotification = useSetAtom(pushNotificationAtom)
  const [accountModalOpen, setAccountModalOpen] = useState(false)
  const [openPlatformModalOpen, setOpenPlatformModalOpen] = useState(false)
  const [pendingConsent, setPendingConsent] = useState<{
    type: RiskConsentType
    action: () => void
  } | null>(null)
  const [selectedAccountId, setSelectedAccountId] = useState<number | null>(null)
  const [exportTarget, setExportTarget] = useState<LocalAccount | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<LocalAccount | null>(null)
  const [exportResult, setExportResult] = useState<LocalAccountCredentialExport | null>(null)
  const statusMutation = api.api.local.accounts[':id'].status.$patch.useMutation()
  const healthMutation = api.api.local.accounts[':id']['health-check'].$post.useMutation()
  const tokenCheckMutation = api.api.local.accounts[':id']['token-check'].$post.useMutation()
  const exportMutation = api.api.local.accounts[':id']['export-credentials'].$post.useMutation()
  const deleteMutation = api.api.local.accounts[':id'].$delete.useMutation()
  const detailQuery = api.api.local.accounts[':id'].$get.useQuery({
    param: { id: String(selectedAccountId ?? '') },
    enabled: selectedAccountId !== null,
  })

  const refresh = async () => {
    await Promise.all([api.api.local.accounts.$get.invalidate(), api.api.local.me.$get.invalidate()])
  }

  const refreshDetailIfOpen = async (accountId: number) => {
    await refresh()
    if (selectedAccountId === accountId) await detailQuery.refetch()
  }

  const vipSummaryFor = (account: LocalAccount) => (account.credentialSource === 'open_platform' ? vipSummaryText(account) : '')

  const updateStatus = async (account: LocalAccount, status: 'active' | 'disabled') => {
    setError(null)
    try {
      await statusMutation.mutateAsync({
        param: { id: String(account.id) },
        json: { status },
      })
      await refreshDetailIfOpen(account.id)
      await api.api.broker.runtime.$get.invalidate()
      pushNotification({
        variant: 'success',
        message: status === 'active' ? '账号已启用' : '账号已禁用',
      })
    } catch (error) {
      setError(messageFromError(error, '更新账号状态失败'))
    }
  }

  const healthCheck = async (account: LocalAccount) => {
    setError(null)
    try {
      await healthMutation.mutateAsync({
        param: { id: String(account.id) },
        json: {},
      })
      await refreshDetailIfOpen(account.id)
      await api.api.broker.runtime.$get.invalidate()
      pushNotification({
        variant: 'success',
        message: '健康检测已完成',
      })
    } catch (error) {
      setError(messageFromError(error, '健康检测失败'))
    }
  }

  const tokenCheck = async (account: LocalAccount) => {
    setError(null)
    try {
      await tokenCheckMutation.mutateAsync({
        param: { id: String(account.id) },
        json: {},
      })
      await refreshDetailIfOpen(account.id)
      pushNotification({
        variant: 'success',
        message: 'Token 校验已完成',
      })
    } catch (error) {
      setError(messageFromError(error, 'Token 校验失败'))
    }
  }

  const remove = async (account: LocalAccount) => {
    setError(null)
    try {
      await deleteMutation.mutateAsync({
        param: { id: String(account.id) },
      })
      if (selectedAccountId === account.id) setSelectedAccountId(null)
      setDeleteTarget(null)
      await refresh()
    } catch (error) {
      setError(messageFromError(error, '删除账号失败'))
    }
  }

  const exportCredentials = async () => {
    if (!exportTarget) return
    setError(null)
    try {
      const result = await exportMutation.mutateAsync({
        param: { id: String(exportTarget.id) },
        json: {},
      })
      setExportTarget(null)
      setExportResult(result.data)
      await refreshDetailIfOpen(exportTarget.id)
      await api.api.broker.runtime.$get.invalidate()
      pushNotification({
        variant: 'success',
        message: '凭据已导出，账号已自动禁用',
      })
    } catch (error) {
      setError(messageFromError(error, '导出凭据失败'))
    }
  }

  const items = query.data?.data ?? []
  const showCookieAccountAddButton = settingsQuery.data?.data.items.showCookieAccountAddButton?.value === 'true'
  const selectedAccount = useMemo(() => items.find((item) => item.id === selectedAccountId) ?? null, [items, selectedAccountId])

  const securityStatusQuery = api.api.security.status.$get.useQuery()
  const ensureConsent = (type: RiskConsentType, action: () => void) => {
    if (securityStatusQuery.data?.data.riskConsents[type]) {
      action()
      return
    }
    setPendingConsent({ type, action })
  }

  return (
    <div className="grid gap-5">
      <Panel className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-bold">账号</h2>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => ensureConsent('open_platform_account', () => setOpenPlatformModalOpen(true))}>
              <LogIn className="size-4" />
              添加开放平台
            </Button>
            {showCookieAccountAddButton ? (
              <Button onClick={() => ensureConsent('cookie_account', () => setAccountModalOpen(true))} variant="secondary">
                <Plus className="size-4" />
                添加 Cookie
              </Button>
            ) : null}
          </div>
        </div>
        {query.isPending ? (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">账号列表加载中...</div>
        ) : items.length === 0 ? (
          <EmptyState title="还没有账号" />
        ) : (
          <Table>
            <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
              <tr>
                <th className="p-3">账号</th>
                <th className="p-3">来源</th>
                <th className="p-3">状态</th>
                <th className="p-3">最近状态</th>
                <th className="p-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {items.map((account) => {
                const vipSummary = vipSummaryFor(account)
                const enableBlockReason = accountEnableBlockReason(account)
                return (
                  <tr key={account.id}>
                    <td className="p-3">
                      <div className="font-semibold">{account.baiduName || account.label}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        #{account.id} · uk {account.uk || '-'} · 权重 {account.weight}
                      </div>
                      {account.reason ? <div className="mt-1 max-w-[320px] break-words text-xs text-red-600">{account.reason}</div> : null}
                    </td>
                    <td className="p-3 text-sm text-slate-600">{account.credentialSource === 'open_platform' ? '开放平台' : 'Cookie'}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-2">
                        <StatusBadge status={account.status} />
                        <StatusBadge status={account.healthStatus || 'unknown'} />
                        <StatusBadge status={account.isSvip ? 'SVIP' : '非 SVIP'} />
                        {account.credentialSource === 'open_platform' ? <StatusBadge status={account.tokenStatus || 'unknown'} /> : null}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">剩余空间 {formatBytes(account.quotaFreeBytes ?? 0)}</div>
                      {vipSummary ? <div className="mt-1 text-xs text-slate-500">{vipSummary}</div> : null}
                      {account.healthMessage ? <div className="mt-1 max-w-[320px] break-words text-xs text-slate-500">{account.healthMessage}</div> : null}
                    </td>
                    <td className="p-3 text-xs text-slate-500">
                      <div>成功 {formatDateTime(account.lastSuccessAt)}</div>
                      <div className="mt-1">
                        失败 {account.lastFailureCode || '-'} · 冷却至 {formatDateTime(account.cooldownUntil) || '-'}
                      </div>
                      <div className="mt-1">Token {formatDateTime(account.tokenCheckedAt) || '-'}</div>
                      <div className="mt-1">健康检测 {formatDateTime(account.healthCheckedAt) || '-'}</div>
                    </td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-2">
                        <Button onClick={() => setSelectedAccountId(account.id)} size="sm" variant="secondary">
                          详情
                        </Button>
                        <Button
                          disabled={statusMutation.isPending || Boolean(enableBlockReason)}
                          onClick={() => updateStatus(account, account.status === 'active' ? 'disabled' : 'active')}
                          size="sm"
                          title={enableBlockReason ?? undefined}
                          variant="secondary"
                        >
                          {account.status === 'active' ? <PauseCircle className="size-4" /> : <PlayCircle className="size-4" />}
                          {account.status === 'active' ? '禁用' : '启用'}
                        </Button>
                        <Button disabled={healthMutation.isPending} onClick={() => healthCheck(account)} size="sm" variant="secondary">
                          <Activity className="size-4" />
                          健康检测
                        </Button>
                        {account.credentialSource === 'open_platform' ? (
                          <Button disabled={tokenCheckMutation.isPending} onClick={() => tokenCheck(account)} size="sm" variant="secondary">
                            <RefreshCw className="size-4" />
                            Token 校验
                          </Button>
                        ) : null}
                        <Button disabled={exportMutation.isPending} onClick={() => setExportTarget(account)} size="sm" variant="secondary">
                          <Download className="size-4" />
                          导出凭据
                        </Button>
                        <Button disabled={deleteMutation.isPending} onClick={() => setDeleteTarget(account)} size="sm" variant="danger">
                          <Trash2 className="size-4" />
                          删除
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
        )}
      </Panel>

      {selectedAccount ? (
        <OwnedAccountDetailCard
          account={selectedAccount}
          detail={detailQuery.data?.data as LocalAccountDetail | undefined}
          loading={detailQuery.isPending}
          onClose={() => setSelectedAccountId(null)}
        />
      ) : null}

      <Modal open={accountModalOpen} title="添加 Cookie 账号" onClose={() => setAccountModalOpen(false)} maxWidthClassName="max-w-3xl">
        <OwnedAccountForm
          credentialSource="cookie"
          onDone={async () => {
            await refresh()
            setAccountModalOpen(false)
          }}
        />
      </Modal>

      <Modal open={openPlatformModalOpen} title="添加开放平台账号" onClose={() => setOpenPlatformModalOpen(false)} maxWidthClassName="max-w-5xl">
        <OwnedOpenPlatformForm
          onDone={async () => {
            await refresh()
            setOpenPlatformModalOpen(false)
          }}
        />
      </Modal>

      <RiskConsentDialog
        open={pendingConsent !== null}
        type={pendingConsent?.type ?? null}
        onAccepted={() => {
          const action = pendingConsent?.action
          setPendingConsent(null)
          action?.()
        }}
        onCancel={() => setPendingConsent(null)}
      />

      <ConfirmDialog
        open={exportTarget !== null}
        title="导出账号凭据"
        description="账号凭据可用于访问对应账号。请只在确实需要迁移或备份时导出；导出后系统会暂停该账号，避免继续参与任务。"
        confirmLabel="确认导出"
        disabled={exportMutation.isPending}
        onCancel={() => setExportTarget(null)}
        onConfirm={() => {
          void exportCredentials()
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除账号"
        description={
          deleteTarget?.tempFiles?.unresolved
            ? `该账号还有 ${deleteTarget.tempFiles.unresolved} 条未清理中转文件。删除账号后这些文件可能变成孤儿记录，Agent 将无法继续自动删除，需要你到百度网盘手动清理。`
            : '将删除该账号及其本地凭据，历史记录会保留。'
        }
        confirmLabel="确认删除"
        disabled={deleteMutation.isPending}
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => {
          if (deleteTarget) void remove(deleteTarget)
        }}
      />

      <CredentialExportModal data={exportResult} onClose={() => setExportResult(null)} />
    </div>
  )
}

function OwnedAccountForm({ credentialSource, onDone }: { credentialSource: CredentialSource; onDone: () => Promise<void> }) {
  const [label, setLabel] = useState('')
  const [weight, setWeight] = useState('100')
  const [cookie, setCookie] = useState('')
  const [probe, setProbe] = useState<AccountProbeData | null>(null)
  const setError = useSetAtom(errorAtom)
  const probeMutation = api.api.local.accounts.probe.$post.useMutation()
  const createMutation = api.api.local.accounts.$post.useMutation()

  const runProbe = async () => {
    setError(null)
    try {
      const result = await probeMutation.mutateAsync({
        json: {
          credentialSource,
          cookie,
        },
      })
      setProbe(result.data)
    } catch (error) {
      setProbe(null)
      setError(messageFromError(error, '检测账号失败'))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!probe) return
    setError(null)
    try {
      await createMutation.mutateAsync({
        json: {
          credentialSource,
          label,
          weight,
          cookie,
        },
      })
      await onDone()
    } catch (error) {
      setError(messageFromError(error, '添加账号失败'))
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Field label="名称">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="可缺省" />
      </Field>
      <Field label="权重">
        <Input min="1" type="number" value={weight} onChange={(event) => setWeight(event.target.value)} />
      </Field>
      <Field label="完整 Cookie">
        <Textarea
          className="min-h-32"
          value={cookie}
          onChange={(event) => {
            setCookie(event.target.value)
            setProbe(null)
          }}
          placeholder="BDUSS=...; STOKEN=..."
        />
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!cookie.trim() || probeMutation.isPending} onClick={runProbe} type="button" variant="secondary">
          <Activity className="size-4" />
          检测账号
        </Button>
        <Button disabled={!probe || createMutation.isPending} type="submit">
          <Plus className="size-4" />
          添加账号
        </Button>
      </div>
      <ProbeResultCard probe={probe} />
    </form>
  )
}

function OwnedOpenPlatformForm({ onDone }: { onDone: () => Promise<void> }) {
  const [label, setLabel] = useState('')
  const [weight, setWeight] = useState('100')
  const [refreshToken, setRefreshToken] = useState('')
  const [openPlatformClientKey, setOpenPlatformClientKey] = useState('')
  const [openPlatformSecretKey, setOpenPlatformSecretKey] = useState('')
  const [openPlatformServerUse, setOpenPlatformServerUse] = useState(false)
  const [openListHelpOpen, setOpenListHelpOpen] = useState(false)
  const [probe, setProbe] = useState<AccountProbeData | null>(null)
  const setError = useSetAtom(errorAtom)
  const probeMutation = api.api.local.accounts.probe.$post.useMutation()
  const createMutation = api.api.local.accounts.$post.useMutation()
  const canSubmitCredential = openPlatformServerUse || (openPlatformClientKey.trim() && openPlatformSecretKey.trim())
  const resetProbe = () => setProbe(null)
  const setOpenListServerUse = (next: boolean) => {
    setOpenPlatformServerUse(next)
    if (next) {
      setOpenPlatformClientKey('')
      setOpenPlatformSecretKey('')
    }
    resetProbe()
  }

  const runProbe = async () => {
    setError(null)
    try {
      const result = await probeMutation.mutateAsync({
        json: {
          credentialSource: 'open_platform',
          refreshToken,
          openPlatformClientKey,
          openPlatformSecretKey,
          openPlatformServerUse,
        },
      })
      setProbe(result.data)
    } catch (error) {
      setProbe(null)
      setError(messageFromError(error, '检测开放平台账号失败'))
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!probe) return
    setError(null)
    try {
      await createMutation.mutateAsync({
        json: {
          credentialSource: 'open_platform',
          label,
          weight,
          refreshToken,
          openPlatformClientKey,
          openPlatformSecretKey,
          openPlatformServerUse,
        },
      })
      await onDone()
    } catch (error) {
      setError(messageFromError(error, '添加开放平台账号失败'))
    }
  }

  return (
    <form className="grid gap-4" onSubmit={submit}>
      <Field label="名称">
        <Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="可缺省" />
      </Field>
      <Field label="权重">
        <Input min="1" type="number" value={weight} onChange={(event) => setWeight(event.target.value)} />
      </Field>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <div className="font-semibold text-slate-800">使用 OpenList 提供的令牌获取工具</div>
          <button
            aria-label="查看 OpenList 令牌获取工具教程"
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-white hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            onClick={() => setOpenListHelpOpen(true)}
            title="查看教程"
            type="button"
          >
            <HelpCircle className="size-4" />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <a
            className="inline-flex min-h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 ring-1 ring-blue-100 transition hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-200"
            href="https://api.oplist.org/"
            rel="noreferrer"
            target="_blank"
          >
            <ExternalLink className="size-3.5" />
            api.oplist.org
          </a>
          <div className="flex items-center gap-1 rounded-lg bg-slate-100 p-1" aria-label="OpenList 令牌获取工具启用状态">
            {[
              { value: true, label: '启用' },
              { value: false, label: '关闭' },
            ].map((item) => {
              const active = openPlatformServerUse === item.value
              return (
                <button
                  aria-pressed={active}
                  className={`inline-flex min-h-7 items-center justify-center rounded-md px-2.5 py-1 text-xs font-semibold transition ${
                    active ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                  }`}
                  key={item.label}
                  onClick={() => setOpenListServerUse(item.value)}
                  type="button"
                >
                  {item.label}
                </button>
              )
            })}
          </div>
        </div>
      </div>
      <Field label="refresh_token">
        <Textarea
          className="min-h-32"
          value={refreshToken}
          onChange={(event) => {
            setRefreshToken(event.target.value)
            resetProbe()
          }}
          placeholder="122.xxxxxx..."
        />
      </Field>
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="AppKey / AK">
          <Input
            disabled={openPlatformServerUse}
            value={openPlatformClientKey}
            onChange={(event) => {
              setOpenPlatformClientKey(event.target.value)
              resetProbe()
            }}
          />
        </Field>
        <Field label="SecretKey / SK">
          <Input
            disabled={openPlatformServerUse}
            type="password"
            value={openPlatformSecretKey}
            onChange={(event) => {
              setOpenPlatformSecretKey(event.target.value)
              resetProbe()
            }}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button disabled={!refreshToken.trim() || !canSubmitCredential || probeMutation.isPending} onClick={runProbe} type="button" variant="secondary">
          <Activity className="size-4" />
          检测账号
        </Button>
        <Button disabled={!probe || createMutation.isPending} type="submit">
          <LogIn className="size-4" />
          添加账号
        </Button>
      </div>
      <ProbeResultCard openPlatform probe={probe} />
      <OpenListTokenHelpModal open={openListHelpOpen} onClose={() => setOpenListHelpOpen(false)} />
    </form>
  )
}

function OpenListTokenHelpModal({ onClose, open }: { open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} title="OpenList 令牌获取工具教程" onClose={onClose} maxWidthClassName="max-w-lg">
      <div className="grid gap-4 text-sm leading-6 text-slate-600">
        <ol className="grid list-decimal gap-2 pl-5">
          <li>
            打开{' '}
            <a className="font-semibold text-blue-700 hover:text-blue-800" href="https://api.oplist.org/" rel="noreferrer" target="_blank">
              https://api.oplist.org/
            </a>
            。
          </li>
          <li>选择“百度网盘（OAuth2）验证登录”。</li>
          <li>勾选“使用 OpenList 提供的令牌获取工具”。</li>
          <li>点击“获取 token”，按页面提示完成登录跳转。</li>
          <li>回到原页面后，复制 122. 开头的刷新令牌（Refresh Token），粘贴到本表单的 refresh_token。</li>
        </ol>
        <InlineAlert variant="warning">OpenList 令牌获取工具由第三方提供，请确认你理解并接受相关风险后再使用。</InlineAlert>
      </div>
    </Modal>
  )
}

function ProbeResultCard({ openPlatform = false, probe }: { openPlatform?: boolean; probe: AccountProbeData | null }) {
  if (!probe) return null
  const vipSummary = vipSummaryText(probe.health)
  return (
    <div className="grid gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
      <div className="font-bold">
        {probe.action === 'update'
          ? `检测通过，将更新账号 #${probe.existingAccountId}`
          : openPlatform
            ? '检测通过，可添加开放平台账号'
            : '检测通过，可添加账号'}
      </div>
      <div>
        {probe.health.baiduName || '未命名'} · uk {probe.health.uk || '-'}
      </div>
      <div>
        SVIP {probe.health.isSvip ? '是' : '否'} · 剩余空间 {formatBytes(probe.health.quotaFreeBytes ?? 0)}
      </div>
      {vipSummary ? <div>{vipSummary}</div> : null}
      {openPlatform && probe.health.tokenExpiresAt ? <div>access_token 到期 {formatDateTime(probe.health.tokenExpiresAt)}</div> : null}
    </div>
  )
}

function CredentialExportModal({ data, onClose }: { data: LocalAccountCredentialExport | null; onClose: () => void }) {
  const content = data ? JSON.stringify(data, null, 2) : ''
  const filename = data
    ? `lc-agent-account-${data.account.id}-${new Date(data.exportedAt).toISOString().replace(/[:.]/g, '-')}.json`
    : 'lc-agent-account-credentials.json'

  const download = () => {
    if (!content) return
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    document.body.appendChild(anchor)
    anchor.click()
    document.body.removeChild(anchor)
    URL.revokeObjectURL(url)
  }

  return (
    <Modal open={data !== null} title="账号凭据已导出" description="请妥善保存导出的内容。该账号已经自动禁用。" onClose={onClose} maxWidthClassName="max-w-4xl">
      <div className="grid gap-4">
        <InlineAlert variant="warning">导出内容包含敏感凭据，任何获得该文件的人都可能使用对应账号能力。</InlineAlert>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="text-sm text-slate-600">
            {data
              ? `${data.account.baiduName || data.account.label || `账号 #${data.account.id}`} · ${data.account.credentialSource === 'open_platform' ? '开放平台' : 'Cookie'}`
              : ''}
          </div>
          <Button onClick={download}>
            <Download className="size-4" />
            下载 JSON
          </Button>
        </div>
        <div className="rounded-lg border border-slate-200 bg-slate-950">
          <div className="flex items-center gap-2 border-b border-slate-800 px-3 py-2 text-xs font-semibold text-slate-300">
            <Eye className="size-4" />
            导出内容
          </div>
          <pre className="max-h-[52vh] overflow-auto p-3 text-xs leading-5 text-slate-100">{content}</pre>
        </div>
      </div>
    </Modal>
  )
}

function OwnedAccountDetailCard({
  account,
  detail,
  loading,
  onClose,
}: {
  account: LocalAccount
  detail?: LocalAccountDetail
  loading: boolean
  onClose: () => void
}) {
  const credentialMode =
    detail?.account.credentialSource === 'open_platform' ? (detail.account.openPlatformServerUse === false ? '自定义 AK/SK' : 'OpenList 参数') : 'Cookie'

  return (
    <Panel className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold">{account.baiduName || account.label}</h3>
        </div>
        <Button onClick={onClose} variant="ghost">
          收起
        </Button>
      </div>
      {loading || !detail ? (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-sm text-slate-500">账号详情加载中...</div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <Metric label="状态" value={detail.account.status} />
            <Metric label="健康" value={detail.account.healthStatus || '-'} />
            <Metric label="最近失败码" value={detail.account.lastFailureCode || '-'} />
            <Metric label="凭证模式" value={credentialMode} />
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4 text-sm text-slate-600">
            <Info label="会员到期" value={formatDateTime(detail.account.vipExpiresAt)} />
            <Info label="最近健康检测" value={formatDateTime(detail.account.healthCheckedAt)} />
            <Info label="最近成功" value={formatDateTime(detail.account.lastSuccessAt)} />
            <Info label="最近失败" value={formatDateTime(detail.account.lastFailureAt)} />
            <Info label="最近 Token 校验" value={formatDateTime(detail.account.tokenCheckedAt)} />
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            <SimpleList
              title="最近解析"
              empty="暂无解析记录"
              rows={detail.records.map((row) => `${row.filename} · ${row.parseRoute ? `${row.credentialSource}.${row.parseRoute}` : '-'} · ${row.status}`)}
            />
            <SimpleList
              title="最近尝试 / 健康 / Token"
              empty="暂无运行记录"
              rows={[
                ...detail.attempts.map((row) => `${row.status} · ${row.errorCode || '-'} · ${formatDateTime(row.createdAt)}`),
                ...detail.healthChecks.map((row) => `health ${row.status} · ${row.code || '-'} · ${formatDateTime(row.createdAt)}`),
                ...detail.tokenEvents.map((row) => `token ${row.status} · ${row.action} · ${formatDateTime(row.createdAt)}`),
              ].slice(0, 20)}
            />
          </div>
        </>
      )}
    </Panel>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2.5">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-bold text-slate-900">{value}</div>
    </div>
  )
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="text-xs font-semibold text-slate-500">{label}</div>
      <div className="mt-1 text-sm text-slate-700">{value || '-'}</div>
    </div>
  )
}

function SimpleList({ title, rows, empty }: { title: string; rows: string[]; empty: string }) {
  return (
    <div className="rounded-lg border border-slate-200">
      <div className="border-b border-slate-200 px-3 py-2 text-sm font-semibold text-slate-700">{title}</div>
      {rows.length === 0 ? (
        <div className="px-3 py-4 text-sm text-slate-500">{empty}</div>
      ) : (
        <div className="divide-y divide-slate-100">
          {rows.map((row, index) => (
            <div className="px-3 py-2 text-sm text-slate-600" key={`${title}-${index}`}>
              {row}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
