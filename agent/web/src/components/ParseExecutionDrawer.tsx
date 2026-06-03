import { useState } from 'react'
import { useAtom } from 'jotai'
import { CheckSquare, Clipboard, Square, Trash2, X } from 'lucide-react'
import { executionTabAtom, type NotificationInput, type ParseResult, type QueuedFile } from '../state'
import { formatBytes } from '../lib/format'
import { sendManyToDownloader, summarizeSendResults, type DownloadableItem, type DownloaderConfig } from '../lib/downloaders'
import { usePagination } from '../lib/usePagination'
import { DownloaderSendButton } from './DownloaderSendButton'
import { Button, CopyButton, EmptyState, MiddleEllipsis, Pagination, StateIcon, StatusBadge } from './ui'

const resultDownloadableId = (result: ParseResult, index: number) => String(result.job?.id ?? result.data?.record_id ?? result.fsId ?? index)

const downloadableFromResult = (result: ParseResult, index: number): DownloadableItem | null => {
  const url = result.data?.urls[0]
  if (result.status !== 'success' || !url) return null
  return {
    id: resultDownloadableId(result, index),
    filename: result.filename,
    url,
    ua: result.data?.ua,
  }
}

const queueStatusLabel = (status: QueuedFile['status']) => {
  if (status === 'waiting') return '待提交'
  if (status === 'queued') return '排队中'
  if (status === 'running') return '解析中'
  if (status === 'success') return '成功'
  return '失败'
}

