import { useSetAtom } from 'jotai'
import { CheckSquare, Clipboard, Eye, RefreshCw, RotateCcw, Square, Trash2 } from 'lucide-react'
import { useState, type ChangeEvent } from 'react'
import { api, messageFromError, type LocalHistoryRecord, type TempFilesCleanupResult } from '../api'
import { DownloaderSendButton } from '../components/DownloaderSendButton'
import { HistoryDetailDrawer } from '../components/HistoryDetailDrawer'
import { TempFileCleanupProgressModal } from '../components/TempFileCleanupProgress'
import { Button, ConfirmDialog, CopyButton, EmptyState, Field, Input, MiddleEllipsis, Panel, Select, StatusBadge, Table } from '../components/ui'
import { formatBytes, formatDateTime } from '../lib/format'
import { downloadableFromHistoryRecord } from '../lib/history'
import {
  parseDownloaders,
  sendManyToDownloader,
  serializeDownloaders,
  summarizeSendResults,
  type DownloadableItem,
  type DownloaderConfig,
} from '../lib/downloaders'
import { errorAtom, pushNotificationAtom } from '../state'

export function HistoryPage() {
  const [selectedRecordId, setSelectedRecordId] = useState<number | null>(null)
  const [selectedDownloadIds, setSelectedDownloadIds] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const [confirmTempCleanup, setConfirmTempCleanup] = useState(false)
  const [tempCleanupProgressOpen, setTempCleanupProgressOpen] = useState(false)
  const [tempCleanupResult, setTempCleanupResult] = useState<TempFilesCleanupResult | null>(null)
  const [tempCleanupError, setTempCleanupError] = useState<string | null>(null)
  const [filters, setFilters] = useState({
    status: '',
    credentialSource: '',
    parseRoute: '',
    q: '',
    page: 1,
  })
  const setError = useSetAtom(errorAtom)
  const pushNotification = useSetAtom(pushNotificationAtom)
  const notifyCopyFailed = () => pushNotification({ variant: 'error', message: '复制失败，请手动复制内容。' })
  const settingsQuery = api.api.settings.$get.useQuery()
  const settingsMutation = api.api.settings.$put.useMutation()
  const historyQuery = api.api.local.history.$get.useQuery({
    query: {
      status: filters.status || undefined,
      credentialSource: filters.credentialSource || undefined,
      parseRoute: filters.parseRoute || undefined,
      q: filters.q || undefined,
      page: String(filters.page),
      pageSize: '20',
    },
  })
  const reparseMutation = api.api.local.history[':id'].reparse.$post.useMutation()
  const tempCleanupMutation = api.api.maintenance['temp-files'].cleanup.$post.useMutation()
  const tempCleanupStatusQuery = api.api.maintenance['temp-files'].cleanup.status.$get.useQuery({
    refetchInterval: tempCleanupProgressOpen || tempCleanupMutation.isPending ? 1000 : false,
  })
  const detailQuery = api.api.local.history[':id'].$get.useQuery({
    param: { id: String(selectedRecordId ?? '') },
    enabled: selectedRecordId !== null,
  })
  const data = historyQuery.data?.data
  const downloaders = parseDownloaders(settingsQuery.data?.data.items.downloadersJson?.value)
  const downloadableRecords = data?.records.map(downloadableFromHistoryRecord).filter((item): item is DownloadableItem => item !== null) ?? []
  const selectedDownloadItems = downloadableRecords.filter((item) => selectedDownloadIds.has(item.id))
  const pageAllSelected = downloadableRecords.length > 0 && downloadableRecords.every((item) => selectedDownloadIds.has(item.id))

  const toggleRecordSelected = (record: LocalHistoryRecord) => {
    const item = downloadableFromHistoryRecord(record)
    if (!item) return
    setSelectedDownloadIds((current) => {
      const next = new Set(current)
      if (next.has(item.id)) next.delete(item.id)
      else next.add(item.id)
      return next
    })
  }

  const togglePageSelected = () => {
    setSelectedDownloadIds((current) => {
      const next = new Set(current)
      for (const item of downloadableRecords) {
        if (pageAllSelected) next.delete(item.id)
        else next.add(item.id)
      }
      return next
    })
  }

  const sendItems = async (downloader: DownloaderConfig, items: DownloadableItem[]) => {
    if (items.length === 0) return
    setSending(true)
    setError(null)
    try {
      const sent = await sendManyToDownloader(downloader, items)
      const failed = sent.filter((item) => !item.ok)
      pushNotification({
        variant: failed.length > 0 ? 'warning' : 'success',
        message: `${downloader.name}: ${summarizeSendResults(sent)}`,
      })
      if (failed[0]?.error) setError(failed[0].error)
    } finally {
      setSending(false)
    }
  }

  const setDefaultDownloader = async (downloaderId: string) => {
    const next = downloaders.map((item) => ({ ...item, isDefault: item.id === downloaderId }))
    try {
      await settingsMutation.mutateAsync({
        json: {
          values: {
            downloadersJson: serializeDownloaders(next),
          },
        },
      })
      await settingsQuery.refetch()
    } catch (error) {
      setError(messageFromError(error, '切换默认下载器失败'))
    }
  }

  const reparse = async (record: LocalHistoryRecord) => {
    setError(null)
    try {
      const response = await reparseMutation.mutateAsync({
        param: { id: String(record.id) },
        json: {},
      })
      const job = response.data
      pushNotification({
        variant: 'info',
        message:
          job.status === 'success'
            ? `重新解析成功 #${job.id}`
            : `已提交重新解析任务 #${job.id}${job.status === 'queued' ? `，前面还有 ${job.ahead_count} 个任务` : ''}`,
      })
      await detailQuery.refetch()
      await historyQuery.refetch()
    } catch (error) {
      setError(messageFromError(error, '重新解析失败'))
    }
  }

  const cleanupTempFiles = async () => {
    setError(null)
    setTempCleanupError(null)
    setTempCleanupResult(null)
    setConfirmTempCleanup(false)
    setTempCleanupProgressOpen(true)
    try {
      const response = await tempCleanupMutation.mutateAsync({ json: {} })
      const result = response.data
      setTempCleanupResult(result)
      const details = [
        `尝试 ${result.attempted}`,
        `删除 ${result.deleted}`,
        result.failed ? `失败 ${result.failed}` : '',
        result.skipped ? `跳过 ${result.skipped}` : '',
        result.orphan ? `孤儿 ${result.orphan}` : '',
        result.waitingForExpiry ? `等待过期 ${result.waitingForExpiry}` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      pushNotification({
        variant: result.failed || result.orphan ? 'warning' : 'success',
        message: `中转文件清理完成：${details}`,
      })
      if (result.firstError) setError(result.firstError)
      await Promise.all([historyQuery.refetch(), detailQuery.refetch(), tempCleanupStatusQuery.refetch()])
    } catch (error) {
      const message = messageFromError(error, '清理中转文件失败')
      setError(message)
      setTempCleanupError(message)
    } finally {
      setConfirmTempCleanup(false)
    }
  }

  return (
    <Panel className="grid gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">解析历史</h2>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button disabled={downloadableRecords.length === 0} onClick={togglePageSelected} variant="secondary">
            {pageAllSelected ? '取消本页' : '选择本页'}
          </Button>
          <DownloaderSendButton
            downloaders={downloaders}
            items={selectedDownloadItems}
            onDefaultChange={(downloaderId) => void setDefaultDownloader(downloaderId)}
            pending={sending}
            size="md"
            onSend={(downloader, items) => void sendItems(downloader, items)}
          />
          <Button disabled={tempCleanupMutation.isPending} onClick={() => setConfirmTempCleanup(true)} variant="secondary">
            <Trash2 className="size-4" />
            清理中转文件
          </Button>
          <Button disabled={historyQuery.isFetching} onClick={() => historyQuery.refetch()} variant="secondary">
            <RefreshCw className={`size-4 ${historyQuery.isFetching ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-[150px_170px_170px_minmax(0,1fr)]">
        <Field label="状态">
          <Select
            value={filters.status}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setFilters((prev) => ({ ...prev, status: event.target.value, page: 1 }))}
          >
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="failed">失败</option>
          </Select>
        </Field>
        <Field label="凭证来源">
          <Select
            value={filters.credentialSource}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setFilters((prev) => ({ ...prev, credentialSource: event.target.value, page: 1 }))}
          >
            <option value="">全部</option>
            <option value="cookie">Cookie</option>
            <option value="open_platform">开放平台</option>
          </Select>
        </Field>
        <Field label="解析路线">
          <Select
            value={filters.parseRoute}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => setFilters((prev) => ({ ...prev, parseRoute: event.target.value, page: 1 }))}
          >
            <option value="">全部</option>
            <option value="disk">disk</option>
            <option value="sharedownload">sharedownload</option>
            <option value="transfer">transfer</option>
          </Select>
        </Field>
        <Field label="搜索">
          <Input
            value={filters.q}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setFilters((prev) => ({ ...prev, q: event.target.value, page: 1 }))}
            placeholder="文件名 / fs_id / 错误码"
          />
        </Field>
      </div>

      {!data || data.records.length === 0 ? (
        <EmptyState title="暂无历史" />
      ) : (
        <div className="grid gap-3">
          <Table>
            <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500">
              <tr>
                <th className="w-10 p-3"></th>
                <th className="p-3">文件</th>
                <th className="p-3">状态</th>
                <th className="p-3">路线</th>
                <th className="p-3">结果</th>
                <th className="p-3">时间</th>
                <th className="p-3">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.records.map((record) => {
                const downloadable = downloadableFromHistoryRecord(record)
                const selected = downloadable ? selectedDownloadIds.has(downloadable.id) : false
                return (
                  <tr key={record.id}>
                    <td className="p-3 align-top">
                      {downloadable ? (
                        <button
                          aria-label="选择下载任务"
                          className="flex size-5 items-center justify-center rounded text-slate-500 hover:bg-slate-100"
                          onClick={() => toggleRecordSelected(record)}
                          type="button"
                        >
                          {selected ? <CheckSquare className="size-5 text-blue-600" /> : <Square className="size-5" />}
                        </button>
                      ) : null}
                    </td>
                    <td className="p-3">
                      <MiddleEllipsis text={record.filename} className="font-semibold" maxWidthPx={320} />
                      <div className="text-xs text-slate-500">
                        {formatBytes(record.sizeBytes)} · fs_id {record.fsId}
                      </div>
                      {record.errorMessage ? <div className="mt-1 max-w-[320px] truncate text-xs text-red-600">{record.errorMessage}</div> : null}
                    </td>
                    <td className="p-3">
                      <StatusBadge status={record.status} />
                    </td>
                    <td className="p-3 text-sm text-slate-600">{record.routeLabel}</td>
                    <td className="p-3 text-xs text-slate-500">{record.resultUrl ? (record.linkExpired ? '可能已过期' : '可用结果') : '-'}</td>
                    <td className="p-3 text-slate-500">{formatDateTime(record.createdAt)}</td>
                    <td className="p-3">
                      <div className="flex flex-wrap gap-2">
                        {record.resultUrl ? (
                          <>
                            <CopyButton value={record.resultUrl} label="复制链接" onCopyFailed={notifyCopyFailed} size="sm" />
                            {downloadable ? (
                              <DownloaderSendButton
                                downloaders={downloaders}
                                items={[downloadable]}
                                menu={false}
                                pending={sending}
                                onSend={(downloader, items) => void sendItems(downloader, items)}
                              />
                            ) : null}
                          </>
                        ) : null}
                        {record.resultUa ? (
                          <CopyButton value={record.resultUa} icon={<Clipboard className="size-4" />} label="复制 UA" onCopyFailed={notifyCopyFailed} size="sm" />
                        ) : null}
                        <Button onClick={() => setSelectedRecordId(record.id)} size="sm" variant="secondary">
                          <Eye className="size-4" />
                          详情
                        </Button>
                        <Button disabled={reparseMutation.isPending} onClick={() => reparse(record)} size="sm" variant="ghost">
                          <RotateCcw className="size-4" />
                          重新解析
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-slate-500">
            <span>
              第 {data.page} / {data.totalPages} 页，共 {data.total} 条
            </span>
            <div className="flex gap-2">
              <Button disabled={filters.page <= 1} onClick={() => setFilters((prev) => ({ ...prev, page: prev.page - 1 }))} size="sm" variant="secondary">
                上一页
              </Button>
              <Button
                disabled={filters.page >= data.totalPages}
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
      <HistoryDetailDrawer
        detail={detailQuery.data?.data}
        loading={detailQuery.isFetching}
        open={selectedRecordId !== null}
        onClose={() => setSelectedRecordId(null)}
        onNotify={pushNotification}
        onReparse={reparse}
        downloaders={downloaders}
        reparsePending={reparseMutation.isPending}
        sending={sending}
        onSend={(downloader, items) => void sendItems(downloader, items)}
      />
      <ConfirmDialog
        confirmLabel="开始清理"
        description="将尝试清理本机 Agent 记录的网盘中转文件。手动清理会重试失败项，但开放平台链接未过期的文件会跳过；账号已删除的孤儿文件只能到百度网盘手动删除。"
        disabled={tempCleanupMutation.isPending}
        open={confirmTempCleanup}
        title="清理中转文件"
        variant="primary"
        onCancel={() => setConfirmTempCleanup(false)}
        onConfirm={() => {
          void cleanupTempFiles()
        }}
      />
      <TempFileCleanupProgressModal
        error={tempCleanupError}
        open={tempCleanupProgressOpen}
        pending={tempCleanupMutation.isPending}
        result={tempCleanupResult}
        status={tempCleanupStatusQuery.data?.data}
        onClose={() => setTempCleanupProgressOpen(false)}
      />
    </Panel>
  )
}