export function ParseExecutionDrawer({
  downloaders,
  open,
  queue,
  results,
  onNotify,
  onError,
  onDefaultDownloaderChange,
  onDeleteWaitingItem,
  onClose,
}: {
  downloaders: DownloaderConfig[]
  open: boolean
  queue: QueuedFile[]
  results: ParseResult[]
  onNotify: (input: NotificationInput) => void
  onError: (message: string | null) => void
  onDefaultDownloaderChange: (downloaderId: string) => void
  onDeleteWaitingItem: (fsId: number) => void
  onClose: () => void
}) {
  const [activeTab, setActiveTab] = useAtom(executionTabAtom)
  const activeCount = queue.filter((item) => item.status === 'waiting' || item.status === 'queued' || item.status === 'running').length
  const successCount = queue.filter((item) => item.status === 'success').length
  const failedCount = queue.filter((item) => item.status === 'failed').length

  return (
    <div className={`fixed inset-0 z-40 ${open ? '' : 'pointer-events-none'}`} aria-hidden={!open}>
      <button
        aria-label="关闭解析队列"
        className={`absolute inset-0 bg-slate-950/30 transition-opacity ${open ? 'opacity-100' : 'opacity-0'}`}
        onClick={onClose}
        tabIndex={open ? 0 : -1}
        type="button"
      />
      <aside
        className={`absolute right-0 top-0 flex h-full w-full max-w-[520px] flex-col border-l border-slate-200 bg-white shadow-2xl shadow-slate-950/20 transition-transform duration-200 max-sm:max-w-none ${open ? 'translate-x-0' : 'translate-x-full'}`}
        role="dialog"
        aria-modal="true"
        aria-label="解析队列"
      >
        <div className="flex items-start gap-3 border-b border-slate-200 px-5 py-4">
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-slate-900">解析队列</h3>
            <p className="mt-1 text-sm text-slate-500">
              {activeCount} 处理中 · {successCount} 成功 · {failedCount} 失败 · {results.length} 结果
            </p>
          </div>
          <button className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" type="button" aria-label="关闭" onClick={onClose}>
            <X className="size-5" />
          </button>
        </div>

        <div className="grid min-h-0 flex-1 grid-rows-[auto_minmax(0,1fr)] gap-4 overflow-hidden p-5">
          <div className="flex rounded-lg bg-slate-100 p-1">
            {[
              { key: 'queue' as const, label: '队列', count: queue.length },
              { key: 'results' as const, label: '结果', count: results.length },
            ].map((tab) => (
              <button
                className={`flex min-h-9 flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition ${activeTab === tab.key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                type="button"
              >
                <span>{tab.label}</span>
                <span className={`rounded-full px-2 py-0.5 text-xs ${activeTab === tab.key ? 'bg-blue-50 text-blue-700' : 'bg-white text-slate-500'}`}>
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          <div className="min-h-0 overflow-y-auto pr-1">
            {activeTab === 'queue' ? (
              <QueuePanel queue={queue} onDeleteWaitingItem={onDeleteWaitingItem} />
            ) : (
              <ResultPanel
                downloaders={downloaders}
                results={results}
                onError={onError}
                onNotify={onNotify}
                onDefaultDownloaderChange={onDefaultDownloaderChange}
              />
            )}
          </div>
        </div>
      </aside>
    </div>
  )
}

function QueuePanel({ queue, onDeleteWaitingItem }: { queue: QueuedFile[]; onDeleteWaitingItem: (fsId: number) => void }) {
  const pagination = usePagination(queue, 5)
  return (
    <div className="grid gap-3">
      {queue.length === 0 ? (
        <EmptyState title="暂无队列" />
      ) : (
        <div className="grid gap-3">
          {pagination.pageItems.map((item) => (
            <QueueItemCard item={item} key={`${item.fsId}:${item.jobId ?? 'pending'}`} onDeleteWaitingItem={onDeleteWaitingItem} />
          ))}
          <Pagination {...pagination} onPageChange={pagination.setPage} />
        </div>
      )}
    </div>
  )
}

function QueueItemCard({ item, onDeleteWaitingItem }: { item: QueuedFile; onDeleteWaitingItem: (fsId: number) => void }) {
  const canDelete = item.status === 'waiting'
  return (
    <div
      className={`overflow-hidden rounded-lg border p-3 ${item.status === 'failed' ? 'border-red-200 bg-red-50/40' : item.status === 'running' ? 'border-blue-200 bg-blue-50/30' : 'border-slate-200 bg-white'}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <StateIcon status={item.status} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
            <MiddleEllipsis text={item.filename} containerClassName="min-w-0" className="text-sm font-bold text-slate-900" />
            <StatusBadge status={queueStatusLabel(item.status)} />
          </div>
          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
            {item.size > 0 ? <span>{formatBytes(item.size)}</span> : null}
            {item.dir ? <span className="max-w-full truncate">{item.dir}</span> : null}
            {item.jobId ? <span>任务 #{item.jobId}</span> : null}
            {typeof item.aheadCount === 'number' ? <span>前方 {item.aheadCount}</span> : null}
          </div>
          {item.message ? <div className="mt-2 break-words text-sm text-slate-600">{item.message}</div> : null}
          {canDelete ? (
            <div className="mt-3 flex justify-end">
              <Button onClick={() => onDeleteWaitingItem(item.fsId)} size="sm" variant="secondary">
                <Trash2 className="size-4" />
                删除
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function ResultPanel({
  downloaders,
  results,
  onNotify,
  onError,
  onDefaultDownloaderChange,
}: {
  downloaders: DownloaderConfig[]
  results: ParseResult[]
  onNotify: (input: NotificationInput) => void
  onError: (message: string | null) => void
  onDefaultDownloaderChange: (downloaderId: string) => void
}) {
  const pagination = usePagination(results, 5)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [sending, setSending] = useState(false)
  const allDownloadable = results.map(downloadableFromResult).filter((item): item is DownloadableItem => item !== null)
  const selectedItems = allDownloadable.filter((item) => selected.has(item.id))
  const pageDownloadable = pagination.pageItems
    .map((result, index) => downloadableFromResult(result, (pagination.page - 1) * pagination.pageSize + index))
    .filter((item): item is DownloadableItem => item !== null)
  const pageAllSelected = pageDownloadable.length > 0 && pageDownloadable.every((item) => selected.has(item.id))
  const sendItems = async (downloader: DownloaderConfig, items: DownloadableItem[]) => {
    if (items.length === 0) return
    setSending(true)
    onError(null)
    try {
      const sent = await sendManyToDownloader(downloader, items)
      const failed = sent.filter((item) => !item.ok)
      onNotify({
        variant: failed.length > 0 ? 'warning' : 'success',
        message: `${downloader.name}: ${summarizeSendResults(sent)}`,
      })
      if (failed[0]?.error) onError(failed[0].error)
    } finally {
      setSending(false)
    }
  }
  const toggleSelected = (item: DownloadableItem, checked: boolean) => {
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(item.id)
      else next.delete(item.id)
      return next
    })
  }
  const togglePageSelected = () => {
    setSelected((current) => {
      const next = new Set(current)
      for (const item of pageDownloadable) {
        if (pageAllSelected) next.delete(item.id)
        else next.add(item.id)
      }
      return next
    })
  }
  const notifyCopyFailed = () => onNotify({ variant: 'error', message: '复制失败，请手动复制内容。' })
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-bold">解析结果</h3>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={pageDownloadable.length === 0} onClick={togglePageSelected} size="sm" variant="secondary">
            {pageAllSelected ? '取消本页' : '选择本页'}
          </Button>
          <DownloaderSendButton
            downloaders={downloaders}
            items={selectedItems}
            onDefaultChange={onDefaultDownloaderChange}
            pending={sending}
            onSend={(downloader, items) => void sendItems(downloader, items)}
          />
        </div>
      </div>
      {results.length === 0 ? (
        <EmptyState title="暂无结果" />
      ) : (
        <div className="grid gap-3">
          {pagination.pageItems.map((result, index) => (
            <ResultCard
              key={`${result.job?.id ?? result.data?.record_id ?? result.fsId}-${result.status}-${index}`}
              downloaders={downloaders}
              index={(pagination.page - 1) * pagination.pageSize + index}
              result={result}
              selected={selected}
              sending={sending}
              onCopyFailed={notifyCopyFailed}
              onSend={(downloader, items) => void sendItems(downloader, items)}
              onToggleSelected={toggleSelected}
            />
          ))}
          <Pagination {...pagination} onPageChange={pagination.setPage} />
        </div>
      )}
    </div>
  )
}

function ResultCard({
  downloaders,
  index,
  result,
  selected,
  sending,
  onCopyFailed,
  onSend,
  onToggleSelected,
}: {
  downloaders: DownloaderConfig[]
  index: number
  result: ParseResult
  selected: Set<string>
  sending: boolean
  onCopyFailed: () => void
  onSend: (downloader: DownloaderConfig, items: DownloadableItem[]) => void
  onToggleSelected: (item: DownloadableItem, checked: boolean) => void
}) {
  const item = downloadableFromResult(result, index)
  return (
    <div
      className={`overflow-hidden rounded-lg border p-3 ${result.status === 'success' ? 'border-emerald-200 bg-emerald-50/40' : 'border-red-200 bg-red-50/40'}`}
    >
      <div className="flex min-w-0 items-start gap-2">
        {item ? (
          <button
            aria-label="选择下载任务"
            className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded text-slate-500 hover:bg-white/70"
            onClick={() => onToggleSelected(item, !selected.has(item.id))}
            type="button"
          >
            {selected.has(item.id) ? <CheckSquare className="size-5 text-blue-600" /> : <Square className="size-5" />}
          </button>
        ) : (
          <span className="mt-0.5 shrink-0">
            <StateIcon status={result.status} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2">
            <MiddleEllipsis text={result.filename} containerClassName="min-w-0" className="text-sm font-bold text-slate-900" />
            <StatusBadge status={result.status === 'success' ? '成功' : '失败'} />
          </div>
          <div className="mt-1 break-words text-xs text-slate-600">{result.message}</div>
        </div>
      </div>
      {result.status === 'success' && result.data ? (
        <div className="mt-3 grid gap-2 text-xs">
          <div className="rounded-md bg-white px-3 py-2 text-slate-600 ring-1 ring-slate-200">
            账号 {result.data.account_id} · {result.data.parseRoute ? `${result.data.credentialSource}.${result.data.parseRoute}` : '-'}
          </div>
          <div className="break-all rounded-md bg-white px-3 py-2 text-slate-600 ring-1 ring-slate-200">UA: {result.data.ua}</div>
          <div className="flex flex-wrap gap-2">
            <CopyButton className="min-h-9 px-3 py-1.5" value={result.data.urls[0] ?? ''} label="复制直链" onCopyFailed={onCopyFailed} size="md" />
            <CopyButton
              className="min-h-9 px-3 py-1.5"
              value={result.data.ua ?? ''}
              icon={<Clipboard className="size-4" />}
              label="复制 UA"
              onCopyFailed={onCopyFailed}
              size="md"
            />
            {item ? <DownloaderSendButton downloaders={downloaders} items={[item]} menu={false} pending={sending} onSend={onSend} /> : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}
